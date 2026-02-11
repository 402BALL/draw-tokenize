require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Keypair, Connection, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ DATABASE ============

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS drawings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename TEXT NOT NULL,
        image_url TEXT NOT NULL,
        tool TEXT DEFAULT 'unknown',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        tokenized BOOLEAN DEFAULT FALSE,
        token_name TEXT,
        token_ticker TEXT,
        token_description TEXT,
        token_twitter TEXT,
        mint_address TEXT,
        pump_url TEXT,
        signature TEXT,
        tokenized_at TIMESTAMPTZ
      )
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// Helper: convert DB row to API response format (same as before)
function rowToDrawing(row) {
  return {
    id: row.id,
    filename: row.filename,
    imageUrl: row.image_url,
    tool: row.tool,
    createdAt: row.created_at,
    tokenized: row.tokenized,
    tokenData: row.tokenized ? {
      name: row.token_name,
      ticker: row.token_ticker,
      description: row.token_description,
      twitter: row.token_twitter,
      mintAddress: row.mint_address,
      pumpUrl: row.pump_url,
      signature: row.signature,
      tokenizedAt: row.tokenized_at
    } : null
  };
}

// ============ MIDDLEWARE ============

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ============ API ROUTES ============

// Save a drawing (from base64 data URL)
app.post('/api/drawings', async (req, res) => {
  try {
    const { imageData, tool } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Convert base64 to file
    const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image data format' });
    }

    const ext = matches[1];
    const data = Buffer.from(matches[2], 'base64');
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(uploadsDir, filename);
    
    fs.writeFileSync(filepath, data);

    // Save to DB
    const result = await pool.query(
      `INSERT INTO drawings (filename, image_url, tool)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [filename, `/uploads/${filename}`, tool || 'unknown']
    );

    res.json({ success: true, drawing: rowToDrawing(result.rows[0]) });
  } catch (error) {
    console.error('Error saving drawing:', error);
    res.status(500).json({ error: 'Failed to save drawing' });
  }
});

// Get all drawings
app.get('/api/drawings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM drawings ORDER BY created_at DESC');
    res.json({ drawings: result.rows.map(rowToDrawing) });
  } catch (error) {
    console.error('Error loading drawings:', error);
    res.status(500).json({ error: 'Failed to load drawings' });
  }
});

// Get a single drawing
app.get('/api/drawings/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM drawings WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Drawing not found' });
    res.json({ drawing: rowToDrawing(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load drawing' });
  }
});

// Tokenize a drawing on pump.fun
app.post('/api/tokenize', async (req, res) => {
  try {
    const { drawingId, name, ticker, description, twitter } = req.body;

    if (!drawingId || !name || !ticker) {
      return res.status(400).json({ error: 'Missing required fields: drawingId, name, ticker' });
    }

    // Load drawing
    const drawingResult = await pool.query('SELECT * FROM drawings WHERE id = $1', [drawingId]);
    if (drawingResult.rows.length === 0) return res.status(404).json({ error: 'Drawing not found' });

    const drawing = drawingResult.rows[0];

    // Check private key
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey || privateKey === 'YOUR_PRIVATE_KEY_HERE') {
      return res.status(400).json({ error: 'Solana private key not configured in .env' });
    }

    // Create keypair from private key
    let signerKeyPair;
    try {
      const decoded = bs58.decode(privateKey);
      signerKeyPair = Keypair.fromSecretKey(decoded);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid private key format' });
    }

    // Generate mint keypair for the new token
    const mintKeypair = Keypair.generate();

    // Read image file
    const imagePath = path.join(uploadsDir, drawing.filename);
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: 'Image file not found' });
    }

    // Create form data for pump.fun IPFS upload
    const formData = new FormData();
    formData.append('file', fs.createReadStream(imagePath));
    formData.append('name', name);
    formData.append('symbol', ticker);
    formData.append('description', description || '');
    formData.append('twitter', twitter || '');
    formData.append('showName', 'true');

    // Step 1: Upload metadata to pump.fun IPFS
    console.log('Uploading metadata to pump.fun IPFS...');
    const metadataResponse = await fetch('https://pump.fun/api/ipfs', {
      method: 'POST',
      body: formData
    });

    if (!metadataResponse.ok) {
      const errorText = await metadataResponse.text();
      console.error('IPFS upload failed:', errorText);
      return res.status(500).json({ error: 'Failed to upload metadata to IPFS' });
    }

    const metadataJson = await metadataResponse.json();
    console.log('Metadata uploaded:', metadataJson);

    // Step 2: Create token transaction via pumpportal.fun
    console.log('Creating token transaction...');
    const txResponse = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: signerKeyPair.publicKey.toBase58(),
        action: 'create',
        tokenMetadata: {
          name: name,
          symbol: ticker,
          uri: metadataJson.metadataUri
        },
        mint: mintKeypair.publicKey.toBase58(),
        denominatedInSol: 'true',
        amount: 0,
        slippage: 10,
        priorityFee: 0.0005,
        pool: 'pump'
      })
    });

    if (txResponse.status !== 200) {
      const errorText = await txResponse.text();
      console.error('Transaction creation failed:', errorText);
      return res.status(500).json({ error: 'Failed to create transaction' });
    }

    // Step 3: Sign and send transaction
    const txData = await txResponse.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    tx.sign([mintKeypair, signerKeyPair]);

    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    console.log('Sending transaction...');
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3
    });

    console.log('Transaction sent:', signature);

    // Confirm transaction
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err) {
      console.error('Transaction failed:', confirmation.value.err);
      return res.status(500).json({ error: 'Transaction failed on-chain' });
    }

    const mintAddress = mintKeypair.publicKey.toBase58();
    const pumpUrl = `https://pump.fun/${mintAddress}`;

    console.log('Token created successfully!');
    console.log('Mint address:', mintAddress);
    console.log('Pump.fun URL:', pumpUrl);

    // Update drawing in DB
    const updateResult = await pool.query(
      `UPDATE drawings SET
        tokenized = TRUE,
        token_name = $1,
        token_ticker = $2,
        token_description = $3,
        token_twitter = $4,
        mint_address = $5,
        pump_url = $6,
        signature = $7,
        tokenized_at = NOW()
      WHERE id = $8
      RETURNING *`,
      [name, ticker, description || '', twitter || '', mintAddress, pumpUrl, signature, drawingId]
    );

    const updatedDrawing = rowToDrawing(updateResult.rows[0]);

    res.json({
      success: true,
      mintAddress,
      pumpUrl,
      signature,
      drawing: updatedDrawing
    });

  } catch (error) {
    console.error('Tokenization error:', error);
    res.status(500).json({ error: error.message || 'Tokenization failed' });
  }
});

// ============ START SERVER ============

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`\nDraw & Tokenize server running at http://localhost:${PORT}`);
      console.log(`Static files: ${__dirname}`);
      console.log(`Uploads: ${uploadsDir}`);
      console.log(`Database: PostgreSQL connected\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

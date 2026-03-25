// ─── WhatsApp Scheduler Server ── By @AnotherDr ───────────────────────
// Each client gets their own isolated server instance — no shared data.
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const WhatsAppService  = require('./services/whatsapp');
const SchedulerService = require('./services/scheduler');
const db         = require('./services/database');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'wa-scheduler-secret';

// ─── Security: Rate limiting (in-memory, per IP) ────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX    = 60;        // 60 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (valid.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, valid);
  }
}, 5 * 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(rateLimit);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Auth middleware — constant-time comparison to prevent timing attacks
function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key || '';
  const expected = API_SECRET;
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Block all unknown routes
app.use('/api', auth);

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Services ─────────────────────────────────────────────────────────────────
const whatsapp  = new WhatsAppService(broadcast);
const scheduler = new SchedulerService(whatsapp, broadcast);

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health check (public — reveals no sensitive data)
app.get('/health', (req, res) => {
  res.json({ ok: true, server: 'WhatsApp Scheduler by @AnotherDr' });
});

// WhatsApp status
app.get('/api/status', (req, res) => {
  res.json({ connected: whatsapp.isReady(), hasQR: !!whatsapp.getLatestQR() });
});

// Initialize WhatsApp (triggers QR or restores session)
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const result = await whatsapp.initialize();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Restart WhatsApp (destroy old client, start fresh — generates new QR)
app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    console.log('[API] Restart requested');
    const result = await whatsapp.restart();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get the latest QR code (if available)
app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getLatestQR();
  if (qr) {
    res.json({ success: true, qrCode: qr });
  } else {
    res.json({ success: false, message: 'No QR available' });
  }
});

// Get chats
app.get('/api/chats', async (req, res) => {
  try {
    const chats = await whatsapp.getChats();
    res.json({ success: true, chats });
  } catch (err) {
    res.json({ success: false, error: err.message, chats: [] });
  }
});

// Logout WhatsApp
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    await whatsapp.logout();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Check if passcode exists for this token
app.get('/api/passcode/exists', (req, res) => {
  try {
    const passcodeExists = db.hasPasscode();
    res.json({ success: true, exists: passcodeExists });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Create/set passcode for this token
app.post('/api/passcode/create', (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode || passcode.length < 4 || passcode.length > 6) {
      return res.status(400).json({ success: false, error: 'Passcode must be 4-6 digits' });
    }
    if (!/^\d+$/.test(passcode)) {
      return res.status(400).json({ success: false, error: 'Passcode must contain only digits' });
    }
    db.setPasscode(passcode);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Verify passcode
app.post('/api/passcode/verify', (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode) {
      return res.status(400).json({ success: false, error: 'Passcode required' });
    }
    const isValid = db.verifyPasscode(passcode);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid passcode' });
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Clear passcode (on logout)
app.post('/api/passcode/clear', (req, res) => {
  try {
    db.clearPasscode();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Schedule a message
app.post('/api/messages', (req, res) => {
  try {
    const id = scheduler.scheduleMessage(req.body);
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get all scheduled messages
app.get('/api/messages', (req, res) => {
  try {
    const messages = scheduler.getScheduledMessages();
    res.json({ success: true, messages });
  } catch (err) {
    res.json({ success: false, error: err.message, messages: [] });
  }
});

// Delete a scheduled message
app.delete('/api/messages/:id', (req, res) => {
  try {
    scheduler.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Catch-all: block any other routes ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // Validate secret on connect via query param (constant-time)
  const url = new URL(req.url, `http://localhost`);
  const key = url.searchParams.get('key') || '';
  if (key.length !== API_SECRET.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(API_SECRET))) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log('[WS] Client connected');

  // Send current status immediately
  const status = { connected: whatsapp.isReady() };
  ws.send(JSON.stringify({ type: 'status', data: status }));

  // If there's a pending QR, send it immediately
  const latestQR = whatsapp.getLatestQR();
  if (latestQR && !whatsapp.isReady()) {
    ws.send(JSON.stringify({ type: 'qr', data: { qrCode: latestQR } }));
  }

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Scheduler Server running on port ${PORT}`);
  console.log(`   By @AnotherDr`);
  console.log(`   Security: Rate limiting, timing-safe auth, security headers enabled\n`);

  // DO NOT auto-initialize WhatsApp — wait for the app to request it
  // Load and reschedule pending messages (in case session restores automatically)
  setTimeout(() => {
    try { scheduler.loadAndRescheduleMessages(); }
    catch (e) { console.error('[Server] Reschedule error:', e.message); }
  }, 3000);
});

// ─── Decrypt activation code (public — no auth needed for setup) ────────────────
const MASTER_KEY = 'WhatsAppSchedulerByAhmedAbdAlazeem2026';
const SALT = 'wa-scheduler-salt-2026';

function deriveKey() {
  return crypto.pbkdf2Sync(MASTER_KEY, SALT, 100000, 32, 'sha256');
}

app.post('/decrypt-code', (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });
    
    const encrypted = Buffer.from(code, 'base64');
    const iv = encrypted.slice(0, 16);
    const ciphertext = encrypted.slice(16);
    
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const paddingLen = decrypted[decrypted.length - 1];
    const plaintext = decrypted.slice(0, decrypted.length - paddingLen);
    
    const data = JSON.parse(plaintext.toString());
    if (!data.url || !data.key) throw new Error('Invalid data');
    
    res.json({ url: data.url, key: data.key });
  } catch (err) {
    res.status(400).json({ error: 'Invalid activation code' });
  }
});

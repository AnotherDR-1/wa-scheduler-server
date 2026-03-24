// ─── WhatsApp Scheduler Server ── By Ahmed Abd Alazeem ───────────────────────
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const path       = require('path');
const WhatsAppService = require('./services/whatsapp');
const SchedulerService = require('./services/scheduler');
const db         = require('./services/database');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'wa-scheduler-secret';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Auth middleware
function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key;
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

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

// Health check (public)
app.get('/health', (req, res) => {
  res.json({ ok: true, connected: whatsapp.isReady(), server: 'WhatsApp Scheduler by Ahmed Abd Alazeem' });
});

// WhatsApp status
app.get('/api/status', auth, (req, res) => {
  res.json({ connected: whatsapp.isReady(), hasQR: !!whatsapp.getLatestQR() });
});

// Initialize WhatsApp (triggers QR or restores session)
app.post('/api/whatsapp/init', auth, async (req, res) => {
  try {
    const result = await whatsapp.initialize();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Restart WhatsApp (destroy old client, start fresh — generates new QR)
app.post('/api/whatsapp/restart', auth, async (req, res) => {
  try {
    console.log('[API] Restart requested');
    const result = await whatsapp.restart();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get the latest QR code (if available)
app.get('/api/whatsapp/qr', auth, (req, res) => {
  const qr = whatsapp.getLatestQR();
  if (qr) {
    res.json({ success: true, qrCode: qr });
  } else {
    res.json({ success: false, message: 'No QR available' });
  }
});

// Get chats
app.get('/api/chats', auth, async (req, res) => {
  try {
    const chats = await whatsapp.getChats();
    res.json({ success: true, chats });
  } catch (err) {
    res.json({ success: false, error: err.message, chats: [] });
  }
});

// Logout WhatsApp
app.post('/api/whatsapp/logout', auth, async (req, res) => {
  try {
    await whatsapp.logout();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Schedule a message
app.post('/api/messages', auth, (req, res) => {
  try {
    const id = scheduler.scheduleMessage(req.body);
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get all scheduled messages
app.get('/api/messages', auth, (req, res) => {
  try {
    const messages = scheduler.getScheduledMessages();
    res.json({ success: true, messages });
  } catch (err) {
    res.json({ success: false, error: err.message, messages: [] });
  }
});

// Delete a scheduled message
app.delete('/api/messages/:id', auth, (req, res) => {
  try {
    scheduler.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // Validate secret on connect via query param
  const url  = new URL(req.url, `http://localhost`);
  const key  = url.searchParams.get('key');
  if (key !== API_SECRET) { ws.close(1008, 'Unauthorized'); return; }

  console.log('[WS] Client connected');

  // Send current status immediately
  const status = { connected: whatsapp.isReady() };
  ws.send(JSON.stringify({ type: 'status', data: status }));

  // If there's a pending QR, send it immediately so the client gets the freshest one
  const latestQR = whatsapp.getLatestQR();
  if (latestQR && !whatsapp.isReady()) {
    ws.send(JSON.stringify({ type: 'qr', data: { qrCode: latestQR } }));
  }

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Scheduler Server running on port ${PORT}`);
  console.log(`   By Ahmed Abd Alazeem\n`);

  // DO NOT auto-initialize WhatsApp — wait for the app to request it
  // This prevents stale QR codes from accumulating before anyone connects

  // Load and reschedule pending messages (in case session restores automatically)
  setTimeout(() => {
    try { scheduler.loadAndRescheduleMessages(); }
    catch (e) { console.error('[Server] Reschedule error:', e.message); }
  }, 3000);
});

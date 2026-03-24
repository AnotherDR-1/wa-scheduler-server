const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs');

// Session storage — Railway persistent volume or local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class WhatsAppService {
  constructor(broadcast) {
    this.broadcast    = broadcast;
    this.client       = null;
    this._isReady     = false;
    this._initializing = false;
    this._latestQR    = null;       // Always stores the latest QR data URL
    this.sessionPath  = path.join(DATA_DIR, 'wwebjs_auth');
  }

  isReady()    { return this._isReady; }
  getLatestQR() { return this._latestQR; }

  /**
   * Destroy any existing client and start fresh.
   * Returns a promise that resolves when QR is available or session is restored.
   */
  async restart() {
    console.log('[WhatsApp] Restarting — destroying old client...');
    await this._destroy();
    return this.initialize();
  }

  /**
   * Initialize WhatsApp. If already ready, returns immediately.
   * If already initializing, returns the latest QR if available.
   */
  async initialize() {
    // Already connected
    if (this._isReady && this.client) {
      return { type: 'ready' };
    }

    // Already initializing — return latest QR if we have one
    if (this._initializing) {
      if (this._latestQR) return { type: 'qr', qrCode: this._latestQR };
      return { type: 'initializing' };
    }

    this._initializing = true;
    this._latestQR = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };
      const fail = (err) => { if (!settled) { settled = true; this._initializing = false; reject(err); } };

      try {
        const puppeteerArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--single-process',
        ];

        this.client = new Client({
          authStrategy: new LocalAuth({
            clientId: 'wa-scheduler',
            dataPath: this.sessionPath,
          }),
          puppeteer: { headless: true, args: puppeteerArgs },
        });

        // ── QR event ──────────────────────────────────────────────────────
        this.client.on('qr', async (qr) => {
          console.log('[WhatsApp] New QR code received');
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
            this._latestQR = qrDataUrl;
            // Broadcast to all connected WebSocket clients immediately
            this.broadcast('qr', { qrCode: qrDataUrl });
            // Resolve the init promise on first QR so the HTTP response returns quickly
            done({ type: 'qr', qrCode: qrDataUrl });
          } catch (e) {
            console.error('[WhatsApp] QR encode error:', e.message);
          }
        });

        // ── Ready event ───────────────────────────────────────────────────
        this.client.on('ready', () => {
          console.log('[WhatsApp] Ready!');
          this._isReady = true;
          this._initializing = false;
          this._latestQR = null;
          this.broadcast('ready', {});
          done({ type: 'ready' });
        });

        // ── Authenticated event ───────────────────────────────────────────
        this.client.on('authenticated', () => {
          console.log('[WhatsApp] Authenticated — loading session...');
          this.broadcast('authenticated', {});
        });

        // ── Auth failure ──────────────────────────────────────────────────
        this.client.on('auth_failure', (msg) => {
          console.error('[WhatsApp] Auth failure:', msg);
          this._isReady = false;
          this._initializing = false;
          this.broadcast('error', { message: 'Authentication failed: ' + msg });
          fail(new Error('Authentication failed'));
        });

        // ── Disconnected ──────────────────────────────────────────────────
        this.client.on('disconnected', (reason) => {
          console.log('[WhatsApp] Disconnected:', reason);
          this._isReady = false;
          this._initializing = false;
          this._latestQR = null;
          this.broadcast('disconnected', { reason });
        });

        // Start the client
        console.log('[WhatsApp] Starting Chromium and WhatsApp Web...');
        this.client.initialize().catch(err => {
          console.error('[WhatsApp] initialize() error:', err.message);
          this._initializing = false;
          fail(err);
        });

        // 3 minute timeout for the initial promise
        setTimeout(() => fail(new Error('WhatsApp initialization timed out (3 min)')), 180000);

      } catch (err) {
        this._initializing = false;
        fail(err);
      }
    });
  }

  async getChats() {
    if (!this.client || !this._isReady) throw new Error('WhatsApp not connected');
    const chats = await this.client.getChats();
    return chats
      .filter(c => c.name || c.contact?.name)
      .map(c => ({
        id:      c.id._serialized,
        name:    c.name || c.contact?.pushname || c.contact?.name || 'Unknown',
        isGroup: c.isGroup,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendMessage(chatId, message) {
    if (!this.client || !this._isReady) throw new Error('WhatsApp not connected');
    return this.client.sendMessage(chatId, message);
  }

  async logout() {
    if (this.client) {
      try { await this.client.logout(); } catch (e) {}
    }
    await this._destroy();
  }

  async _destroy() {
    if (this.client) {
      try { await this.client.destroy(); } catch (e) {}
    }
    this.client       = null;
    this._isReady     = false;
    this._initializing = false;
    this._latestQR    = null;
  }
}

module.exports = WhatsAppService;

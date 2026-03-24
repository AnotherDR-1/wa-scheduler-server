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
    this._initPromise = null;
    this._readyFired  = false;
    this.sessionPath  = path.join(DATA_DIR, 'wwebjs_auth');
  }

  isReady() { return this._isReady; }

  initialize() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      const fail = (err) => { if (!resolved) { resolved = true; this._initPromise = null; reject(err); } };

      try {
        // On Railway (Linux), use the system Chromium or puppeteer's bundled one
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

        this.client.on('qr', async (qr) => {
          console.log('[WhatsApp] QR code received');
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
            this.broadcast('qr', { qrCode: qrDataUrl });
            done({ type: 'qr', qrCode: qrDataUrl });
          } catch (e) { fail(e); }
        });

        this.client.on('ready', () => {
          if (this._readyFired) return;
          this._readyFired = true;
          console.log('[WhatsApp] Ready!');
          this._isReady = true;
          this.broadcast('ready', {});
          done({ type: 'ready' });
        });

        this.client.on('authenticated', () => {
          console.log('[WhatsApp] Authenticated');
          this.broadcast('authenticated', {});
        });

        this.client.on('auth_failure', (msg) => {
          console.error('[WhatsApp] Auth failure:', msg);
          this._isReady = false;
          this._initPromise = null;
          this.broadcast('error', { message: 'Authentication failed' });
          fail(new Error('Authentication failed'));
        });

        this.client.on('disconnected', (reason) => {
          console.log('[WhatsApp] Disconnected:', reason);
          this._isReady = false;
          this._readyFired = false;
          this._initPromise = null;
          this.broadcast('disconnected', { reason });
        });

        this.client.initialize().catch(err => {
          console.error('[WhatsApp] initialize() error:', err.message);
          this._initPromise = null;
          fail(err);
        });

        // 3 minute timeout
        setTimeout(() => fail(new Error('WhatsApp initialization timed out')), 180000);

      } catch (err) {
        this._initPromise = null;
        fail(err);
      }
    });

    return this._initPromise;
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
      try { await this.client.destroy(); } catch (e) {}
    }
    this.client       = null;
    this._isReady     = false;
    this._readyFired  = false;
    this._initPromise = null;
  }
}

module.exports = WhatsAppService;

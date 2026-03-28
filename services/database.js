const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store DB in /data for Railway persistent volume, fallback to local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId      TEXT NOT NULL,
    chatName    TEXT NOT NULL,
    message     TEXT NOT NULL,
    scheduledTime TEXT NOT NULL,
    cronExpression TEXT,
    isRecurring INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',
    createdAt   TEXT DEFAULT (datetime('now')),
    sentAt      TEXT
  );
  
  CREATE TABLE IF NOT EXISTS passcode (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    passcode  TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  
  CREATE TABLE IF NOT EXISTS licenses (
    licenseKey TEXT PRIMARY KEY,
    deviceId   TEXT NOT NULL UNIQUE,
    registeredAt TEXT DEFAULT (datetime('now')),
    expiresAt  TEXT
  );
`);

// Passcode management functions
db.hasPasscode = function() {
  const row = db.prepare('SELECT passcode FROM passcode WHERE id = 1').get();
  return !!row;
};

db.setPasscode = function(passcode) {
  db.prepare('INSERT OR REPLACE INTO passcode (id, passcode) VALUES (1, ?)').run(passcode);
};

db.verifyPasscode = function(passcode) {
  const row = db.prepare('SELECT passcode FROM passcode WHERE id = 1').get();
  if (!row) return false;
  return row.passcode === passcode;
};

db.clearPasscode = function() {
  db.prepare('DELETE FROM passcode WHERE id = 1').run();
};

module.exports = db;

// License management functions
db.registerLicense = function(licenseKey, deviceId) {
  db.prepare('INSERT OR REPLACE INTO licenses (licenseKey, deviceId, registeredAt) VALUES (?, ?, datetime("now"))').run(licenseKey, deviceId);
};

db.validateLicense = function(licenseKey, deviceId) {
  const row = db.prepare('SELECT deviceId FROM licenses WHERE licenseKey = ?').get(licenseKey);
  if (!row) return false;
  return row.deviceId === deviceId;
};

db.getLicenseInfo = function(licenseKey) {
  return db.prepare('SELECT * FROM licenses WHERE licenseKey = ?').get(licenseKey);
};

const schedule = require('node-schedule');
const db       = require('./database');

class SchedulerService {
  constructor(whatsapp, broadcast) {
    this.whatsapp  = whatsapp;
    this.broadcast = broadcast;
    this.jobs      = new Map(); // id → node-schedule job
  }

  scheduleMessage(data) {
    const { chatId, chatName, message, scheduledTime, cronExpression, isRecurring } = data;
    if (!chatId || !message) throw new Error('chatId and message are required');

    const stmt = db.prepare(`
      INSERT INTO scheduled_messages (chatId, chatName, message, scheduledTime, cronExpression, isRecurring, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(chatId, chatName || chatId, message, scheduledTime, cronExpression || null, isRecurring ? 1 : 0);
    const id = result.lastInsertRowid;

    this._createJob(id, { chatId, chatName, message, scheduledTime, cronExpression, isRecurring: !!isRecurring });
    console.log(`[Scheduler] Scheduled message #${id} for ${chatName} at ${isRecurring ? cronExpression : scheduledTime}`);
    return id;
  }

  _createJob(id, data) {
    const { chatId, chatName, message, scheduledTime, cronExpression, isRecurring } = data;

    const sendFn = async () => {
      console.log(`[Scheduler] Sending message #${id} to ${chatName}`);
      try {
        await this.whatsapp.sendMessage(chatId, message);
        if (!isRecurring) {
          db.prepare(`UPDATE scheduled_messages SET status='sent', sentAt=datetime('now') WHERE id=?`).run(id);
          this.jobs.delete(id);
        }
        this.broadcast('message_sent', { id, chatName });
        console.log(`[Scheduler] ✓ Message #${id} sent to ${chatName}`);
      } catch (err) {
        console.error(`[Scheduler] ✗ Failed to send message #${id}:`, err.message);
        if (!isRecurring) {
          db.prepare(`UPDATE scheduled_messages SET status='failed' WHERE id=?`).run(id);
        }
        this.broadcast('message_failed', { id, chatName, error: err.message });
      }
    };

    let job;
    if (isRecurring && cronExpression) {
      job = schedule.scheduleJob(cronExpression, sendFn);
    } else {
      const sendAt = new Date(scheduledTime);
      if (sendAt > new Date()) {
        job = schedule.scheduleJob(sendAt, sendFn);
      } else {
        // Already past — mark as missed
        db.prepare(`UPDATE scheduled_messages SET status='failed' WHERE id=? AND status='pending'`).run(id);
        return;
      }
    }

    if (job) this.jobs.set(id, job);
  }

  loadAndRescheduleMessages() {
    const pending = db.prepare(`SELECT * FROM scheduled_messages WHERE status='pending'`).all();
    console.log(`[Scheduler] Rescheduling ${pending.length} pending message(s)...`);
    for (const msg of pending) {
      if (!this.jobs.has(msg.id)) {
        this._createJob(msg.id, {
          chatId:         msg.chatId,
          chatName:       msg.chatName,
          message:        msg.message,
          scheduledTime:  msg.scheduledTime,
          cronExpression: msg.cronExpression,
          isRecurring:    !!msg.isRecurring,
        });
      }
    }
  }

  getScheduledMessages() {
    return db.prepare(`SELECT * FROM scheduled_messages ORDER BY createdAt DESC`).all();
  }

  deleteMessage(id) {
    const job = this.jobs.get(Number(id));
    if (job) { job.cancel(); this.jobs.delete(Number(id)); }
    db.prepare(`DELETE FROM scheduled_messages WHERE id=?`).run(id);
  }
}

module.exports = SchedulerService;

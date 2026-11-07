'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor({ dir, limit = 800 }) {
    this.dir = dir;
    this.limit = limit;
    this.entries = [];
    this.seq = 0;
    this.stream = null;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'manager.log');
    this.openStream();
  }

  openStream() {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 5 * 1024 * 1024) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    } catch (_e) {
      this.stream = null;
    }
  }

  write(level, message, meta = {}) {
    const entry = {
      id: ++this.seq,
      ts: Date.now(),
      level,
      message: String(message),
      accountId: meta.accountId || null,
      account: meta.account || null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    const line = `[${new Date(entry.ts).toISOString()}] [${level.toUpperCase()}]${
      entry.account ? ` [${entry.account}]` : ''
    } ${entry.message}\n`;
    try {
      if (this.stream) this.stream.write(line);
    } catch (_e) {
      /* ignore */
    }
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(line.trimEnd());
    return entry;
  }

  debug(message, meta) {
    return this.write('debug', message, meta);
  }

  info(message, meta) {
    return this.write('info', message, meta);
  }

  warn(message, meta) {
    return this.write('warn', message, meta);
  }

  error(message, meta) {
    return this.write('error', message, meta);
  }

  list({ after = 0, accountId = '', limit = 300 } = {}) {
    let list = this.entries;
    if (accountId) list = list.filter((e) => e.accountId === accountId);
    if (after) list = list.filter((e) => e.id > after);
    return list.slice(-limit);
  }
}

module.exports = { Logger, LEVELS };

'use strict';
// Small JSON store for accounts, sessions and share links. File contents never go here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Db {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.data = { users: {}, sessions: {}, shares: {}, settings: {}, secret: '' };
    if (fs.existsSync(this.file)) Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    if (!this.data.secret) {
      this.data.secret = crypto.randomBytes(32).toString('hex');
      this.save();
    }
  }

  // Write-then-rename so a crash or power cut can never leave a half-written database.
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (e) {
        // Antivirus and search indexers briefly lock files on Windows.
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  }

  user(name) {
    return Object.hasOwn(this.data.users, name) ? this.data.users[name] : null;
  }
}

module.exports = { Db };

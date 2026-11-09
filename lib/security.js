'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAX_MEM = 128 * N * R * 2;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [, n, salt, hash] = String(stored).split('$');
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: R, p: P, maxmem: MAX_MEM });
  return crypto.timingSafeEqual(key, expected);
}

// Verified against when the username does not exist, so response time can't reveal valid names.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Failures earn a growing cooldown: 5 are free, then 30s, 60s... capped at 15 minutes.
class Limiter {
  constructor(free = 5) {
    this.free = free;
    this.map = new Map();
  }

  check(key) {
    const hit = this.map.get(key);
    if (hit && hit.until > Date.now()) {
      const seconds = Math.ceil((hit.until - Date.now()) / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${seconds} seconds.`, { retryAfter: seconds });
    }
  }

  fail(key) {
    if (this.map.size > 20000) this.prune();
    const hit = this.map.get(key) || { count: 0, until: 0, last: 0 };
    hit.count++;
    hit.last = Date.now();
    if (hit.count >= this.free) {
      hit.until = Date.now() + Math.min(30000 * 2 ** (hit.count - this.free), 15 * 60000);
    }
    this.map.set(key, hit);
  }

  reset(key) {
    this.map.delete(key);
  }

  prune() {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of this.map) if (v.last < cutoff && v.until < Date.now()) this.map.delete(k);
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// Returns the matched time-step, or null. Callers store it so a code can't be used twice.
function verifyTotp(secret, code, lastCounter = -1) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const counter of [now - 1, now, now + 1]) {
    if (counter > lastCounter && safeEqual(totpAt(secret, counter), clean)) return counter;
  }
  return null;
}

module.exports = {
  HttpError, hashPassword, verifyPassword, dummyHash, sha256, randomToken, safeEqual,
  Limiter, newTotpSecret, verifyTotp, totpAt,
};

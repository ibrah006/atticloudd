'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const config = require('./lib/config');
const { Db } = require('./lib/db');
const {
  HttpError, hashPassword, verifyPassword, dummyHash, sha256, randomToken, safeEqual,
  Limiter, newTotpSecret, verifyTotp,
} = require('./lib/security');
const { assertName, resolveSafe, exists, uniquePath, validName } = require('./lib/paths');
const { collect, writeZip } = require('./lib/zip');
const { Remote } = require('./lib/remote');

const db = new Db(config.dataDir);
const remote = new Remote(config, db);
const limiter = new Limiter();

const USERS_DIR = path.join(config.storageDir, 'users');
const SYSTEM_DIR = path.join(config.storageDir, '.system');
const TRASH_DIR = path.join(SYSTEM_DIR, 'trash');
const UPLOAD_DIR = path.join(SYSTEM_DIR, 'uploads');
for (const dir of [USERS_DIR, TRASH_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

const DAY = 86400000;
const SESSION_TTL = 30 * DAY;
const CHUNK_SIZE = 8 * 1024 * 1024; // Comfortably below the 100 MB request limit of Cloudflare tunnels.
const CHUNK_MAX = 32 * 1024 * 1024;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// Each email doubles as the account's home folder name, so it must also be a safe folder name.
for (const email of [...config.allowedEmails, ...config.adminEmails]) {
  if (email.length > 254 || !EMAIL.test(email) || !validName(email)) {
    console.error(`"${email}" in allowedEmails/adminEmails is not a valid email address.`);
    process.exit(1);
  }
}
const ALLOWED = new Set([...config.allowedEmails, ...config.adminEmails]);
const ADMINS = new Set(config.adminEmails);
const isAllowed = (email) => ALLOWED.has(email);
const isAdmin = (email) => ADMINS.has(email);

const userRoot = (name) => path.join(USERS_DIR, name);
const trashRoot = (name) => path.join(TRASH_DIR, name);

// ---- Request helpers ----------------------------------------------------------------------

function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

function clientIp(req) {
  const socket = req.socket.remoteAddress || '';
  if (isLoopback(socket)) {
    // Forwarding headers are only trusted when the connection came from a tunnel on this PC.
    if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
    if (req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
  }
  return socket;
}

// Tunnels connect from loopback too, so a local socket alone doesn't prove someone is at the PC.
function isLocalRequest(req) {
  if (!isLoopback(req.socket.remoteAddress || '')) return false;
  for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'cf-ray']) {
    if (req.headers[h]) return false;
  }
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function isHttps(req) {
  return isLoopback(req.socket.remoteAddress || '') && req.headers['x-forwarded-proto'] === 'https';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch {
        reject(new HttpError(400, 'Malformed request.'));
      }
    });
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function setCookie(req, res, name, value, maxAge) {
  const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isHttps(req)) attrs.push('Secure');
  const previous = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...previous, attrs.join('; ')]);
}

function str(value, label = 'value') {
  if (typeof value !== 'string') throw new HttpError(400, `Missing ${label}.`);
  return value;
}

function checkPasswordStrength(p) {
  if (typeof p !== 'string' || p.length < 12) throw new HttpError(400, 'Use a password of at least 12 characters.');
  if (p.length > 512) throw new HttpError(400, 'That password is too long.');
}

const noRoot = (p) => {
  if (!p.parts.length) throw new HttpError(400, 'Your home folder cannot be changed.');
  return p;
};

// ---- Sessions -----------------------------------------------------------------------------

function loadSession(req) {
  const token = cookie(req, 'attic_sid');
  if (!token) return null;
  const hash = sha256(token);
  if (!Object.hasOwn(db.data.sessions, hash)) return null;
  const session = db.data.sessions[hash];
  const user = db.user(session.user);
  // Removing an email from the allowlist (and restarting) signs that person out everywhere.
  if (!user || !user.pass || !isAllowed(user.name) || session.exp < Date.now()) {
    delete db.data.sessions[hash];
    db.save();
    return null;
  }
  if (Date.now() - session.seen > 600000) {
    session.seen = Date.now();
    session.exp = Date.now() + SESSION_TTL;
    session.ip = clientIp(req);
    db.save();
  }
  return { hash, session, user };
}

function startSession(c, user) {
  const token = randomToken();
  db.data.sessions[sha256(token)] = {
    user: user.name,
    created: Date.now(),
    seen: Date.now(),
    exp: Date.now() + SESSION_TTL,
    ip: c.ip,
    ua: String(c.req.headers['user-agent'] || '').slice(0, 200),
  };
  db.save();
  setCookie(c.req, c.res, 'attic_sid', token, SESSION_TTL / 1000);
}

function endSessions(username, exceptHash) {
  for (const [hash, s] of Object.entries(db.data.sessions)) {
    if (s.user === username && hash !== exceptHash) delete db.data.sessions[hash];
  }
}

// ---- Router -------------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, opts });
}

const open = { public: true };
const admin = { admin: true };

// ---- Accounts -----------------------------------------------------------------------------

route('GET', '/api/me', (c) => ({
  setupNeeded: ALLOWED.size === 0,
  local: c.local,
  user: c.auth ? { name: c.auth.user.name, admin: isAdmin(c.auth.user.name), totp: Boolean(c.auth.user.totp && c.auth.user.totp.enabled) } : null,
}), open);

const readEmail = (b) => String(b.email || '').trim().toLowerCase().slice(0, 254);
// An allowed email with no password yet: whoever signs in first with it chooses the password.
const unclaimed = (email) => isAllowed(email) && !(db.user(email) && db.user(email).pass);

route('POST', '/api/claim', async (c) => {
  const b = await c.body();
  const email = readEmail(b);
  const key = `ip:${c.ip}`;
  if (!c.local) limiter.check(key);
  if (!unclaimed(email)) {
    if (!c.local) limiter.fail(key);
    throw new HttpError(409, 'This account already has a password. Sign in instead.');
  }
  checkPasswordStrength(b.password);
  const pass = await hashPassword(b.password);
  // Re-check after the slow hash so two simultaneous first sign-ins can't both win.
  if (!unclaimed(email)) throw new HttpError(409, 'This account already has a password. Sign in instead.');
  const user = db.user(email) || { name: email, created: Date.now() };
  user.pass = pass;
  delete user.totp;
  db.data.users[email] = user;
  await fsp.mkdir(userRoot(email), { recursive: true });
  startSession(c, user);
  return { ok: true };
}, open);

route('POST', '/api/login', async (c) => {
  const b = await c.body();
  const name = readEmail(b);
  const password = String(b.password || '').slice(0, 512);
  const keys = c.local ? [] : [`ip:${c.ip}`, `user:${name}`];
  keys.forEach((k) => limiter.check(k));
  if (unclaimed(name)) return { needsPassword: true };
  const fail = () => {
    keys.forEach((k) => limiter.fail(k));
    return new HttpError(401, 'Wrong email or password.');
  };
  const user = isAllowed(name) ? db.user(name) : null;
  const good = await verifyPassword(password, user ? user.pass : await dummyHash);
  if (!user || !good) throw fail();
  if (user.totp && user.totp.enabled) {
    if (!b.code) return { needsCode: true };
    const counter = verifyTotp(user.totp.secret, b.code, user.totp.last);
    if (counter === null) {
      keys.forEach((k) => limiter.fail(k));
      throw new HttpError(401, 'That code did not match. Check your authenticator and try again.');
    }
    user.totp.last = counter;
  }
  keys.forEach((k) => limiter.reset(k));
  startSession(c, user);
  return { ok: true };
}, open);

route('POST', '/api/logout', (c) => {
  delete db.data.sessions[c.auth.hash];
  db.save();
  setCookie(c.req, c.res, 'attic_sid', '', 0);
  return { ok: true };
});

async function confirmPassword(c, user, password) {
  const key = `confirm:${user.name}`;
  if (!c.local) limiter.check(key);
  if (!(await verifyPassword(String(password || '').slice(0, 512), user.pass))) {
    if (!c.local) limiter.fail(key);
    throw new HttpError(403, 'Your current password was not correct.');
  }
  limiter.reset(key);
}

route('POST', '/api/account/password', async (c) => {
  const b = await c.body();
  await confirmPassword(c, c.auth.user, b.current);
  checkPasswordStrength(b.next);
  c.auth.user.pass = await hashPassword(b.next);
  endSessions(c.auth.user.name, c.auth.hash);
  db.save();
  return { ok: true };
});

route('POST', '/api/account/2fa/begin', async (c) => {
  const b = await c.body();
  await confirmPassword(c, c.auth.user, b.password);
  const u = c.auth.user;
  if (u.totp && u.totp.enabled) throw new HttpError(409, 'Two-step sign-in is already on.');
  const secret = newTotpSecret();
  u.totp = { secret, enabled: false };
  db.save();
  const uri = `otpauth://totp/Attic:${encodeURIComponent(u.name)}?secret=${secret}&issuer=Attic&digits=6&period=30`;
  return { secret, uri };
});

route('POST', '/api/account/2fa/enable', async (c) => {
  const b = await c.body();
  const u = c.auth.user;
  if (!u.totp || u.totp.enabled) throw new HttpError(409, 'Start two-step setup again.');
  const counter = verifyTotp(u.totp.secret, b.code);
  if (counter === null) throw new HttpError(400, 'That code did not match. Try the next one your app shows.');
  u.totp.enabled = true;
  u.totp.last = counter;
  endSessions(u.name, c.auth.hash);
  db.save();
  return { ok: true };
});

route('POST', '/api/account/2fa/disable', async (c) => {
  const b = await c.body();
  const u = c.auth.user;
  await confirmPassword(c, u, b.password);
  if (!u.totp || !u.totp.enabled) return { ok: true };
  if (verifyTotp(u.totp.secret, b.code, u.totp.last) === null) throw new HttpError(403, 'That code did not match.');
  delete u.totp;
  db.save();
  return { ok: true };
});

route('GET', '/api/account/sessions', (c) => ({
  sessions: Object.entries(db.data.sessions)
    .filter(([, s]) => s.user === c.auth.user.name)
    .map(([hash, s]) => ({ current: hash === c.auth.hash, ip: s.ip, ua: s.ua, seen: s.seen, created: s.created }))
    .sort((a, b) => b.seen - a.seen),
}));

route('POST', '/api/account/sessions/revoke-others', (c) => {
  endSessions(c.auth.user.name, c.auth.hash);
  db.save();
  return { ok: true };
});

// ---- People (admin) -----------------------------------------------------------------------

// Who can sign in is decided by allowedEmails in the config, so this page only shows and resets.
route('GET', '/api/users', () => ({
  users: [...ALLOWED].map((email) => {
    const u = db.user(email);
    return { name: email, admin: isAdmin(email), claimed: Boolean(u && u.pass), created: u ? u.created : null, totp: Boolean(u && u.totp && u.totp.enabled) };
  }),
}), admin);

// Clears the password: they choose a new one the next time they sign in.
route('POST', '/api/users/:name/reset', (c) => {
  const user = db.user(c.params.name);
  if (!user || !isAllowed(user.name)) throw new HttpError(404, 'No such user.');
  if (user.name === c.auth.user.name) throw new HttpError(400, 'Change your own password under Settings.');
  user.pass = '';
  delete user.totp;
  endSessions(user.name);
  db.save();
  return { ok: true };
}, admin);

// ---- Files --------------------------------------------------------------------------------

const here = (c, rel) => resolveSafe(userRoot(c.auth.user.name), rel);

async function listDir(full, prefix) {
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (e) => {
    if (e.isSymbolicLink() || !(e.isFile() || e.isDirectory())) return null;
    try {
      const st = await fsp.stat(path.join(full, e.name));
      return { name: e.name, rel: prefix ? `${prefix}/${e.name}` : e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? st.size : 0, mtime: st.mtimeMs };
    } catch {
      return null; // Removed while we were looking.
    }
  }));
  return items.filter(Boolean);
}

route('GET', '/api/list', async (c) => {
  const p = await here(c, c.q('path') || '');
  await fsp.mkdir(userRoot(c.auth.user.name), { recursive: true });
  const st = await fsp.stat(p.full);
  if (!st.isDirectory()) throw new HttpError(400, 'That is not a folder.');
  return { path: p.rel, items: await listDir(p.full, p.rel) };
});

route('GET', '/api/search', async (c) => {
  const needle = String(c.q('q') || '').toLowerCase();
  if (!needle) return { items: [] };
  const root = userRoot(c.auth.user.name);
  const results = [];
  const queue = [''];
  const deadline = Date.now() + 4000;
  while (queue.length && results.length < 200 && Date.now() < deadline) {
    const rel = queue.shift();
    let items;
    try { items = await listDir(path.join(root, ...rel.split('/').filter(Boolean)), rel); } catch { continue; }
    for (const item of items) {
      if (item.type === 'dir') queue.push(item.rel);
      if (item.name.toLowerCase().includes(needle) && results.length < 200) results.push(item);
    }
  }
  return { items: results };
});

const usageCache = new Map();
async function folderSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderSize(full);
    else if (e.isFile()) total += await fsp.stat(full).then((s) => s.size, () => 0);
  }
  return total;
}

async function diskFree() {
  const s = await fsp.statfs(config.storageDir);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

route('GET', '/api/usage', async (c) => {
  const name = c.auth.user.name;
  let hit = usageCache.get(name);
  if (!hit || hit.at < Date.now() - 30000) {
    hit = { at: Date.now(), used: await folderSize(userRoot(name)) };
    usageCache.set(name, hit);
  }
  return { used: hit.used, ...(await diskFree()) };
});

route('POST', '/api/mkdir', async (c) => {
  const b = await c.body();
  assertName(b.name);
  const p = await here(c, [str(b.path ?? '', 'path'), b.name].filter(Boolean).join('/'));
  if (await exists(p.full)) throw new HttpError(409, 'Something with that name already exists here.');
  await fsp.mkdir(p.full, { recursive: true });
  return { ok: true, rel: p.rel };
});

// Keeps share links pointing at the right place after a rename or move.
function repointShares(owner, from, to) {
  let changed = false;
  for (const s of Object.values(db.data.shares)) {
    if (s.owner !== owner) continue;
    if (s.path === from) {
      s.path = to;
      s.name = path.posix.basename(to);
      changed = true;
    } else if (s.path.startsWith(`${from}/`)) {
      s.path = to + s.path.slice(from.length);
      changed = true;
    }
  }
  if (changed) db.save();
}

function dropShares(owner, rel) {
  let changed = false;
  for (const [token, s] of Object.entries(db.data.shares)) {
    if (s.owner === owner && (s.path === rel || s.path.startsWith(`${rel}/`))) {
      delete db.data.shares[token];
      changed = true;
    }
  }
  if (changed) db.save();
}

route('POST', '/api/rename', async (c) => {
  const b = await c.body();
  assertName(b.name);
  const from = noRoot(await here(c, str(b.path, 'path')));
  const to = await here(c, [...from.parts.slice(0, -1), b.name].join('/'));
  const caseOnly = from.full.toLowerCase() === to.full.toLowerCase();
  if (!caseOnly && await exists(to.full)) throw new HttpError(409, 'Something with that name already exists here.');
  await fsp.rename(from.full, to.full);
  repointShares(c.auth.user.name, from.rel, to.rel);
  return { ok: true, rel: to.rel };
});

function pathList(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5000) throw new HttpError(400, 'Nothing selected.');
  return value;
}

route('POST', '/api/move', async (c) => {
  const b = await c.body();
  const dest = await here(c, b.dest ?? '');
  const st = await fsp.stat(dest.full);
  if (!st.isDirectory()) throw new HttpError(400, 'Choose a folder to move into.');
  for (const item of pathList(b.paths)) {
    const from = noRoot(await here(c, str(item, 'path')));
    if (dest.rel === from.rel || dest.rel.startsWith(`${from.rel}/`)) throw new HttpError(400, 'A folder cannot be moved inside itself.');
    const wanted = path.join(dest.full, from.parts[from.parts.length - 1]);
    if (wanted === from.full) continue;
    const target = await uniquePath(wanted);
    await fsp.rename(from.full, target);
    repointShares(c.auth.user.name, from.rel, [dest.rel, path.basename(target)].filter(Boolean).join('/'));
  }
  return { ok: true };
});

route('POST', '/api/delete', async (c) => {
  const b = await c.body();
  const owner = c.auth.user.name;
  await fsp.mkdir(trashRoot(owner), { recursive: true });
  for (const item of pathList(b.paths)) {
    const p = noRoot(await here(c, str(item, 'path')));
    const st = await fsp.lstat(p.full);
    const id = crypto.randomBytes(12).toString('hex');
    const meta = { id, name: p.parts[p.parts.length - 1], from: p.rel, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0, deleted: Date.now() };
    await fsp.writeFile(path.join(trashRoot(owner), `${id}.json`), JSON.stringify(meta));
    await fsp.rename(p.full, path.join(trashRoot(owner), id));
    dropShares(owner, p.rel);
  }
  return { ok: true };
});

async function readTrash(owner) {
  const dir = trashRoot(owner);
  const names = await fsp.readdir(dir).catch(() => []);
  const metas = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => fsp.readFile(path.join(dir, n), 'utf8').then(JSON.parse).catch(() => null)));
  return metas.filter(Boolean).sort((a, b) => b.deleted - a.deleted);
}

function trashId(id) {
  if (!/^[0-9a-f]{24}$/.test(String(id))) throw new HttpError(400, 'Invalid item.');
  return id;
}

async function purgeTrashItem(owner, id) {
  await fsp.rm(path.join(trashRoot(owner), id), { recursive: true, force: true, maxRetries: 3 });
  await fsp.rm(path.join(trashRoot(owner), `${id}.json`), { force: true });
}

route('GET', '/api/trash', async (c) => ({ items: await readTrash(c.auth.user.name), days: config.trashDays }));

route('POST', '/api/trash/restore', async (c) => {
  const b = await c.body();
  const owner = c.auth.user.name;
  const dir = trashRoot(owner);
  for (const raw of pathList(b.ids)) {
    const id = trashId(raw);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8'));
    const dest = await here(c, meta.from);
    await fsp.mkdir(path.dirname(dest.full), { recursive: true });
    await fsp.rename(path.join(dir, id), await uniquePath(dest.full));
    await fsp.rm(path.join(dir, `${id}.json`), { force: true });
  }
  return { ok: true };
});

route('POST', '/api/trash/purge', async (c) => {
  const b = await c.body();
  const owner = c.auth.user.name;
  const ids = b.all ? (await readTrash(owner)).map((m) => m.id) : pathList(b.ids).map(trashId);
  for (const id of ids) await purgeTrashItem(owner, id);
  return { ok: true };
});

// ---- Sending files ------------------------------------------------------------------------

const TEXT_EXT = 'txt md markdown log csv tsv json jsonl xml yml yaml toml ini conf cfg env js mjs cjs ts tsx jsx py rb go rs java c h cpp hpp cs php sh bat ps1 sql html htm css scss svg';
const INLINE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  pdf: 'application/pdf',
};
for (const ext of TEXT_EXT.split(' ')) INLINE[ext] = 'text/plain; charset=utf-8';

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`)}`;
}

// Uploaded files are hostile until proven otherwise. Only an allow-list renders inline, HTML and
// SVG are always plain text, and the sandbox CSP stops any file running script on Attic's origin.
function fileHeaders(res, name, inline) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = inline && Object.hasOwn(INLINE, ext) ? INLINE[ext] : null;
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(type ? 'inline' : 'attachment', name));
  if (type === 'application/pdf') {
    // Browser PDF viewers refuse to run under a sandbox CSP.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'");
  }
}

async function sendFile(req, res, full, name, inline) {
  const st = await fsp.stat(full);
  fileHeaders(res, name, inline);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', st.mtime.toUTCString());
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range && (!ifRange || ifRange === etag) && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
      } else {
        start = Math.max(st.size - Number(m[2]), 0);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
  }
  res.setHeader('Content-Length', st.size === 0 ? 0 : end - start + 1);
  res.writeHead(status);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  try {
    await pipeline(fs.createReadStream(full, { start, end, highWaterMark: 1 << 20 }), res);
  } catch (e) {
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  }
}

async function sendZip(res, targets, filename) {
  const entries = [];
  for (const t of targets) await collect(t.full, t.name, entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', filename),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  try {
    await writeZip(res, entries);
    res.end();
  } catch {
    res.destroy(); // Headers are gone, so a broken connection is the only honest signal.
  }
}

route('GET', '/api/file', async (c) => {
  const p = noRoot(await here(c, str(c.q('path'), 'path')));
  const st = await fsp.stat(p.full);
  const name = p.parts[p.parts.length - 1];
  if (st.isDirectory()) return sendZip(c.res, [{ full: p.full, name }], `${name}.zip`);
  return sendFile(c.req, c.res, p.full, name, c.q('inline') === '1');
});

route('GET', '/api/zip', async (c) => {
  const list = pathList(c.url.searchParams.getAll('p'));
  const targets = [];
  for (const rel of list) {
    const p = noRoot(await here(c, rel));
    targets.push({ full: p.full, name: p.parts[p.parts.length - 1] });
  }
  return sendZip(c.res, targets, targets.length === 1 ? `${targets[0].name}.zip` : 'attic-files.zip');
});

// ---- Uploads ------------------------------------------------------------------------------
// Files arrive in chunks and the server's byte count is the source of truth, so a dropped
// connection, or picking the same file again later, continues where it stopped.

const activeChunks = new Set();
const uploadFiles = (id) => ({ meta: path.join(UPLOAD_DIR, `${id}.json`), part: path.join(UPLOAD_DIR, `${id}.part`) });

async function loadUpload(id, owner) {
  if (!/^[0-9a-f]{40}$/.test(String(id))) throw new HttpError(400, 'Invalid upload.');
  const { meta } = uploadFiles(id);
  let value;
  try {
    value = JSON.parse(await fsp.readFile(meta, 'utf8'));
  } catch {
    throw new HttpError(404, 'That upload no longer exists.');
  }
  if (value.owner !== owner) throw new HttpError(404, 'That upload no longer exists.');
  return value;
}

// One at a time, so two uploads with the same name can't both claim it.
let finishQueue = Promise.resolve();
function finishUpload(meta) {
  const job = finishQueue.then(async () => {
    const root = userRoot(meta.owner);
    const dir = await resolveSafe(root, meta.dir);
    const dest = await resolveSafe(root, [dir.rel, meta.name].filter(Boolean).join('/'));
    await fsp.mkdir(dir.full, { recursive: true });
    const { part, meta: metaFile } = uploadFiles(meta.id);
    const target = await uniquePath(dest.full);
    await fsp.rename(part, target);
    await fsp.rm(metaFile, { force: true });
    if (meta.mtime > 0) await fsp.utimes(target, new Date(), new Date(meta.mtime)).catch(() => {});
    usageCache.delete(meta.owner);
    return path.relative(root, target).split(path.sep).join('/');
  });
  finishQueue = job.catch(() => {});
  return job;
}

route('POST', '/api/uploads', async (c) => {
  const b = await c.body();
  assertName(b.name);
  const owner = c.auth.user.name;
  const dir = await here(c, b.dir ?? '');
  await here(c, [dir.rel, b.name].filter(Boolean).join('/'));
  const size = Number(b.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Invalid file size.');
  const mtime = Number(b.mtime) || 0;
  const id = sha256(`${owner}\0${dir.rel}\0${b.name}\0${size}\0${mtime}`).slice(0, 40);
  const files = uploadFiles(id);

  let meta;
  if (await exists(files.meta)) {
    meta = await loadUpload(id, owner);
  } else {
    const { free } = await diskFree();
    if (free - size < config.reserveBytes) throw new HttpError(507, 'There is not enough free space on this PC for that file.');
    meta = { id, owner, dir: dir.rel, name: b.name, size, mtime, created: Date.now() };
    await fsp.writeFile(files.part, '');
    await fsp.writeFile(files.meta, JSON.stringify(meta));
  }
  if (size === 0) return { id, done: true, rel: await finishUpload(meta) };
  const { size: offset } = await fsp.stat(files.part);
  return { id, offset, chunkSize: CHUNK_SIZE };
});

route('PUT', '/api/uploads/:id', async (c) => {
  const owner = c.auth.user.name;
  const meta = await loadUpload(c.params.id, owner);
  if (activeChunks.has(meta.id)) throw new HttpError(409, 'This file is already uploading in another tab.');
  activeChunks.add(meta.id);
  const { part } = uploadFiles(meta.id);
  try {
    const current = (await fsp.stat(part)).size;
    if (Number(c.q('offset')) !== current) {
      c.req.resume();
      return c.send(409, { error: 'Out of sync.', offset: current });
    }
    const max = Math.min(CHUNK_MAX, meta.size - current);
    if (Number(c.req.headers['content-length'] || 0) > max) throw new HttpError(413, 'Chunk too large.');
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > max) cb(new HttpError(413, 'Chunk too large.'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(c.req, counter, fs.createWriteStream(part, { flags: 'a' }));
    } catch (e) {
      await fsp.truncate(part, current).catch(() => {});
      if (e.code === 'ENOSPC') throw new HttpError(507, 'This PC ran out of disk space.');
      throw e;
    }
    const offset = current + received;
    if (offset < meta.size) return { offset };
    return { offset, done: true, rel: await finishUpload(meta) };
  } finally {
    activeChunks.delete(meta.id);
  }
});

route('DELETE', '/api/uploads/:id', async (c) => {
  const meta = await loadUpload(c.params.id, c.auth.user.name);
  if (activeChunks.has(meta.id)) throw new HttpError(409, 'Upload is still running.');
  const files = uploadFiles(meta.id);
  await fsp.rm(files.part, { force: true });
  await fsp.rm(files.meta, { force: true });
  return { ok: true };
});

// ---- Share links --------------------------------------------------------------------------

const shareCookieName = (token) => `attic_s_${sha256(token).slice(0, 12)}`;
const shareProof = (token, share) => crypto.createHmac('sha256', db.data.secret).update(`${token}\0${share.pass}`).digest('hex');

function getShare(token) {
  if (!Object.hasOwn(db.data.shares, token)) throw new HttpError(404, 'This link does not exist or has expired.');
  const share = db.data.shares[token];
  if ((share.exp && share.exp < Date.now()) || !db.user(share.owner) || !isAllowed(share.owner)) throw new HttpError(404, 'This link does not exist or has expired.');
  return share;
}

function shareOpen(c, token, share) {
  return !share.pass || safeEqual(cookie(c.req, shareCookieName(token)), shareProof(token, share));
}

function requireShare(c) {
  const share = getShare(c.params.token);
  if (!shareOpen(c, c.params.token, share)) throw new HttpError(403, 'Password required.');
  return share;
}

const shareTarget = (share, sub) => resolveSafe(userRoot(share.owner), [share.path, sub].filter(Boolean).join('/'));

route('GET', '/api/shares', async (c) => {
  const owner = c.auth.user.name;
  return {
    shares: Object.entries(db.data.shares)
      .filter(([, s]) => s.owner === owner && (!s.exp || s.exp > Date.now()))
      .map(([token, s]) => ({ token, path: s.path, name: s.name, type: s.type, exp: s.exp, locked: Boolean(s.pass), downloads: s.downloads || 0, created: s.created }))
      .sort((a, b) => b.created - a.created),
  };
});

route('POST', '/api/shares', async (c) => {
  const b = await c.body();
  const p = noRoot(await here(c, str(b.path, 'path')));
  const st = await fsp.stat(p.full);
  const days = Number(b.days) || 0;
  if (days < 0 || days > 3650) throw new HttpError(400, 'Invalid expiry.');
  if (b.password && (typeof b.password !== 'string' || b.password.length > 512)) throw new HttpError(400, 'Invalid password.');
  const token = randomToken(18);
  db.data.shares[token] = {
    owner: c.auth.user.name,
    path: p.rel,
    name: p.parts[p.parts.length - 1],
    type: st.isDirectory() ? 'dir' : 'file',
    exp: days ? Date.now() + days * DAY : 0,
    pass: b.password ? await hashPassword(b.password) : '',
    downloads: 0,
    created: Date.now(),
  };
  db.save();
  return { token };
});

route('DELETE', '/api/shares/:token', (c) => {
  const token = c.params.token;
  if (!Object.hasOwn(db.data.shares, token) || db.data.shares[token].owner !== c.auth.user.name) throw new HttpError(404, 'No such link.');
  delete db.data.shares[token];
  db.save();
  return { ok: true };
});

route('GET', '/api/s/:token', async (c) => {
  const share = getShare(c.params.token);
  if (!shareOpen(c, c.params.token, share)) return { locked: true };
  const sub = c.q('path') || '';
  const p = await shareTarget(share, sub);
  const st = await fsp.stat(p.full);
  const base = { name: share.name, exp: share.exp };
  if (st.isFile()) return { ...base, type: 'file', size: st.size, mtime: st.mtimeMs };
  const items = await listDir(p.full, '');
  const prefix = p.parts.slice(share.path.split('/').length).join('/');
  return { ...base, type: 'dir', path: prefix, items: items.map((i) => ({ ...i, rel: prefix ? `${prefix}/${i.name}` : i.name })) };
}, open);

route('POST', '/api/s/:token/unlock', async (c) => {
  const token = c.params.token;
  const share = getShare(token);
  const key = `share:${c.ip}`;
  if (!c.local) limiter.check(key);
  const b = await c.body();
  if (!share.pass || !(await verifyPassword(String(b.password || '').slice(0, 512), share.pass))) {
    if (!c.local) limiter.fail(key);
    throw new HttpError(403, 'That password is not right.');
  }
  limiter.reset(key);
  setCookie(c.req, c.res, shareCookieName(token), shareProof(token, share), 86400);
  return { ok: true };
}, open);

route('GET', '/api/s/:token/file', async (c) => {
  const share = requireShare(c);
  const p = await shareTarget(share, c.q('path') || '');
  const st = await fsp.stat(p.full);
  const name = p.parts[p.parts.length - 1];
  if (c.q('inline') !== '1' && !c.req.headers.range) {
    share.downloads = (share.downloads || 0) + 1;
    db.save();
  }
  if (st.isDirectory()) return sendZip(c.res, [{ full: p.full, name }], `${name}.zip`);
  return sendFile(c.req, c.res, p.full, name, c.q('inline') === '1');
}, open);

// ---- Remote access ------------------------------------------------------------------------

route('GET', '/api/public-url', async () => ({ url: await remote.publicUrl() }));
route('GET', '/api/remote', () => remote.status(), admin);
route('POST', '/api/remote', async (c) => {
  const b = await c.body();
  const result = await remote.set(String(b.provider), Boolean(b.on));
  return { ...result, ...(await remote.status()) };
}, admin);

// ---- Web interface and request handling ---------------------------------------------------

const PUBLIC = path.join(config.root, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/share.js': ['share.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function serveStatic(req, res, file, type) {
  const body = await fsp.readFile(path.join(PUBLIC, file));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  let url;
  try {
    url = new URL(req.url, 'http://attic.invalid');
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && Object.hasOwn(STATIC, pathname)) return serveStatic(req, res, ...STATIC[pathname]);
  if (isRead && /^\/s\/[A-Za-z0-9_-]+$/.test(pathname)) return serveStatic(req, res, 'share.html', 'text/html; charset=utf-8');

  for (const r of routes) {
    if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
    const match = r.re.exec(pathname);
    if (!match) continue;

    // A custom header can't be sent cross-site without a CORS approval this server never gives.
    if (!isRead && req.headers['x-attic'] !== '1') throw new HttpError(403, 'Request blocked.');

    const params = {};
    try {
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
    } catch {
      throw new HttpError(400, 'Bad request.');
    }
    const auth = loadSession(req);
    if (!r.opts.public && !auth) throw new HttpError(401, 'Please sign in.');
    if (r.opts.admin && !isAdmin(auth.user.name)) throw new HttpError(403, 'Only an admin can do that.');

    const ctx = {
      req, res, url, params, auth,
      ip: clientIp(req),
      local: isLocalRequest(req),
      q: (name) => url.searchParams.get(name),
      body: () => readJson(req),
      send: (status, value) => json(res, status, value),
    };
    const result = await r.handler(ctx);
    if (result !== undefined && !res.writableEnded && !res.headersSent) json(res, 200, result);
    return undefined;
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (!req.complete) req.resume();
    if (e instanceof HttpError) {
      if (e.extra && e.extra.retryAfter) res.setHeader('Retry-After', e.extra.retryAfter);
      json(res, e.status, { error: e.message });
    } else if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      json(res, 404, { error: 'That item no longer exists.' });
    } else if (e.code === 'ENOSPC') {
      json(res, 507, { error: 'This PC ran out of disk space.' });
    } else if (e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET') {
      res.destroy();
    } else {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url.split('?')[0]}:`, e);
      json(res, 500, { error: 'Something went wrong on the server.' });
    }
  });
});
server.requestTimeout = 15 * 60000;
server.headersTimeout = 30000;

async function housekeeping() {
  const now = Date.now();
  let changed = false;
  for (const [hash, s] of Object.entries(db.data.sessions)) if (s.exp < now) { delete db.data.sessions[hash]; changed = true; }
  for (const [token, s] of Object.entries(db.data.shares)) if (s.exp && s.exp < now) { delete db.data.shares[token]; changed = true; }
  if (changed) db.save();
  for (const name of Object.keys(db.data.users)) {
    for (const m of await readTrash(name)) {
      if (m.deleted < now - config.trashDays * DAY) await purgeTrashItem(name, m.id).catch(() => {});
    }
  }
  for (const f of await fsp.readdir(UPLOAD_DIR).catch(() => [])) {
    const full = path.join(UPLOAD_DIR, f);
    const st = await fsp.stat(full).catch(() => null);
    if (st && st.mtimeMs < now - 7 * DAY) await fsp.rm(full, { force: true }).catch(() => {});
  }
}

async function resetAccount(name) {
  const user = db.user(String(name || '').trim().toLowerCase());
  if (!user || !user.pass) {
    console.error(`No signed-up account for "${name}". Signed-up: ${Object.keys(db.data.users).filter((n) => db.user(n).pass).join(', ') || '(none)'}`);
    process.exit(1);
  }
  const password = randomToken(15);
  user.pass = await hashPassword(password);
  delete user.totp;
  endSessions(user.name);
  db.save();
  console.log(`Password for ${user.name} reset, and two-step sign-in turned off.\nNew password: ${password}\nSign in and change it under Settings.`);
}

if (process.argv[2] === 'reset') {
  resetAccount(process.argv[3]).then(() => process.exit(0));
} else {
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Is Attic already running?` : e.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`Attic is running.\n  This PC:  http://localhost:${config.port}\n  Files in: ${config.storageDir}`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
      console.log(`  WARNING:  listening on ${config.host} without HTTPS. Use this only on a network you trust.`);
    }
    remote.resume();
    housekeeping().catch(console.error);
    setInterval(() => housekeeping().catch(console.error), 3600000).unref();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

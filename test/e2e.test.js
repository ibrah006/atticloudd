'use strict';
// Runs a real server against a throwaway folder and exercises it the way a browser or attacker would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { totpAt } = require('../lib/security');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-test-'));
const dataDir = path.join(tmp, 'data');
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_PW = crypto.randomBytes(12).toString('hex');
const MEMBER_PW = crypto.randomBytes(12).toString('hex');
let proc;

// cloudflared stand-in: the server runs `<bin> tunnel ...` and node happily executes ./tunnel.
fs.writeFileSync(path.join(tmp, 'tunnel'), "console.error('INF |  https://fake-quick.trycloudflare.com  |'); setInterval(()=>{},1000);");

class Client {
  constructor(ip) {
    this.cookies = {};
    this.ip = ip;
  }

  async req(method, url, { body, headers = {}, raw, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf) h['X-Attic'] = '1';
    if (this.ip) h['CF-Connecting-IP'] = this.ip;
    const jar = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) h.Cookie = jar;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  }

  async json(method, url, opts) {
    const res = await this.req(method, url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
  }

  get(url) { return this.json('GET', url); }
  post(url, body) { return this.json('POST', url, { body }); }

  async upload(dir, name, buffer, chunk = 8 * 1024 * 1024) {
    const init = await this.post('/api/uploads', { dir, name, size: buffer.length, mtime: 1700000000000 });
    assert.equal(init.status, 200, JSON.stringify(init.data));
    let offset = init.data.offset ?? 0;
    let last = init.data;
    while (offset < buffer.length) {
      const put = await this.json('PUT', `/api/uploads/${init.data.id}?offset=${offset}`, { raw: buffer.subarray(offset, offset + chunk) });
      assert.equal(put.status, 200, JSON.stringify(put.data));
      offset = put.data.offset;
      last = put.data;
    }
    return last;
  }
}

const owner = new Client();
const member = new Client();

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), `--data=${dataDir}`, `--port=${PORT}`], {
    cwd: tmp,
    env: { ...process.env, ATTIC_CLOUDFLARED: process.execPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      await new Promise((r) => { setTimeout(r, 100); });
    }
  }
  throw new Error('server did not start');
});

test.after(async () => {
  proc.kill();
  await new Promise((r) => { setTimeout(r, 300); });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

// Tests run in order: later ones rely on accounts and files created earlier.

test('setup cannot be claimed through a tunnel', async () => {
  const body = { username: 'evil', password: 'x'.repeat(20) };
  for (const headers of [{ 'CF-Connecting-IP': '8.8.8.8' }, { 'X-Forwarded-For': '8.8.8.8' }, { 'Tailscale-User-Login': 'a@b.c' }]) {
    assert.equal((await new Client().json('POST', '/api/setup', { body, headers })).status, 403);
  }
  // fetch won't send a custom Host, so this one goes over a raw request.
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ port: PORT, method: 'POST', path: '/api/setup', headers: { Host: 'evil.example.com', 'X-Attic': '1', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
  assert.equal(status, 403);
  assert.equal((await owner.get('/api/me')).data.setupNeeded, true);
});

test('setup rejects weak passwords, then works once', async () => {
  assert.equal((await owner.post('/api/setup', { username: 'owner', password: 'short' })).status, 400);
  assert.equal((await owner.post('/api/setup', { username: 'owner', password: OWNER_PW })).status, 200);
  assert.equal((await new Client().post('/api/setup', { username: 'second', password: OWNER_PW })).status, 409);
  const me = await owner.get('/api/me');
  assert.equal(me.data.user.name, 'owner');
  assert.equal(me.data.user.admin, true);
});

test('session cookie is locked down', async () => {
  const c = new Client();
  const res = await c.req('POST', '/api/login', { body: { username: 'owner', password: OWNER_PW } });
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/); // plain localhost
  const viaTunnel = await new Client('9.9.9.1').req('POST', '/api/login', { body: { username: 'owner', password: OWNER_PW }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(viaTunnel.headers.getSetCookie()[0], /Secure/);
  assert.ok(viaTunnel.headers.get('strict-transport-security'));
});

test('anonymous requests and forged cross-site writes are refused', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/list')).status, 401);
  assert.equal((await anon.get('/api/file?path=a')).status, 401);
  assert.equal((await anon.get('/api/remote')).status, 401);
  assert.equal((await owner.json('POST', '/api/mkdir', { body: { name: 'csrf' }, csrf: false })).status, 403);
  assert.equal((await owner.get('/api/list')).data.items.some((i) => i.name === 'csrf'), false);
});

test('app source and database are not served', async () => {
  for (const url of ['/server.js', '/data/db.json', '/lib/security.js', '/attic.config.json', '/..%2fserver.js', '/public/app.js', '/%2e%2e/%2e%2e/server.js']) {
    const res = await new Client().req('GET', url);
    assert.equal(res.status, 404, url);
  }
});

test('hostile paths are rejected everywhere', async () => {
  const secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, 'top secret');
  const attacks = [
    '../secret.txt', '../../secret.txt', '..\\secret.txt', 'a/../../secret.txt', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini',
    '\\\\127.0.0.1\\c$\\Windows\\win.ini', 'CON', 'nul.txt', 'COM1', 'a.txt.', 'a.txt ', 'a.txt::$DATA', 'file:stream', 'a\0b', '..',
  ];
  for (const p of attacks) {
    const url = encodeURIComponent(p);
    assert.equal((await owner.get(`/api/file?path=${url}`)).status, 400, `file ${p}`);
    assert.equal((await owner.get(`/api/list?path=${url}`)).status, 400, `list ${p}`);
    assert.equal((await owner.post('/api/delete', { paths: [p] })).status, 400, `delete ${p}`);
    assert.equal((await owner.post('/api/uploads', { dir: p, name: 'x.txt', size: 1 })).status, 400, `upload dir ${p}`);
    assert.equal((await owner.post('/api/shares', { path: p })).status, 400, `share ${p}`);
  }
  for (const name of ['../x', 'a/b', 'a\\b', 'CON', 'x:y', 'a.', '']) {
    assert.equal((await owner.post('/api/mkdir', { path: '', name })).status, 400, `mkdir ${name}`);
    assert.equal((await owner.post('/api/uploads', { dir: '', name, size: 1 })).status, 400, `upload ${name}`);
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'top secret');
});

test('links and junctions planted in storage are not followed', async () => {
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'nope');
  const root = path.join(dataDir, 'storage', 'users', 'owner');
  fs.symlinkSync(outside, path.join(root, 'jump'), 'junction');
  assert.equal((await owner.get('/api/file?path=jump/private.txt')).status, 403);
  assert.equal((await owner.get('/api/list?path=jump')).status, 403);
  assert.equal((await owner.get('/api/list')).data.items.some((i) => i.name === 'jump'), false);
  const zip = await owner.req('GET', '/api/zip?p=jump');
  assert.equal(zip.status, 403);
  fs.rmSync(path.join(root, 'jump'));
});

let bigFile;

test('chunked upload arrives intact and handles protocol abuse', async () => {
  bigFile = crypto.randomBytes(20 * 1024 * 1024 + 123);
  const init = await owner.post('/api/uploads', { dir: 'media/2026', name: 'big.bin', size: bigFile.length, mtime: 1700000000000 });
  assert.equal(init.status, 200);
  const { id, chunkSize } = init.data;

  const put = (offset, raw) => owner.json('PUT', `/api/uploads/${id}?offset=${offset}`, { raw });
  assert.equal((await put(0, bigFile.subarray(0, chunkSize))).data.offset, chunkSize);

  // A retry of a chunk the server already stored must not double-write it.
  const stale = await put(0, bigFile.subarray(0, chunkSize));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.offset, chunkSize);

  // Picking the same file again resumes instead of restarting.
  assert.equal((await owner.post('/api/uploads', { dir: 'media/2026', name: 'big.bin', size: bigFile.length, mtime: 1700000000000 })).data.offset, chunkSize);

  // More data than the file declared is refused and leaves the partial file untouched.
  assert.equal((await put(chunkSize, Buffer.alloc(bigFile.length))).status, 413);

  assert.equal((await member.json('PUT', `/api/uploads/${id}?offset=${chunkSize}`, { raw: Buffer.alloc(1) })).status, 401);

  let offset = chunkSize;
  let last;
  while (offset < bigFile.length) {
    last = await put(offset, bigFile.subarray(offset, offset + chunkSize));
    assert.equal(last.status, 200);
    offset = last.data.offset;
  }
  assert.equal(last.data.rel, 'media/2026/big.bin');

  const down = await owner.req('GET', '/api/file?path=media/2026/big.bin');
  const got = Buffer.from(await down.arrayBuffer());
  assert.equal(sha(got), sha(bigFile));
  assert.match(down.headers.get('content-disposition'), /attachment/);
  const listed = (await owner.get('/api/list?path=media/2026')).data.items[0];
  assert.equal(listed.mtime, 1700000000000);
});

function sha(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

test('an upload cut off mid-chunk can be resumed', async () => {
  const data = crypto.randomBytes(1024 * 1024);
  const init = await owner.post('/api/uploads', { dir: '', name: 'cut.bin', size: data.length, mtime: 5 });
  await new Promise((resolve) => {
    const r = http.request({
      port: PORT, method: 'PUT', path: `/api/uploads/${init.data.id}?offset=0`,
      headers: { 'X-Attic': '1', Cookie: `attic_sid=${owner.cookies.attic_sid}`, 'Content-Length': data.length },
    });
    r.on('error', () => resolve());
    r.write(data.subarray(0, 1000), () => setTimeout(() => { r.destroy(); resolve(); }, 150));
  });
  await new Promise((r) => { setTimeout(r, 250); });
  const again = await owner.post('/api/uploads', { dir: '', name: 'cut.bin', size: data.length, mtime: 5 });
  assert.equal(again.data.offset, 0);
  await owner.upload('', 'cut.bin', data);
  const got = Buffer.from(await (await owner.req('GET', '/api/file?path=cut.bin')).arrayBuffer());
  assert.equal(sha(got), sha(data));
  await owner.post('/api/delete', { paths: ['cut.bin'] });
});

test('same-name uploads never overwrite; empty files work', async () => {
  await owner.upload('', 'dup.txt', Buffer.from('first'));
  const second = await owner.upload('', 'dup.txt', Buffer.from('other'));
  assert.equal(second.rel, 'dup (1).txt');
  assert.equal(await (await owner.req('GET', '/api/file?path=dup.txt')).text(), 'first');
  const empty = await owner.post('/api/uploads', { dir: '', name: 'empty.txt', size: 0, mtime: 9 });
  assert.equal(empty.data.done, true);
  const res = await owner.req('GET', '/api/file?path=empty.txt');
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('range requests support video seeking and resumable downloads', async () => {
  const url = '/api/file?path=media/2026/big.bin';
  const part = await owner.req('GET', url, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${bigFile.length}`);
  assert.equal(sha(Buffer.from(await part.arrayBuffer())), sha(bigFile.subarray(1000, 2000)));
  const tail = await owner.req('GET', url, { headers: { Range: 'bytes=-10' } });
  assert.equal(sha(Buffer.from(await tail.arrayBuffer())), sha(bigFile.subarray(bigFile.length - 10)));
  assert.equal((await owner.req('GET', url, { headers: { Range: `bytes=${bigFile.length}-` } })).status, 416);
});

test('uploaded files cannot execute in the Attic origin', async () => {
  const payload = '<script>fetch("/api/shares")</script>';
  for (const name of ['evil.html', 'evil.svg', 'evil.xhtml', 'evil.mhtml', 'evil.xml']) {
    await owner.upload('', name, Buffer.from(payload));
    for (const q of ['', '&inline=1']) {
      const res = await owner.req('GET', `/api/file?path=${name}${q}`);
      await res.arrayBuffer();
      assert.doesNotMatch(res.headers.get('content-type'), /html|svg|xml/, `${name}${q}`);
      assert.match(res.headers.get('content-security-policy'), /sandbox/, `${name}${q}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  }
});

test('a hostile filename cannot inject response headers', async () => {
  const name = "it's %0d%0aSet-Cookie; x=1 é日本.txt";
  await owner.upload('', name, Buffer.from('a'));
  const res = await owner.req('GET', `/api/file?path=${encodeURIComponent(name)}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-disposition').includes("filename*=UTF-8''it%27s%20%250d%250aSet-Cookie"));
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.equal((res.headers.get('content-disposition').match(/"/g) || []).length, 2);
});

test('rename, move, trash and restore', async () => {
  assert.equal((await owner.post('/api/mkdir', { path: '', name: 'docs' })).status, 200);
  assert.equal((await owner.post('/api/mkdir', { path: '', name: 'docs' })).status, 409);
  await owner.post('/api/mkdir', { path: 'docs', name: 'inner' });
  await owner.upload('docs', 'a.txt', Buffer.from('hello'));
  assert.equal((await owner.post('/api/rename', { path: 'docs/a.txt', name: 'b.txt' })).status, 200);
  assert.equal((await owner.post('/api/rename', { path: 'docs/b.txt', name: 'B.txt' })).status, 200);
  assert.equal((await owner.post('/api/rename', { path: 'docs/B.txt', name: 'inner' })).status, 409);
  assert.equal((await owner.post('/api/move', { paths: ['docs'], dest: 'docs/inner' })).status, 400);
  assert.equal((await owner.post('/api/move', { paths: ['docs/B.txt'], dest: 'docs/inner' })).status, 200);
  assert.equal(await (await owner.req('GET', '/api/file?path=docs/inner/B.txt')).text(), 'hello');

  assert.equal((await owner.post('/api/delete', { paths: ['docs/inner/B.txt'] })).status, 200);
  assert.equal((await owner.get('/api/file?path=docs/inner/B.txt')).status, 404);
  const trash = (await owner.get('/api/trash')).data.items.find((m) => m.name === 'B.txt');
  assert.equal((await owner.post('/api/trash/restore', { ids: [trash.id] })).status, 200);
  assert.equal(await (await owner.req('GET', '/api/file?path=docs/inner/B.txt')).text(), 'hello');
  assert.equal((await owner.post('/api/trash/restore', { ids: ['../../db'] })).status, 400);
  assert.equal((await owner.post('/api/delete', { paths: [''] })).status, 400);
});

test('folder ZIP extracts correctly with Windows tar', async () => {
  const res = await owner.req('GET', '/api/file?path=docs');
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zipPath = path.join(tmp, 'docs.zip');
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const out = path.join(tmp, 'unzipped');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', zipPath, '-C', out]);
  assert.equal(fs.readFileSync(path.join(out, 'docs', 'inner', 'B.txt'), 'utf8'), 'hello');
});

test('accounts are isolated from each other', async () => {
  assert.equal((await owner.post('/api/users', { username: '__proto__', password: MEMBER_PW })).status, 400);
  assert.equal((await owner.post('/api/users', { username: 'member', password: MEMBER_PW })).status, 200);
  assert.equal((await member.post('/api/login', { username: 'member', password: MEMBER_PW })).status, 200);

  assert.equal((await member.get('/api/list')).data.items.length, 0);
  assert.equal((await member.get('/api/file?path=docs/inner/B.txt')).status, 404);
  assert.equal((await member.get('/api/search?q=B.txt')).data.items.length, 0);
  assert.equal((await member.post('/api/shares', { path: 'docs' })).status, 404);
  for (const p of ['../owner/dup.txt', '..\\owner\\dup.txt']) {
    assert.equal((await member.get(`/api/file?path=${encodeURIComponent(p)}`)).status, 400);
  }
  assert.equal((await member.get('/api/remote')).status, 403);
  assert.equal((await member.get('/api/users')).status, 403);
  assert.equal((await member.post('/api/users', { username: 'sneak', password: MEMBER_PW })).status, 403);
  assert.equal((await member.post('/api/remote', { provider: 'cloudflare', on: true })).status, 403);
});

test('API responses never contain secrets', async () => {
  for (const url of ['/api/users', '/api/me', '/api/account/sessions', '/api/shares']) {
    const text = JSON.stringify((await owner.get(url)).data);
    assert.doesNotMatch(text, /scrypt|"pass"|"secret"/, url);
  }
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(db), new RegExp(OWNER_PW));
  assert.doesNotMatch(JSON.stringify(db.sessions), new RegExp(owner.cookies.attic_sid.replace(/[-]/g, '\\-')));
});

test('share links: public access, confinement, passwords, revocation', async () => {
  const anon = new Client('7.7.7.7');
  const { token } = (await owner.post('/api/shares', { path: 'docs', days: 7 })).data;
  const meta = await anon.get(`/api/s/${token}`);
  assert.equal(meta.data.type, 'dir');
  assert.equal(meta.data.name, 'docs');
  assert.equal((await anon.get(`/api/s/${token}?path=inner`)).data.items[0].name, 'B.txt');
  assert.equal(await (await anon.req('GET', `/api/s/${token}/file?path=inner/B.txt`)).text(), 'hello');

  for (const p of ['..', '../dup.txt', 'inner/../../dup.txt', '..\\dup.txt']) {
    assert.equal((await anon.get(`/api/s/${token}/file?path=${encodeURIComponent(p)}`)).status, 400, p);
    assert.equal((await anon.get(`/api/s/${token}?path=${encodeURIComponent(p)}`)).status, 400, p);
  }
  assert.equal((await anon.get('/api/list')).status, 401);

  // Links survive a rename of the shared folder.
  await owner.post('/api/rename', { path: 'docs', name: 'papers' });
  assert.equal((await anon.get(`/api/s/${token}`)).data.name, 'papers');
  await owner.post('/api/rename', { path: 'papers', name: 'docs' });

  assert.equal((await owner.json('DELETE', `/api/shares/${token}`)).status, 200);
  assert.equal((await anon.get(`/api/s/${token}`)).status, 404);

  const locked = (await owner.post('/api/shares', { path: 'dup.txt', password: 'open sesame' })).data.token;
  const visitor = new Client('7.7.7.8');
  assert.deepEqual((await visitor.get(`/api/s/${locked}`)).data, { locked: true });
  assert.equal((await visitor.get(`/api/s/${locked}/file`)).status, 403);
  assert.equal((await visitor.post(`/api/s/${locked}/unlock`, { password: 'wrong' })).status, 403);
  assert.equal((await visitor.post(`/api/s/${locked}/unlock`, { password: 'open sesame' })).status, 200);
  assert.equal(await (await visitor.req('GET', `/api/s/${locked}/file`)).text(), 'first');

  assert.equal((await member.json('DELETE', `/api/shares/${locked}`)).status, 404);
  assert.equal((await anon.get('/api/s/constructor')).status, 404);
  assert.equal((await anon.get('/api/s/__proto__')).status, 404);

  // Deleting the file kills its links.
  await owner.post('/api/delete', { paths: ['dup.txt'] });
  assert.equal((await visitor.get(`/api/s/${locked}`)).status, 404);
});

test('expired share links stop working', async () => {
  const oneSecond = 1 / 86400;
  const { token } = (await owner.post('/api/shares', { path: 'docs', days: oneSecond })).data;
  const anon = new Client('7.7.7.9');
  assert.equal((await anon.get(`/api/s/${token}`)).status, 200);
  await new Promise((r) => { setTimeout(r, 1100); });
  assert.equal((await anon.get(`/api/s/${token}`)).status, 404);
  assert.equal((await anon.get(`/api/s/${token}/file?path=inner/B.txt`)).status, 404);
});

test('password guessing is throttled across IPs, sparing the local owner', async () => {
  const body = { username: 'member', password: 'wrong-password-here' };
  const attacker = new Client('6.6.6.6');
  for (let i = 0; i < 5; i++) assert.equal((await attacker.post('/api/login', body)).status, 401);
  const blocked = await attacker.post('/api/login', body);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Rotating IP doesn't help: the account itself is cooling down.
  assert.equal((await new Client('6.6.6.7').post('/api/login', body)).status, 429);
  // Correct password is refused during cooldown too, so guesses can't be confirmed.
  assert.equal((await new Client('6.6.6.8').post('/api/login', { username: 'member', password: MEMBER_PW })).status, 429);
  // Someone at the PC is never locked out.
  assert.equal((await new Client().post('/api/login', { username: 'member', password: MEMBER_PW })).status, 200);
  // Unknown and known usernames give the same answer.
  const unknown = await new Client('6.6.6.9').post('/api/login', { username: 'nobody', password: 'x' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, 'Wrong username or password.');
});

test('two-step sign-in: enrol, require, block replay, disable', async () => {
  assert.equal((await owner.post('/api/account/2fa/begin', { password: 'bad' })).status, 403);
  const { secret } = (await owner.post('/api/account/2fa/begin', { password: OWNER_PW })).data;
  const step = () => Math.floor(Date.now() / 30000);
  assert.equal((await owner.post('/api/account/2fa/enable', { code: '000000' })).status, 400);
  const enrolStep = step();
  assert.equal((await owner.post('/api/account/2fa/enable', { code: totpAt(secret, enrolStep) })).status, 200);

  const c = new Client();
  assert.deepEqual((await c.post('/api/login', { username: 'owner', password: OWNER_PW })).data, { needsCode: true });
  assert.equal((await c.get('/api/me')).data.user, null);
  assert.equal((await c.post('/api/login', { username: 'owner', password: OWNER_PW, code: totpAt(secret, enrolStep) })).status, 401, 'replayed code');
  assert.equal((await c.post('/api/login', { username: 'owner', password: 'wrong', code: totpAt(secret, step() + 1) })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'owner', password: OWNER_PW, code: totpAt(secret, step() + 1) })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.totp, true);

  assert.equal((await owner.post('/api/account/2fa/disable', { password: OWNER_PW, code: '000000' })).status, 403);
});

test('password change signs out other devices', async () => {
  const other = new Client();
  await other.post('/api/login', { username: 'member', password: MEMBER_PW });
  const main = new Client();
  await main.post('/api/login', { username: 'member', password: MEMBER_PW });
  const next = crypto.randomBytes(10).toString('hex');
  assert.equal((await main.post('/api/account/password', { current: MEMBER_PW, next })).status, 200);
  assert.equal((await other.get('/api/list')).status, 401);
  assert.equal((await main.get('/api/list')).status, 200);
});

test('removing a user ends access at once, keeps files', async () => {
  assert.equal((await owner.json('DELETE', '/api/users/owner')).status, 400);
  await member.upload('', 'keep.txt', Buffer.from('k')).catch(() => {});
  assert.equal((await owner.json('DELETE', '/api/users/member')).status, 200);
  assert.equal((await member.get('/api/list')).status, 401);
  assert.equal(fs.existsSync(path.join(dataDir, 'storage', 'users', 'member')), true);
});

test('public tunnel: starts, reports its URL, stops', async () => {
  assert.equal((await owner.post('/api/remote', { provider: 'nonsense', on: true })).status, 400);
  const on = await owner.post('/api/remote', { provider: 'cloudflare', on: true });
  assert.equal(on.status, 200);
  let status;
  for (let i = 0; i < 40; i++) {
    status = (await owner.get('/api/remote')).data.cloudflare;
    if (status.state === 'on') break;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.equal(status.state, 'on');
  assert.equal(status.url, 'https://fake-quick.trycloudflare.com');
  assert.equal((await owner.get('/api/public-url')).data.url, status.url);
  await owner.post('/api/remote', { provider: 'cloudflare', on: false });
  assert.equal((await owner.get('/api/remote')).data.cloudflare.state, 'off');
});

test('every page carries a strict content security policy', async () => {
  for (const url of ['/', '/s/abcDEF123']) {
    const res = await new Client().req('GET', url);
    await res.arrayBuffer();
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

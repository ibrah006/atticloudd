'use strict';
// Internet access via outbound tunnels: no router ports opened and the home IP stays hidden.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { HttpError } = require('./security');

function findBinary(name, configured, windowsPaths) {
  if (configured) return configured;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === 'win32') for (const p of windowsPaths) if (fs.existsSync(p)) return p;
  return null;
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4e6 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), timedOut: Boolean(err && err.killed) });
    });
  });
}

class Remote {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.child = null;
    this.cf = { state: 'off', url: '', error: '' };
    this.retries = 0;
    process.on('exit', () => this.killChild());
  }

  get target() {
    return `http://127.0.0.1:${this.config.port}`;
  }

  cloudflared() {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return findBinary('cloudflared', this.config.cloudflaredPath, [
      path.join(pf86, 'cloudflared', 'cloudflared.exe'),
      path.join(pf, 'cloudflared', 'cloudflared.exe'),
    ]);
  }

  tailscale() {
    return findBinary('tailscale', '', [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]);
  }

  killChild() {
    if (this.child) {
      this.child.removeAllListeners('exit');
      this.child.kill();
      this.child = null;
    }
  }

  startCloudflare() {
    const bin = this.cloudflared();
    if (!bin) throw new HttpError(409, 'cloudflared is not installed on this PC.');
    this.killChild();
    const named = Boolean(this.config.cloudflareTunnelToken);
    this.cf = { state: 'starting', url: '', error: '' };
    const args = named
      ? ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', this.target];
    const env = named ? { ...process.env, TUNNEL_TOKEN: this.config.cloudflareTunnelToken } : process.env;
    const child = spawn(bin, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    let tail = '';
    const onData = (buf) => {
      const text = String(buf);
      tail = (tail + text).slice(-2000);
      if (named) {
        if (/Registered tunnel connection/i.test(text)) {
          this.cf = { state: 'on', url: `https://${this.config.publicHostname}`, error: '' };
          this.retries = 0;
        }
      } else {
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
        if (match && !/api\.trycloudflare/.test(match[0])) {
          this.cf = { state: 'on', url: match[0], error: '' };
          this.retries = 0;
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      this.child = null;
      this.cf = { state: 'error', url: '', error: e.message };
    });
    child.on('exit', () => {
      this.child = null;
      if (this.db.data.settings.tunnel !== 'cloudflare') return;
      // Unexpected exit, usually a network drop: reconnect with growing delay.
      this.retries++;
      this.cf = { state: 'starting', url: '', error: tail.split('\n').filter(Boolean).pop() || '' };
      setTimeout(() => {
        if (this.db.data.settings.tunnel === 'cloudflare' && !this.child) {
          try { this.startCloudflare(); } catch (e) { this.cf = { state: 'error', url: '', error: e.message }; }
        }
      }, Math.min(5000 * 2 ** Math.min(this.retries, 6), 300000)).unref();
    });
  }

  resume() {
    if (this.db.data.settings.tunnel === 'cloudflare') {
      try { this.startCloudflare(); } catch (e) { console.error('Tunnel not started: ' + e.message); }
    }
  }

  async tailscaleStatus() {
    const bin = this.tailscale();
    if (!bin) return { installed: false, mode: 'off' };
    const status = await run(bin, ['status', '--json'], 8000);
    let state = 'Unknown';
    let dns = '';
    try {
      const parsed = JSON.parse(status.out);
      state = parsed.BackendState;
      dns = String((parsed.Self && parsed.Self.DNSName) || '').replace(/\.$/, '');
    } catch { /* daemon not running: reported as Unknown */ }
    const result = { installed: true, state, dns, mode: 'off', url: '', foreign: false };
    if (state !== 'Running' || !dns) return result;
    try {
      const serve = JSON.parse((await run(bin, ['serve', 'status', '--json'], 8000)).out || '{}');
      const key = `${dns}:443`;
      const proxy = serve.Web && serve.Web[key] && serve.Web[key].Handlers && serve.Web[key].Handlers['/'] && serve.Web[key].Handlers['/'].Proxy;
      if (proxy) {
        if (proxy.includes(`:${this.config.port}`)) {
          result.mode = serve.AllowFunnel && serve.AllowFunnel[key] ? 'funnel' : 'serve';
          result.url = `https://${dns}`;
        } else {
          result.foreign = true; // Port 443 already belongs to something else the owner set up.
        }
      }
    } catch { /* treated as off */ }
    return result;
  }

  async setTailscale(mode) {
    const bin = this.tailscale();
    if (!bin) throw new HttpError(409, 'Tailscale is not installed on this PC.');
    const status = await this.tailscaleStatus();
    if (status.state !== 'Running') throw new HttpError(409, 'Sign in to the Tailscale app on this PC first.');
    if (status.foreign) throw new HttpError(409, 'Tailscale port 443 is already used by another service on this PC.');

    if (status.mode === 'funnel') await run(bin, ['funnel', '--https=443', 'off']);
    else if (status.mode === 'serve') await run(bin, ['serve', '--https=443', 'off']);
    if (mode === 'off') return { ok: true };

    // If HTTPS or Funnel is not enabled on the tailnet, the CLI prints an approval link and waits.
    const result = await run(bin, [mode, '--bg', this.target], 25000);
    const text = result.out + result.err;
    const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
    if (link && (!result.ok || result.timedOut)) return { ok: false, actionUrl: link[0] };
    if (!result.ok) throw new HttpError(502, `Tailscale reported: ${text.trim().slice(0, 300) || 'unknown error'}`);
    return { ok: true };
  }

  // The address share links should use. Public routes win over the private tailnet one.
  async publicUrl() {
    if (this.cf.state === 'on') return this.cf.url;
    const ts = await this.tailscaleStatus();
    return ts.url || '';
  }

  async status() {
    return {
      port: this.config.port,
      tailscale: await this.tailscaleStatus(),
      cloudflare: {
        installed: Boolean(this.cloudflared()),
        named: Boolean(this.config.cloudflareTunnelToken),
        ...this.cf,
      },
    };
  }

  async set(provider, on) {
    if (provider === 'cloudflare') {
      this.db.data.settings.tunnel = on ? 'cloudflare' : null;
      this.db.save();
      if (on) {
        this.retries = 0;
        this.startCloudflare();
      } else {
        this.killChild();
        this.cf = { state: 'off', url: '', error: '' };
      }
      return { ok: true };
    }
    if (provider === 'tailscale-serve') return this.setTailscale(on ? 'serve' : 'off');
    if (provider === 'tailscale-funnel') return this.setTailscale(on ? 'funnel' : 'off');
    throw new HttpError(400, 'Unknown provider.');
  }
}

module.exports = { Remote };

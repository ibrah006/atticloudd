'use strict';
// Settings come from (highest priority first): command line, environment, attic.config.json.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

let file = {};
try {
  file = JSON.parse(fs.readFileSync(path.join(root, 'attic.config.json'), 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('attic.config.json could not be read: ' + e.message);
    process.exit(1);
  }
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

// Comma-separated in env vars, an array in the config file. Lowercased so sign-in is case-insensitive.
function emailList(envValue, fileValue) {
  const raw = envValue !== undefined ? envValue.split(',') : Array.isArray(fileValue) ? fileValue : [];
  return [...new Set(raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
}

const dataDir = path.resolve(arg('data') || process.env.ATTIC_DATA || file.dataDir || path.join(root, 'data'));

module.exports = {
  root,
  port: Number(arg('port') || process.env.ATTIC_PORT || file.port || 8420),
  // Loopback by default: tunnels reach it locally and nothing else on the network can.
  host: arg('host') || process.env.ATTIC_HOST || file.host || '127.0.0.1',
  dataDir,
  storageDir: path.resolve(arg('storage') || process.env.ATTIC_STORAGE || file.storageDir || path.join(dataDir, 'storage')),
  cloudflaredPath: process.env.ATTIC_CLOUDFLARED || file.cloudflaredPath || '',
  cloudflareTunnelToken: process.env.ATTIC_CF_TOKEN || file.cloudflareTunnelToken || '',
  publicHostname: process.env.ATTIC_PUBLIC_HOSTNAME || file.publicHostname || '',
  // Only these addresses can sign in. Keep them in attic.config.json (git-ignored), never in the repo.
  allowedEmails: emailList(process.env.ATTIC_ALLOWED_EMAILS, file.allowedEmails),
  adminEmails: emailList(process.env.ATTIC_ADMIN_EMAILS, file.adminEmails),
  trashDays:Number(file.trashDays || 30),
  reserveBytes: Number(file.reserveGB ?? 1) * 1024 ** 3,
};

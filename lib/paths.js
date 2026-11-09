'use strict';
// Every path a client sends goes through here. Paths are validated one segment at a time
// rather than by cleaning up the whole string, because Windows has many ways to alias a file.
const fsp = require('fs').promises;
const path = require('path');
const { HttpError } = require('./security');

// Backslash, colon (NTFS alternate data streams) and the other characters Windows reserves.
const BAD_CHARS = /[<>:"|?*\\/\x00-\x1f\x7f]/;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function validName(name) {
  return typeof name === 'string'
    && name.length > 0
    && Buffer.byteLength(name) <= 240
    && name !== '.' && name !== '..'
    && !BAD_CHARS.test(name)
    // Windows silently strips trailing dots and spaces, so "a.txt." would alias "a.txt".
    && !/[. ]$/.test(name)
    && !RESERVED.test(name);
}

function assertName(name) {
  if (!validName(name)) throw new HttpError(400, 'That name contains characters that are not allowed.');
  return name;
}

function splitPath(rel) {
  if (rel === undefined || rel === null || rel === '') return [];
  if (typeof rel !== 'string') throw new HttpError(400, 'Invalid path.');
  const parts = rel.split('/').filter(Boolean);
  if (parts.length > 64) throw new HttpError(400, 'Path is too deep.');
  parts.forEach(assertName);
  return parts;
}

// Resolves a client path inside `root`, refusing anything that passes through a symlink or junction.
async function resolveSafe(root, rel) {
  const parts = splitPath(rel);
  const full = path.join(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(403, 'Access denied.');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await fsp.lstat(cursor);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break;
      throw e;
    }
    if (st.isSymbolicLink()) throw new HttpError(403, 'Access denied.');
  }
  return { full, parts, rel: parts.join('/') };
}

async function exists(full) {
  try {
    await fsp.lstat(full);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

// "report.pdf" -> "report (1).pdf" when the name is taken.
async function uniquePath(full) {
  if (!(await exists(full))) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  for (let n = 1; n < 100000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new HttpError(409, 'Too many files with that name.');
}

module.exports = { validName, assertName, splitPath, resolveSafe, exists, uniquePath };

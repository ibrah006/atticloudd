'use strict';
// Streams a ZIP straight to the response so folders of any size need no temp space.
// Files are stored rather than compressed: most large files (video, photos) are already compressed.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { HttpError } = require('./security');

const MAX_ENTRIES = 200000;
const LIMIT32 = 0xffffffff;

// Gathers a file or folder into a flat entry list. Links are skipped, never followed.
async function collect(abs, zipName, out) {
  if (out.length >= MAX_ENTRIES) throw new HttpError(413, 'Too many files to download at once.');
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    out.push({ name: `${zipName}/`, dir: true, size: 0, mtime: st.mtime });
    for (const child of await fsp.readdir(abs)) await collect(path.join(abs, child), `${zipName}/${child}`, out);
  } else if (st.isFile()) {
    out.push({ abs, name: zipName, dir: false, size: st.size, mtime: st.mtime });
  }
}

function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

async function writeZip(out, entries) {
  let offset = 0;
  const write = async (buf) => {
    if (out.destroyed) throw new Error('client disconnected');
    offset += buf.length;
    if (!out.write(buf)) await Promise.race([once(out, 'drain'), once(out, 'close')]);
  };

  const central = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const start = offset;
    const big = e.size >= LIMIT32;
    const flags = e.dir ? 0x0800 : 0x0808; // UTF-8 names; bit 3 = sizes follow the data
    const version = big ? 45 : 20;
    const extra = big ? Buffer.concat([Buffer.from([1, 0, 16, 0]), Buffer.alloc(16)]) : Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    if (big) {
      local.writeUInt32LE(LIMIT32, 18);
      local.writeUInt32LE(LIMIT32, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    await write(Buffer.concat([local, name, extra]));

    let crc = 0;
    let size = 0;
    if (!e.dir && e.size > 0) {
      // Capped at the size seen earlier, so a file that's still growing can't corrupt the archive.
      for await (const chunk of fs.createReadStream(e.abs, { end: e.size - 1, highWaterMark: 1 << 20 })) {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
        await write(chunk);
      }
    }

    if (!e.dir) {
      const desc = Buffer.alloc(big ? 24 : 16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      if (big) {
        desc.writeBigUInt64LE(BigInt(size), 8);
        desc.writeBigUInt64LE(BigInt(size), 16);
      } else {
        desc.writeUInt32LE(size, 8);
        desc.writeUInt32LE(size, 12);
      }
      await write(desc);
    }
    central.push({ name, time, date, crc, size, start, flags, dir: e.dir });
  }

  const cdStart = offset;
  for (const c of central) {
    const bigSize = c.size >= LIMIT32;
    const bigOffset = c.start >= LIMIT32;
    const fields = [];
    if (bigSize) fields.push(u64(c.size), u64(c.size));
    if (bigOffset) fields.push(u64(c.start));
    let extra = Buffer.alloc(0);
    if (fields.length) {
      const data = Buffer.concat(fields);
      const head = Buffer.alloc(4);
      head.writeUInt16LE(1, 0);
      head.writeUInt16LE(data.length, 2);
      extra = Buffer.concat([head, data]);
    }
    const version = fields.length ? 45 : 20;
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(version, 4);
    rec.writeUInt16LE(version, 6);
    rec.writeUInt16LE(c.flags, 8);
    rec.writeUInt16LE(c.time, 12);
    rec.writeUInt16LE(c.date, 14);
    rec.writeUInt32LE(c.crc, 16);
    rec.writeUInt32LE(bigSize ? LIMIT32 : c.size, 20);
    rec.writeUInt32LE(bigSize ? LIMIT32 : c.size, 24);
    rec.writeUInt16LE(c.name.length, 28);
    rec.writeUInt16LE(extra.length, 30);
    rec.writeUInt32LE(c.dir ? 0x10 : 0, 38);
    rec.writeUInt32LE(bigOffset ? LIMIT32 : c.start, 42);
    await write(Buffer.concat([rec, c.name, extra]));
  }
  const cdSize = offset - cdStart;
  const count = central.length;

  if (count >= 0xffff || cdStart >= LIMIT32 || cdSize >= LIMIT32) {
    const eocd64Start = offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    await write(rec);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(eocd64Start), 8);
    locator.writeUInt32LE(1, 16);
    await write(locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, LIMIT32), 12);
  end.writeUInt32LE(Math.min(cdStart, LIMIT32), 16);
  await write(end);
}

module.exports = { collect, writeZip };

// Minimal ZIP reader for untrusted archives: no ZIP64, no encryption, bounded sizes. Entries are read one at a time.
const zlib = require('zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

function openZip(buf, { maxEntries = 20000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (count > maxEntries) throw new Error('zip has too many entries');
  if (cdOffset + cdSize > buf.length) throw new Error('corrupt zip');

  const entries = new Map();
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL) throw new Error('corrupt zip');
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20), size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen > buf.length) throw new Error('corrupt zip');
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error('encrypted zip entries are not supported');
    if (entries.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    entries.set(name, { name, method, csize, size, offset, dir: name.endsWith('/') });
  }

  function read(name) {
    const e = entries.get(name);
    if (!e || e.dir) throw new Error(`no such entry: ${name}`);
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOCAL) throw new Error('corrupt zip');
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (start + e.csize > buf.length) throw new Error('corrupt zip');
    const data = buf.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = data;
    else if (e.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
    else throw new Error('unsupported zip compression');
    if (out.length !== e.size) throw new Error('corrupt zip entry size');
    return out;
  }

  return { entries: [...entries.values()], has: (name) => entries.has(name), read };
}

module.exports = { openZip };

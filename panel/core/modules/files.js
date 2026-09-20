// File access inside one instance folder: listing, reading and saving text, uploads and deletes. Every path is checked against the root.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function createFiles({ root }) {
  const base = path.resolve(root);

  function safePath(rel) {
    const resolved = path.resolve(base, rel || '.');
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    try {
      const real = fs.realpathSync(resolved);
      const realBase = fs.realpathSync(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
    } catch (_) { /* does not exist yet: the caller's fs call reports the real error */ }
    return resolved;
  }

  const fail = (status, error) => Object.assign(new Error(error), { status });

  function list(rel) {
    const resolved = safePath(rel);
    if (!resolved) throw fail(400, 'invalid path');
    let st;
    try { st = fs.statSync(resolved); } catch (err) { throw fail(404, err.message); }
    if (!st.isDirectory()) throw fail(400, 'not a directory');
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((d) => {
      let size = null, mtime = null;
      try {
        const s = fs.statSync(path.join(resolved, d.name));
        size = s.isFile() ? s.size : null;
        mtime = s.mtimeMs;
      } catch (_) {}
      return { name: d.name, isDir: d.isDirectory(), sizeMB: size != null ? +(size / 1024 / 1024).toFixed(3) : null, mtime };
    }).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { path: path.relative(base, resolved) || '.', entries };
  }

  // Returns { text, mtime, crlf, sizeMB } or { tooLarge } / { binary }.
  function read(rel) {
    const resolved = safePath(rel);
    if (!resolved) throw fail(400, 'invalid path');
    let st;
    try { st = fs.statSync(resolved); } catch (err) { throw fail(404, err.message); }
    if (!st.isFile()) throw fail(400, 'not a file');
    const sizeMB = +(st.size / 1024 / 1024).toFixed(2);
    if (st.size > MAX_EDIT_BYTES) return { tooLarge: true, sizeMB };
    const buf = fs.readFileSync(resolved);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, sizeMB };
    const text = buf.toString('utf8');
    if (text.includes('�') && Buffer.from(text, 'utf8').compare(buf) !== 0) return { binary: true, sizeMB };
    return { text, sizeMB, mtime: st.mtimeMs, crlf: /\r\n/.test(text), mode: st.mode & 0o777 };
  }

  // Atomic save. expectedMtime guards against overwriting a change made in between.
  function write(rel, text, { expectedMtime } = {}) {
    const resolved = safePath(rel);
    if (!resolved || resolved === base) throw fail(400, 'invalid path');
    if (typeof text !== 'string') throw fail(400, 'text is required');
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_EDIT_BYTES) throw fail(413, 'file is too large to save from the editor');
    let st;
    try { st = fs.statSync(resolved); } catch (err) { throw fail(404, err.message); }
    if (!st.isFile()) throw fail(400, 'not a file');
    if (Number.isFinite(expectedMtime) && Math.abs(st.mtimeMs - expectedMtime) > 1) throw fail(409, 'the file was changed by someone else since you opened it');
    const tmp = `${resolved}.editing-${process.pid}`;
    try {
      fs.writeFileSync(tmp, data, { mode: st.mode & 0o777 });
      fs.renameSync(tmp, resolved);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw fail(500, err.message);
    }
    return { mtime: fs.statSync(resolved).mtimeMs, sizeMB: +(data.length / 1024 / 1024).toFixed(3) };
  }

  function remove(rel) {
    const resolved = safePath(rel);
    if (!resolved || resolved === base) throw fail(400, 'invalid path');
    let st;
    try { st = fs.statSync(resolved); } catch (err) { throw fail(404, err.message); }
    fs.rmSync(resolved, { recursive: st.isDirectory(), force: true });
    return { name: path.basename(resolved), dir: path.dirname(rel) };
  }

  function uploadTarget(dirRel, name) {
    const dir = safePath(dirRel);
    if (!dir || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw fail(400, 'invalid path or filename');
    const dest = safePath(path.join(dirRel, name));
    if (!dest) throw fail(400, 'invalid path');
    let st;
    try { st = fs.statSync(dir); } catch (err) { throw fail(404, err.message); }
    if (!st.isDirectory()) throw fail(400, 'not a directory');
    return dest;
  }

  // Streams the request into a temp file next to dest and renames it when complete, so a failed upload never damages an existing file.
  function receiveUpload(req, dest, done) {
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let finished = false;
    const end = (err) => {
      if (finished) return;
      finished = true;
      if (err) { out.destroy(); try { fs.unlinkSync(tmp); } catch (_) {} }
      done(err, size);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) { req.unpipe(out); end(fail(413, 'file is too large')); }
    });
    req.on('aborted', () => end(fail(400, 'upload interrupted')));
    req.on('error', (err) => end(err));
    out.on('error', (err) => end(err));
    out.on('finish', () => {
      if (finished) return;
      try { fs.renameSync(tmp, dest); } catch (err) { return end(err); }
      finished = true;
      done(null, size);
    });
    req.pipe(out);
  }

  function fileInfo(rel) {
    const resolved = safePath(rel);
    if (!resolved) throw fail(400, 'invalid path');
    let st;
    try { st = fs.statSync(resolved); } catch (err) { throw fail(404, err.message); }
    if (!st.isFile()) throw fail(400, 'not a file');
    return { resolved, size: st.size, name: path.basename(resolved) };
  }

  return { safePath, list, read, write, remove, uploadTarget, receiveUpload, fileInfo, MAX_EDIT_BYTES, MAX_UPLOAD_BYTES };
}

module.exports = { createFiles };

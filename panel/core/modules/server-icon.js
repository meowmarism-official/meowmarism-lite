// The Minecraft server icon (server-icon.png, 64x64) of one instance folder.
const fs = require('fs');
const path = require('path');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 100 * 1024;

// defaultIcon: path of the icon "reset" copies back
function createServerIcon({ dir, defaultIcon }) {
  const file = path.join(dir, 'server-icon.png');
  return {
    exists: () => fs.existsSync(file),
    file,
    // body: { reset: true } or { png: base64 }; returns a short description for the audit log
    apply(body) {
      if (body.reset === true) {
        fs.copyFileSync(defaultIcon, file);
        return 'reset to the meowmarism icon';
      }
      const png = Buffer.from(String(body.png || ''), 'base64');
      if (png.length <= 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('that is not a PNG image');
      if (png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64) throw new Error('Minecraft needs a 64x64 PNG');
      if (png.length > MAX_BYTES) throw new Error('the image is too large');
      fs.writeFileSync(file, png);
      return 'changed';
    },
  };
}

module.exports = { createServerIcon };

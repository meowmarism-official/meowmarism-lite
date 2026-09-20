// Whitelist, operators and bans: reads the game's JSON lists and changes them through console commands.
const fs = require('fs');
const path = require('path');

const FILES = { whitelist: 'whitelist.json', ops: 'ops.json', banned: 'banned-players.json' };
const COMMANDS = {
  whitelist: { add: 'whitelist add', remove: 'whitelist remove' },
  ops: { add: 'op', remove: 'deop' },
  banned: { add: 'ban', remove: 'pardon' },
};

const { playerName } = require('./players');

// dir: server directory; isRunning(): bool; command(text): sends a console command
function createAccess({ dir, isRunning, command }) {
  const readList = (file) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
  };

  function list() {
    const out = {};
    for (const [key, file] of Object.entries(FILES)) out[key] = readList(file);
    return out;
  }

  function act(listName, action, name, reason) {
    const group = COMMANDS[listName];
    if (!group) throw new Error('invalid list');
    const verb = group[action];
    if (!verb) throw new Error('invalid action');
    const player = playerName(name);
    if (!isRunning()) throw new Error('server is not running');
    let text = `${verb} ${player}`;
    if (listName === 'banned' && action === 'add') {
      const why = String(reason || '').replace(/[\r\n]/g, ' ').trim().slice(0, 160);
      text += ` ${why || 'Banned by an operator'}`;
    }
    if (command(text) === false) throw new Error('server is not running');
    return player;
  }

  return { list, act };
}

module.exports = { createAccess };

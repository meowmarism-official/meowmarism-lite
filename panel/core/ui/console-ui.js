// Console page: log lines with filters, search, pause and autoscroll, and the command line with Minecraft command suggestions and history.
// Shared by every product. cfg: { el, send(cmd) (throws on failure), players() -> online names, fmtClock(ts, withSeconds), downloadHref?, onJump?(ts), t, esc }
(function () {
  function mount(cfg) {
    const { esc } = cfg;
    const $ = (id) => document.getElementById(id);
    const download = cfg.downloadHref ? `<a class="tool" href="${cfg.downloadHref}" style="text-decoration:none;display:flex;align-items:center">Download log</a>` : '';
    cfg.el.innerHTML = `
                <div class="console-shell">
          <div class="console-toolbar"><div class="console-filter-row"><span class="hint"><span id="lineCount">0 lines</span></span><button class="filter-chip active" data-console-kind="all">All</button><button class="filter-chip" data-console-kind="warn">Warn</button><button class="filter-chip" data-console-kind="error">Error</button><button class="filter-chip" data-console-kind="chat">Chat</button><button class="filter-chip" data-console-kind="player">Players</button><button class="filter-chip" data-console-kind="command">Commands</button></div><div class="console-tools"><input class="search" id="consoleSearch" placeholder="Filter console" autocomplete="off"><button class="tool" id="btnRegex">Regex</button><button class="tool" id="btnPauseConsole">Pause</button><button class="tool active" id="btnAutoscroll">Autoscroll</button><button class="tool" id="btnClear">Clear</button>${download}</div></div>
          <div class="console-paused" id="consolePaused"><span id="consolePausedText">Console paused</span><button class="tool" id="btnResumeConsole">Resume</button></div>
          <div id="console"><div class="console-line system" id="consoleEmpty">--- waiting for console output ---</div></div>
          <div class="command"><div class="quick-row"><button class="quick" data-command="list">list</button><button class="quick" data-command="save-all">save-all</button><button class="quick" data-command="whitelist list">whitelist list</button><button class="quick" data-command="tps">tps</button><button class="quick" data-command="help">help</button></div><div class="cmd-area"><div class="cmd-suggest" id="cmdSuggest" role="listbox" aria-label="Command suggestions"><div class="cmd-suggest-head"><span id="cmdSuggestTitle">Suggestions</span><span id="cmdSuggestCount"></span></div><div class="cmd-suggest-list" id="cmdSuggestList"></div></div><div class="cmd-row"><div class="cmd-input-wrap"><span class="prompt">&gt;</span><input class="cmd-input" id="cmdInput" placeholder="Server command" autocomplete="off" autocapitalize="off" spellcheck="false" aria-autocomplete="list" aria-controls="cmdSuggest"></div><button class="btn primary" id="btnSend">Send</button></div><div class="cmd-hint"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Tab</kbd> complete · <kbd>Enter</kbd> send · <kbd>Esc</kbd> close</div></div></div>
        </div>
      `;

    let autoscroll = true;
    let totalLines = 0;
    let consoleClearSeq = 0;
    let consoleFilterKind = 'all';
    let consoleRegex = false;
    let consolePaused = false;
    const pausedConsoleEntries = [];
    const consoleSeen = new Set();
    const receivedConsoleSeq = new Set();
    let contiguousConsoleSeq = 0;
    let highestConsoleSeq = 0;
    const quickButtons = [...cfg.el.querySelectorAll('.quick')];
    const consoleEl = $('console');
    const search = $('consoleSearch');
    const cmdInput = $('cmdInput');
    const cmdSuggest = $('cmdSuggest');
    const cmdSuggestList = $('cmdSuggestList');

const COMMAND_CATALOG = [
  { name:'advancement', usage:'advancement <grant|revoke> <targets> ...', desc:'Grant or revoke player advancements.' },
  { name:'attribute', usage:'attribute <target> <attribute> ...', desc:'Read or change an entity attribute.' },
  { name:'ban', usage:'ban <player> [reason]', desc:'Ban a player from the server.' },
  { name:'ban-ip', usage:'ban-ip <target> [reason]', desc:'Ban an IP address.' },
  { name:'banlist', usage:'banlist [ips|players]', desc:'Show the current ban list.' },
  { name:'bossbar', usage:'bossbar <add|get|list|remove|set> ...', desc:'Manage custom boss bars.' },
  { name:'clear', usage:'clear [targets] [item] [maxCount]', desc:'Clear items from player inventories.' },
  { name:'clone', usage:'clone <begin> <end> <destination> ...', desc:'Clone blocks from one region to another.' },
  { name:'damage', usage:'damage <target> <amount> [damageType] ...', desc:'Apply damage to an entity.' },
  { name:'data', usage:'data <get|merge|modify|remove> ...', desc:'Read or modify NBT data.' },
  { name:'datapack', usage:'datapack <disable|enable|list> ...', desc:'Manage data packs.' },
  { name:'deop', usage:'deop <targets>', desc:'Remove operator status from a player.' },
  { name:'difficulty', usage:'difficulty [peaceful|easy|normal|hard]', desc:'Get or change the world difficulty.' },
  { name:'effect', usage:'effect <clear|give> ...', desc:'Add or remove status effects.' },
  { name:'enchant', usage:'enchant <targets> <enchantment> [level]', desc:'Enchant a player-held item.' },
  { name:'execute', usage:'execute ... run <command>', desc:'Execute a command with changed context.' },
  { name:'experience', usage:'experience <add|set|query> ...', desc:'Manage player experience.', aliases:['xp'] },
  { name:'fill', usage:'fill <from> <to> <block> ...', desc:'Fill a region with blocks.' },
  { name:'fillbiome', usage:'fillbiome <from> <to> <biome>', desc:'Change biomes in a region.' },
  { name:'forceload', usage:'forceload <add|query|remove> ...', desc:'Control force-loaded chunks.' },
  { name:'function', usage:'function <name>', desc:'Run a data pack function.' },
  { name:'gamemode', usage:'gamemode <mode> [target]', desc:'Change a player game mode.' },
  { name:'gamerule', usage:'gamerule <rule> [value]', desc:'Read or change a game rule.' },
  { name:'give', usage:'give <targets> <item> [count]', desc:'Give items to players.' },
  { name:'help', usage:'help [command]', desc:'Show command help.' },
  { name:'item', usage:'item <modify|replace> ...', desc:'Modify inventory or block-container items.' },
  { name:'jfr', usage:'jfr <start|stop>', desc:'Control Java Flight Recorder profiling.' },
  { name:'kick', usage:'kick <player> [reason]', desc:'Disconnect a player.' },
  { name:'kill', usage:'kill [targets]', desc:'Kill entities or players.' },
  { name:'list', usage:'list [uuids]', desc:'List online players.' },
  { name:'locate', usage:'locate <structure|biome|poi> <id>', desc:'Find a world feature.' },
  { name:'loot', usage:'loot <target> <source> ...', desc:'Generate or move loot.' },
  { name:'me', usage:'me <action>', desc:'Broadcast an action message.' },
  { name:'msg', usage:'msg <targets> <message>', desc:'Send a private message.', aliases:['tell','w'] },
  { name:'op', usage:'op <targets>', desc:'Grant operator status.' },
  { name:'pardon', usage:'pardon <player>', desc:'Remove a player ban.' },
  { name:'pardon-ip', usage:'pardon-ip <target>', desc:'Remove an IP ban.' },
  { name:'particle', usage:'particle <name> ...', desc:'Spawn particles.' },
  { name:'place', usage:'place <feature|jigsaw|structure|template> ...', desc:'Place configured world features.' },
  { name:'playsound', usage:'playsound <sound> <source> <targets> ...', desc:'Play a sound for players.' },
  { name:'publish', usage:'publish [allowCommands] [gamemode] [port]', desc:'Open a local world to LAN when supported.' },
  { name:'random', usage:'random <value|roll|reset> ...', desc:'Generate or manage random sequences.' },
  { name:'recipe', usage:'recipe <give|take> <targets> <recipe>', desc:'Manage recipe knowledge.' },
  { name:'reload', usage:'reload', desc:'Reload data packs and server data.' },
  { name:'return', usage:'return <value|run|fail> ...', desc:'Control function return values.' },
  { name:'ride', usage:'ride <target> <mount|dismount> ...', desc:'Control entity riding.' },
  { name:'save-all', usage:'save-all [flush]', desc:'Save all worlds to disk.' },
  { name:'save-off', usage:'save-off', desc:'Disable automatic world saving.' },
  { name:'save-on', usage:'save-on', desc:'Enable automatic world saving.' },
  { name:'say', usage:'say <message>', desc:'Broadcast a server message.' },
  { name:'schedule', usage:'schedule <function|clear> ...', desc:'Schedule data pack functions.' },
  { name:'scoreboard', usage:'scoreboard <objectives|players> ...', desc:'Manage scoreboards.' },
  { name:'seed', usage:'seed', desc:'Show the world seed.' },
  { name:'setblock', usage:'setblock <pos> <block> ...', desc:'Set a block in the world.' },
  { name:'setidletimeout', usage:'setidletimeout <minutes>', desc:'Set player idle timeout.' },
  { name:'setworldspawn', usage:'setworldspawn [pos] [angle]', desc:'Set the world spawn.' },
  { name:'spawnpoint', usage:'spawnpoint [targets] [pos] [angle]', desc:'Set player spawn points.' },
  { name:'spectate', usage:'spectate [target] [player]', desc:'Make a player spectate an entity.' },
  { name:'spreadplayers', usage:'spreadplayers <center> <spreadDistance> <maxRange> ...', desc:'Spread entities around an area.' },
  { name:'stop', usage:'stop', desc:'Save and stop the Minecraft server.' },
  { name:'stopsound', usage:'stopsound <targets> [source] [sound]', desc:'Stop sounds for players.' },
  { name:'summon', usage:'summon <entity> [pos] [nbt]', desc:'Summon an entity.' },
  { name:'tag', usage:'tag <targets> <add|remove|list> [name]', desc:'Manage entity tags.' },
  { name:'team', usage:'team <add|empty|join|leave|list|modify|remove> ...', desc:'Manage scoreboard teams.' },
  { name:'teammsg', usage:'teammsg <message>', desc:'Message members of your team.', aliases:['tm'] },
  { name:'teleport', usage:'teleport <targets> <destination>', desc:'Teleport entities.', aliases:['tp'] },
  { name:'tellraw', usage:'tellraw <targets> <message>', desc:'Send a raw JSON chat message.' },
  { name:'tick', usage:'tick <query|rate|freeze|step|sprint|unfreeze> ...', desc:'Inspect or control server ticking.' },
  { name:'time', usage:'time <add|query|set> ...', desc:'Read or change world time.' },
  { name:'title', usage:'title <targets> <clear|reset|title|subtitle|actionbar|times> ...', desc:'Control on-screen titles.' },
  { name:'transfer', usage:'transfer <hostname> [port] [players]', desc:'Transfer players to another server.' },
  { name:'trigger', usage:'trigger <objective> [add|set] [value]', desc:'Modify a trigger scoreboard objective.' },
  { name:'weather', usage:'weather <clear|rain|thunder> [duration]', desc:'Change the weather.' },
  { name:'whitelist', usage:'whitelist <add|remove|list|on|off|reload> ...', desc:'Manage the server whitelist.' },
  { name:'worldborder', usage:'worldborder <add|center|damage|get|set|warning> ...', desc:'Manage the world border.' },
  { name:'tps', usage:'tps', desc:'Show TPS when supported by the server or plugins.', plugin:true },
  { name:'mspt', usage:'mspt', desc:'Show MSPT when supported by the server or plugins.', plugin:true },
];

const COMMAND_BY_NAME = new Map();
for (const def of COMMAND_CATALOG) {
  COMMAND_BY_NAME.set(def.name, def);
  for (const alias of def.aliases || []) COMMAND_BY_NAME.set(alias, { ...def, alias, name: alias, canonical: def.name, usage: def.usage.replace(def.name, alias) });
}
const GAMEMODES = ['survival','creative','adventure','spectator'];
const DIFFICULTIES = ['peaceful','easy','normal','hard'];
const SELECTORS = ['@a','@p','@r','@s','@e'];
const COMMON_ITEMS = ['minecraft:diamond','minecraft:diamond_sword','minecraft:diamond_pickaxe','minecraft:elytra','minecraft:golden_apple','minecraft:totem_of_undying','minecraft:experience_bottle','minecraft:ender_pearl'];
const COMMON_EFFECTS = ['minecraft:speed','minecraft:haste','minecraft:strength','minecraft:regeneration','minecraft:resistance','minecraft:night_vision','minecraft:invisibility','minecraft:slow_falling','minecraft:water_breathing'];
const GAMERULES = ['doDaylightCycle','doWeatherCycle','doMobSpawning','doMobLoot','doEntityDrops','keepInventory','mobGriefing','naturalRegeneration','showDeathMessages','announceAdvancements','commandBlockOutput','disableRaids','doFireTick','doInsomnia','doImmediateRespawn','doPatrolSpawning','doTraderSpawning','fallDamage','fireDamage','freezeDamage','playersSleepingPercentage','randomTickSpeed','spawnRadius'];
let commandSuggestions = [];
let commandSuggestionIndex = 0;
let commandHistory = [];
let commandHistoryIndex = -1;
let commandHistoryDraft = '';

function onlinePlayerNames() { return cfg.players(); }
function suggestion(value, description, kind = 'value', extra = {}) { return { value:String(value), description, kind, ...extra }; }
function fuzzyScore(value, query) {
  value = String(value).toLowerCase(); query = String(query || '').toLowerCase();
  if (!query) return 10;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1 + (value.length - query.length) / 100;
  const at = value.indexOf(query); if (at >= 0) return 3 + at / 10;
  let qi = 0; for (let i = 0; i < value.length && qi < query.length; i++) if (value[i] === query[qi]) qi++;
  return qi === query.length ? 8 + (value.length - query.length) / 100 : Infinity;
}
function filterSuggestionValues(items, query, limit = 8) {
  const unique = new Map();
  for (const item of items) if (!unique.has(item.value.toLowerCase())) unique.set(item.value.toLowerCase(), item);
  return [...unique.values()].map((item) => ({ item, score:fuzzyScore(item.value, query) })).filter((x) => Number.isFinite(x.score)).sort((a,b) => a.score - b.score || a.item.value.localeCompare(b.item.value)).slice(0, limit).map((x) => x.item);
}
function playerSuggestions(includeSelectors = true) {
  const items = onlinePlayerNames().map((name) => suggestion(name, 'Online player', 'player'));
  if (includeSelectors) items.push(...SELECTORS.map((x) => suggestion(x, 'Target selector', 'selector')));
  return items;
}
function commandContext() {
  const value = cmdInput.value, cursor = cmdInput.selectionStart ?? value.length;
  const before = value.slice(0, cursor), tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('	')) + 1;
  const afterCursor = value.slice(cursor), tokenTail = (afterCursor.match(/^\S*/) || [''])[0], tokenEnd = cursor + tokenTail.length;
  const currentRaw = before.slice(tokenStart), prefixText = before.slice(0, tokenStart).trim(), prior = prefixText ? prefixText.split(/\s+/) : [];
  if (!prior.length) return { value, cursor, tokenStart, tokenEnd, current:currentRaw.replace(/^\//,''), command:null, argIndex:-1, args:[], slash:currentRaw.startsWith('/') };
  const command = prior[0].replace(/^\//,'').toLowerCase();
  return { value, cursor, tokenStart, tokenEnd, current:currentRaw, command, argIndex:prior.length - 1, args:prior.slice(1), slash:prior[0].startsWith('/') };
}
function argumentSuggestions(ctx) {
  const cmd = ctx.command, i = ctx.argIndex, done = ctx.args, items = [];
  const sub = (done[0] || '').toLowerCase();
  const addEnums = (arr, desc, kind='value') => items.push(...arr.map((v) => suggestion(v, desc, kind)));
  if (cmd === 'gamemode') { if (i === 0) addEnums(GAMEMODES, 'Game mode', 'mode'); else if (i === 1) items.push(...playerSuggestions()); }
  else if (cmd === 'difficulty') { if (i === 0) addEnums(DIFFICULTIES, 'Difficulty', 'mode'); }
  else if (['kick','ban','op','deop','pardon'].includes(cmd)) { if (i === 0) items.push(...playerSuggestions(false)); }
  else if (cmd === 'kill') { if (i === 0) items.push(...playerSuggestions()); }
  else if (['msg','tell','w'].includes(cmd)) { if (i === 0) items.push(...playerSuggestions()); }
  else if (['tp','teleport','spectate'].includes(cmd)) { if (i <= 1) items.push(...playerSuggestions()); }
  else if (cmd === 'whitelist') {
    if (i === 0) addEnums(['add','remove','list','on','off','reload'], 'Whitelist action', 'action');
    else if (i === 1 && ['add','remove'].includes(sub)) items.push(...playerSuggestions(false));
  }
  else if (cmd === 'time') {
    if (i === 0) addEnums(['set','add','query'], 'Time action', 'action');
    else if (i === 1 && sub === 'set') addEnums(['day','noon','night','midnight'], 'Preset time', 'value');
    else if (i === 1 && sub === 'query') addEnums(['daytime','gametime','day'], 'Time query', 'value');
  }
  else if (cmd === 'weather') { if (i === 0) addEnums(['clear','rain','thunder'], 'Weather', 'value'); }
  else if (cmd === 'save-all') { if (i === 0) addEnums(['flush'], 'Force all chunks to disk', 'option'); }
  else if (cmd === 'list') { if (i === 0) addEnums(['uuids'], 'Include player UUIDs', 'option'); }
  else if (cmd === 'effect') {
    if (i === 0) addEnums(['give','clear'], 'Effect action', 'action');
    else if (i === 1) items.push(...playerSuggestions());
    else if (i === 2 && sub === 'give') addEnums(COMMON_EFFECTS, 'Common effect', 'effect');
  }
  else if (cmd === 'give') {
    if (i === 0) items.push(...playerSuggestions());
    else if (i === 1) addEnums(COMMON_ITEMS, 'Common item', 'item');
  }
  else if (cmd === 'clear') { if (i === 0) items.push(...playerSuggestions()); else if (i === 1) addEnums(COMMON_ITEMS, 'Common item', 'item'); }
  else if (cmd === 'gamerule') {
    if (i === 0) addEnums(GAMERULES, 'Game rule', 'rule');
    else if (i === 1) addEnums(['true','false'], 'Boolean value', 'value');
  }
  else if (cmd === 'help') {
    if (i === 0) items.push(...COMMAND_CATALOG.map((d) => suggestion(d.name, d.desc, 'command')));
  }
  else if (cmd === 'experience' || cmd === 'xp') {
    if (i === 0) addEnums(['add','set','query'], 'Experience action', 'action');
    else if (i === 1) items.push(...playerSuggestions());
    else if (i === 3) addEnums(['points','levels'], 'Experience unit', 'unit');
  }
  else if (cmd === 'title') {
    if (i === 0) items.push(...playerSuggestions());
    else if (i === 1) addEnums(['clear','reset','title','subtitle','actionbar','times'], 'Title action', 'action');
  }
  else if (cmd === 'tellraw') { if (i === 0) items.push(...playerSuggestions()); }
  else if (cmd === 'worldborder') { if (i === 0) addEnums(['add','center','damage','get','set','warning'], 'World border action', 'action'); }
  else if (cmd === 'forceload') { if (i === 0) addEnums(['add','query','remove'], 'Force-load action', 'action'); }
  else if (cmd === 'datapack') { if (i === 0) addEnums(['disable','enable','list'], 'Data pack action', 'action'); }
  else if (cmd === 'bossbar') { if (i === 0) addEnums(['add','get','list','remove','set'], 'Bossbar action', 'action'); }
  else if (cmd === 'scoreboard') { if (i === 0) addEnums(['objectives','players'], 'Scoreboard area', 'action'); }
  else if (cmd === 'team') { if (i === 0) addEnums(['add','empty','join','leave','list','modify','remove'], 'Team action', 'action'); }
  else if (cmd === 'tick') { if (i === 0) addEnums(['query','rate','freeze','step','sprint','unfreeze'], 'Tick action', 'action'); }
  else if (cmd === 'jfr') { if (i === 0) addEnums(['start','stop'], 'JFR action', 'action'); }
  else if (cmd === 'banlist') { if (i === 0) addEnums(['ips','players'], 'Ban list type', 'value'); }
  return filterSuggestionValues(items, ctx.current);
}
function buildCommandSuggestions() {
  const ctx = commandContext(); let list = [];
  if (!ctx.command) {
    const q = ctx.current;
    list = filterSuggestionValues(COMMAND_CATALOG.flatMap((d) => {
      const base = [suggestion(d.name, `${d.desc} · ${d.usage}`, d.plugin ? 'plugin' : 'command', { usage:d.usage })];
      for (const alias of d.aliases || []) base.push(suggestion(alias, `${d.desc} · alias for ${d.name}`, 'alias', { usage:d.usage.replace(d.name, alias) }));
      return base;
    }), q, 9);
    if (!q && commandHistory.length) {
      const recent = [...new Set(commandHistory.slice().reverse())].slice(0, 6).map((v) => suggestion(v, 'Recent command', 'history', { whole:true }));
      list = recent;
    }
  } else list = argumentSuggestions(ctx);
  return { ctx, list };
}
function suggestionTitle(ctx, list) {
  if (!ctx.command) return list.some((x) => x.kind === 'history') ? 'Recent commands' : 'Commands';
  const def = COMMAND_BY_NAME.get(ctx.command); return def ? def.usage : `${ctx.command} arguments`;
}
function renderCommandSuggestions({ resetIndex = false } = {}) {
  if (document.activeElement !== cmdInput || cmdInput.disabled) return hideCommandSuggestions();
  const { ctx, list } = buildCommandSuggestions(); commandSuggestions = list;
  if (resetIndex) commandSuggestionIndex = 0;
  commandSuggestionIndex = Math.max(0, Math.min(commandSuggestionIndex, Math.max(0, list.length - 1)));
  if (!list.length) return hideCommandSuggestions();
  $('cmdSuggestTitle').textContent = suggestionTitle(ctx, list); $('cmdSuggestCount').textContent = `${list.length}`;
  cmdSuggestList.innerHTML = list.map((item, i) => `<button type="button" class="cmd-suggest-item ${i === commandSuggestionIndex ? 'active' : ''}" data-suggest-index="${i}" role="option" aria-selected="${i === commandSuggestionIndex}"><span class="cmd-suggest-main">${esc(item.value)}</span><span class="cmd-suggest-kind">${esc(item.kind)}</span><span class="cmd-suggest-desc">${esc(item.description || '')}</span></button>`).join('');
  cmdSuggest.classList.add('open'); cmdInput.setAttribute('aria-expanded', 'true');
}
function hideCommandSuggestions() { commandSuggestions = []; cmdSuggest.classList.remove('open'); cmdSuggestList.innerHTML = ''; cmdInput.setAttribute('aria-expanded', 'false'); }
function acceptCommandSuggestion(index = commandSuggestionIndex) {
  const item = commandSuggestions[index]; if (!item) return false;
  const ctx = commandContext();
  if (item.whole) {
    cmdInput.value = item.value; cmdInput.setSelectionRange(item.value.length, item.value.length); hideCommandSuggestions(); return true;
  }
  let insert = item.value;
  if (!ctx.command && ctx.slash) insert = `/${insert}`;
  const before = ctx.value.slice(0, ctx.tokenStart), after = ctx.value.slice(ctx.tokenEnd);
  const needsSpace = !after.startsWith(' ') && !after.startsWith('	');
  cmdInput.value = before + insert + (needsSpace ? ' ' : '') + after;
  const caret = before.length + insert.length + (needsSpace ? 1 : 0);
  cmdInput.setSelectionRange(caret, caret); commandSuggestionIndex = 0; renderCommandSuggestions({ resetIndex:true }); return true;
}
function selectCommandSuggestion(delta) {
  if (!commandSuggestions.length) return false;
  commandSuggestionIndex = (commandSuggestionIndex + delta + commandSuggestions.length) % commandSuggestions.length;
  renderCommandSuggestions();
  cmdSuggestList.querySelector('.cmd-suggest-item.active')?.scrollIntoView({ block:'nearest' }); return true;
}
function navigateCommandHistory(delta) {
  if (!commandHistory.length) return false;
  if (commandHistoryIndex === -1) { commandHistoryDraft = cmdInput.value; commandHistoryIndex = commandHistory.length; }
  commandHistoryIndex = Math.max(0, Math.min(commandHistory.length, commandHistoryIndex + delta));
  cmdInput.value = commandHistoryIndex === commandHistory.length ? commandHistoryDraft : commandHistory[commandHistoryIndex];
  cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); renderCommandSuggestions({ resetIndex:true }); return true;
}

function classifyConsoleClient(text) {
  const line = String(text || ''); let level = 'info', category = 'general';
  if (/^\[stderr\]|\b(?:ERROR|SEVERE|FATAL)\b|Exception|Caused by:/i.test(line)) level = 'error';
  else if (/\bWARN(?:ING)?\b|Can'?t keep up!/i.test(line)) level = 'warn';
  else if (/^---/.test(line)) level = 'system';
  if (/\]: <[A-Za-z0-9_]{1,16}> /.test(line)) category = 'chat';
  else if (/ joined the game| left the game/.test(line)) category = 'player';
  else if (/issued server command:|\bcommand\b/i.test(line)) category = 'command';
  else if (/Starting minecraft server|Done \(|Stopping server|Saving players/i.test(line)) category = 'lifecycle';
  else if (/TPS|MSPT|Can'?t keep up!/i.test(line)) category = 'performance';
  return { level, category };
}
function consoleSearchMatches(raw) {
  const q = search.value.trim(); if (!q) return true;
  if (consoleRegex) { try { return new RegExp(q, 'i').test(raw); } catch (_) { return raw.toLowerCase().includes(q.toLowerCase()); } }
  return raw.toLowerCase().includes(q.toLowerCase());
}
function applyFilter(line) {
  const level = line.dataset.level || 'info', cat = line.dataset.category || 'general';
  let kindOk = consoleFilterKind === 'all' || consoleFilterKind === level || consoleFilterKind === cat;
  line.classList.toggle('hidden', !(kindOk && consoleSearchMatches(line.dataset.raw || '')));
}
function updateLineCount() { const visible = consoleEl.querySelectorAll('.console-line:not(.hidden)').length; $('lineCount').textContent = `${visible} / ${totalLines} lines`; }
function advanceContiguousConsole() { while (receivedConsoleSeq.has(contiguousConsoleSeq + 1)) contiguousConsoleSeq++; }
function appendLine(text, { animate = false, seq = null, at = null, initializeCursor = false, level = null, category = null } = {}) {
  text = String(text ?? ''); $('consoleEmpty')?.remove(); seq = Number(seq) || 0;
  if (contiguousConsoleSeq === 0 && seq > 0) contiguousConsoleSeq = seq - 1;
  if (seq) {
    if (receivedConsoleSeq.has(seq)) return;
    receivedConsoleSeq.add(seq); highestConsoleSeq = Math.max(highestConsoleSeq, seq); advanceContiguousConsole();
    if (seq <= consoleClearSeq) return; consoleSeen.add(seq);
  }
  const cls = classifyConsoleClient(text); level = level || cls.level; category = category || cls.category;
  if (consolePaused && animate) {
    pausedConsoleEntries.push({ text, seq, at, level, category });
    if (pausedConsoleEntries.length > 2000) pausedConsoleEntries.shift();
    $('consolePaused').classList.add('show'); $('consolePausedText').textContent = `Console paused · +${pausedConsoleEntries.length} new line${pausedConsoleEntries.length === 1 ? '' : 's'}`;
    return;
  }
  const d = document.createElement('div'); d.className = `console-line level-${level} cat-${category}`; if (animate) d.classList.add('live-enter');
  d.dataset.raw = text; d.dataset.level = level; d.dataset.category = category; if (seq) d.dataset.seq = String(seq); if (at != null) d.dataset.at = String(at);
  const ts = document.createElement('button'); ts.type = 'button'; ts.className = 'console-ts'; ts.textContent = at ? cfg.fmtClock(at, true) : '··:··:··'; if (at) ts.dataset.jumpTime = String(at);
  const msg = document.createElement('span'); msg.className = 'console-msg'; msg.textContent = text;
  d.append(ts, msg); consoleEl.appendChild(d); totalLines++;
  while (consoleEl.children.length > 5000) { const first = consoleEl.firstElementChild; if (first?.dataset?.seq) consoleSeen.delete(Number(first.dataset.seq)); first?.remove(); totalLines = Math.max(0, totalLines - 1); }
  applyFilter(d); updateLineCount(); if (animate) d.addEventListener('animationend', () => d.classList.remove('live-enter'), { once:true }); if (autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}
function mergeConsoleSnapshot(entries = [], { initializeCursor = false } = {}) {
  const sorted = [...entries].filter(Boolean).sort((a,b) => Number(a.seq)-Number(b.seq)); let first = true;
  for (const entry of sorted) { appendLine(entry.line, { seq:entry.seq, at:entry.at, level:entry.level, category:entry.category, animate:false, initializeCursor:initializeCursor && first }); first=false; }
}
function flushPausedConsole() {
  consolePaused = false; $('btnPauseConsole').classList.remove('active'); $('consolePaused').classList.remove('show');
  const entries = pausedConsoleEntries.splice(0); for (const x of entries) appendLine(x.text, { ...x, animate:false }); if (autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}
search.addEventListener('input', () => { [...consoleEl.querySelectorAll('.console-line')].forEach(applyFilter); updateLineCount(); });
document.querySelectorAll('[data-console-kind]').forEach((b) => b.addEventListener('click', () => { consoleFilterKind = b.dataset.consoleKind; document.querySelectorAll('[data-console-kind]').forEach((x) => x.classList.toggle('active', x === b)); [...consoleEl.querySelectorAll('.console-line')].forEach(applyFilter); updateLineCount(); }));
$('btnRegex').onclick = () => { consoleRegex = !consoleRegex; $('btnRegex').classList.toggle('active', consoleRegex); [...consoleEl.querySelectorAll('.console-line')].forEach(applyFilter); updateLineCount(); };
$('btnPauseConsole').onclick = () => { if (consolePaused) flushPausedConsole(); else { consolePaused = true; $('btnPauseConsole').classList.add('active'); $('consolePaused').classList.add('show'); $('consolePausedText').textContent = 'Console paused · +0 new lines'; } };
$('btnResumeConsole').onclick = flushPausedConsole;
$('btnAutoscroll').onclick = () => { autoscroll = !autoscroll; $('btnAutoscroll').classList.toggle('active', autoscroll); if (autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight; };
$('btnClear').onclick = () => { consoleClearSeq = highestConsoleSeq; consoleEl.innerHTML = ''; consoleSeen.clear(); totalLines = 0; updateLineCount(); };
consoleEl.addEventListener('click', (e) => { const b = e.target.closest('[data-jump-time]'); if (!b || !cfg.onJump) return; const t = Number(b.dataset.jumpTime); if (Number.isFinite(t)) cfg.onJump(t); });
async function sendCmd(cmd) {
  cmd = (cmd || '').trim(); if (!cmd) return;
  if (cmd.startsWith('/')) cmd = cmd.slice(1).trim();
  if (!cmd) return;
  try {
    await cfg.send(cmd);
    if (commandHistory.at(-1) !== cmd) commandHistory.push(cmd);
    if (commandHistory.length > 100) commandHistory = commandHistory.slice(-100);
    commandHistoryIndex = -1; commandHistoryDraft = ''; cmdInput.value = ''; hideCommandSuggestions();
  } catch (e) { appendLine(`--- command failed: ${e.message} ---`); }
}
$('btnSend').onclick = () => sendCmd(cmdInput.value);
cmdInput.addEventListener('input', () => { commandHistoryIndex = -1; commandSuggestionIndex = 0; renderCommandSuggestions({ resetIndex:true }); });
cmdInput.addEventListener('focus', () => renderCommandSuggestions({ resetIndex:true }));
cmdInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== cmdInput) hideCommandSuggestions(); }, 100));
cmdInput.addEventListener('click', () => renderCommandSuggestions());
cmdInput.addEventListener('keyup', (e) => { if (!['ArrowUp','ArrowDown','Tab','Escape','Enter'].includes(e.key)) renderCommandSuggestions(); });
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    if (cmdSuggest.classList.contains('open') && commandSuggestions.length) { e.preventDefault(); selectCommandSuggestion(-1); }
    else if (navigateCommandHistory(-1)) e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (cmdSuggest.classList.contains('open') && commandSuggestions.length) { e.preventDefault(); selectCommandSuggestion(1); }
    else if (navigateCommandHistory(1)) e.preventDefault();
  } else if (e.key === 'Tab' && commandSuggestions.length) {
    e.preventDefault(); acceptCommandSuggestion();
  } else if (e.key === 'Escape') {
    hideCommandSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault(); sendCmd(cmdInput.value);
  }
});
cmdSuggestList.addEventListener('mousemove', (e) => { const b = e.target.closest('[data-suggest-index]'); if (!b) return; const i = Number(b.dataset.suggestIndex); if (Number.isFinite(i) && i !== commandSuggestionIndex) { commandSuggestionIndex = i; renderCommandSuggestions(); } });
cmdSuggestList.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-suggest-index]'); if (!b) return; e.preventDefault(); const i = Number(b.dataset.suggestIndex); if (Number.isFinite(i)) acceptCommandSuggestion(i); cmdInput.focus(); });
quickButtons.forEach((b) => b.onclick = () => sendCmd(b.dataset.command));

    return {
      appendLine, mergeConsoleSnapshot,
      state: {
        get contiguous() { return contiguousConsoleSeq; }, set contiguous(v) { contiguousConsoleSeq = v; },
        get highest() { return highestConsoleSeq; },
      },
      reset() { consoleEl.innerHTML = ''; consoleSeen.clear(); receivedConsoleSeq.clear(); totalLines = 0; contiguousConsoleSeq = 0; highestConsoleSeq = 0; consoleClearSeq = 0; },
      setEnabled(on) { cmdInput.disabled = !on; $('btnSend').disabled = !on; quickButtons.forEach((b) => { b.disabled = !on; }); if (!on) hideCommandSuggestions(); },
      focusSearch() { search.focus(); },
      scrollToEnd() { if (autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight; },
      focus() { cmdInput.focus(); },
      refreshSuggestions() { if (document.activeElement === cmdInput) renderCommandSuggestions(); },
    };
  }
  window.MeowConsole = { mount };
})();

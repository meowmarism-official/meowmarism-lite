// Page state: live values, history buffers and the display state.
const BASE = window.__BASE || '';
let currentPage = null;
const showPage = (page, opts) => INSTANCE_SHELL.show(page, opts);
const pageFromPath = () => INSTANCE_SHELL.pageFromPath();

let running = false;
let isSleeping = false;
let startedAt = null;
let lastExitAt = null;
let restartCount = 0;
let latest = null;
let connected = false;
let serverPhase = 'offline';
let readyAt = null;
let startupDurationMs = null;
let lastReadyAt = null;
let lastStartupDurationMs = null;
let chartRangeMs = 60_000;
let panelInstanceId = null;
let lastStatsSeq = 0;
let lastSyncAt = 0;
let hasSnapshot = false;
let lastDisplayedSampleAt = 0;
let lastReceivedSample = null;
let lastBatchCount = 0;
let backgroundPaused = document.hidden;
let recoveryState = document.hidden ? 'background' : 'idle';
let recoveryMessage = 'idle';
let recoveryRequest = null;
let clockOffsetMs = 0;
let clockRttMs = null;
let clockSynced = false;
let lastClockSyncAt = 0;
let catchupUntil = 0;
let peakHold = { cpu: 0, ram: 0, procCpu: 0, until: 0 };
let visibleSyncMode = 'live';
let syncModeCandidate = 'live';
let syncModeCandidateAt = performance.now();
let syncModeChangedAt = performance.now();
let catchupGoodSince = 0;
let chartLiveMode = true;
let chartAnchorTime = null;
let sharedHoverRatio = null;
let chartDrag = null;
const timelineEntries = [];
const auditEntriesClient = [];
let restartPlanState = null;

const rawHistory = [];
const history1s = [];
const history5s = [];
const history1m = [];
const history10m = [];
const seenSampleSeq = new Set();
let contiguousSampleSeq = 0;
let highestSampleSeq = 0;

const CONSOLE = MeowConsole.mount({
  el: $('consoleRoot'),
  send: (cmd) => post('/command', { cmd }),
  players: () => (latest?.players?.list || []).map((p) => p.name).filter(Boolean),
  fmtClock: (ts, withSeconds) => fmtClock(ts, withSeconds),
  downloadHref: '/log',
  onJump: (at) => { chartLiveMode = false; chartAnchorTime = at; updateHistoryModeUi(); showPage('performance', { push: true }); scheduleChartDraw(true); },
  t, esc,
});
const { appendLine, mergeConsoleSnapshot } = CONSOLE;
const chartHover = new Map();
const chartScaleState = new Map();


let playbackQueue = [];
let playbackTimer = null;
let lastQueuedSeq = 0;

const displayState = {
  cpu: null, ram: null, procCpu: null, procRam: null, ramUsedGB: null,
  rx: null, tx: null, procRead: null, procWrite: null, cores: [],
};
const displayTarget = { ...displayState, cores: [] };
let lastRenderFrame = performance.now();
let lastDomRender = 0;
let chartDrawPending = false;
let lastChartDrawAt = 0;

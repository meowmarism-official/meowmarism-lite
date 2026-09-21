// Toasts, the sample to display pipeline, history ingest and playback.
function toast(message, type = 'ok') { const d = document.createElement('div'); d.className = `toast ${type}`; d.textContent = message; $('toastStack').appendChild(d); setTimeout(() => d.remove(), 3200); }


function renderCores(values = []) {
  const root = $('coreGrid');
  if (root.children.length !== values.length) root.innerHTML = values.map((_, i) => `<div class="core"><div class="core-top"><span>CPU ${i}</span><span class="core-v">0%</span></div><div class="core-track"><div class="core-fill"></div></div></div>`).join('');
  [...root.children].forEach((el, i) => {
    const v = Math.max(0, Math.min(100, Number(values[i]) || 0));
    el.querySelector('.core-v').textContent = `${Math.round(v)}%`;
    el.querySelector('.core-fill').style.width = `${v}%`;
  });
}

function sampleMetric(sample, smoothKey, rawKey) {
  const smoothRaw = sample?.[smoothKey];
  if (smoothRaw != null) { const smooth = Number(smoothRaw); if (Number.isFinite(smooth)) return smooth; }
  const rawValue = sample?.[rawKey];
  if (rawValue == null) return null;
  const raw = Number(rawValue);
  return Number.isFinite(raw) ? raw : null;
}
function aggregateAsSample(s = {}) {
  const cpu = s.cpu || {}, mem = s.memory || {}, net = s.network || {}, proc = s.server || {};
  return {
    seq: s.panel?.latestRawSeq || highestSampleSeq,
    at: s.sampledAt || serverNow(),
    cpu: cpu.current ?? cpu.usage ?? 0, cpuSmooth: cpu.usage ?? cpu.current ?? 0,
    cores: cpu.perCoreCurrent || cpu.perCore || [], coresSmooth: cpu.perCore || cpu.perCoreCurrent || [],
    ram: mem.current ?? mem.percent ?? 0, ramSmooth: mem.percent ?? mem.current ?? 0,
    ramUsedGB: mem.usedGB ?? null, ramUsedSmoothGB: mem.usedAvgGB ?? mem.usedGB ?? null,
    rx: net.rxCurrentBps ?? net.rxBps ?? 0, rxSmooth: net.rxBps ?? net.rxCurrentBps ?? 0,
    tx: net.txCurrentBps ?? net.txBps ?? 0, txSmooth: net.txBps ?? net.txCurrentBps ?? 0,
    procCpu: proc.cpuCurrent ?? proc.cpuPercent ?? null, procCpuSmooth: proc.cpuPercent ?? proc.cpuCurrent ?? null,
    procRam: proc.rssMB ?? null, procRamSmooth: proc.rssAvgMB ?? proc.rssMB ?? null,
    procRead: proc.readCurrentBps ?? proc.readBps ?? null, procReadSmooth: proc.readBps ?? proc.readCurrentBps ?? null,
    procWrite: proc.writeCurrentBps ?? proc.writeBps ?? null, procWriteSmooth: proc.writeBps ?? proc.writeCurrentBps ?? null,
    players: s.players?.online ?? 0,
  };
}

function setRenderTarget(sample, { snap = false, catchup = false } = {}) {
  if (!sample) return;
  const target = {
    cpu: sampleMetric(sample, 'cpuSmooth', 'cpu'),
    ram: sampleMetric(sample, 'ramSmooth', 'ram'),
    procCpu: sampleMetric(sample, 'procCpuSmooth', 'procCpu'),
    procRam: sampleMetric(sample, 'procRamSmooth', 'procRam'),
    ramUsedGB: sampleMetric(sample, 'ramUsedSmoothGB', 'ramUsedGB'),
    rx: sampleMetric(sample, 'rxSmooth', 'rx'),
    tx: sampleMetric(sample, 'txSmooth', 'tx'),
    procRead: sampleMetric(sample, 'procReadSmooth', 'procRead'),
    procWrite: sampleMetric(sample, 'procWriteSmooth', 'procWrite'),
    cores: Array.isArray(sample.coresSmooth) && sample.coresSmooth.length ? sample.coresSmooth : (sample.cores || []),
  };
  Object.assign(displayTarget, target);
  const rawCpu = Number(sample.cpu), rawRam = Number(sample.ram), rawProc = Number(sample.procCpu);
  if (Number.isFinite(rawCpu)) peakHold.cpu = Math.max(peakHold.cpu || 0, rawCpu);
  if (Number.isFinite(rawRam)) peakHold.ram = Math.max(peakHold.ram || 0, rawRam);
  if (Number.isFinite(rawProc)) peakHold.procCpu = Math.max(peakHold.procCpu || 0, rawProc);
  peakHold.until = performance.now() + 1800;
  if (snap || displayState.cpu == null) {
    for (const key of Object.keys(target)) displayState[key] = Array.isArray(target[key]) ? [...target[key]] : target[key];
  }
  if (catchup) catchupUntil = performance.now() + 450;
  lastDisplayedSampleAt = Number(sample.at) || serverNow();
}

function renderDisplay() {
  const cpu = displayState.cpu, ram = displayState.ram, procCpu = displayState.procCpu, procRam = displayState.procRam;
  $('overviewCpu').textContent = pct(cpu); $('overviewRam').textContent = pct(ram);
  $('ovProcCpu').textContent = procCpu == null ? '—' : pct(procCpu); $('ovProcRam').textContent = procRam == null ? '—' : fmtMB(procRam);
  $('ovRx').textContent = fmtRate(displayState.rx); $('ovTx').textContent = fmtRate(displayState.tx);
  $('ovProcRead').textContent = fmtRate(displayState.procRead); $('ovProcWrite').textContent = fmtRate(displayState.procWrite);
  $('perfCpu').textContent = pct(cpu); setBar('perfCpuBar', cpu, peakHold.cpu);
  $('perfRam').textContent = pct(ram); setBar('perfRamBar', ram, peakHold.ram);
  $('perfProc').textContent = procCpu == null ? '—' : pct(procCpu); setBar('perfProcBar', procCpu, peakHold.procCpu);
  if (displayState.ramUsedGB != null) $('perfRamUsed').textContent = `${fmtGB(displayState.ramUsedGB)} used`;
  $('perfProcRam').textContent = procRam == null ? '— RAM' : `${fmtMB(procRam)} RAM`;
  $('sysProcCpu').textContent = procCpu == null ? '—' : pct(procCpu); $('sysProcRam').textContent = procRam == null ? '—' : fmtMB(procRam);
  $('sysProcRead').textContent = fmtRate(displayState.procRead); $('sysProcWrite').textContent = fmtRate(displayState.procWrite);
  renderCores(displayState.cores || []);
}

function lerpMetric(current, target, alpha) {
  if (!Number.isFinite(Number(target))) return current;
  if (!Number.isFinite(Number(current))) return Number(target);
  return Number(current) + (Number(target) - Number(current)) * alpha;
}
function renderLoop(now) {
  const dt = Math.max(1, Math.min(100, now - lastRenderFrame)); lastRenderFrame = now;
  const fastCatchup = now < catchupUntil;
  const tau = fastCatchup ? 65 : 135;
  const alpha = 1 - Math.exp(-dt / tau);
  for (const key of ['cpu', 'ram', 'procCpu', 'procRam', 'ramUsedGB', 'rx', 'tx', 'procRead', 'procWrite']) displayState[key] = lerpMetric(displayState[key], displayTarget[key], alpha);
  const targetCores = Array.isArray(displayTarget.cores) ? displayTarget.cores : [];
  if (!Array.isArray(displayState.cores) || displayState.cores.length !== targetCores.length) displayState.cores = [...targetCores];
  else displayState.cores = targetCores.map((v, i) => lerpMetric(displayState.cores[i], v, Math.min(1, alpha * 1.35)));
  if (now > peakHold.until) {
    peakHold.cpu = Math.max(Number(displayState.cpu) || 0, peakHold.cpu * .94);
    peakHold.ram = Math.max(Number(displayState.ram) || 0, peakHold.ram * .94);
    peakHold.procCpu = Math.max(Number(displayState.procCpu) || 0, peakHold.procCpu * .94);
  }
  if (now - lastDomRender >= 33) { lastDomRender = now; renderDisplay(); updateTelemetry(); }
  requestAnimationFrame(renderLoop);
}

function sampleToHistoryPoint(sample) {
  return {
    seq: Number(sample.seq) || 0,
    t: Number(sample.at) || serverNow(),
    cpuRaw: Number(sample.cpu) || 0, cpu: sampleMetric(sample, 'cpuSmooth', 'cpu') ?? 0,
    ramRaw: Number(sample.ram) || 0, ram: sampleMetric(sample, 'ramSmooth', 'ram') ?? 0,
    procCpuRaw: sample.procCpu == null ? null : Number(sample.procCpu), procCpu: sampleMetric(sample, 'procCpuSmooth', 'procCpu'),
    procRamRaw: sample.procRam == null ? null : Number(sample.procRam), procRam: sampleMetric(sample, 'procRamSmooth', 'procRam'),
    rxRaw: Number(sample.rx) || 0, rx: sampleMetric(sample, 'rxSmooth', 'rx') ?? 0,
    txRaw: Number(sample.tx) || 0, tx: sampleMetric(sample, 'txSmooth', 'tx') ?? 0,
    players: Number.isFinite(Number(sample.players)) ? Number(sample.players) : (latest?.players?.online || 0),
  };
}

function trimRawHistory() {
  const cutoff = serverNow() - 5 * 60 * 1000;
  while (rawHistory.length > 1 && rawHistory[0].t < cutoff) rawHistory.shift();
  if (rawHistory.length > 7000) rawHistory.splice(0, rawHistory.length - 7000);
  if (seenSampleSeq.size > 10000) {
    const keepFrom = rawHistory[0]?.seq || Math.max(0, contiguousSampleSeq - 100);
    for (const seq of seenSampleSeq) if (seq < keepFrom) seenSampleSeq.delete(seq);
  }
}
function mergeAggregate(target, incoming = [], max = 2000) {
  const byTime = new Map(target.map((p) => [Number(p.t), p]));
  for (const p of incoming || []) { const t = Number(p?.t); if (Number.isFinite(t)) byTime.set(t, { ...p, t }); }
  target.splice(0, target.length, ...[...byTime.values()].sort((a, b) => a.t - b.t).slice(-max));
}
function mergeHistoryTiers(tiers = {}, legacy = []) {
  mergeAggregate(history1s, tiers.oneSecond || legacy || [], 1000);
  mergeAggregate(history5s, tiers.fiveSecond || [], 800);
  mergeAggregate(history1m, tiers.oneMinute || [], 1500);
  mergeAggregate(history10m, tiers.tenMinute || [], 1100);
}

function advanceContiguousSamples() {
  while (seenSampleSeq.has(contiguousSampleSeq + 1)) contiguousSampleSeq++;
}
function ingestSamples(samples, { enqueue = true, initializeCursor = false } = {}) {
  if (!Array.isArray(samples) || !samples.length) return [];
  const clean = samples.filter(Boolean).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0) || Number(a.at || 0) - Number(b.at || 0));
  const firstSeq = Number(clean.find((s) => Number(s.seq) > 0)?.seq || 0);
  if (contiguousSampleSeq === 0 && firstSeq > 0) contiguousSampleSeq = firstSeq - 1;
  const added = [];
  for (const sample of clean) {
    const seq = Number(sample.seq) || 0;
    if (seq && seenSampleSeq.has(seq)) continue;
    if (seq) { seenSampleSeq.add(seq); highestSampleSeq = Math.max(highestSampleSeq, seq); }
    rawHistory.push(sampleToHistoryPoint(sample));
    PLAYERS.notePeak(sample.players);
    lastReceivedSample = sample;
    added.push(sample);
    if (enqueue && !backgroundPaused) enqueuePlaybackSample(sample);
  }
  rawHistory.sort((a, b) => a.t - b.t);
  trimRawHistory(); advanceContiguousSamples(); scheduleChartDraw();
  return added;
}

function enqueuePlaybackSample(sample) {
  const seq = Number(sample.seq) || 0;
  if (seq && seq <= lastQueuedSeq) return;
  if (seq) lastQueuedSeq = seq;
  playbackQueue.push(sample);
  if (playbackQueue.length > 90) {
    // History already contains every point. Visual state can skip old frames during catch-up.
    playbackQueue = playbackQueue.slice(-28);
    recoveryState = 'catching-up'; recoveryMessage = 'fast catch-up';
  }
  if (playbackTimer == null && !backgroundPaused) playNextSample();
}
function playbackDelayFor(sample, next) {
  const base = next && Number(next.at) > Number(sample.at) ? Math.max(16, Math.min(120, Number(next.at) - Number(sample.at))) : 50;
  const delay = Math.max(0, serverNow() - (Number(sample.at) || serverNow()));
  if (delay > 6000) return 3;
  if (delay > 4000) return 5;
  if (delay > 2800) return 9;
  if (delay > 2100) return 27;
  if (delay > 1650) return 37;
  return base;
}
function playNextSample() {
  if (backgroundPaused || !playbackQueue.length) { playbackTimer = null; return; }
  const oldestDelay = Math.max(0, serverNow() - (Number(playbackQueue[0]?.at) || serverNow()));
  if (oldestDelay > 4500 && playbackQueue.length > 36) playbackQueue.splice(0, playbackQueue.length - 24);
  const sample = playbackQueue.shift(), next = playbackQueue[0];
  setRenderTarget(sample);
  const delay = playbackDelayFor(sample, next);
  const displayDelay = Math.max(0, serverNow() - (Number(sample.at) || serverNow()));
  if (displayDelay > 1650 || playbackQueue.length > 30) { recoveryState = 'catching-up'; recoveryMessage = `catch-up ${playbackQueue.length}`; }
  else if (recoveryState === 'catching-up') { recoveryState = 'idle'; recoveryMessage = 'idle'; }
  playbackTimer = setTimeout(playNextSample, delay);
}
function stopPlayback() { if (playbackTimer != null) clearTimeout(playbackTimer); playbackTimer = null; playbackQueue = []; }
function catchUpDisplay(sample, reason = 'recovery') {
  if (!sample) return;
  stopPlayback(); lastQueuedSeq = Math.max(lastQueuedSeq, Number(sample.seq) || 0);
  recoveryState = 'catching-up'; recoveryMessage = reason;
  setRenderTarget(sample, { catchup: true });
  setTimeout(() => { if (!backgroundPaused && recoveryState === 'catching-up') { recoveryState = 'idle'; recoveryMessage = 'idle'; updateSyncIndicator(); } }, 520);
}

function aggregatePointToChart(p) {
  return { t: Number(p.t), cpu: Number(p.cpu) || 0, cpuRaw: Number(p.cpuCurrent ?? p.cpu) || 0, ram: Number(p.ram) || 0, ramRaw: Number(p.ramCurrent ?? p.ram) || 0, procCpu: p.procCpu == null ? null : Number(p.procCpu), procCpuRaw: p.procCpu == null ? null : Number(p.procCpu), procRam: p.procRam == null ? null : Number(p.procRam), rx: Number(p.rx) || 0, rxRaw: Number(p.rxPeak ?? p.rx) || 0, tx: Number(p.tx) || 0, txRaw: Number(p.txPeak ?? p.tx) || 0, players: Number(p.players) || 0 };
}
function chartHistoryForRange(range) {
  const latestTime = rawHistory.at(-1)?.t || history1s.at(-1)?.t || history5s.at(-1)?.t || history1m.at(-1)?.t || serverNow();
  const now = chartLiveMode ? latestTime : Math.min(Number(chartAnchorTime) || latestTime, latestTime);
  const items = [];
  const add = (arr, from, to, convert = false) => { for (const p of arr) { const t = Number(p?.t); if (t >= from && t <= to) items.push(convert ? aggregatePointToChart(p) : p); } };
  const start = now - range;
  if (range <= 5 * 60_000) {
    const rawStart = rawHistory[0]?.t ?? Infinity;
    if (start < rawStart) add(history1s, start, rawStart - 1, true);
    add(rawHistory, Math.max(start, rawStart === Infinity ? start : rawStart), now);
  } else if (range <= 15 * 60_000) {
    const rawCut = now - 5 * 60_000;
    add(history1s, start, rawCut - 1, true); add(rawHistory, rawCut, now);
  } else if (range <= 60 * 60_000) {
    const secCut = now - 15 * 60_000, rawCut = now - 5 * 60_000;
    add(history5s, start, secCut - 1, true); add(history1s, secCut, rawCut - 1, true); add(rawHistory, rawCut, now);
  } else {
    const fiveCut = now - 60 * 60_000, secCut = now - 15 * 60_000, rawCut = now - 5 * 60_000;
    const dayCut = now - 24 * 60 * 60_000;
    if (range > 24 * 60 * 60_000) add(history10m, start, dayCut - 1, true);
    add(history1m, Math.max(start, dayCut), fiveCut - 1, true); add(history5s, fiveCut, secCut - 1, true); add(history1s, secCut, rawCut - 1, true); add(rawHistory, rawCut, now);
  }
  const byTime = new Map(); for (const p of items) if (Number.isFinite(Number(p.t))) byTime.set(Number(p.t), p);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

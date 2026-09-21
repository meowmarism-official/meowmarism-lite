// Clock sync, snapshot, recovery and the event stream.
async function syncClock() {
  try {
    const t0 = Date.now(); const res = await fetch('/api/time', { cache: 'no-store' }); const d = await res.json(); const t1 = Date.now();
    if (!res.ok || !Number.isFinite(Number(d.serverTime))) return;
    const offset = Number(d.serverTime) - ((t0 + t1) / 2), rtt = t1 - t0;
    if (!clockSynced || rtt <= (clockRttMs ?? Infinity) * 1.5) clockOffsetMs = clockSynced ? clockOffsetMs * .75 + offset * .25 : offset;
    clockRttMs = rtt; clockSynced = true; lastClockSyncAt = Date.now(); updateTelemetry();
  } catch (_) {}
}
setInterval(syncClock, 30000);

function resetForNewInstance() {
  stopPlayback(); rawHistory.length = 0; history1s.length = 0; history5s.length = 0; history1m.length = 0; history10m.length = 0; seenSampleSeq.clear(); contiguousSampleSeq = 0; highestSampleSeq = 0; lastQueuedSeq = 0; lastReceivedSample = null;
  CONSOLE.reset(); lastStatsSeq = 0;
  appendLine('--- panel restarted · state resynced ---', { animate: true });
}

function applySnapshot(d) {
  if (!d) return;
  const instanceChanged = panelInstanceId && d.instanceId && panelInstanceId !== d.instanceId;
  if (instanceChanged) resetForNewInstance();
  panelInstanceId = d.instanceId || panelInstanceId;
  if (!clockSynced && Number.isFinite(Number(d.serverTime))) clockOffsetMs = Number(d.serverTime) - Date.now();
  updateStats(d); SETTINGS.render(d.settings); mergeHistoryTiers(d.historyTiers || {}, d.history || []); mergeTimeline(d.timeline || []); mergeAudit(d.audit || []); applyRestartPlan(d.restartPlan || d.stats?.restartPlan || null);
  if ('sleeping' in d) { isSleeping = d.sleeping; updateLifecycleUi(); }
  const recent = Array.isArray(d.recentSamples) ? d.recentSamples : [];
  ingestSamples(recent, { enqueue: false, initializeCursor: !hasSnapshot });
  mergeConsoleSnapshot(d.console || [], { initializeCursor: !hasSnapshot });
  lastStatsSeq = Math.max(lastStatsSeq, Number(d.seq?.stats) || 0);
  if (recent.length) { lastReceivedSample = recent[recent.length - 1]; setRenderTarget(lastReceivedSample, { snap: !hasSnapshot, catchup: hasSnapshot }); }
  else if (d.stats) setRenderTarget(aggregateAsSample(d.stats), { snap: !hasSnapshot });
  hasSnapshot = true; markSynced(); scheduleChartDraw(true); updateTelemetry();
  if (!backgroundPaused && ((recent[0]?.seq && contiguousSampleSeq + 1 < Number(recent[0].seq)) || (d.seq?.sample && contiguousSampleSeq < Number(d.seq.sample)))) scheduleRecovery('snapshot gap');
}

async function recoverMissing(reason = 'reconnect') {
  if (backgroundPaused) return;
  if (recoveryRequest) return recoveryRequest;
  recoveryState = 'recovering'; recoveryMessage = reason; updateSyncIndicator(); updateTelemetry();
  const sampleCursor = contiguousSampleSeq, consoleCursor = CONSOLE.state.contiguous;
  recoveryRequest = (async () => {
    try {
      const res = await fetch(`/api/recover?afterSampleSeq=${encodeURIComponent(sampleCursor)}&afterConsoleSeq=${encodeURIComponent(consoleCursor)}`, { cache: 'no-store' });
      const d = await res.json(); if (!res.ok) throw new Error(d?.error || `HTTP ${res.status}`);
      if (panelInstanceId && d.instanceId && panelInstanceId !== d.instanceId) {
        const snap = await fetch('/snapshot', { cache: 'no-store' }).then((r) => r.json()); applySnapshot(snap); return;
      }
      panelInstanceId = d.instanceId || panelInstanceId;
      if (d.truncated?.samples && Array.isArray(d.samples) && d.samples.length) {
        const first = Number(d.samples[0].seq) || 0; if (first) contiguousSampleSeq = first - 1;
        recoveryMessage = 'cache edge';
      }
      if (d.truncated?.console && Array.isArray(d.console) && d.console.length) {
        const first = Number(d.console[0].seq) || 0; if (first) CONSOLE.state.contiguous = first - 1;
      }
      mergeHistoryTiers(d.historyTiers || {}); ingestSamples(d.samples || [], { enqueue: false }); mergeConsoleSnapshot(d.console || []); mergeTimeline(d.timeline || []); mergeAudit(d.audit || []); applyRestartPlan(d.restartPlan || d.stats?.restartPlan || null); updateStats({ ...(d.lifecycle || {}), stats: d.stats });
      const latestRecovered = (d.samples || []).at(-1) || lastReceivedSample;
      if (latestRecovered) catchUpDisplay(latestRecovered, d.truncated?.samples ? 'cache catch-up' : 'caught up');
      else { recoveryState = 'idle'; recoveryMessage = 'idle'; }
      markSynced(); scheduleChartDraw(true);
    } catch (e) {
      recoveryState = 'idle'; recoveryMessage = 'retry pending'; console.warn('recovery failed', e);
    } finally {
      recoveryRequest = null; updateSyncIndicator(); updateTelemetry();
    }
  })();
  return recoveryRequest;
}
function scheduleRecovery(reason) { if (!backgroundPaused) setTimeout(() => recoverMissing(reason), 0); }

document.addEventListener('visibilitychange', () => {
  backgroundPaused = document.hidden;
  if (backgroundPaused) {
    stopPlayback(); recoveryState = 'background'; recoveryMessage = 'background'; updateSyncIndicator();
  } else {
    recoveryState = 'recovering'; recoveryMessage = 'tab resume'; updateSyncIndicator();
    recoverMissing('tab resume'); syncClock(); scheduleChartDraw(true);
  }
});

const es = new EventSource('/api/events');
es.onopen = () => { setConnected(true); syncClock(); if (hasSnapshot && !backgroundPaused) recoverMissing('reconnect'); };
es.onerror = () => setConnected(false);
es.addEventListener('snapshot', (e) => { try { applySnapshot(JSON.parse(e.data)); } catch (err) { console.error(err); } });
es.addEventListener('console', (e) => {
  try {
    const d = JSON.parse(e.data), seq = Number(d.seq) || 0;
    if (seq && CONSOLE.state.contiguous && seq > CONSOLE.state.contiguous + 1) scheduleRecovery('console gap');
    appendLine(d.line, { seq, at: d.at, level:d.level, category:d.category, animate: !backgroundPaused }); markSynced();
  } catch (err) { console.error(err); }
});
es.addEventListener('status', (e) => { try { setLifecycle(JSON.parse(e.data)); updateUptimes(); markSynced(); } catch (_) {} });
es.addEventListener('settings', (e) => { try { SETTINGS.render(JSON.parse(e.data)); markSynced(); } catch (err) { console.error(err); } });
es.addEventListener('timeline', (e) => { try { mergeTimeline([JSON.parse(e.data)]); markSynced(); } catch (err) { console.error(err); } });
es.addEventListener('audit', (e) => { try { mergeAudit([JSON.parse(e.data)]); markSynced(); } catch (err) { console.error(err); } });
es.addEventListener('restart-plan', (e) => { try { applyRestartPlan(JSON.parse(e.data)); markSynced(); } catch (err) { console.error(err); } });
es.addEventListener('backup', (e) => { try { loadBackups(); } catch (err) { console.error(err); } });

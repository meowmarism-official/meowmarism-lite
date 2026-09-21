// Starts everything once all the files are loaded: page, timers, the event stream and the first data requests.
// Nothing above this file may start work on its own, because files load one after the other.
showPage(pageFromPath(), { replace: location.pathname === `${BASE}/` || location.pathname === BASE });
setInterval(updateSyncIndicator, 500);
setInterval(updateUptimes, 250);
setInterval(() => { if (restartPlanState?.executeAt) applyRestartPlan({ ...restartPlanState, remainingSec: Math.max(0, Math.ceil((restartPlanState.executeAt - serverNow()) / 1000)) }); }, 1000);
requestAnimationFrame(renderLoop);
setInterval(syncClock, 30000);
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
loadBackups();
setInterval(loadBackups, 30000);
loadMods();
loadAutomation();
es.addEventListener('stats', (e) => {
  try {
    const d = JSON.parse(e.data);
    if (d.instanceId && panelInstanceId && d.instanceId !== panelInstanceId) { scheduleRecovery('panel restart'); return; }
    const batchSeq = Number(d.seq) || 0; if (batchSeq && batchSeq <= lastStatsSeq) return; if (batchSeq) lastStatsSeq = batchSeq;
    updateStats(d); appendHistoryFromStats(d);
    const samples = Array.isArray(d.samples) ? d.samples : [];
    if (samples.length) {
      const firstSeq = Number(samples[0].seq) || 0;
      if (firstSeq && contiguousSampleSeq && firstSeq > contiguousSampleSeq + 1) scheduleRecovery('sample gap');
      ingestSamples(samples, { enqueue: !backgroundPaused, initializeCursor: !hasSnapshot });
    } else if (d.stats) setRenderTarget(aggregateAsSample(d.stats));
    markSynced();
  } catch (err) { console.error(err); }
});
setTimeout(() => { if (!hasSnapshot) fetch('/snapshot', { cache: 'no-store' }).then((r) => r.json()).then(applySnapshot).catch(() => {}); }, 1500);
syncClock();
updateHistoryModeUi();
swLoad();

// Sync indicator, server lifecycle, telemetry and uptime display.
function markSynced() { lastSyncAt = Date.now(); updateSyncIndicator(); }
function setConnected(v) {
  connected = !!v;
  $('liveRow').classList.toggle('online', connected);
  $('connectionText').textContent = connected ? 'live connected' : 'disconnected';
  updateSyncIndicator();
}
function currentDisplayDelay() {
  return lastDisplayedSampleAt ? Math.max(0, serverNow() - lastDisplayedSampleAt) : null;
}
function desiredSyncMode() {
  const age = lastSyncAt ? Date.now() - lastSyncAt : Infinity;
  const delay = currentDisplayDelay();
  if (backgroundPaused) return 'paused';
  if (!connected) return hasSnapshot ? 'reconnecting' : 'connecting';
  if (recoveryState === 'recovering') return 'syncing';
  const behind = (delay != null && delay > 1500) || playbackQueue.length > 28;
  if (visibleSyncMode === 'catching') {
    const good = delay != null && delay < 450 && playbackQueue.length < 8;
    if (good) { if (!catchupGoodSince) catchupGoodSince = performance.now(); }
    else catchupGoodSince = 0;
    if (!good || performance.now() - catchupGoodSince < 1600) return 'catching';
  }
  catchupGoodSince = 0;
  if (behind) return 'catching';
  if (age >= 3000) return 'stale';
  return 'live';
}
function updateSyncIndicator() {
  const pill = $('syncPill'), text = $('syncText'); if (!pill || !text) return;
  const desired = desiredSyncMode(), now = performance.now();
  if (desired !== syncModeCandidate) { syncModeCandidate = desired; syncModeCandidateAt = now; }
  const urgent = ['paused','reconnecting','connecting','syncing'].includes(desired);
  const dwell = desired === 'catching' ? 450 : 900;
  if (desired !== visibleSyncMode && (urgent || now - syncModeCandidateAt >= dwell) && now - syncModeChangedAt >= 700) {
    visibleSyncMode = desired; syncModeChangedAt = now;
  }
  const delay = currentDisplayDelay();
  pill.classList.toggle('live', visibleSyncMode === 'live');
  pill.classList.toggle('recovering', visibleSyncMode === 'syncing' || visibleSyncMode === 'catching');
  pill.classList.toggle('stale', ['paused','reconnecting','connecting','stale'].includes(visibleSyncMode));
  const behind = delay == null ? '' : delay < 1000 ? `${Math.round(delay)} ms behind` : `${(delay / 1000).toFixed(1)} s behind`;
  if (visibleSyncMode === 'paused') text.textContent = 'Paused · background tab';
  else if (visibleSyncMode === 'syncing') text.textContent = 'Syncing missed history';
  else if (visibleSyncMode === 'catching') text.textContent = `Catching up${behind ? ` · ${behind}` : ''}`;
  else if (visibleSyncMode === 'reconnecting') text.textContent = 'Cached · reconnecting';
  else if (visibleSyncMode === 'connecting') text.textContent = 'Connecting';
  else if (visibleSyncMode === 'stale') text.textContent = 'Live stream stale';
  else text.textContent = `Live${behind ? ` · ${behind}` : ''}`;
}
setInterval(updateSyncIndicator, 500);

function setRunning(v) {
  running = !!v;
  $('btnStart').disabled = running;
  $('btnStop').disabled = !running;
  $('btnRestart').disabled = false;
  CONSOLE.setEnabled(running);
  PLAYERS.refresh();
}

function updateLifecycleUi() {
  const phase = running ? (serverPhase || 'starting') : 'offline';
  const strip = $('statusStrip'), pill = $('phasePill');
  for (const cls of ['ready', 'starting', 'stopping', 'error', 'offline']) { strip.classList.remove(cls); pill.classList.remove(cls); }
  strip.classList.add(phase); pill.classList.add(phase);
  const labels = { ready: 'Ready', starting: 'Starting', stopping: 'Stopping', error: 'Error', offline: 'Offline' };
  const label = (phase === 'offline' && isSleeping) ? 'Sleeping' : (labels[phase] || phase);
  $('statusState').textContent = label; $('phaseText').textContent = label.toLowerCase(); $('ovPhase').textContent = label; $('sysPhase').textContent = label;
  $('ovReadyAt').textContent = readyAt ? fmtDate(readyAt) : '—';
  $('sysReadyAt').textContent = readyAt ? fmtDate(readyAt) : (lastReadyAt ? `${fmtDate(lastReadyAt)} (last)` : '—');
  $('ovStartup').textContent = startupDurationMs != null ? fmtStartup(startupDurationMs) : (lastStartupDurationMs != null ? `${fmtStartup(lastStartupDurationMs)} last` : '—');
  $('sysStartup').textContent = startupDurationMs != null ? fmtStartup(startupDurationMs) : (lastStartupDurationMs != null ? `${fmtStartup(lastStartupDurationMs)} (last)` : '—');
  const now = serverNow();
  if (phase === 'ready') $('statusNote').textContent = `Ready since ${fmtClock(readyAt)} · startup ${fmtStartup(startupDurationMs)}`;
  else if (phase === 'starting') $('statusNote').textContent = `Starting · ${startedAt ? fmtDuration((now - startedAt) / 1000) : 'waiting for process'}`;
  else if (phase === 'stopping') $('statusNote').textContent = 'Stopping server cleanly…';
  else if (phase === 'error') $('statusNote').textContent = 'Server process reported a start error';
  else if (isSleeping) $('statusNote').textContent = 'No players for a while — sleeping until someone tries to join';
  else $('statusNote').textContent = lastExitAt ? `Offline · last exit ${fmtDate(lastExitAt)}` : 'Server is not running';
}

function setLifecycle(payload = {}) {
  const prevPhase = serverPhase;
  if ('running' in payload) setRunning(payload.running);
  if ('startedAt' in payload) startedAt = payload.startedAt;
  if ('lastExitAt' in payload) lastExitAt = payload.lastExitAt;
  if ('restartCount' in payload) restartCount = payload.restartCount;
  if ('phase' in payload) serverPhase = payload.phase;
  else if ('running' in payload) serverPhase = payload.running ? (serverPhase === 'ready' ? 'ready' : 'starting') : 'offline';
  if ('readyAt' in payload) readyAt = payload.readyAt;
  if ('startupDurationMs' in payload) startupDurationMs = payload.startupDurationMs;
  if ('lastReadyAt' in payload) lastReadyAt = payload.lastReadyAt;
  if ('lastStartupDurationMs' in payload) lastStartupDurationMs = payload.lastStartupDurationMs;
  if ('sleeping' in payload) isSleeping = payload.sleeping;
  updateLifecycleUi();
  if (hasSnapshot && prevPhase !== 'ready' && serverPhase === 'ready') toast(`Server ready · startup ${fmtStartup(startupDurationMs)}`);
}

function updateTelemetry() {
  const delay = lastDisplayedSampleAt ? Math.max(0, serverNow() - lastDisplayedSampleAt) : null;
  $('telemetryDelay').textContent = delay == null ? '—' : `${Math.round(delay)} ms`;
  $('telemetryPoints').textContent = (rawHistory.length + history1s.length + history5s.length + history1m.length + history10m.length).toLocaleString('de-DE');
  $('telemetryClients').textContent = latest?.panel?.eventClients ?? '—';
  $('telemetryRange').textContent = rangeLabel(chartRangeMs);
  $('telemetryQueue').textContent = `${playbackQueue.length}`;
  $('telemetryRecovery').textContent = ({live:'Live',catching:'Catching up',syncing:'Syncing history',paused:'Paused',reconnecting:'Reconnecting',connecting:'Connecting',stale:'Stale'})[visibleSyncMode] || 'Live';
  $('telemetryClock').textContent = clockSynced ? `${clockOffsetMs >= 0 ? '+' : ''}${Math.round(clockOffsetMs)} ms` : 'syncing';
  $('telemetrySeq').textContent = highestSampleSeq ? highestSampleSeq.toLocaleString('de-DE') : '—';
  $('sysRawSeq').textContent = highestSampleSeq ? highestSampleSeq.toLocaleString('de-DE') : '—';
  $('sysClockOffset').textContent = clockSynced ? `${clockOffsetMs >= 0 ? '+' : ''}${Math.round(clockOffsetMs)} ms · RTT ${Math.round(clockRttMs || 0)} ms` : 'syncing';
  $('sysPlaybackQueue').textContent = `${playbackQueue.length}`;
  $('healthDelay').textContent = delay == null ? '—' : `${Math.round(delay)} ms`;
  $('healthDelay').className = `health-v ${delay == null ? '' : delay < 1800 ? 'good' : delay < 3500 ? 'warn' : 'bad'}`;
  const streamLabel = ({live:'Live',catching:'Catching up',syncing:'Syncing history',paused:'Paused',reconnecting:'Reconnecting',connecting:'Connecting',stale:'Stale'})[visibleSyncMode] || 'Live';
  $('healthRecovery').textContent = streamLabel;
  $('healthRecovery').className = `health-v ${visibleSyncMode === 'live' ? 'good' : ['catching','syncing'].includes(visibleSyncMode) ? 'warn' : ''}`;
}

function updateUptimes() {
  const now = serverNow(), serverSec = running && startedAt ? (now - startedAt) / 1000 : null;
  $('serverUptime').textContent = serverSec == null ? '—' : fmtDuration(serverSec);
  $('serverStarted').textContent = startedAt ? fmtDate(startedAt) : 'not started';
  $('ovServerRuntime').textContent = serverSec == null ? '—' : fmtDuration(serverSec);
  $('sysServerUptime').textContent = serverSec == null ? '—' : fmtDuration(serverSec);
  if (latest) {
    $('ovHostRuntime').textContent = fmtDuration(latest.system?.uptimeSec);
    $('ovPanelRuntime').textContent = fmtDuration(latest.system?.panelUptimeSec);
    $('sysHostUptime').textContent = fmtDuration(latest.system?.uptimeSec);
    $('sysPanelUptime').textContent = fmtDuration(latest.system?.panelUptimeSec);
  }
  updateLifecycleUi();
  updateTelemetry();
}
setInterval(updateUptimes, 250);
setInterval(() => { if (restartPlanState?.executeAt) applyRestartPlan({ ...restartPlanState, remainingSec: Math.max(0, Math.ceil((restartPlanState.executeAt - serverNow()) / 1000)) }); }, 1000);

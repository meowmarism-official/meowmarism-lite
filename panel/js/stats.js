// Stats updates, health, events widgets and the power buttons.
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || text || `HTTP ${res.status}`); return data;
}
const SETTINGS = MeowSettings.mount({
  el: $('settingsRoot'),
  load: async () => (await fetch(`${window.__BASE || ''}/api/settings`)).json(),
  save: (patch) => post('/api/settings', { settings: patch }),
  restart: () => post('/restart'),
  t, esc, toast,
  confirm: (title, message, label, danger) => modalConfirm(title, message, label, danger),
});
$('btnStart').onclick = () => post('/start').catch((e) => toast(e.message, 'error'));
$('btnStop').onclick = async () => { if (await modalConfirm('Stop the server?', 'Players will be disconnected and the world is saved.', 'Stop', true)) post('/stop').catch(console.error); };
$('btnRestart').onclick = async () => { if (await modalConfirm('Restart the server?', 'Players will be disconnected while it restarts.', 'Restart', true)) post('/restart').catch(console.error); };
$('btnCancelStart').onclick = async () => { if (await modalConfirm('Cancel starting?', 'Force-kills the Minecraft process while it starts up. Use this if it hangs or you started it by mistake.', 'Cancel start', true)) post('/force-stop').catch((e) => toast(e.message, 'error')); };

function updateHealth() {
  const disk = latest?.disk, mc = latest?.minecraft || {}, lag = mc.lag?.last, lagCount = mc.lag?.warningCount || 0;
  if (lag && serverNow() - Number(lag.at) < 10 * 60_000) {
    $('healthLag').textContent = `${lag.ticksBehind} ticks · ${lag.delayMs} ms`;
    $('healthLag').className = 'health-v warn';
  } else {
    $('healthLag').textContent = lagCount ? `${lagCount} warning${lagCount === 1 ? '' : 's'}` : 'no warnings';
    $('healthLag').className = `health-v ${lagCount ? '' : 'good'}`;
  }
  const free = Number(disk?.freeGB); $('healthDisk').textContent = Number.isFinite(free) ? fmtGB(free) : '—';
  $('healthDisk').className = `health-v ${Number(disk?.percent) >= 95 ? 'bad' : Number(disk?.percent) >= 88 ? 'warn' : Number.isFinite(free) ? 'good' : ''}`;
}

function updateStats(payload) {
  if (!payload) return;
  setLifecycle(payload.lifecycle || payload);
  latest = payload.stats || latest || {};
  const s = latest, cpu = s.cpu || {}, mem = s.memory || {}, disk = s.disk, proc = s.server, sys = s.system || {}, mc = s.minecraft || {}, win = s.sampleWindow || {};
  OVERVIEW_PAGE.update({
    cpu: { avg: cpu.usage, min: cpu.min, max: cpu.max },
    ram: { avg: mem.percent, used: mem.usedGB, total: mem.totalGB },
    minecraft: mc,
    notice: !!(s.modpack && s.crash && !running),
  });
  PERF_PAGE.update({
    cpu: { temperatureC: cpu.temperatureC ?? null, cores: cpu.cores ?? null, speedMHz: cpu.speedMHz ?? null, avg: cpu.usage, min: cpu.min, max: cpu.max },
    ram: { total: mem.totalGB, avg: mem.percent, min: mem.min, max: mem.max },
    disk: disk ? { percent: disk.percent, used: disk.usedGB, total: disk.totalGB } : null,
  });
  $('ovLastExit').textContent = lastExitAt ? fmtDate(lastExitAt) : '—'; $('ovRestarts').textContent = restartCount;
  $('ovPid').textContent = proc?.pid ?? '—'; $('ovThreads').textContent = proc?.threads ?? '—'; $('ovDisk').textContent = disk ? pct(disk.percent) : '—'; $('ovFiles').textContent = proc?.openFiles ?? '—';
  $('ovRxTotal').textContent = fmtBytes(s.network?.rxTotal); $('ovTxTotal').textContent = fmtBytes(s.network?.txTotal);
  $('sampleWindowMeta').textContent = `${win.count ?? '—'} × ${win.sampleMs ?? '—'} ms raw · server EMA · 1 packet / ${win.publishMs ?? '—'} ms`;
  $('sysPid').textContent = proc?.pid ?? '—'; $('sysLauncherPid').textContent = proc?.launcherPid ?? '—'; $('sysThreads').textContent = proc?.threads ?? '—'; $('sysFiles').textContent = proc?.openFiles ?? '—';
  $('sysCtx').textContent = proc ? `${(proc.voluntaryCtx ?? 0).toLocaleString('de-DE')} / ${(proc.involuntaryCtx ?? 0).toLocaleString('de-DE')}` : '—';
  $('sysHost').textContent = sys.hostname || '—'; $('sysOs').textContent = sys.platform || '—'; $('sysArch').textContent = sys.arch || '—'; $('sysCpuModel').textContent = cpu.model || '—'; $('sysCpuModel').title = cpu.model || ''; $('sysCores').textContent = cpu.cores ?? '—';
  $('sysLoad').textContent = Array.isArray(s.load) ? s.load.join(' / ') : '—'; $('sysMem').textContent = `${fmtGB(mem.usedGB)} / ${fmtGB(mem.totalGB)}`; $('sysDiskFree').textContent = disk ? fmtGB(disk.freeGB) : '—'; $('sysNode').textContent = sys.node || '—';
  $('sysSampleMs').textContent = win.sampleMs != null ? `${win.sampleMs} ms` : '—'; $('sysPublishMs').textContent = win.publishMs != null ? `${win.publishMs} ms` : '—'; $('sysSampleCount').textContent = win.count ?? '—';
  $('sysCacheWindow').textContent = s.panel?.cacheWindowMs != null ? `${Math.round(s.panel.cacheWindowMs / 60000)} min` : '5 min'; $('sysSnapshotWindow').textContent = s.panel?.snapshotWindowMs != null ? `${Math.round(s.panel.snapshotWindowMs / 1000)} s` : '60 s';
  $('sysRawCache').textContent = s.panel?.rawCacheSamples ?? '—'; $('sysConsoleCache').textContent = s.panel?.consoleCacheLines ?? '—'; $('sysClients').textContent = s.panel?.eventClients ?? '—'; $('sysBuffer').textContent = `${s.panel?.bufferedLines ?? 0} lines`; $('sysLastExit').textContent = lastExitAt ? fmtDate(lastExitAt) : '—'; $('sysRestarts').textContent = restartCount;
  $('telemetrySample').textContent = win.sampleMs != null ? `${win.sampleMs} ms` : '—'; $('telemetryBatch').textContent = win.count != null ? `${win.count} samples` : '—'; lastBatchCount = Number(win.count) || lastBatchCount;
  PLAYERS.update(s.players); updateHealth(); updateExtendedStats(); updateUptimes(); scheduleChartDraw();
}


function stateLabel(state) { return state === 'normal' ? 'normal' : state === 'elevated' ? 'elevated' : state === 'high' ? 'high' : 'unknown'; }
function setHealthValue(id, item, formatter = (v) => v == null ? '—' : String(v)) {
  const el=$(id); if(!el)return; const state=item?.state || 'unknown'; el.className=`health-summary-v ${state}`; el.textContent=`${formatter(item?.value)} · ${stateLabel(state)}`;
}
function updateExtendedStats() {
  const h=latest?.health || {}, mc=latest?.minecraft || {}, java=latest?.server?.java, features=mc.features || {}, crash=latest?.crash;
  setHealthValue('ovHealthCpu',h.cpu,(v)=>v==null?'—':pct(v)); setHealthValue('ovHealthRam',h.memory,(v)=>v==null?'—':pct(v)); setHealthValue('ovHealthDisk',h.disk,(v)=>v==null?'—':pct(v));
  const tick=$('ovHealthTick'); if(tick){ const t=mc.tps?.one, m=mc.mspt?.current; tick.className=`health-summary-v ${h.tps?.state || 'unknown'}`; tick.textContent=t!=null?`${Number(t).toFixed(2)} TPS${m!=null?` · ${Number(m).toFixed(1)} ms`:''}`:'not reported'; }
  const lag=$('ovHealthLag'); if(lag){ lag.className=`health-summary-v ${h.lag?.state || 'normal'}`; lag.textContent=`${h.lag?.last10m ?? 0} spike${h.lag?.last10m===1?'':'s'}`; }
  $('perfTps').textContent=mc.tps?`${mc.tps.one ?? '—'} / ${mc.tps.five ?? '—'} / ${mc.tps.fifteen ?? '—'}`:'—'; $('perfMspt').textContent=mc.mspt?.current!=null?`${Number(mc.mspt.current).toFixed(2)} ms`:'—'; $('perfChunks').textContent=mc.world?.chunks ?? 'not reported'; $('perfEntities').textContent=mc.world?.entities ?? 'not reported'; $('perfEngine').textContent=features.engine || 'unknown'; $('perfSpark').textContent=features.spark?'detected':'not detected';
  if(java){ $('javaTelemetryState').textContent=`sample ${fmtClock(java.sampledAt)}`; $('javaHeap').textContent=`${fmtMB(java.heapUsedMB)} / ${fmtMB(java.heapCapacityMB)} · ${pct(java.heapPercent)}`; $('javaMeta').textContent=java.metaspaceUsedMB!=null?`${fmtMB(java.metaspaceUsedMB)} / ${fmtMB(java.metaspaceCapacityMB)}`:'—'; $('javaYoungGc').textContent=java.youngGcCount ?? '—'; $('javaFullGc').textContent=java.fullGcCount ?? '—'; $('javaGcTime').textContent=java.gcTimeSec!=null?`${Number(java.gcTimeSec).toFixed(2)} s`:'—'; $('javaGcLoad').textContent=java.gcLoadPercent!=null?pct(java.gcLoadPercent):'—'; } else { $('javaTelemetryState').textContent=features.jstat?'waiting for Java process':'jstat unavailable'; for(const id of ['javaHeap','javaMeta','javaYoungGc','javaFullGc','javaGcTime','javaGcLoad']) $(id).textContent='—'; }
  $('featEngine').textContent=features.engine || 'unknown'; $('featSpark').textContent=features.spark?'detected':'no'; $('featJstat').textContent=features.jstat?'available':'unavailable'; $('featJmx').textContent=features.jmx?'enabled':'off'; $('featPlugins').textContent=`Plugins: ${(features.plugins||[]).length ? features.plugins.join(', ') : 'none detected'}`;
  const healthMap=[['evHealthCpu',h.cpu,(x)=>x==null?'—':pct(x)],['evHealthRam',h.memory,(x)=>x==null?'—':pct(x)],['evHealthDisk',h.disk,(x)=>x==null?'—':pct(x)],['evHealthTps',h.tps,(x)=>x==null?'not reported':Number(x).toFixed(2)],['evHealthLag',h.lag,()=>`${h.lag?.last10m??0} / 10m`]];
  for(const [id,item,fmt] of healthMap){const el=$(id);if(el){el.textContent=fmt(item?.value);el.className=`v ${item?.state||''}`;}}
  $('evHealthCrash').textContent=crash?fmtDate(crash.at):'none'; $('crashBox').classList.toggle('show',!!crash); if(crash)$('crashDetail').textContent=`${fmtDate(crash.at)} · ${crash.reason||'process exit'}${crash.runtimeMs!=null?` · runtime ${fmtDuration(crash.runtimeMs/1000)}`:''}`;
}

function mergeTimeline(entries=[]) { const by=new Map(timelineEntries.map((e)=>[Number(e.seq),e])); for(const e of entries||[]) if(e&&Number(e.seq)) by.set(Number(e.seq),e); timelineEntries.splice(0,timelineEntries.length,...[...by.values()].sort((a,b)=>Number(a.seq)-Number(b.seq)).slice(-1000)); renderTimeline(); scheduleChartDraw(true); }
function mergeAudit(entries=[]) { const by=new Map(auditEntriesClient.map((e)=>[Number(e.seq),e])); for(const e of entries||[]) if(e&&Number(e.seq)) by.set(Number(e.seq),e); auditEntriesClient.splice(0,auditEntriesClient.length,...[...by.values()].sort((a,b)=>Number(a.seq)-Number(b.seq)).slice(-1000)); renderAudit(); }
function renderTimeline(){const root=$('timelineList');if(!root)return; const list=timelineEntries.slice().reverse(); root.innerHTML=list.length?list.map((e)=>`<div class="event-row"><div class="event-time">${fmtClock(e.at,true)}</div><div class="event-dot ${esc(e.severity||'')}"></div><div><div class="event-title">${esc(e.title||e.type)}</div><div class="event-detail">${esc(e.detail||'')}</div></div><div class="event-type">${esc(e.type||'event')}</div></div>`).join(''):'<div class="event-empty">No events yet.</div>';}
function renderAudit(){const root=$('auditList');if(!root)return; const list=auditEntriesClient.slice().reverse(); root.innerHTML=list.length?list.map((e)=>`<div class="event-row"><div class="event-time">${fmtClock(e.at,true)}</div><div class="event-dot"></div><div><div class="event-title">${esc(e.action)}${e.target?` · ${esc(e.target)}`:''}</div><div class="event-detail">${esc(e.detail||'')}</div></div><div class="event-type">${esc(e.actor||'panel')}</div></div>`).join(''):'<div class="event-empty">No panel actions yet.</div>';}
function applyRestartPlan(plan){restartPlanState=plan||null; const box=$('restartLive'); if(!box)return; if(plan){box.classList.add('show'); box.textContent=`Restart in ${Math.max(0,Number(plan.remainingSec)||0)}s · ${plan.reason||'Scheduled restart'}`; $('btnCancelRestart').disabled=false;}else{box.classList.remove('show');$('btnCancelRestart').disabled=true;}}
function updateHistoryModeUi(){const b=$('btnBackLive'); if(!b)return; b.classList.toggle('show',!chartLiveMode); if(!chartLiveMode)b.textContent=`Viewing history · ${fmtClock(chartAnchorTime,true)} · Back to live`;}
$('btnBackLive').onclick=()=>{chartLiveMode=true;chartAnchorTime=null;updateHistoryModeUi();scheduleChartDraw(true);};
$('btnTimelineClearView').onclick=()=>{$('timelineList').innerHTML='<div class="event-empty">View cleared. New events will appear here.</div>';};
$('btnScheduleRestart').onclick=async()=>{try{const d=await post('/api/restart-plan',{delaySec:Number($('restartDelay').value)||0,reason:$('restartReason').value,warnPlayers:$('restartWarn').checked});applyRestartPlan(d.plan);toast('Restart scheduled');}catch(e){toast(e.message,'error');}};
$('btnCancelRestart').onclick=async()=>{try{await post('/api/restart-plan',{action:'cancel'});applyRestartPlan(null);toast('Restart cancelled');}catch(e){toast(e.message,'error');}};
$('btnForceStop').onclick=async()=>{if(!(await modalConfirm('Force stop?','Force stop the Minecraft process? Unsaved world data can be lost.','Force stop',true)))return;try{await post('/force-stop');toast('Force stop sent');}catch(e){toast(e.message,'error');}};

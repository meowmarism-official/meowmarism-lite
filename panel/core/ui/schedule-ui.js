// Scheduler page: task table and the add/edit dialog. Shared by every product.
// cfg: { el, base() -> the schedule API prefix, t, esc, toast, confirm(title, message, label, danger), fmtDate(ts), isVisible() }
(function () {
  function mount(cfg) {
    const { t, esc, toast, fmtDate } = cfg;
    const $ = (id) => document.getElementById(id);
    const base = cfg.base;

    cfg.el.innerHTML = `<div class="grid">
  <article class="card span-12"><div class="card-head"><div class="card-title">Scheduled tasks</div><button class="btn primary" id="btnAddTask">Add task</button></div><div class="card-body">
    <div class="hint" style="margin-bottom:10px">Run backups, restarts, start/stop and console commands automatically. Times use the server's local time.</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>When</th><th>Action</th><th>Last run</th><th>Next run</th><th></th></tr></thead><tbody id="taskRows"></tbody></table><div class="empty-state" id="taskEmpty" style="display:none">No scheduled tasks yet.</div></div>
  </div></article>
</div>
      `;
    if (!$('taskBack')) document.body.insertAdjacentHTML('beforeend', `<div class="modal-back" id="taskBack"><div class="modal" role="dialog" aria-modal="true" style="width:440px">
  <h3 class="modal-title" id="taskTitle">Add task</h3>
  <div style="display:grid;gap:10px;margin:6px 0 16px">
    <label class="hint">Name<input class="compact-input" id="tkName" style="width:100%;margin-top:4px"></label>
    <label class="hint">Action<select class="compact-input" id="tkAction" style="width:100%;margin-top:4px"><option value="backup">Backup</option><option value="restart">Restart</option><option value="stop">Stop</option><option value="start">Start</option><option value="command">Console command</option></select></label>
    <label class="hint" id="tkCommandWrap">Command<input class="compact-input" id="tkCommand" placeholder="say Hello" style="width:100%;margin-top:4px"></label>
    <label class="hint" id="tkWarnWrap">Warn players first<input class="compact-input" type="number" min="0" max="3600" id="tkWarn" value="60" style="width:90px;margin:4px 6px 0 6px">seconds</label>
    <label class="hint">Repeat<select class="compact-input" id="tkType" style="width:100%;margin-top:4px"><option value="daily">Every day</option><option value="weekly">On weekdays</option><option value="interval">Every few minutes</option></select></label>
    <label class="hint" id="tkTimeWrap">At<input class="compact-input" type="time" id="tkTime" value="04:00" style="margin-left:6px"></label>
    <div class="hint" id="tkDaysWrap" style="display:flex;gap:10px;flex-wrap:wrap"><label><input type="checkbox" data-day="1"> Mon</label><label><input type="checkbox" data-day="2"> Tue</label><label><input type="checkbox" data-day="3"> Wed</label><label><input type="checkbox" data-day="4"> Thu</label><label><input type="checkbox" data-day="5"> Fri</label><label><input type="checkbox" data-day="6"> Sat</label><label><input type="checkbox" data-day="0"> Sun</label></div>
    <label class="hint" id="tkEveryWrap">Every<input class="compact-input" type="number" min="5" max="10080" id="tkEvery" value="60" style="width:90px;margin:0 6px">minutes</label>
    <label class="hint"><input type="checkbox" id="tkEnabled" checked> enabled</label>
    <div class="hint" id="tkError" style="color:var(--red);display:none"></div>
  </div>
  <div class="modal-actions"><button class="btn" id="tkCancel">Cancel</button><button class="btn primary" id="tkSave">Save</button></div>
</div></div>`);

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ACTION_NAMES = { backup: 'Backup', restart: 'Restart', stop: 'Stop', start: 'Start', command: 'Console command' };
  let scheduleTasks = [];
  let editingTaskId = null;
  async function loadSchedule() {
    try {
      const d = await (await fetch(base())).json();
      scheduleTasks = d.tasks || [];
      $('taskEmpty').style.display = scheduleTasks.length ? 'none' : '';
      $('taskRows').innerHTML = scheduleTasks.map((k) => {
        const trig = k.trigger;
        const when = trig.type === 'interval' ? t('Every {n} min', { n: trig.everyMinutes }) : trig.type === 'daily' ? t('Every day at {time}', { time: trig.time }) : t('{days} at {time}', { days: trig.days.map((x) => t(DAY_NAMES[x])).join(', '), time: trig.time });
        const action = t(ACTION_NAMES[k.action.type]) + (k.action.type === 'command' ? `: ${k.action.command}` : '');
        return `<tr><td>${esc(k.name)}${k.enabled ? '' : ` <span class="tag">${t('paused')}</span>`}</td><td>${esc(when)}</td><td>${esc(action)}</td>
          <td>${k.lastRunAt ? esc(fmtDate(k.lastRunAt)) + (k.lastResult ? ` · ${esc(t(k.lastResult))}` : '') : '—'}</td>
          <td>${k.enabled && k.nextRunAt ? esc(fmtDate(k.nextRunAt)) : '—'}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn" data-task-run="${k.id}">Run now</button> <button class="btn" data-task-edit="${k.id}">Edit</button> <button class="btn danger" data-task-del="${k.id}">Delete</button></td></tr>`;
      }).join('');
    } catch (err) { console.error(err); }
  }
  function syncTaskForm() {
    const action = $('tkAction').value, type = $('tkType').value;
    $('tkCommandWrap').style.display = action === 'command' ? '' : 'none';
    $('tkWarnWrap').style.display = action === 'restart' || action === 'stop' ? '' : 'none';
    $('tkTimeWrap').style.display = type === 'interval' ? 'none' : '';
    $('tkDaysWrap').style.display = type === 'weekly' ? 'flex' : 'none';
    $('tkEveryWrap').style.display = type === 'interval' ? '' : 'none';
  }
  function openTaskModal(task) {
    editingTaskId = task ? task.id : null;
    $('taskTitle').textContent = task ? 'Edit task' : 'Add task';
    $('tkName').value = task ? task.name : '';
    $('tkAction').value = task ? task.action.type : 'backup';
    $('tkCommand').value = task && task.action.command ? task.action.command : '';
    $('tkWarn').value = task && task.action.warnSec != null ? task.action.warnSec : 60;
    $('tkType').value = task ? task.trigger.type : 'daily';
    $('tkTime').value = task && task.trigger.time ? task.trigger.time : '04:00';
    $('tkEvery').value = task && task.trigger.everyMinutes ? task.trigger.everyMinutes : 60;
    document.querySelectorAll('#tkDaysWrap [data-day]').forEach((c) => { c.checked = !!(task && task.trigger.days && task.trigger.days.includes(Number(c.dataset.day))); });
    $('tkEnabled').checked = task ? task.enabled : true;
    $('tkError').style.display = 'none';
    syncTaskForm();
    $('taskBack').classList.add('open');
  }
  $('tkAction').addEventListener('change', syncTaskForm);
  $('tkType').addEventListener('change', syncTaskForm);
  $('btnAddTask').addEventListener('click', () => openTaskModal(null));
  $('tkCancel').addEventListener('click', () => $('taskBack').classList.remove('open'));
  $('tkSave').addEventListener('click', async () => {
    const type = $('tkType').value, action = $('tkAction').value;
    const trigger = type === 'interval' ? { type, everyMinutes: Number($('tkEvery').value) } : { type, time: $('tkTime').value };
    if (type === 'weekly') trigger.days = [...document.querySelectorAll('#tkDaysWrap [data-day]')].filter((c) => c.checked).map((c) => Number(c.dataset.day));
    const act = { type: action };
    if (action === 'command') act.command = $('tkCommand').value;
    if (action === 'restart' || action === 'stop') act.warnSec = Number($('tkWarn').value) || 0;
    const r = await fetch(base(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editingTaskId, name: $('tkName').value, enabled: $('tkEnabled').checked, trigger, action: act }) });
    const d = await r.json();
    if (!d.ok) { $('tkError').textContent = t(d.error || 'Could not save'); $('tkError').style.display = ''; return; }
    $('taskBack').classList.remove('open');
    toast('Task saved');
    loadSchedule();
  });
  document.addEventListener('click', async (e) => {
    const run = e.target.closest('[data-task-run]');
    const edit = e.target.closest('[data-task-edit]');
    const del = e.target.closest('[data-task-del]');
    if (edit) openTaskModal(scheduleTasks.find((k) => k.id === edit.dataset.taskEdit));
    if (run) {
      const r = await fetch(`${base()}/${run.dataset.taskRun}/run`, { method: 'POST' });
      const d = await r.json();
      toast(d.ok ? t(d.result) : t(d.error || 'Failed'), d.ok ? 'ok' : 'error');
      loadSchedule();
    }
    if (del) {
      const task = scheduleTasks.find((k) => k.id === del.dataset.taskDel);
      if (await cfg.confirm('Delete task?', task ? task.name : '', 'Delete', true)) {
        await fetch(`${base()}/${del.dataset.taskDel}`, { method: 'DELETE' });
        loadSchedule();
      }
    }
  });

    setInterval(() => { if (cfg.isVisible()) loadSchedule(); }, 15000);
    return { load: loadSchedule };
  }
  window.MeowSchedule = { mount };
})();

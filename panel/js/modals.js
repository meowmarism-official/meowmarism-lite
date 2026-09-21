// Modal dialogs.
function showModal(title, message, buttons) {
  return new Promise((resolve) => {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalMsg').textContent = message;
    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    const back = document.getElementById('modalBack');
    const close = (value) => { back.classList.remove('open'); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(b.value));
      actions.appendChild(btn);
    });
    document.addEventListener('keydown', onKey);
    back.classList.add('open');
  });
}
function modalAlert(title, message) {
  return showModal(title, message, [{ label: 'OK', value: true, primary: true }]);
}
function modalConfirm(title, message, confirmLabel, danger) {
  return showModal(title, message, [
    { label: 'Cancel', value: false },
    { label: confirmLabel || 'Confirm', value: true, primary: !danger, danger: !!danger },
  ]);
}

(() => {
  const dialog = document.querySelector('#override-dialog');
  const form = document.querySelector('#override-form');
  const actionSelect = document.querySelector('#override-action');
  const courseWrap = document.querySelector('#override-course-wrap');
  const stationWrap = document.querySelector('#override-station-wrap');
  const stationSelect = document.querySelector('#override-station');
  const reasonInput = document.querySelector('#override-reason');
  const title = document.querySelector('#override-title');
  const taskLabel = document.querySelector('#override-task');
  const submit = document.querySelector('#override-submit');
  let pending = null;

  const label = (value) => String(value || '').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const choicesFor = (state) => {
    if (state === 'held') return [['resume', 'Resume']];
    if (state === 'expo' || state === 'ready') return [['served', 'Mark served'], ['refire', 'Refire']];
    if (state === 'ordered' || state === 'eligible' || state === 'scheduled') return [['hold', 'Hold'], ['rush', 'Rush'], ['fire-now', 'Fire now']];
    return [['hold', 'Hold'], ['defer', 'Defer']];
  };
  const extendedChoices = [['change-course', 'Change course'], ['move-station', 'Move station'], ['refire', 'Refire'], ['served', 'Mark served']];
  const operator = () => String(document.querySelector('#operator')?.value || localStorage.getItem('redLanternKitchenOperator') || 'Kitchen console').trim().slice(0, 100) || 'Kitchen console';
  const stateFor = (task) => new Map((data?.taskStates || []).map((entry) => [entry.task_id, entry.task_state])).get(task.taskKey) || task.taskState || 'ordered';

  function syncFields() {
    const action = actionSelect.value;
    courseWrap.hidden = action !== 'change-course';
    stationWrap.hidden = action !== 'move-station';
  }
  function fillStations() {
    stationSelect.innerHTML = `<option value="">Choose station</option>${(data?.stations || []).filter((station) => station.enabled !== false).map((station) => `<option value="${String(station.id || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${String(station.name || station.id || '')}</option>`).join('')}`;
  }
  function open(task, mode = 'quick', suggestedAction = '') {
    const state = stateFor(task);
    const choices = mode === 'more' ? extendedChoices : choicesFor(state);
    pending = { task, state };
    title.textContent = mode === 'more' ? 'More kitchen actions' : `Kitchen action · ${label(suggestedAction)}`;
    taskLabel.textContent = `${task.quantity}× ${task.itemName} · Order #${String(task.orderNumber || '—').padStart(2, '0')} · ${task.stationId || 'Station not assigned'}`;
    actionSelect.innerHTML = choices.map(([value, text]) => `<option value="${value}">${text}</option>`).join('');
    if (suggestedAction && choices.some(([value]) => value === suggestedAction)) actionSelect.value = suggestedAction;
    reasonInput.value = '';
    fillStations();
    syncFields();
    dialog.showModal();
    reasonInput.focus();
  }
  function injectControls() {
    const tasks = Array.isArray(data?.recommendations) ? data.recommendations : [];
    document.querySelectorAll('#board .card[data-task-card]').forEach((card) => {
      const task = tasks.find((entry) => String(entry.taskKey) === String(card.dataset.task) && String(entry.orderId) === String(card.dataset.order));
      const actions = card.querySelector('.actions');
      if (!task || !actions || actions.querySelector('[data-smart-override]')) return;
      const state = stateFor(task);
      const buttons = choicesFor(state).map(([action, text]) => `<button type="button" class="override" data-smart-override="${action}" data-task="${task.taskKey}" data-order="${task.orderId}">${text}</button>`).join('');
      actions.insertAdjacentHTML('beforeend', `${buttons}<button type="button" class="override more" data-smart-override="more" data-task="${task.taskKey}" data-order="${task.orderId}">More actions</button>`);
    });
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-smart-override]');
    if (!button) return;
    const task = (data?.recommendations || []).find((entry) => String(entry.taskKey) === String(button.dataset.task) && String(entry.orderId) === String(button.dataset.order));
    if (task) open(task, button.dataset.smartOverride === 'more' ? 'more' : 'quick', button.dataset.smartOverride);
  });
  actionSelect.addEventListener('change', syncFields);
  ['#override-close', '#override-cancel'].forEach((selector) => document.querySelector(selector)?.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending || reasonInput.value.trim().length < 3) return reasonInput.focus();
    const action = actionSelect.value;
    const body = { action, taskKey: pending.task.taskKey, orderId: pending.task.orderId, reason: reasonInput.value.trim() };
    if (action === 'change-course') body.course = document.querySelector('#override-course').value;
    if (action === 'move-station') body.stationId = stationSelect.value;
    if ((action === 'change-course' && !body.course) || (action === 'move-station' && !body.stationId)) return;
    submit.disabled = true;
    try {
      const response = await fetch('/api/orders/smart-kds/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kitchen-Operator': operator() }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw Error(payload.error || 'Override failed.');
      dialog.close();
      await load();
    } catch (error) { window.alert(error.message); }
    finally { submit.disabled = false; }
  });
  new MutationObserver(injectControls).observe(document.querySelector('#board'), { childList: true, subtree: true });
  injectControls();
})();

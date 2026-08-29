const { TASK_STATES } = require('./smart-kds-domain');

// The full lifecycle is defined here even where a later phase owns the UI action.
// This keeps persisted task states explicit and makes illegal transitions rejectable.
const ACTION_TRANSITIONS = {
  hold: { from: ['ordered', 'eligible', 'scheduled', 'fired', 'preparing'], to: 'held' },
  resume: { from: 'held', to: 'eligible' },
  schedule: { from: ['ordered', 'eligible'], to: 'scheduled' },
  fire: { from: ['ordered', 'eligible', 'scheduled'], to: 'fired' },
  start: { from: ['ordered', 'eligible', 'scheduled', 'fired'], to: 'preparing' },
  ready: { from: 'preparing', to: 'ready' },
  expo: { from: 'ready', to: 'expo' },
  serve: { from: ['ready', 'expo'], to: 'served' },
  cancel: { from: ['ordered', 'held', 'eligible', 'scheduled', 'fired', 'preparing', 'ready', 'expo'], to: 'cancelled' },
  refire: { from: ['held', 'ready', 'expo', 'served'], to: 'eligible' },
};

function transitionForAction(action) {
  return ACTION_TRANSITIONS[String(action || '')] || null;
}

function applyTaskAction(currentState, action) {
  const transition = transitionForAction(action);
  if (!transition) return { applied: false, reason: 'invalid-action', state: currentState };
  const expected = Array.isArray(transition.from) ? transition.from : [transition.from];
  if (!TASK_STATES.includes(currentState) || !expected.includes(currentState))
    return { applied: false, reason: 'state-conflict', state: currentState, expected };
  return { applied: true, state: transition.to, expected: transition.from };
}

module.exports = { ACTION_TRANSITIONS, transitionForAction, applyTaskAction };

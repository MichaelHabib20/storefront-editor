/**
 * What the admin page may see of a chat, for the event stream (the backend's ChatPresenter gives the same shape for
 * polling): the conversation, whether a change is being made, the open draft, the preview and the allowance. Never
 * costs, models, file names, check output or screenshots.
 */
const ROLES = ['merchant', 'assistant', 'system'];
const STATES = { triage: 'understanding', editing: 'editing', checking: 'checking', fixing: 'checking', building_preview: 'preparing_preview', done: 'done' };

function options(list) {
  const out = [];
  for (const option of Array.isArray(list) ? list : []) {
    if (typeof option === 'string' && option.trim()) out.push(option.trim().slice(0, 60));
    if (out.length === 4) break;
  }
  return out;
}

export function presentChat(chat, { preview = null, budget = null } = {}) {
  const run = chat.run && typeof chat.run === 'object' ? chat.run : null;
  const state = run ? STATES[run.state] ?? 'editing' : null;
  return {
    ready: true,
    messages: (chat.messages ?? [])
      .filter((m) => ROLES.includes(m.role))
      .map((m) => ({ id: String(m.id ?? ''), role: m.role, text: String(m.text ?? ''), at: m.at ?? null, previewUrl: m.preview ?? null, failed: m.error !== undefined, options: options(m.options) })),
    working: state !== null && state !== 'done',
    run: run ? { id: String(run.id ?? ''), state, startedAt: run.startedAt ?? null } : null,
    draft: chat.draft ? { updatedAt: chat.draft.updatedAt ?? null } : null,
    preview: preview?.url ? { url: preview.url } : null,
    allowance: budget ? { usedPercent: Math.round(100 * (budget.usedShare ?? 0)), warn: !!budget.warn, exhausted: !!budget.blocked } : null,
  };
}

/**
 * What the admin page may see of a chat, for the event stream (the backend's ChatPresenter gives the same shape for
 * polling): the conversation, whether a change is being made, the open draft, the preview and the allowance. Never
 * costs, models, file names, check output or screenshots.
 */
const ROLES = ['merchant', 'assistant', 'system'];
const STATES = { triage: 'understanding', editing: 'editing', checking: 'checking', fixing: 'checking', building_preview: 'preparing_preview', done: 'done' };
const KINDS = ['plan', 'style_card', 'bug_report', 'refusal', 'change_summary'];
const REFUSE_KINDS = ['business_logic', 'needs_backend', 'unsafe'];

function options(list) {
  const out = [];
  for (const option of Array.isArray(list) ? list : []) {
    if (typeof option === 'string' && option.trim()) out.push(option.trim().slice(0, 60));
    if (out.length === 4) break;
  }
  return out;
}

/** Only the parts of a card the owner may see. */
const CAUSES = ['store_change', 'platform', 'data_or_setting', 'not_reproduced'];

function cardOf(kind, card, reportStatus) {
  if (kind === 'refusal') {
    const report = card?.reportId ? reportStatus(card.reportId) : null;
    return { refuseKind: REFUSE_KINDS.includes(card?.refuseKind) ? card.refuseKind : 'unsafe', ...(report ? { report: { status: report } } : {}) };
  }
  if (kind === 'bug_report' && card) {
    const cause = CAUSES.includes(card.cause) ? card.cause : 'not_reproduced';
    const open = !card.used;
    const report = card.reportId ? reportStatus(card.reportId) : null;
    // what the owner can press: the button texts come from the page, not from here
    const actions = [];
    if (open && cause === 'store_change' && card.suspectCommit) actions.push('undo');
    if (open && cause === 'store_change' && card.fixPlan) actions.push('fix');
    if (cause === 'not_reproduced') actions.push('more_detail');
    return {
      reproduced: !!card.reproduced,
      cause,
      steps: (Array.isArray(card.steps) ? card.steps : []).slice(0, 10).map((s) => String(s).slice(0, 160)),
      ...(cause === 'store_change' && card.suspectTitle ? { suspectTitle: String(card.suspectTitle).slice(0, 80) } : {}),
      ...(cause === 'data_or_setting' && card.adminPlace ? { adminPlace: String(card.adminPlace).slice(0, 120) } : {}),
      ...(report ? { report: { status: report } } : {}),
      used: card.used === 'undo' || card.used === 'fix' ? card.used : null,
      actions,
    };
  }
  return null;
}

function messageOf(m, chatId, reportStatus) {
  const kind = KINDS.includes(m.kind) ? m.kind : 'text';
  const card = cardOf(kind, m.card, reportStatus);
  return {
    id: String(m.id ?? ''),
    role: m.role,
    text: String(m.text ?? ''),
    at: m.at ?? null,
    previewUrl: m.preview ?? null,
    failed: m.error !== undefined,
    options: options(m.options),
    kind,
    ...(card ? { card } : {}),
    images: (Array.isArray(m.images) ? m.images : []).slice(0, 3).filter((i) => typeof i?.file === 'string').map((i) => ({ id: i.file, url: `chats/${chatId}/images/${i.file}` })),
  };
}

const steps = (list) => (Array.isArray(list) ? list : []).slice(-50).map((s) => ({ at: s.at ?? null, text: String(s.text ?? '').slice(0, 120) }));

/**
 * @param chat   one chat
 * @param state  the store state ({ run, draft }), `titleOf(chatId)` names a chat
 */
export function presentChat(chat, { state = {}, titleOf = () => '', reportStatus = () => null, preview = null, budget = null } = {}) {
  const storeRun = state.run && typeof state.run === 'object' ? state.run : null;
  const here = !!storeRun && storeRun.chatId === chat.id;
  const light = chat.lightRun && typeof chat.lightRun === 'object' ? chat.lightRun : null;
  const mine = here ? storeRun : light;
  const status = mine ? STATES[mine.state] ?? 'editing' : null;
  const otherBuilding = storeRun && !here && storeRun.state !== 'done' ? storeRun.chatId : null;
  return {
    ready: true,
    chat: { id: chat.id, title: String(chat.title ?? '') },
    messages: (chat.messages ?? []).filter((m) => ROLES.includes(m.role)).map((m) => messageOf(m, chat.id, reportStatus)),
    working: status !== null && status !== 'done',
    run: mine ? { id: String(mine.id ?? ''), state: status, startedAt: mine.startedAt ?? null, chatId: chat.id, here: true, steps: steps(mine.steps) } : null,
    otherChatBuilding: otherBuilding ? { chatId: otherBuilding, title: titleOf(otherBuilding) } : null,
    draft: state.draft ? { updatedAt: state.draft.updatedAt ?? null, chatId: state.draft.chatId ?? null, chatTitle: state.draft.chatId ? titleOf(state.draft.chatId) : null } : null,
    preview: preview?.url ? { url: preview.url } : null,
    allowance: budget ? { usedPercent: Math.round(100 * (budget.usedShare ?? 0)), warn: !!budget.warn, exhausted: !!budget.blocked } : null,
  };
}

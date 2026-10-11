/**
 * One merchant message, end to end (agent design §2.2):
 *   reserve budget → triage (cheap model) → edit (Agent SDK, the store's model) → checks + preview build, with fix
 *   rounds → commit on the store's draft → preview link → settle the actual cost.
 *
 * Edits land on `draft/<id>`; the merchant approves (merged into `store/<id>`) or discards it. A run that cannot
 * be made to pass leaves the draft exactly as it was and is refunded.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { explainPrompt, fixPrompt, lookPrompt, systemPrompt, taskPrompt } from './prompt.mjs';
import { admitsUnchecked, missingLooks } from './looks.mjs';
import { samplePages } from './sample-pages.mjs';
import { createFilePolicy, relativeTo } from './paths.mjs';
import { cleanOptions, splitChoices } from './triage.mjs';
import { PreviewError } from './preview.mjs';
import { SCREENSHOT_TOOL, screenshotServer } from './screenshot.mjs';
import { must, run } from './run.mjs';
import { BudgetError } from './ledger.mjs';
import fs from 'node:fs';
import { checkImages, loadImages, promptWithImages, saveImages, saveShots } from './images.mjs';
import { applyTask, buttonTokenTask, cardRows, chosenRows, hasButtonToken, planText } from './style-card.mjs';
import { MAIN_CHAT, NEW_CHAT_TITLE, cleanTitle } from './chats.mjs';

const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AUTHOR = ['-c', 'user.name=AI Designer', '-c', 'user.email=ai-designer@supercommerce.local'];

export class ChangeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The PreToolUse hook: writes only to editable files, reads never of secrets, nothing outside the workspace. */
export function fileGuard(workspace, policy) {
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  return async (input) => {
    // the editor's own tools (screenshots) take page paths, not files
    if (String(input.tool_name ?? '').startsWith('mcp__editor__')) return {};
    const args = input.tool_input ?? {};
    const target = args.file_path ?? args.notebook_path ?? args.path;
    if (WRITE_TOOLS.has(input.tool_name)) {
      const relative = relativeTo(workspace, target);
      if (!relative || !policy.canEdit(relative)) return deny('The editor does not allow changing this file. Tell the owner what you could not change and why, in plain words.');
    } else if (target !== undefined) {
      const relative = relativeTo(workspace, target);
      if (!relative && target !== '.') return deny('Only files of this storefront can be read.');
      if (relative && !policy.canRead(relative)) return deny('This file is not readable.');
    }
    return {};
  };
}

/** The question when a change would reach shared, store-wide parts; in Arabic when the owner writes Arabic. */
export function askShared(ownerText) {
  if (/[؀-ۿ]/.test(ownerText)) {
    return {
      text: 'هذا التعديل سيغيّر أيضًا أجزاء مشتركة تظهر في كل المتجر (مثل الأيقونات أو ألوان الموقع)، وليس فقط ما طلبته. هل أطبّقه في كل مكان، أم فقط حيث طلبت؟',
      options: ['نعم، في كل مكان', 'لا، فقط حيث طلبت'],
    };
  }
  return {
    text: 'This change would also change parts used across your whole store (like the icons or the site colours), not only what you asked for. Should I change it everywhere, or only where you asked?',
    options: ['Yes, everywhere', 'No, only where I asked'],
  };
}

export function createAgentRunner({ config, stores, previews, ledger, aiConfig, chats, triage, query = sdkQuery, files, browsers = null, diagnoser = null, reports = null, siteReader = null, log = () => {} }) {
  const policy = createFilePolicy(files);
  const generated = files.generated ?? [];
  const git = (args, cwd) => must('git', args, { cwd });
  const draftOf = (id) => `draft/${id}`;

  async function branchExists(cwd, branch) {
    return (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })).code === 0;
  }

  async function ensureDraft(storeId, cwd) {
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    const draft = draftOf(storeId);
    if (current === draft) return;
    if (await branchExists(cwd, draft)) await git(['checkout', '-q', draft], cwd);
    else await git(['checkout', '-q', '-b', draft, stores.branchOf(storeId)], cwd);
  }

  /** Throws away uncommitted changes (a failed run); ignored files (node_modules, .next) stay. */
  async function resetWorkspace(cwd) {
    await git(['reset', '-q', '--hard', 'HEAD'], cwd);
    await git(['clean', '-q', '-fd'], cwd);
  }

  async function changedFiles(cwd) {
    for (const file of generated) await run('git', ['checkout', '-q', '--', file], { cwd });
    await git(['add', '-A'], cwd);
    const names = (await git(['diff', '--cached', '--name-only', 'HEAD'], cwd)).split('\n').map((s) => s.trim()).filter(Boolean);
    await git(['reset', '-q'], cwd);
    return names;
  }

  /** Changed files whose existing lines were changed or removed (pure additions are not counted). */
  async function modifiedFiles(cwd) {
    await git(['add', '-A'], cwd);
    const rows = (await git(['diff', '--cached', '--numstat', 'HEAD'], cwd)).split('\n').filter(Boolean);
    await git(['reset', '-q'], cwd);
    return rows
      .map((row) => row.split('\t'))
      .filter(([, deleted]) => deleted === '-' || Number(deleted) > 0)
      .map(([, , file]) => file);
  }

  /** One Agent SDK call; returns the final message and what it cost beyond what the session had already spent. */
  async function agentTurn(storeId, chatId, { prompt, images = [], model, settings, maxBudgetUsd, cwd, eyes = null }) {
    const chat = chats.get(storeId, chatId);
    // a turn that hangs (a stuck tool, a stuck preview) ends instead of holding the store forever
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.turnTimeoutMs ?? 10 * 60_000);
    const stream = query({
      prompt: promptWithImages(prompt, images),
      options: {
        abortController: abort,
        cwd,
        model,
        effort: settings.effort,
        maxTurns: settings.maxTurns,
        maxBudgetUsd: Math.max(0.01, maxBudgetUsd),
        tools: TOOLS,
        allowedTools: eyes ? [...TOOLS, SCREENSHOT_TOOL] : TOOLS,
        ...(eyes ? { mcpServers: { editor: eyes } } : {}),
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: systemPrompt(cwd, { eyes: !!eyes, pages: eyes?.pages }),
        ...(chat.sessionId ? { resume: chat.sessionId } : {}),
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'storefront-editor/0.1' },
        hooks: { PreToolUse: [{ hooks: [fileGuard(cwd, policy)] }] },
      },
    });
    let result = null;
    let sessionId = chat.sessionId;
    try {
      for await (const message of stream) {
        if (message.session_id) sessionId = message.session_id;
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      if (abort.signal.aborted) throw new ChangeError('timeout', 'The agent took too long.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (abort.signal.aborted) throw new ChangeError('timeout', 'The agent took too long.');
    if (!result) throw new ChangeError('agent_failed', 'The agent ended without a result.');
    const total = Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
    // a resumed session's total starts from what its transcript saved; charge only the new part
    const previous = chat.sessionId === sessionId ? chat.sessionCostUsd : 0;
    const costUsd = total >= previous ? total - previous : total;
    chats.update(storeId, chatId, (c) => {
      c.sessionId = sessionId;
      c.sessionCostUsd = total;
    });
    return {
      subtype: result.subtype,
      text: result.subtype === 'success' ? String(result.result ?? '').trim() : '',
      costUsd,
      charge: { kind: 'edit', model, costUsd, usage: result.modelUsage ?? null },
    };
  }

  /**
   * The screenshot tool for one run: only with a dev preview, which shows the copy as the agent edits it. The
   * preview is started (or reused) first, so the agent can look before it changes anything.
   */
  async function eyesFor(storeId, runId, { light = false, chatId = null } = {}) {
    if (!browsers || config.previewMode !== 'dev') return null;
    try {
      // a run that only talks (another chat may hold the build) keeps its steps on its own chat
      if (!light) setRun(storeId, { state: 'building_preview' });
      const started = await previews.start(storeId);
      const server = screenshotServer({
        pool: browsers,
        // checked before every shot: a hung dev server is restarted instead of blinding the agent
        baseUrl: async () => `http://127.0.0.1:${await previews.ensure(storeId)}`,
        saveDir: path.join(config.dataDir, 'runs', runId),
        onShot: (file) => {
          if (!light) setRun(storeId, { screenshots: [...(chats.state.get(storeId).run?.screenshots ?? []), file] });
        },
        onStep: (text) => (light ? addLightStep(storeId, chatId, text) : addStep(storeId, text, 'look')),
      });
      // real addresses of each kind of page, so it can look everywhere its change shows
      server.pages = await samplePages(`http://127.0.0.1:${started.port}`);
      return server;
    } catch (error) {
      log('no screenshots for this run', storeId, runId, error.message);
      return null;
    }
  }


  /** The plan waiting for the owner's OK (or null). */
  function setPending(storeId, chatId, plan) {
    chats.update(storeId, chatId, (chat) => {
      chat.pending = plan ? { ...plan, at: new Date().toISOString() } : null;
    });
  }

  function setRun(storeId, fields) {
    chats.state.update(storeId, (state) => {
      state.run = { ...(state.run ?? {}), ...fields, updatedAt: new Date().toISOString() };
    });
  }

  /** One line of the live activity list (plain words, the last 50 are kept). */
  function addStep(storeId, text, kind = 'phase') {
    chats.state.update(storeId, (state) => {
      if (!state.run) return;
      const steps = [...(state.run.steps ?? []), { at: new Date().toISOString(), kind, text }];
      state.run.steps = steps.slice(-50);
    });
  }

  /** A run that only talks (another chat holds the build) keeps its small state on its own chat. */
  function setLight(storeId, chatId, fields) {
    chats.update(storeId, chatId, (chat) => {
      chat.lightRun = { ...(chat.lightRun ?? {}), ...fields, updatedAt: new Date().toISOString() };
    });
  }

  /** One line of the live list of a run that only talks. */
  function addLightStep(storeId, chatId, text) {
    chats.update(storeId, chatId, (chat) => {
      if (!chat.lightRun) return;
      chat.lightRun.steps = [...(chat.lightRun.steps ?? []), { at: new Date().toISOString(), kind: 'phase', text }].slice(-50);
    });
  }

  /** The AI's last edits in this chat were thrown away (its session still remembers them). */
  function markUndone(storeId, chatId) {
    try {
      chats.update(storeId, chatId, (c) => (c.editsUndone = true));
    } catch {
      // the chat was deleted meanwhile
    }
  }

  /** The owner's language for the few fixed sentences the editor says itself. */
  const said = (ownerText, en, ar) => (/[؀-ۿ]/.test(ownerText) ? ar : en);

  /** Commands that make no AI call: they never hold the store's build slot. */
  const NO_COST = ['read_website', 'style_cancel', 'apply_style'];

  /** The style card a button was pressed on (null when it is not there or was used already). */
  function styleCardOf(storeId, chatId, cardId) {
    const message = chats.get(storeId, chatId).messages.find((m) => m.id === cardId && m.kind === 'style_card');
    return message?.card && !message.card.used ? message.card : null;
  }

  /** "Read a website": the look of a public page as a card the owner ticks. No AI, no cost. */
  async function readWebsite({ storeId, chatId, runId, text, command, cwd }) {
    const step = (line) => addLightStep(storeId, chatId, line);
    const fail = (reply, outcome) => {
      chats.say(storeId, chatId, 'assistant', reply, { runId });
      return outcome;
    };
    if (!siteReader) return fail(said(text, 'I cannot read websites right now.', 'لا أستطيع قراءة المواقع الآن.'), 'site_reader_off');
    step('Opening the website');
    let seen;
    try {
      seen = await siteReader.read({ url: command.url, mode: command.mode === 'style_layout' ? 'style_layout' : 'style' });
    } catch (error) {
      log('read website failed', storeId, runId, error.code ?? error.message);
      if (error.code === 'url_refused') return fail(said(text, error.message, 'لا يمكن قراءة هذا العنوان. أعطني رابط موقع عام يبدأ بـ https://.'), 'url_refused');
      if (error.code === 'unreachable' || error.code === 'timeout') return fail(said(text, error.message, 'تعذّر فتح هذا الموقع أو أنه استغرق وقتًا طويلًا.'), 'site_unreadable');
      return fail(said(text, 'I could not read that website.', 'لم أتمكن من قراءة هذا الموقع.'), 'site_unreadable');
    }
    step('Reading its colours, fonts and shapes');
    const rows = cardRows(seen.style, command.mode === 'style_layout' ? seen.layout : null, cwd);
    if (!rows.length) return fail(said(text, 'I could not read the look of that website.', 'لم أتمكن من قراءة شكل هذا الموقع.'), 'site_unreadable');
    let images = [];
    if (seen.screenshot) {
      const runDir = path.join(config.dataDir, 'runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'site.jpg'), seen.screenshot);
      images = saveShots(config.dataDir, storeId, chatId, runId, runDir, ['site.jpg']);
    }
    chats.say(storeId, chatId, 'assistant', said(text, `This is the look I read from ${seen.host}. Tick what you would like to use.`, `هذا هو الشكل الذي قرأته من ${seen.host}. اختر ما تريد استخدامه.`), {
      runId,
      kind: 'style_card',
      card: { host: seen.host, mode: command.mode === 'style_layout' ? 'style_layout' : 'style', rows, layout: command.mode === 'style_layout' ? seen.layout : null, used: null },
      ...(images.length ? { images } : {}),
    });
    return 'style_card';
  }

  /** "Apply selected": the ticked rows become a plan the owner confirms (a site-wide edit, built as usual after yes). */
  function applyStyle({ storeId, chatId, runId, text, command }) {
    const card = styleCardOf(storeId, chatId, command.cardId);
    if (!card) {
      chats.say(storeId, chatId, 'assistant', said(text, 'That suggestion is not available any more.', 'هذا الاقتراح لم يعد متاحًا.'), { runId });
      return 'unclear';
    }
    const rows = chosenRows(card, command.selected);
    if (!rows.length) {
      chats.say(storeId, chatId, 'assistant', said(text, 'Tick at least one item first.', 'اختر عنصرًا واحدًا على الأقل أولًا.'), { runId });
      return 'unclear';
    }
    chats.update(storeId, chatId, (chat) => {
      const message = chat.messages.find((m) => m.id === command.cardId);
      if (message?.card) message.card.used = 'applied';
    });
    const arabic = /[؀-ۿ]/.test(text);
    // the confirmation is ours, not the triage's: it must not name a different website
    const apply = { task: applyTask(rows, card.layout), large: false, shared: true, images: [], ack: arabic ? 'جارٍ تطبيق الشكل الذي اخترته.' : 'On it: applying the look you picked.' };
    if (rows.some((r) => r.id === 'colour_primary') && !hasButtonToken(stores.workspaceOf(storeId))) {
      // the main buttons have no colour of their own yet: first give them one (nothing looks different), then apply
      setPending(storeId, chatId, {
        task: buttonTokenTask(),
        large: true,
        shared: true,
        images: [],
        ack: arabic ? 'جارٍ إعطاء الأزرار الرئيسية لونًا خاصًا بها (دون أي تغيير في الشكل).' : 'On it: giving your main buttons a colour of their own (nothing will look different).',
        then: { ...apply, afterApprove: true },
      });
      chats.say(
        storeId,
        chatId,
        'assistant',
        arabic
          ? `أزرارك الرئيسية تستخدم لون النص، لذلك أحتاج خطوتين. أولًا: أعطي الأزرار لونًا خاصًا بها (لن يتغير أي شيء في الشكل)، ثم توافق عليه. ثانيًا: ${planText(rows, true)}`
          : `Your main buttons use the text colour, so this takes two steps. First, I give the buttons a colour of their own (nothing will look different) and you approve it. Then: ${planText(rows, false)}`,
        { runId, kind: 'plan', options: arabic ? ['نعم، تابع', 'لا، ألغِ'] : ['Yes, go ahead', 'No, cancel'] },
      );
      return 'plan';
    }
    setPending(storeId, chatId, apply);
    chats.say(storeId, chatId, 'assistant', planText(rows, arabic), { runId, kind: 'plan', options: arabic ? ['نعم، تابع', 'لا، ألغِ'] : ['Yes, go ahead', 'No, cancel'] });
    return 'plan';
  }

  /** A read-only look at the store that answers "why…?" in plain words (screenshots + reading code, no edits). */
  async function explainTurn({ storeId, chatId, runId, text, light, settings, maxBudgetUsd, cwd }) {
    const model = aiConfig.editModel(storeId, { large: false });
    const eyes = browsers && config.previewMode === 'dev' ? await eyesFor(storeId, runId, { light, chatId }) : null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.turnTimeoutMs ?? 10 * 60_000);
    let result = null;
    try {
      for await (const message of query({
        prompt: `The owner asks:\n${text}\n\nThe conversation so far:\n${chats.recent(storeId, chatId, 8).map((m) => `${m.role}: ${m.text}`).join('\n')}`,
        options: {
          abortController: abort,
          cwd,
          model,
          effort: settings.effort,
          maxTurns: Math.min(settings.maxTurns, 20),
          maxBudgetUsd: Math.max(0.01, maxBudgetUsd),
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: eyes ? ['Read', 'Glob', 'Grep', SCREENSHOT_TOOL] : ['Read', 'Glob', 'Grep'],
          ...(eyes ? { mcpServers: { editor: eyes } } : {}),
          permissionMode: 'dontAsk',
          permissionPrompts: 'none',
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          systemPrompt: explainPrompt(),
          env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'storefront-editor/0.1' },
          hooks: { PreToolUse: [{ hooks: [fileGuard(cwd, policy)] }] },
        },
      })) {
        if (message.type === 'result') result = message;
      }
    } finally {
      clearTimeout(timer);
    }
    const costUsd = Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : 0;
    return { text: result?.subtype === 'success' ? String(result.result ?? '').trim() : '', charge: { kind: 'explain', model, costUsd, usage: result?.modelUsage ?? null } };
  }

  /** The bug card a button was pressed on (null when it is not there, used already, or has nothing to act on). */
  function cardOf(storeId, chatId, cardId) {
    const message = chats.get(storeId, chatId).messages.find((m) => m.id === cardId && m.kind === 'bug_report');
    const card = message?.card;
    if (!card || card.used || card.cause !== 'store_change') return null;
    return card;
  }

  /** "Checked again: fixed" / "Still happens": the bug's steps repeated in a fresh browser after a fix or an undo. */
  async function announceRecheck(storeId, chatId, runId, text, recheck) {
    addStep(storeId, 'Checking the problem again');
    const verdict = await diagnoser?.recheck(storeId, recheck);
    if (!verdict) return;
    const lines = {
      fixed: ['Checked again: fixed.', 'تمت إعادة الفحص: تم الإصلاح.'],
      still: ['Checked again: it still happens.', 'تمت إعادة الفحص: المشكلة ما زالت موجودة.'],
      unchecked: ['I could not check it again myself. Please look at the preview.', 'لم أتمكن من إعادة الفحص بنفسي. يرجى إلقاء نظرة على المعاينة.'],
    }[verdict];
    chats.say(storeId, chatId, 'assistant', said(text, ...lines), { runId, recheck: verdict });
  }

  /**
   * "Undo the change": one earlier change of the AI Designer reverted as a normal draft (Approve and Discard work as
   * usual). No AI call. Conflicts or failing checks leave the draft as it was.
   */
  async function undoChange({ storeId, chatId, runId, text, job, cwd, phase }) {
    await ensureDraft(storeId, cwd);
    phase('editing', 'Undoing the change');
    const before = (await git(['rev-parse', 'HEAD'], cwd)).trim();
    const sorry = (reason) =>
      chats.say(storeId, chatId, 'assistant', said(text, 'I could not undo that change by itself, so nothing was changed. You were not charged for it.', 'لم أستطع التراجع عن هذا التغيير تلقائيًا، لذلك لم يتغير شيء. لم يتم خصم أي رصيد.'), { runId, error: reason });
    const reverted = await run('git', [...AUTHOR, 'revert', '--no-edit', job.undo.commit], { cwd });
    if (reverted.code !== 0) {
      await run('git', ['revert', '--abort'], { cwd });
      await resetWorkspace(cwd);
      sorry('undo_conflict');
      return 'undo_conflict';
    }
    const changed = (await git(['diff', '--name-only', before, 'HEAD'], cwd)).split('\n').map((f) => f.trim()).filter((f) => f && fs.existsSync(path.join(cwd, f)));
    phase('checking', 'Checking everything still works', { files: changed.length });
    const checked = await stores.check(storeId, { files: changed });
    if (!checked.ok) {
      setRun(storeId, { lastFailure: { round: 0, step: checked.step, output: String(checked.output ?? '').slice(-4000) } });
      await git(['reset', '-q', '--hard', before], cwd);
      sorry('checks_failed');
      return 'checks_failed';
    }
    phase('building_preview', 'Preparing the preview');
    let preview;
    try {
      preview = await previews.start(storeId);
    } catch (error) {
      await git(['reset', '-q', '--hard', before], cwd);
      throw error;
    }
    const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
    chats.state.update(storeId, (state) => {
      state.draft = { branch: draftOf(storeId), commit, updatedAt: new Date().toISOString(), chatId: state.draft?.chatId ?? chatId };
    });
    chats.say(storeId, chatId, 'assistant', said(text, `Done. I undid "${job.undo.title}". Have a look at the preview.`, `تم. تراجعت عن "${job.undo.title}". ألقِ نظرة على المعاينة.`), { runId, preview: preview.url });
    if (job.recheck) await announceRecheck(storeId, chatId, runId, text, job.recheck);
    return 'preview';
  }

  async function work(storeId, chatId, runId, text, reservation, light, images = [], savedRefs = [], command = null) {
    const settings = aiConfig.forStore(storeId);
    const cwd = stores.workspaceOf(storeId);
    const charges = [];
    const refundable = [];
    let spent = 0;
    const charge = (entry, refund = false) => {
      charges.push({ runId, ...entry });
      spent += entry.costUsd;
      if (refund) refundable.push(entry.costUsd);
    };
    let outcome = 'failed';
    /** A phase of the run: the state the page maps to a status, and one plain line of the live list. */
    const phase = (state, line, fields = {}) => {
      setRun(storeId, { state, ...fields });
      if (line) addStep(storeId, line);
    };

    try {
      if (command?.name === 'read_website') {
        if (chats.get(storeId, chatId).title === NEW_CHAT_TITLE) {
          const host = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(command.url ?? '')?.[1];
          if (host) chats.rename(storeId, chatId, said(text, `Look of ${host}`, `شكل ${host}`));
        }
        outcome = await readWebsite({ storeId, chatId, runId, text, command, cwd });
        return;
      }
      if (command?.name === 'apply_style') {
        outcome = applyStyle({ storeId, chatId, runId, text, command });
        return;
      }
      if (command?.name === 'style_cancel') {
        const card = styleCardOf(storeId, chatId, command.cardId);
        if (card) {
          chats.update(storeId, chatId, (chat) => {
            const message = chat.messages.find((m) => m.id === command.cardId);
            if (message?.card) message.card.used = 'cancelled';
          });
        }
        chats.say(storeId, chatId, 'assistant', said(text, 'OK, your store stays as it is.', 'حسنًا، يبقى متجرك كما هو.'), { runId });
        outcome = 'style_cancelled';
        return;
      }
      const pending = chats.get(storeId, chatId).pending ?? null;
      // a button of the page (Fix a bug, Undo the change, Fix it instead) says what it wants: no triage for those
      const card = command && command.name !== 'fix_bug' ? cardOf(storeId, chatId, command.cardId) : null;
      let decision;
      if (command?.name === 'fix_bug') {
        decision = { decision: 'bug', refuseKind: 'none', title: text.slice(0, 40), reply: said(text, 'I will look into it.', 'سأبحث في الأمر.'), model: null, costUsd: 0, usage: null };
      } else if (command) {
        decision = { decision: card ? 'edit' : 'unclear', refuseKind: 'none', title: '', reply: card ? 'On it.' : said(text, 'That suggestion is not available any more.', 'هذا الاقتراح لم يعد متاحًا.'), model: null, costUsd: 0, usage: null };
      } else decision = await triage(text, chats.recent(storeId, chatId), { pending, images });
      if (decision.model) charge({ kind: 'triage', model: decision.model, costUsd: decision.costUsd, usage: decision.usage });
      const title = cleanTitle(decision.title);
      if (title && chats.get(storeId, chatId).title === NEW_CHAT_TITLE) chats.rename(storeId, chatId, title);

      // what gets built: a clear request now, or the plan the owner just accepted
      const pendingRefs = decision.decision === 'go_ahead' ? [...(pending?.images ?? []), ...savedRefs].slice(0, 3) : savedRefs;
      let job = null;
      let ack = null;
      if (decision.decision === 'go_ahead' && pending?.afterApprove && chats.state.get(storeId).draft) {
        // the step before must be approved first, so this change stands on its own
        chats.say(storeId, chatId, 'assistant', said(text, 'Please press Approve at the top first, then say "yes" and I will apply the look.', 'اضغط "موافقة" في الأعلى أولًا، ثم قل "نعم" وسأطبّق الشكل.'), { runId, kind: 'plan', options: said(text, ['Yes, go ahead'], ['نعم، تابع']) });
        outcome = 'plan';
        return;
      } else if (decision.decision === 'go_ahead' && pending) {
        job = { task: pending.task, large: pending.large, shared: !!pending.shared, images: [...loadImages(config.dataDir, storeId, chatId, pending.images), ...images].slice(0, 3), then: pending.then ?? null };
        ack = pending.ack || decision.reply || 'On it.';
      } else if (decision.decision === 'edit' && (decision.confirm || decision.large)) {
        // unclear, large or site-wide: show the plan and wait for the owner's OK (a large request always asks)
        setPending(storeId, chatId, { task: decision.task, large: decision.large, shared: !!decision.shared, images: savedRefs });
        chats.say(storeId, chatId, 'assistant', decision.reply, { runId, kind: 'plan', options: cleanOptions(decision.options) });
        outcome = 'plan';
        return;
      } else if (command && card) {
        // Undo the change / Fix it instead: from the bug card the owner pressed it on
        const used = command.name === 'bug_undo' ? 'undo' : 'fix';
        job = command.name === 'bug_undo' ? { undo: { commit: card.suspectCommit, title: card.suspectTitle }, images: [], recheck: card.recheck } : { task: card.fixPlan, large: false, shared: true, images: [], recheck: card.recheck };
        chats.update(storeId, chatId, (chat) => {
          const message = chat.messages.find((m) => m.id === command.cardId);
          if (message?.card) message.card.used = used;
        });
        ack = decision.reply;
      } else if (decision.decision === 'edit') {
        job = { task: decision.task, large: decision.large, shared: !!decision.shared, images };
        ack = decision.reply;
      } else if (decision.decision === 'explain') {
        chats.say(storeId, chatId, 'assistant', said(text, 'I will have a look and explain.', 'سألقي نظرة وأشرح لك.'), { runId });
        const answer = await explainTurn({ storeId, chatId, runId, text, light, settings, maxBudgetUsd: (reservation?.amountUsd ?? settings.perRequestMaxUsd) - spent, cwd });
        charge(answer.charge);
        chats.say(storeId, chatId, 'assistant', answer.text || said(text, 'I could not look at it right now.', 'لم أتمكن من الاطلاع عليه الآن.'), { runId });
        outcome = 'explained';
        return;
      } else if (decision.decision === 'bug') {
        if (!diagnoser || !browsers) {
          chats.say(storeId, chatId, 'assistant', said(text, 'I cannot look at your store right now. Please describe what you see, or try again in a few minutes.', 'لا أستطيع فحص متجرك الآن. صف لي ما تراه، أو حاول مرة أخرى بعد قليل.'), { runId });
          outcome = 'bug';
          return;
        }
        // our own words: looking into a problem never promises a fix
        chats.say(storeId, chatId, 'assistant', said(text, 'I will look into it.', 'سأبحث في الأمر.'), { runId });
        const step = (line) => (light ? addLightStep(storeId, chatId, line) : addStep(storeId, line));
        step('Reading your report');
        const found = await diagnoser.diagnose({
          storeId,
          chatId,
          runId,
          text,
          images,
          savedRefs,
          model: aiConfig.editModel(storeId, { large: false }),
          settings,
          maxBudgetUsd: (reservation?.amountUsd ?? settings.perRequestMaxUsd) - spent,
          guard: fileGuard(cwd, policy),
          onStep: step,
          onShot: (file) => {
            if (!light) setRun(storeId, { screenshots: [...(chats.state.get(storeId).run?.screenshots ?? []), file] });
          },
        });
        charge(found.charge, true);
        if (found.failed) throw new ChangeError('agent_failed', 'The diagnosis gave no usable answer.');
        chats.say(storeId, chatId, 'assistant', found.text, { runId, kind: 'bug_report', card: found.card, ...(found.images.length ? { images: found.images } : {}) });
        outcome = found.reproduced ? 'bug_found' : 'bug_not_reproduced';
        return;
      } else if (decision.decision === 'refuse') {
        const refuseKind = ['business_logic', 'needs_backend', 'unsafe'].includes(decision.refuseKind) ? decision.refuseKind : 'unsafe';
        // something the store needs from us: our team gets the owner's words (and pictures). "Send it to our team"
        // says nothing by itself: the request is the owner's message before it
        const tapped = /^(send it to our team|أرسله إلى فريقكم)$/i.test(text.trim());
        const request = tapped ? (chats.get(storeId, chatId).messages.filter((m) => m.role === 'merchant' && m.text).at(-2)?.text ?? text) : text;
        const report =
          refuseKind === 'needs_backend' && reports
            ? reports.create({
                storeId,
                chatId,
                summary: (decision.task || request).slice(0, 300),
                ownerText: request,
                files: { images: savedRefs.map((r) => ({ path: path.join(config.dataDir, 'uploads', storeId, chatId, r.file), name: r.file })) },
              })
            : null;
        chats.say(storeId, chatId, 'assistant', decision.reply, { runId, kind: 'refusal', card: { refuseKind, ...(report ? { reportId: report.id } : {}) } });
        outcome = 'refuse';
        return;
      } else {
        // a question about the AI Designer gets the store's preview link when one is running
        const preview = decision.decision === 'help' ? previews.list().find((p) => p.id === storeId) : null;
        const reply = decision.decision === 'go_ahead' ? 'There is no change waiting to be made. What would you like to change?' : decision.reply;
        // a request only our team can build is sent when the owner asks for it (then it is a "refuse" that makes a report)
        const options =
          decision.decision === 'unclear' ? cleanOptions(decision.options) : decision.decision === 'needs_backend' && reports ? [said(text, 'Send it to our team', 'أرسله إلى فريقكم')] : [];
        chats.say(storeId, chatId, 'assistant', reply, { runId, ...(preview ? { preview: preview.url } : {}), ...(options.length ? { options } : {}) });
        outcome = decision.decision === 'go_ahead' ? 'unclear' : decision.decision;
        return;
      }

      if (light) {
        // another chat held the build when this message came in: take the store if it is free now, else wait
        try {
          reservation = ledger.reserve(storeId);
          light = false;
          chats.state.update(storeId, (state) => {
            state.run = { id: runId, chatId, state: 'editing', startedAt: new Date().toISOString(), outcome: null, round: 0, steps: [] };
          });
        } catch (error) {
          if (!(error instanceof BudgetError) || error.code !== 'busy') throw error;
          const other = chats.state.get(storeId).run;
          const otherTitle = other ? chats.get(storeId, other.chatId).title : '';
          setPending(storeId, chatId, { task: job.task, large: job.large, shared: job.shared, images: pendingRefs, ...(decision.decision === 'go_ahead' && pending?.ack ? { ack: pending.ack } : {}) });
          chats.say(
            storeId,
            chatId,
            'assistant',
            said(
              text,
              `Another change is being made in "${otherTitle}". You can keep planning here; I will build this when it is finished.`,
              `يجري الآن تنفيذ تغيير آخر في "${otherTitle}". يمكنك متابعة التخطيط هنا، وسأنفذ هذا الطلب عندما ينتهي.`,
            ),
            { runId, notice: 'busy_other_chat' },
          );
          outcome = 'busy_other_chat';
          return;
        }
      }
      chats.say(storeId, chatId, 'assistant', ack, { runId, kind: 'understood' });
      setPending(storeId, chatId, null);

      if (job.undo) {
        outcome = await undoChange({ storeId, chatId, runId, text, job, cwd, phase });
        return;
      }

      const model = aiConfig.editModel(storeId, { large: job.large });
      await ensureDraft(storeId, cwd);
      const eyes = await eyesFor(storeId, runId);
      phase('editing', 'Changing files', { model });

      // the editing AI gets the job triage resolved plus the conversation, not just the owner's last few words
      // the AI's session remembers edits the editor threw away: say so once, or it believes they are still there
      const undone = !!chats.get(storeId, chatId).editsUndone;
      if (undone) chats.update(storeId, chatId, (c) => (c.editsUndone = false));
      const prompt = taskPrompt({ task: job.task, latest: text, recent: chats.recent(storeId, chatId, 12), shared: job.shared, pictures: job.images.length, undone });
      let turn = await agentTurn(storeId, chatId, { prompt, images: job.images, model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd, eyes });
      charge(turn.charge, true);

      let looked = false;
      for (let round = 0; ; round++) {
        if (turn.subtype === 'error_max_budget_usd') throw new ChangeError('budget_stop', 'This request needed more than one request may spend.');
        if (turn.subtype !== 'success') throw new ChangeError('agent_failed', `The agent stopped (${turn.subtype}).`);

        let changed = await changedFiles(cwd);
        // it must have seen its change on phone and desktop: if not, once, it looks now (and fixes what it sees)
        if (eyes && !looked && changed.length) {
          looked = true;
          const missing = await missingLooks(cwd, changed, path.join(config.dataDir, 'runs', runId));
          const admitted = admitsUnchecked(turn.text);
          log('looked', storeId, runId, missing.length ? `missing ${missing.join(', ')}` : 'phone and desktop', admitted ? 'but says it did not check something' : '');
          if (missing.length || admitted) {
            phase('editing', 'Looking at the change on phone and desktop', { model });
            turn = await agentTurn(storeId, chatId, { prompt: lookPrompt(missing.length ? missing : ['phone', 'desktop'], admitted), model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd, eyes });
            charge(turn.charge, true);
            if (turn.subtype === 'error_max_budget_usd') throw new ChangeError('budget_stop', 'This request needed more than one request may spend.');
            if (turn.subtype !== 'success') throw new ChangeError('agent_failed', `The agent stopped (${turn.subtype}).`);
            changed = await changedFiles(cwd);
          }
        }
        const outside = changed.filter((file) => !policy.canEdit(file));
        if (outside.length) throw new ChangeError('outside_allowed_files', `Changed files the editor does not allow: ${outside.join(', ')}`);
        if (changed.length === 0) {
          // the agent explained instead of editing (needs the backend, a question...)
          // a question ending with short choices: the choices become tap buttons
          const asked = splitChoices(turn.text || 'I did not change anything.');
          chats.say(storeId, chatId, 'assistant', asked.text, { runId, ...(asked.options.length ? { options: asked.options } : {}) });
          outcome = 'no_change';
          return;
        }
        // stop and ask: an existing shared part changed although the request was not about it
        const sharedTouched = job.shared ? [] : (await modifiedFiles(cwd)).filter((file) => policy.isShared(file));
        if (sharedTouched.length) {
          setRun(storeId, { lastFailure: { round, step: 'shared parts changed', output: sharedTouched.join('\n') } });
          await resetWorkspace(cwd);
          markUndone(storeId, chatId);
          setPending(storeId, chatId, { task: job.task, large: job.large, shared: true, images: pendingRefs });
          const question = askShared(text);
          chats.say(storeId, chatId, 'assistant', question.text, { runId, kind: 'plan', options: question.options });
          outcome = 'needs_confirmation';
          return;
        }

        phase('checking', 'Checking everything still works', { round, files: changed.length });
        let failure = null;
        const checked = await stores.check(storeId, { files: changed });
        if (!checked.ok) failure = { step: checked.step, output: checked.output };
        else {
          phase('building_preview', 'Preparing the preview');
          try {
            const preview = await previews.start(storeId);
            await git(['add', '-A'], cwd);
            await git([...AUTHOR, 'commit', '-q', '-m', `AI Designer: ${(job.task || text).slice(0, 72)}`, '-m', `owner: ${text.slice(0, 200)}\nrun ${runId}`], cwd);
            const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
            chats.state.update(storeId, (state) => {
              // a second change on an open draft stays under the chat that began it
              state.draft = { branch: draftOf(storeId), commit, updatedAt: new Date().toISOString(), chatId: state.draft?.chatId ?? chatId };
            });
            chats.say(storeId, chatId, 'assistant', turn.text || 'Done. Have a look at the preview.', { runId, preview: preview.url });
            outcome = 'preview';
            if (job.recheck) await announceRecheck(storeId, chatId, runId, text, job.recheck);
            if (job.then) {
              // the first of two steps is ready: the second waits for the owner's Approve and "yes"
              setPending(storeId, chatId, job.then);
              chats.say(storeId, chatId, 'assistant', said(text, 'Step 1 is ready: your main buttons now have a colour of their own, and the store looks the same. Press Approve at the top, then say "yes" and I will apply the look.', 'الخطوة الأولى جاهزة: أصبح للأزرار الرئيسية لون خاص بها، والمتجر يبدو كما هو. اضغط "موافقة" في الأعلى، ثم قل "نعم" وسأطبّق الشكل.'), { runId, kind: 'plan', options: said(text, ['Yes, go ahead'], ['نعم، تابع']) });
            }
            return;
          } catch (error) {
            if (!(error instanceof PreviewError) || error.code !== 'build_failed') {
              // not the agent's fault (the preview server, a port...): keep what it said for us, then give up
              if (error instanceof PreviewError) setRun(storeId, { lastFailure: { round, step: `preview ${error.code}`, output: String(error.output ?? '').slice(-4000) } });
              throw error;
            }
            failure = { step: 'build', output: error.output };
          }
        }

        // kept on the run for us (debugging, evals); never shown to the merchant
        setRun(storeId, { lastFailure: { round, step: failure.step, output: String(failure.output ?? '').slice(-4000) } });
        if (round >= settings.maxFixRounds) throw new ChangeError('checks_failed', `Still failing after ${round} fix rounds (${failure.step}).`);
        phase('fixing', 'Fixing a problem the checks found', { round: round + 1 });
        turn = await agentTurn(storeId, chatId, { prompt: fixPrompt(failure.step, failure.output), model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd, eyes });
        charge({ ...turn.charge, kind: 'fix' }, true);
      }
    } catch (error) {
      outcome = error.code ?? 'error';
      log('run failed', storeId, runId, error);
      if (!light) {
        await resetWorkspace(cwd).catch(() => {});
        markUndone(storeId, chatId);
      }
      // the AI service out of reach (network, overload) is not the change's fault: say so, so the owner simply retries
      const unreachable = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Can't reach the API|overloaded|rate.?limit|\b52\d\b/i.test(String(error?.message ?? error));
      if (unreachable) outcome = 'ai_unreachable';
      const reply =
        outcome === 'budget_stop'
          ? said(text, 'This change is bigger than one request allows. Could you ask for a smaller part of it first?', 'هذا التغيير أكبر مما يسمح به طلب واحد. هل يمكنك أن تطلب جزءًا أصغر منه أولًا؟')
          : unreachable
            ? said(text, 'I could not reach the AI service just now, so nothing was changed. Please send your message again in a minute. You were not charged.', 'تعذّر عليّ الوصول إلى خدمة الذكاء الاصطناعي الآن، لذلك لم يتغير شيء. يرجى إرسال رسالتك مرة أخرى بعد دقيقة. لم يتم احتساب أي تكلفة.')
            : said(text, 'I could not make this change safely, so nothing was changed. You were not charged for it.', 'لم أتمكن من تنفيذ هذا التغيير بأمان، لذلك لم يتغير شيء. لم يتم احتساب أي تكلفة.');
      chats.say(storeId, chatId, 'assistant', reply, { runId, error: outcome });
    } finally {
      // the run always ends: a broken cost figure is logged and charged as 0, never left hanging
      let status = null;
      let refunded = 0;
      try {
        if (reservation) {
          status = ledger.settle(reservation, charges);
          refunded = !['preview', 'no_change', 'bug_found'].includes(outcome) && refundable.length ? refundable.reduce((a, b) => a + b, 0) : 0;
          if (refunded > 0) status = ledger.refund(storeId, runId, refunded, outcome);
        } else {
          status = ledger.record(storeId, charges);
          refunded = !['preview', 'no_change', 'bug_found'].includes(outcome) && refundable.length ? refundable.reduce((a, b) => a + b, 0) : 0;
          if (refunded > 0) status = ledger.refund(storeId, runId, refunded, outcome);
        }
      } catch (error) {
        log('settle failed', storeId, runId, error);
        if (reservation) ledger.release(reservation);
      }
      const done = { state: 'done', outcome, costUsd: Math.round(Math.max(0, spent - refunded) * 1e6) / 1e6, budget: status };
      if (reservation) {
        setRun(storeId, done);
        addStep(storeId, 'Done');
      } else setLight(storeId, chatId, done);
      log('run done', storeId, runId, outcome, spent.toFixed(4));
    }
  }

  /** An undo rewrites the store's branch in the workspace: nothing else may touch it meanwhile. */
  function undoGuard(storeId) {
    if (chats.state.get(storeId).publish?.state === 'undoing') throw new ChangeError('busy', 'The website is being put back to its earlier version. Please wait.');
  }

  /** A page note ("Approved.") goes to the chat that made the draft and to the chat the owner pressed the button in. */
  function noteStoreAction(storeId, draftChatId, viewingChatId, text, extra = {}) {
    const targets = new Set([draftChatId, viewingChatId].filter(Boolean));
    if (!targets.size) targets.add(null);
    for (const id of targets) chats.note(storeId, id, 'system', text, extra);
  }

  return {
    /**
     * Starts a run for a merchant message and returns at once (the admin page polls the chat). Throws `busy` or
     * `out_of_budget` before anything starts. While another chat holds the store's build, the message still gets
     * an answer (a question, a plan); a build waits and the chat says which chat is building.
     */
    async send(storeId, text, { chatId = MAIN_CHAT, images: rawImages, command: rawCommand, cardId, url, mode, selected } = {}) {
      await stores.get(storeId);
      undoGuard(storeId);
      if (typeof text !== 'string' || !text.trim()) throw new ChangeError('empty_message', 'The message is empty.');
      if (text.length > 4000) throw new ChangeError('message_too_long', 'The message is too long.');
      const images = checkImages(rawImages);
      const chat = chats.get(storeId, chatId);
      if (chat.lightRun && chat.lightRun.state !== 'done') throw new ChangeError('busy', 'This chat is still working on your last message.');
      const building = chats.state.get(storeId).run;
      let reservation = null;
      let light = false;
      const noCost = NO_COST.includes(rawCommand);
      try {
        // commands that call no AI never hold the build slot
        if (noCost) throw new BudgetError('busy', 'no reservation needed');
        reservation = ledger.reserve(storeId);
      } catch (error) {
        if (noCost) {
          light = true;
        } else {
        const elsewhere = building && building.state !== 'done' && building.chatId !== chatId;
        if (!(error instanceof BudgetError) || error.code !== 'busy' || !elsewhere) throw error;
        const current = ledger.status(storeId);
        if (current.blocked) throw new BudgetError('out_of_budget', 'The AI budget for this month is used up.', current);
        light = true;
        }
      }
      const runId = randomUUID();
      const savedRefs = saveImages(config.dataDir, storeId, chatId, runId, images);
      chats.say(storeId, chatId, 'merchant', text.trim(), { runId, ...(savedRefs.length ? { images: savedRefs } : {}) });
      const startedAt = new Date().toISOString();
      if (light) {
        chats.update(storeId, chatId, (c) => {
          c.lightRun = { id: runId, state: 'triage', startedAt, outcome: null, updatedAt: startedAt };
        });
      } else {
        chats.update(storeId, chatId, (c) => {
          c.lightRun = null;
        });
        chats.state.update(storeId, (state) => {
          state.run = { id: runId, chatId, state: 'triage', startedAt, outcome: null, round: 0, steps: [{ at: startedAt, kind: 'phase', text: 'Reading your request' }], updatedAt: startedAt };
        });
      }
      const command = ['fix_bug', 'bug_undo', 'bug_fix', ...NO_COST].includes(rawCommand)
        ? { name: rawCommand, cardId: typeof cardId === 'string' ? cardId : null, url: typeof url === 'string' ? url.slice(0, 2048) : '', mode: mode === 'style_layout' ? 'style_layout' : 'style', selected: Array.isArray(selected) ? selected.slice(0, 30) : [] }
        : null;
      const done = work(storeId, chatId, runId, text.trim(), reservation, light, images, savedRefs, command);
      return { runId, done };
    },

    /** Merges the draft into the store's branch (publishing it is a separate step). */
    async approve(storeId, { chatId = null } = {}) {
      if (ledger.status(storeId).busy) throw new ChangeError('busy', 'A change is still running.');
      undoGuard(storeId);
      const cwd = stores.workspaceOf(storeId);
      const draft = draftOf(storeId);
      if (!(await branchExists(cwd, draft))) throw new ChangeError('no_draft', 'There is nothing to approve.');
      await resetWorkspace(cwd);
      await git(['checkout', '-q', stores.branchOf(storeId)], cwd);
      await git(['merge', '-q', '--ff-only', draft], cwd);
      await git(['branch', '-q', '-D', draft], cwd);
      const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
      const draftChat = chats.state.get(storeId).draft?.chatId ?? null;
      chats.state.update(storeId, (state) => {
        state.draft = null;
      });
      noteStoreAction(storeId, draftChat, chatId, 'Approved.', { commit });
      return { commit };
    },

    /** Drops the draft; the store's copy is back to its last approved state. */
    async discard(storeId, { chatId = null } = {}) {
      if (ledger.status(storeId).busy) throw new ChangeError('busy', 'A change is still running.');
      undoGuard(storeId);
      const cwd = stores.workspaceOf(storeId);
      const draft = draftOf(storeId);
      if (!(await branchExists(cwd, draft))) throw new ChangeError('no_draft', 'There is nothing to discard.');
      await resetWorkspace(cwd);
      await git(['checkout', '-q', stores.branchOf(storeId)], cwd);
      await git(['branch', '-q', '-D', draft], cwd);
      const draftChat = chats.state.get(storeId).draft?.chatId ?? null;
      chats.state.update(storeId, (state) => {
        state.draft = null;
      });
      noteStoreAction(storeId, draftChat, chatId, 'Discarded.');
      return { discarded: true };
    },
  };
}

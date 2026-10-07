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
import { fixPrompt, systemPrompt, taskPrompt } from './prompt.mjs';
import { createFilePolicy, relativeTo } from './paths.mjs';
import { cleanOptions } from './triage.mjs';
import { PreviewError } from './preview.mjs';
import { SCREENSHOT_TOOL, screenshotServer } from './screenshot.mjs';
import { must, run } from './run.mjs';
import { BudgetError } from './ledger.mjs';
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

export function createAgentRunner({ config, stores, previews, ledger, aiConfig, chats, triage, query = sdkQuery, files, browsers = null, log = () => {} }) {
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
  async function agentTurn(storeId, chatId, { prompt, model, settings, maxBudgetUsd, cwd, eyes = null }) {
    const chat = chats.get(storeId, chatId);
    // a turn that hangs (a stuck tool, a stuck preview) ends instead of holding the store forever
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.turnTimeoutMs ?? 10 * 60_000);
    const stream = query({
      prompt,
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
        systemPrompt: systemPrompt(cwd, { eyes: !!eyes }),
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
  async function eyesFor(storeId, runId) {
    if (!browsers || config.previewMode !== 'dev') return null;
    try {
      setRun(storeId, { state: 'building_preview' });
      await previews.start(storeId);
      return screenshotServer({
        pool: browsers,
        // checked before every shot: a hung dev server is restarted instead of blinding the agent
        baseUrl: async () => `http://127.0.0.1:${await previews.ensure(storeId)}`,
        saveDir: path.join(config.dataDir, 'runs', runId),
        onShot: (file) => setRun(storeId, { screenshots: [...(chats.state.get(storeId).run?.screenshots ?? []), file] }),
        onStep: (text) => addStep(storeId, text, 'look'),
      });
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

  /** The owner's language for the few fixed sentences the editor says itself. */
  const said = (ownerText, en, ar) => (/[؀-ۿ]/.test(ownerText) ? ar : en);

  async function work(storeId, chatId, runId, text, reservation, light) {
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
      const pending = chats.get(storeId, chatId).pending ?? null;
      const decision = await triage(text, chats.recent(storeId, chatId), { pending });
      charge({ kind: 'triage', model: decision.model, costUsd: decision.costUsd, usage: decision.usage });
      const title = cleanTitle(decision.title);
      if (title && chats.get(storeId, chatId).title === NEW_CHAT_TITLE) chats.rename(storeId, chatId, title);

      // what gets built: a clear request now, or the plan the owner just accepted
      let job = null;
      let ack = null;
      if (decision.decision === 'go_ahead' && pending) {
        job = { task: pending.task, large: pending.large, shared: !!pending.shared };
        ack = decision.reply || 'On it.';
      } else if (decision.decision === 'edit' && (decision.confirm || decision.large)) {
        // unclear, large or site-wide: show the plan and wait for the owner's OK (a large request always asks)
        setPending(storeId, chatId, { task: decision.task, large: decision.large, shared: !!decision.shared });
        chats.say(storeId, chatId, 'assistant', decision.reply, { runId, kind: 'plan', options: cleanOptions(decision.options) });
        outcome = 'plan';
        return;
      } else if (decision.decision === 'edit') {
        job = { task: decision.task, large: decision.large, shared: !!decision.shared };
        ack = decision.reply;
      } else if (decision.decision === 'refuse') {
        const refuseKind = ['business_logic', 'needs_backend', 'unsafe'].includes(decision.refuseKind) ? decision.refuseKind : 'unsafe';
        chats.say(storeId, chatId, 'assistant', decision.reply, { runId, kind: 'refusal', card: { refuseKind } });
        outcome = 'refuse';
        return;
      } else {
        // a question about the AI Designer gets the store's preview link when one is running
        const preview = decision.decision === 'help' ? previews.list().find((p) => p.id === storeId) : null;
        const reply = decision.decision === 'go_ahead' ? 'There is no change waiting to be made. What would you like to change?' : decision.reply;
        const options = decision.decision === 'unclear' ? cleanOptions(decision.options) : [];
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
          setPending(storeId, chatId, job);
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

      const model = aiConfig.editModel(storeId, { large: job.large });
      await ensureDraft(storeId, cwd);
      const eyes = await eyesFor(storeId, runId);
      phase('editing', 'Changing files', { model });

      // the editing AI gets the job triage resolved plus the conversation, not just the owner's last few words
      const prompt = taskPrompt({ task: job.task, latest: text, recent: chats.recent(storeId, chatId, 12), shared: job.shared });
      let turn = await agentTurn(storeId, chatId, { prompt, model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd, eyes });
      charge(turn.charge, true);

      for (let round = 0; ; round++) {
        if (turn.subtype === 'error_max_budget_usd') throw new ChangeError('budget_stop', 'This request needed more than one request may spend.');
        if (turn.subtype !== 'success') throw new ChangeError('agent_failed', `The agent stopped (${turn.subtype}).`);

        const changed = await changedFiles(cwd);
        const outside = changed.filter((file) => !policy.canEdit(file));
        if (outside.length) throw new ChangeError('outside_allowed_files', `Changed files the editor does not allow: ${outside.join(', ')}`);
        if (changed.length === 0) {
          // the agent explained instead of editing (needs the backend, a question...)
          chats.say(storeId, chatId, 'assistant', turn.text || 'I did not change anything.', { runId });
          outcome = 'no_change';
          return;
        }
        // stop and ask: an existing shared part changed although the request was not about it
        const sharedTouched = job.shared ? [] : (await modifiedFiles(cwd)).filter((file) => policy.isShared(file));
        if (sharedTouched.length) {
          setRun(storeId, { lastFailure: { round, step: 'shared parts changed', output: sharedTouched.join('\n') } });
          await resetWorkspace(cwd);
          setPending(storeId, chatId, { task: job.task, large: job.large, shared: true });
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
      if (!light) await resetWorkspace(cwd).catch(() => {});
      const reply =
        outcome === 'budget_stop'
          ? 'This change is bigger than one request allows. Could you ask for a smaller part of it first?'
          : 'I could not make this change safely, so nothing was changed. You were not charged for it.';
      chats.say(storeId, chatId, 'assistant', reply, { runId, error: outcome });
    } finally {
      // the run always ends: a broken cost figure is logged and charged as 0, never left hanging
      let status = null;
      let refunded = 0;
      try {
        if (reservation) {
          status = ledger.settle(reservation, charges);
          refunded = !['preview', 'no_change'].includes(outcome) && refundable.length ? refundable.reduce((a, b) => a + b, 0) : 0;
          if (refunded > 0) status = ledger.refund(storeId, runId, refunded, outcome);
        } else {
          status = ledger.record(storeId, charges);
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
    async send(storeId, text, { chatId = MAIN_CHAT } = {}) {
      await stores.get(storeId);
      undoGuard(storeId);
      if (typeof text !== 'string' || !text.trim()) throw new ChangeError('empty_message', 'The message is empty.');
      if (text.length > 4000) throw new ChangeError('message_too_long', 'The message is too long.');
      const chat = chats.get(storeId, chatId);
      if (chat.lightRun && chat.lightRun.state !== 'done') throw new ChangeError('busy', 'This chat is still working on your last message.');
      const building = chats.state.get(storeId).run;
      let reservation = null;
      let light = false;
      try {
        reservation = ledger.reserve(storeId);
      } catch (error) {
        const elsewhere = building && building.state !== 'done' && building.chatId !== chatId;
        if (!(error instanceof BudgetError) || error.code !== 'busy' || !elsewhere) throw error;
        const current = ledger.status(storeId);
        if (current.blocked) throw new BudgetError('out_of_budget', 'The AI budget for this month is used up.', current);
        light = true;
      }
      const runId = randomUUID();
      chats.say(storeId, chatId, 'merchant', text.trim(), { runId });
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
      const done = work(storeId, chatId, runId, text.trim(), reservation, light);
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

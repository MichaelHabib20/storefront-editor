/**
 * One merchant message, end to end (agent design §2.2):
 *   reserve budget → triage (cheap model) → edit (Agent SDK, the store's model) → checks + preview build, with fix
 *   rounds → commit on the store's draft → preview link → settle the actual cost.
 *
 * Edits land on `draft/<id>`; the merchant approves (merged into `store/<id>`) or discards it. A run that cannot
 * be made to pass leaves the draft exactly as it was and is refunded.
 */
import { randomUUID } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { fixPrompt, systemPrompt, taskPrompt } from './prompt.mjs';
import { createFilePolicy, relativeTo } from './paths.mjs';
import { PreviewError } from './preview.mjs';
import { must, run } from './run.mjs';

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

export function createAgentRunner({ config, stores, previews, ledger, aiConfig, chats, triage, query = sdkQuery, files, log = () => {} }) {
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

  /** One Agent SDK call; returns the final message and what it cost beyond what the session had already spent. */
  async function agentTurn(storeId, { prompt, model, settings, maxBudgetUsd, cwd }) {
    const chat = chats.get(storeId);
    const stream = query({
      prompt,
      options: {
        cwd,
        model,
        effort: settings.effort,
        maxTurns: settings.maxTurns,
        maxBudgetUsd: Math.max(0.01, maxBudgetUsd),
        tools: TOOLS,
        allowedTools: TOOLS,
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: systemPrompt(cwd),
        ...(chat.sessionId ? { resume: chat.sessionId } : {}),
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'storefront-editor/0.1' },
        hooks: { PreToolUse: [{ hooks: [fileGuard(cwd, policy)] }] },
      },
    });
    let result = null;
    let sessionId = chat.sessionId;
    for await (const message of stream) {
      if (message.session_id) sessionId = message.session_id;
      if (message.type === 'result') result = message;
    }
    if (!result) throw new ChangeError('agent_failed', 'The agent ended without a result.');
    const total = Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
    // a resumed session's total starts from what its transcript saved; charge only the new part
    const previous = chat.sessionId === sessionId ? chat.sessionCostUsd : 0;
    const costUsd = total >= previous ? total - previous : total;
    chats.update(storeId, (c) => {
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

  function setRun(storeId, fields) {
    chats.update(storeId, (chat) => {
      chat.run = { ...(chat.run ?? {}), ...fields, updatedAt: new Date().toISOString() };
    });
  }

  async function work(storeId, runId, text, reservation) {
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

    try {
      const decision = await triage(text, chats.recent(storeId));
      charge({ kind: 'triage', model: decision.model, costUsd: decision.costUsd, usage: decision.usage });
      if (decision.decision !== 'edit') {
        // a question about the AI Designer gets the store's preview link when one is running
        const preview = decision.decision === 'help' ? previews.list().find((p) => p.id === storeId) : null;
        chats.say(storeId, 'assistant', decision.reply, { runId, ...(preview ? { preview: preview.url } : {}) });
        outcome = decision.decision;
        return;
      }
      chats.say(storeId, 'assistant', decision.reply, { runId, kind: 'understood' });

      const model = aiConfig.editModel(storeId, { large: decision.large });
      await ensureDraft(storeId, cwd);
      setRun(storeId, { state: 'editing', model });

      // the editing AI gets the job triage resolved plus the conversation, not just the owner's last few words
      const prompt = taskPrompt({ task: decision.task, latest: text, recent: chats.recent(storeId, 12) });
      let turn = await agentTurn(storeId, { prompt, model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd });
      charge(turn.charge, true);

      for (let round = 0; ; round++) {
        if (turn.subtype === 'error_max_budget_usd') throw new ChangeError('budget_stop', 'This request needed more than one request may spend.');
        if (turn.subtype !== 'success') throw new ChangeError('agent_failed', `The agent stopped (${turn.subtype}).`);

        const changed = await changedFiles(cwd);
        const outside = changed.filter((file) => !policy.canEdit(file));
        if (outside.length) throw new ChangeError('outside_allowed_files', `Changed files the editor does not allow: ${outside.join(', ')}`);
        if (changed.length === 0) {
          // the agent explained instead of editing (needs the backend, a question...)
          chats.say(storeId, 'assistant', turn.text || 'I did not change anything.', { runId });
          outcome = 'no_change';
          return;
        }

        setRun(storeId, { state: 'checking', round, files: changed.length });
        let failure = null;
        const checked = await stores.check(storeId, { files: changed });
        if (!checked.ok) failure = { step: checked.step, output: checked.output };
        else {
          setRun(storeId, { state: 'building_preview' });
          try {
            const preview = await previews.start(storeId);
            await git(['add', '-A'], cwd);
            await git([...AUTHOR, 'commit', '-q', '-m', `AI Designer: ${text.slice(0, 72)}`, '-m', `run ${runId}`], cwd);
            const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
            chats.update(storeId, (chat) => {
              chat.draft = { branch: draftOf(storeId), commit, updatedAt: new Date().toISOString() };
            });
            chats.say(storeId, 'assistant', turn.text || 'Done. Have a look at the preview.', { runId, preview: preview.url });
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
        setRun(storeId, { state: 'fixing', round: round + 1 });
        turn = await agentTurn(storeId, { prompt: fixPrompt(failure.step, failure.output), model, settings, maxBudgetUsd: reservation.amountUsd - spent, cwd });
        charge({ ...turn.charge, kind: 'fix' }, true);
      }
    } catch (error) {
      outcome = error.code ?? 'error';
      log('run failed', storeId, runId, error);
      await resetWorkspace(cwd).catch(() => {});
      const reply =
        outcome === 'budget_stop'
          ? 'This change is bigger than one request allows. Could you ask for a smaller part of it first?'
          : 'I could not make this change safely, so nothing was changed. You were not charged for it.';
      chats.say(storeId, 'assistant', reply, { runId, error: outcome });
    } finally {
      // the run always ends: a broken cost figure is logged and charged as 0, never left hanging
      let status = null;
      let refunded = 0;
      try {
        status = ledger.settle(reservation, charges);
        refunded = outcome !== 'preview' && outcome !== 'no_change' && refundable.length ? refundable.reduce((a, b) => a + b, 0) : 0;
        if (refunded > 0) status = ledger.refund(storeId, runId, refunded, outcome);
      } catch (error) {
        log('settle failed', storeId, runId, error);
        ledger.release(reservation);
      }
      setRun(storeId, { state: 'done', outcome, costUsd: Math.round(Math.max(0, spent - refunded) * 1e6) / 1e6, budget: status });
      log('run done', storeId, runId, outcome, spent.toFixed(4));
    }
  }

  return {
    /**
     * Starts a run for a merchant message and returns at once (the admin page polls the chat). Throws `busy` or
     * `out_of_budget` before anything starts.
     */
    async send(storeId, text) {
      await stores.get(storeId);
      if (typeof text !== 'string' || !text.trim()) throw new ChangeError('empty_message', 'The message is empty.');
      if (text.length > 4000) throw new ChangeError('message_too_long', 'The message is too long.');
      const reservation = ledger.reserve(storeId);
      const runId = randomUUID();
      chats.say(storeId, 'merchant', text.trim(), { runId });
      chats.update(storeId, (chat) => {
        chat.run = null;
      });
      setRun(storeId, { id: runId, state: 'triage', startedAt: new Date().toISOString(), outcome: null, round: 0 });
      const done = work(storeId, runId, text.trim(), reservation);
      return { runId, done };
    },

    /** Merges the draft into the store's branch (publishing it comes with step 5). */
    async approve(storeId) {
      if (ledger.status(storeId).busy) throw new ChangeError('busy', 'A change is still running.');
      const cwd = stores.workspaceOf(storeId);
      const draft = draftOf(storeId);
      if (!(await branchExists(cwd, draft))) throw new ChangeError('no_draft', 'There is nothing to approve.');
      await resetWorkspace(cwd);
      await git(['checkout', '-q', stores.branchOf(storeId)], cwd);
      await git(['merge', '-q', '--ff-only', draft], cwd);
      await git(['branch', '-q', '-D', draft], cwd);
      const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
      chats.update(storeId, (chat) => {
        chat.draft = null;
      });
      chats.say(storeId, 'system', 'Approved.', { commit });
      return { commit };
    },

    /** Drops the draft; the store's copy is back to its last approved state. */
    async discard(storeId) {
      if (ledger.status(storeId).busy) throw new ChangeError('busy', 'A change is still running.');
      const cwd = stores.workspaceOf(storeId);
      const draft = draftOf(storeId);
      if (!(await branchExists(cwd, draft))) throw new ChangeError('no_draft', 'There is nothing to discard.');
      await resetWorkspace(cwd);
      await git(['checkout', '-q', stores.branchOf(storeId)], cwd);
      await git(['branch', '-q', '-D', draft], cwd);
      chats.update(storeId, (chat) => {
        chat.draft = null;
      });
      chats.say(storeId, 'system', 'Discarded.');
      return { discarded: true };
    },
  };
}

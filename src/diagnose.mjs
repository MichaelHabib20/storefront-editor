/**
 * Finding a bug (v2 plan §4.3): an Agent SDK turn with read-only file tools and the browser tools (src/browser-tools.mjs)
 * that reproduces the owner's problem, finds the cause and answers with JSON. It never changes a file.
 * Also: the AI Designer's own changes on a store (the `store_changes` tool) and the re-check after a fix.
 */
import path from 'node:path';
import { z } from 'zod';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { BROWSER_TOOLS, browse, browserToolsServer } from './browser-tools.mjs';
import { promptWithImages, saveShots } from './images.mjs';
import { diagnosePrompt, diagnoseTask } from './prompt.mjs';
import { agentEnv } from './child-env.mjs';
import { must, run } from './run.mjs';

const Step = z.object({
  do: z.enum(['click', 'fill', 'press', 'goto', 'wait', 'login']),
  text: z.string().nullable(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  value: z.string().nullable(),
  path: z.string().nullable(),
  ms: z.number().nullable(),
});

const Diagnosis = z.object({
  reproduced: z.boolean(),
  cause: z.enum(['store_change', 'platform', 'data_or_setting', 'not_reproduced']),
  summary: z.string(),
  steps: z.array(z.string()),
  suspectCommit: z.string().nullable(),
  adminPlace: z.string().nullable(),
  fixPlan: z.string().nullable(),
  recheck: z
    .object({
      path: z.string(),
      viewport: z.enum(['phone', 'desktop']),
      steps: z.array(Step),
      expectVisible: z.object({ role: z.string().nullable(), name: z.string().nullable(), text: z.string().nullable() }).nullable(),
      expectNoError: z.string().nullable(),
    })
    .nullable(),
});

// the engine rejects the draft 2020-12 `$schema` header zod adds
const { $schema, ...SCHEMA } = z.toJSONSchema(Diagnosis);

/** nulls are "not given" for the browser. */
const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

/** What the re-check keeps of the AI's answer (the browser's own step shape). */
function cleanRecheck(recheck) {
  if (!recheck) return null;
  return {
    path: recheck.path,
    viewport: recheck.viewport,
    steps: recheck.steps.slice(0, 15).map(clean),
    expectVisible: recheck.expectVisible ? clean(recheck.expectVisible) : null,
    expectNoError: recheck.expectNoError || null,
  };
}

export function createDiagnoser({ config, stores, previews, chats, reports, browsers, query = sdkQuery, log = () => {} }) {
  const git = (args, cwd) => must('git', args, { cwd });

  /** The AI Designer's commits on the store since the starter (and on its open draft), newest first, at most 30. */
  async function storeChanges(storeId) {
    const store = await stores.get(storeId);
    const cwd = stores.workspaceOf(storeId);
    const branch = stores.branchOf(storeId);
    const draft = `draft/${storeId}`;
    const exists = async (ref) => (await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd })).code === 0;
    const ranges = [];
    if (await exists(`refs/heads/${draft}`)) ranges.push({ range: `${branch}..${draft}`, inDraft: true });
    ranges.push({ range: store.starterCommit && (await exists(store.starterCommit)) ? `${store.starterCommit}..${branch}` : branch, inDraft: false });
    const out = [];
    for (const { range, inDraft } of ranges) {
      const log = await run('git', ['log', '--author=AI Designer', '-n', '30', '--format=%h%x1f%aI%x1f%s', range], { cwd });
      for (const line of log.output.split('\n').filter(Boolean)) {
        const [commit, date, subject] = line.split('\x1f');
        const files = (await git(['show', '--name-only', '--format=', commit], cwd)).split('\n').map((f) => f.trim()).filter(Boolean);
        out.push({ commit, date, title: subject.replace(/^AI Designer:\s*/, ''), files, ...(inDraft ? { notApprovedYet: true } : {}) });
      }
    }
    return out.slice(0, 30);
  }

  /** One diagnosing turn; answers the parsed JSON (or null) and what it cost. */
  async function turn({ prompt, images, model, settings, maxBudgetUsd, cwd, server, guard }) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.turnTimeoutMs ?? 10 * 60_000);
    let result = null;
    try {
      for await (const message of query({
        prompt: promptWithImages(prompt, images),
        options: {
          abortController: abort,
          cwd,
          model,
          effort: settings.effort,
          maxTurns: settings.maxTurns,
          maxBudgetUsd: Math.max(0.01, maxBudgetUsd),
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Glob', 'Grep', ...BROWSER_TOOLS],
          mcpServers: { editor: server },
          permissionMode: 'dontAsk',
          permissionPrompts: 'none',
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          systemPrompt: diagnosePrompt(),
          outputFormat: { type: 'json_schema', schema: SCHEMA },
          env: { ...agentEnv(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'storefront-editor/0.1' },
          hooks: { PreToolUse: [{ hooks: [guard] }] },
        },
      })) {
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      if (abort.signal.aborted) throw Object.assign(new Error('The diagnosis took too long.'), { code: 'timeout' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (abort.signal.aborted) throw Object.assign(new Error('The diagnosis took too long.'), { code: 'timeout' });
    if (!result) throw Object.assign(new Error('The diagnosis ended without a result.'), { code: 'agent_failed' });
    const costUsd = Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
    const parsed = result.subtype === 'success' ? Diagnosis.safeParse(result.structured_output) : null;
    return { subtype: result.subtype, diagnosis: parsed?.success ? parsed.data : null, costUsd, charge: { kind: 'diagnose', model, costUsd, usage: result.modelUsage ?? null } };
  }

  return {
    storeChanges,

    /**
     * Reproduces and diagnoses. `onStep(text)` / `onShot(file)` feed the live list and the run's screenshots.
     * @returns {Promise<{ failed: boolean, costUsd: number, charge: object, card?: object, text?: string, images?: object[], reproduced?: boolean }>}
     */
    async diagnose({ storeId, chatId, runId, text, images = [], savedRefs = [], model, settings, maxBudgetUsd, guard, onStep = () => {}, onShot = () => {} }) {
      const cwd = stores.workspaceOf(storeId);
      const runDir = path.join(config.dataDir, 'runs', runId);
      const shots = [];
      const seen = { consoleErrors: [], failedRequests: [] };
      const server = browserToolsServer({
        pool: browsers,
        baseUrl: async () => `http://127.0.0.1:${await previews.ensure(storeId)}`,
        saveDir: runDir,
        storeChanges: () => storeChanges(storeId),
        login: () => config.testLogin,
        onShot: (file) => {
          shots.push(file);
          onShot(file);
        },
        onStep,
        onSeen: (page) => {
          for (const e of page.consoleErrors) if (seen.consoleErrors.length < 20 && !seen.consoleErrors.includes(e)) seen.consoleErrors.push(e);
          for (const r of page.failedRequests) if (seen.failedRequests.length < 20) seen.failedRequests.push(r);
        },
      });
      await previews.start(storeId);
      const prompt = diagnoseTask({ text, recent: chats.recent(storeId, chatId, 12), pictures: images.length });
      const answered = await turn({ prompt, images, model, settings, maxBudgetUsd, cwd, server, guard });
      if (!answered.diagnosis) return { failed: true, costUsd: answered.costUsd, charge: answered.charge };

      const d = answered.diagnosis;
      const changes = await storeChanges(storeId);
      const suspect = d.suspectCommit ? changes.find((c) => d.suspectCommit.startsWith(c.commit) || c.commit.startsWith(d.suspectCommit)) ?? null : null;
      const reproduced = d.reproduced && d.cause !== 'not_reproduced';
      const cause = reproduced ? d.cause : 'not_reproduced';
      const refs = saveShots(config.dataDir, storeId, chatId, runId, runDir, shots);

      let report = null;
      if (reproduced && cause === 'platform') {
        report = reports.create({
          storeId,
          chatId,
          summary: d.summary,
          steps: d.steps,
          ownerText: text,
          files: {
            images: savedRefs.map((r) => ({ path: path.join(config.dataDir, 'uploads', storeId, chatId, r.file), name: r.file })),
            screenshots: shots.slice(-3).map((name) => ({ path: path.join(runDir, name), name })),
          },
          consoleErrors: seen.consoleErrors,
          failedRequests: seen.failedRequests,
        });
      }
      return {
        failed: false,
        reproduced,
        costUsd: answered.costUsd,
        charge: answered.charge,
        text: d.summary,
        images: refs,
        card: {
          reproduced,
          cause,
          steps: d.steps.slice(0, 10),
          suspectCommit: cause === 'store_change' ? suspect?.commit ?? null : null,
          suspectTitle: cause === 'store_change' ? suspect?.title ?? null : null,
          adminPlace: cause === 'data_or_setting' ? d.adminPlace : null,
          fixPlan: cause === 'store_change' ? d.fixPlan : null,
          recheck: reproduced ? cleanRecheck(d.recheck) : null,
          reportId: report?.id ?? null,
          used: null,
        },
      };
    },

    /**
     * Repeats a bug's steps in a fresh browser and says whether the problem is gone: "fixed", "still", "unchecked"
     * when the page could not be checked, or null when there is nothing to check. Never throws.
     */
    async recheck(storeId, recheck) {
      if (!recheck || !browsers || !(recheck.expectVisible || recheck.expectNoError)) return null;
      try {
        const port = await previews.ensure(storeId);
        const visit = () => browse(browsers, { baseUrl: `http://127.0.0.1:${port}`, path: recheck.path, viewport: recheck.viewport, steps: recheck.steps, login: () => config.testLogin, expectVisible: recheck.expectVisible ?? null });
        // right after a change the preview may still be rebuilding the page: the first visit can time out
        const seen = await visit().catch((error) => {
          log('recheck retry', storeId, error.message);
          return visit();
        });
        if (seen.steps.some((s) => !s.ok)) return 'still';
        if (recheck.expectVisible && seen.visible !== true) return 'still';
        if (recheck.expectNoError) {
          const needle = recheck.expectNoError.toLowerCase();
          if (seen.consoleErrors.some((e) => e.toLowerCase().includes(needle)) || seen.failedRequests.some((r) => `${r.path} ${r.status}`.toLowerCase().includes(needle))) return 'still';
        }
        return 'fixed';
      } catch (error) {
        log('recheck failed', storeId, error.message);
        return 'unchecked';
      }
    },
  };
}

export { Diagnosis };

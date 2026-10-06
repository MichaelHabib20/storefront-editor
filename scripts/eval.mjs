#!/usr/bin/env node
/**
 * The AI Designer test-request set (plan step 7): plays every case of evals/cases.json against a throw-away store
 * copy ("eval") with the real models, scores it (src/eval-score.mjs) and writes evals/out/<run>/report.md +
 * results.json after every case, so a run can stop (usage limits, 2-hour shells) and go on with --resume.
 *
 *   node scripts/eval.mjs [--only c01,m01] [--resume evals/out/<run>] [--no-judge]
 *
 * Needs EVAL_SC_API_URL / EVAL_SC_API_KEY (the store API the previews show). Runs on whatever credentials the
 * Agent SDK finds (an API key, or this machine's Claude Code login).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../src/config.mjs';
import { scoreCase, summarise } from '../src/eval-score.mjs';
import { createFilePolicy } from '../src/paths.mjs';
import { must, run } from '../src/run.mjs';
import { createBrowserPool, SCREENSHOT_TOOL, screenshotServer } from '../src/screenshot.mjs';
import { createApp } from '../src/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const STORE = 'eval';
const JUDGE_MODEL = 'claude-sonnet-5-5';
const USAGE_LIMIT = /usage limit|weekly limit|hit your [a-z ]*limit|limit · resets|rate limit|rate_limit|\b429\b|overloaded|quota/i;

const outDir = value('--resume') ? path.resolve(value('--resume')) : path.join(root, 'evals', 'out', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outDir, { recursive: true });
const resultsFile = path.join(outDir, 'results.json');
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
const only = value('--only')?.split(',');
const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8'));
const todo = cases.filter((c) => (!only || only.includes(c.id)) && !results.some((r) => r.id === c.id));

// the eval store has its own, generous limits (its spend is reported, not capped per month)
const baseAi = JSON.parse(fs.readFileSync(path.join(root, 'config', 'ai.json'), 'utf8'));
const aiConfigFile = path.join(outDir, 'ai.json');
fs.writeFileSync(aiConfigFile, JSON.stringify({ ...baseAi, stores: { [STORE]: { monthlyLimitUsd: 1000, perRequestMaxUsd: 3 } } }, null, 2));

const logs = [];
// the eval store copy and its data stay between runs (evals/data); results go to the run's folder
const config = { ...loadConfig(), dataDir: path.join(root, 'evals', 'data'), aiConfigFile, previewMode: 'dev' };
const browsers = createBrowserPool();
const app = createApp(config, { browsers, log: (...a) => logs.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')) });
const policy = createFilePolicy(app.aiConfig.files);
const t0 = Date.now();
const say = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

if (!process.env.EVAL_SC_API_URL) {
  console.error('Set EVAL_SC_API_URL (and EVAL_SC_API_KEY) to the store API the previews use.');
  process.exit(2);
}
if (!(await app.stores.list()).some((s) => s.id === STORE)) await app.stores.create(STORE, { apiUrl: process.env.EVAL_SC_API_URL, apiKeyEnv: 'EVAL_SC_API_KEY' });
const workspace = app.stores.workspaceOf(STORE);
const git = (a) => must('git', a, { cwd: workspace });

/** A clean start for a case: no draft, no chat (a fresh AI session), no plan waiting. */
async function reset() {
  if ((await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/draft/${STORE}`], { cwd: workspace })).code === 0) await app.runner.discard(STORE);
  await git(['reset', '-q', '--hard', 'HEAD']);
  await git(['clean', '-q', '-fd']);
  fs.rmSync(path.join(config.dataDir, 'chats', `${STORE}.json`), { force: true });
}

/** "{yes}" and "{option:N}" become what the owner would tap. */
function resolveTurn(turn) {
  const last = app.chats.get(STORE).messages.filter((m) => m.role === 'assistant').at(-1);
  const options = last?.options ?? [];
  if (turn === '{yes}') return options.find((o) => /yes|go ahead|نعم|تمام/i.test(o)) ?? 'Yes, go ahead';
  const pick = /^\{option:(\d+)\}$/.exec(turn);
  if (pick) return options[Number(pick[1])] ?? options[0] ?? 'Yes, go ahead';
  return turn;
}

async function changes() {
  const hasDraft = (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/draft/${STORE}`], { cwd: workspace })).code === 0;
  if (!hasDraft) return { changedFiles: [], sharedModified: [] };
  const base = `store/${STORE}`;
  const changedFiles = (await git(['diff', '--name-only', base, `draft/${STORE}`])).split('\n').map((s) => s.trim()).filter(Boolean);
  const sharedModified = (await git(['diff', '--numstat', base, `draft/${STORE}`]))
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('\t'))
    .filter(([, deleted, file]) => (deleted === '-' || Number(deleted) > 0) && policy.isShared(file))
    .map(([, , file]) => file);
  return { changedFiles, sharedModified };
}

/** A judge model looks at the preview through the same screenshot tool and answers pass/fail. */
async function judge(testCase, caseDir) {
  const preview = app.previews.list().find((p) => p.id === STORE);
  if (!preview) return { pass: false, reason: 'no preview running', costUsd: 0 };
  const { path: pagePath = '/en', viewport = 'desktop', fullPage = false, check } = testCase.expect.see;
  const eyes = screenshotServer({ pool: browsers, baseUrl: () => `http://127.0.0.1:${preview.port}`, saveDir: path.join(caseDir, 'judge') });
  let result = null;
  for await (const message of query({
    prompt: `You check a change on an online store. Use the screenshot tool on "${pagePath}" (viewport "${viewport}"${fullPage ? ', start with a fullPage shot to find things' : ''}). To see a detail up close, pass scrollTo with a text shown on or next to the element (a button label like "Add to cart", a section title, a product name); take a few shots if needed. Then decide whether this is true:\n\n${check}\n\nAnswer pass=true only if you can see it is true. Give a one-sentence reason.`,
    options: {
      model: JUDGE_MODEL,
      tools: [],
      allowedTools: [SCREENSHOT_TOOL],
      mcpServers: { editor: eyes },
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 10,
      outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass', 'reason'], additionalProperties: false } },
    },
  })) {
    if (message.type === 'result') result = message;
  }
  const verdict = result?.structured_output;
  return { pass: !!verdict?.pass, reason: String(verdict?.reason ?? `judge failed (${result?.subtype})`), costUsd: result?.total_cost_usd ?? 0 };
}

function report() {
  const summary = summarise(results);
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const lines = [
    `# AI Designer test-request report`,
    '',
    `Run: ${path.basename(outDir)} · cases: ${results.length}/${cases.length} · estimated cost: $${cost.toFixed(2)} · ${summary.met ? '**pass levels met**' : '**pass levels NOT met**'}`,
    '',
    '| Group | Passed | Rate | Required |',
    '|---|---|---|---|',
    ...Object.entries(summary.groups).map(([g, s]) => `| ${g} | ${s.passed}/${s.total} | ${Math.round(s.rate * 100)}% | ${Math.round(s.required * 100)}% |`),
    '',
    '| Case | Category | Result | Turns → outcomes | Why | Cost |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.pass ? 'pass' : '**fail**'} | ${r.outcomes.join(' → ')} | ${(r.reasons.join('; ') || '').replace(/\|/g, '/')} | $${(r.costUsd ?? 0).toFixed(3)} |`),
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  return summary;
}

let stoppedForLimits = false;
say(`${todo.length} case(s) to run → ${outDir}`);
for (const testCase of todo) {
  const caseDir = path.join(outDir, testCase.id);
  fs.mkdirSync(caseDir, { recursive: true });
  const logStart = logs.length;
  const spentBefore = app.ledger.status(STORE).spentUsd;
  const outcomes = [];
  const turns = [];
  try {
    await reset();
    for (const raw of testCase.turns) {
      const text = resolveTurn(raw);
      turns.push(text);
      const { done } = await app.runner.send(STORE, text);
      await done;
      outcomes.push(app.chats.get(STORE).run?.outcome ?? 'none');
    }
  } catch (error) {
    outcomes.push(`error`);
    logs.push(String(error.stack ?? error));
  }
  const chat = app.chats.get(STORE);
  const caseLogs = logs.slice(logStart).join('\n');
  const limitHit = (text) => USAGE_LIMIT.test(text ?? '');
  if (limitHit(caseLogs) || chat.messages.some((m) => limitHit(m.text))) {
    say(`${testCase.id}: the model usage limit was hit — stopping; go on later with --resume ${outDir}`);
    fs.writeFileSync(path.join(caseDir, 'log.txt'), caseLogs);
    stoppedForLimits = true;
    break;
  }
  const seen = { outcomes, ...(await changes()), reply: chat.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '', judge: null };
  let judgeCost = 0;
  if (testCase.expect.see && outcomes.at(-1) === 'preview' && !flag('--no-judge')) {
    seen.judge = await judge(testCase, caseDir).catch((error) => ({ pass: false, reason: `judge error: ${error.message}`, costUsd: 0 }));
    judgeCost = seen.judge.costUsd ?? 0;
    if (limitHit(seen.judge.reason)) {
      say(`${testCase.id}: the judge hit the model usage limit — stopping; go on later with --resume ${outDir}`);
      stoppedForLimits = true;
      break;
    }
  }
  const score = scoreCase(testCase, seen);
  const costUsd = Math.max(0, app.ledger.status(STORE).spentUsd - spentBefore) + judgeCost;
  results.push({ id: testCase.id, category: testCase.category, pass: score.pass, reasons: score.reasons, turns, outcomes, changedFiles: seen.changedFiles, sharedModified: seen.sharedModified, reply: seen.reply, judge: seen.judge, screenshots: chat.run?.screenshots ?? [], lastFailure: chat.run?.lastFailure ?? null, costUsd });
  fs.writeFileSync(path.join(caseDir, 'chat.json'), JSON.stringify({ messages: chat.messages, run: chat.run, pending: chat.pending ?? null }, null, 2));
  fs.writeFileSync(path.join(caseDir, 'log.txt'), caseLogs);
  if (seen.changedFiles.length) fs.writeFileSync(path.join(caseDir, 'diff.patch'), await git(['diff', `store/${STORE}`, `draft/${STORE}`]).catch(() => ''));
  report();
  say(`${testCase.id} ${score.pass ? 'pass' : 'FAIL'} (${outcomes.join(' → ')}) ${score.reasons.join('; ')}`);
}

const summary = report();
say(`done: ${results.length}/${cases.length} cases · ${summary.met ? 'pass levels met' : 'pass levels NOT met'} · report: ${path.join(outDir, 'report.md')}`);
await reset().catch(() => {});
await app.previews.stopAll();
await browsers.close();
process.exit(stoppedForLimits ? 3 : 0);

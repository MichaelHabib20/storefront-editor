/**
 * The agent loop against a throw-away starter, with a fake triage and a fake Agent SDK `query` that edits files the
 * way the real agent would. Checks fail while `src/BROKEN` exists; the "build" fails while `src/BADBUILD` exists.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileGuard } from '../src/agent.mjs';
import { createFilePolicy } from '../src/paths.mjs';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';

let dir, starter, app, base, workspace;
const git = (args, cwd = starter) => must('git', args, { cwd });

/** What the fake triage answers next, and the fake agent's script: one function per call. */
let triageAnswer;
let agentScript;
let agentCalls;
let sessionTotal = 0;

const fakeTriage = async () => ({ ...triageAnswer, model: 'claude-haiku-4-5', costUsd: 0.001, usage: { input_tokens: 100, output_tokens: 20 } });

function fakeQuery({ prompt, options }) {
  const step = agentScript[agentCalls.length];
  agentCalls.push({ prompt, options });
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: options.resume ?? 'session-1' };
    const outcome = (await step?.(options.cwd, prompt)) ?? {};
    sessionTotal += outcome.cost ?? 0.1;
    yield { type: 'result', subtype: outcome.subtype ?? 'success', result: outcome.text ?? 'I changed it.', total_cost_usd: sessionTotal, modelUsage: {}, session_id: options.resume ?? 'session-1' };
  })();
}

const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));

async function call(method, url, payload) {
  const response = await fetch(base + url, { method, headers: payload ? { 'content-type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function runToEnd(text) {
  const sent = await call('POST', '/stores/acme/messages', { text });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  let chat;
  for (let i = 0; i < 300; i++) {
    chat = (await call('GET', '/stores/acme/chat')).body;
    if (chat.run?.id === sent.body.runId && chat.run.state === 'done') return chat;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run did not finish: ${JSON.stringify(chat.run)}`);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-'));
  starter = path.join(dir, 'starter');
  await fs.mkdir(path.join(starter, 'src'), { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await write(starter, 'check.mjs', "import fs from 'node:fs'; if (fs.existsSync('src/BROKEN')) { console.error('type error in page'); process.exit(1); }\n");
  await write(starter, 'build.mjs', "import fs from 'node:fs'; if (fs.existsSync('src/BADBUILD')) { console.error('build boom'); process.exit(1); } fs.writeFileSync('built.txt', 'ok');\n");
  await write(starter, 'serve.mjs', "import http from 'node:http'; http.createServer((q, s) => s.end('preview')).listen(Number(process.argv[2]), '127.0.0.1');\n");
  await write(starter, '.gitignore', 'built.txt\nnode_modules\n');
  await write(starter, 'src/page.txt', 'v1');
  await write(starter, 'src/money/price.txt', 'locked');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);

  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(
    aiConfigFile,
    JSON.stringify({
      defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5', 'claude-opus-5-5'], routing: 'auto', effort: 'medium', monthlyLimitUsd: 5, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 },
      stores: { poor: { monthlyLimitUsd: 0.01 } },
      files: { editable: ['src/**'], locked: ['src/money/**'], generated: [] },
    }),
  );
  app = createApp(
    {
      starterRepo: starter,
      starterBranch: 'main',
      workspacesDir: path.join(dir, 'workspaces'),
      dataDir: path.join(dir, 'data'),
      checks: [['node', ['check.mjs']]],
      build: ['node', ['build.mjs']],
      serve: ['node', ['serve.mjs', '{port}']],
      previewMode: 'production',
      previewPorts: [3471, 3480],
      aiConfigFile,
    },
    { triage: fakeTriage, query: fakeQuery, log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  workspace = (await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' })).body.workspace;
  await call('POST', '/stores', { id: 'poor', apiUrl: 'https://api.poor.test' });
});

beforeEach(() => {
  triageAnswer = { decision: 'edit', large: false, reply: 'You want the page changed.' };
  agentScript = [];
  agentCalls = [];
});

after(async () => {
  await app.previews.stopAll();
  await new Promise((resolve) => app.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('the file guard allows editable files only and never secrets', async () => {
  const guard = fileGuard('/ws', createFilePolicy({ editable: ['src/**'], locked: ['src/money/**'] }));
  const denied = (r) => r.hookSpecificOutput?.permissionDecision === 'deny';
  assert.equal(denied(await guard({ tool_name: 'Edit', tool_input: { file_path: '/ws/src/app/page.tsx' } })), false);
  assert.equal(denied(await guard({ tool_name: 'Write', tool_input: { file_path: 'src/money/Price.tsx' } })), true);
  assert.equal(denied(await guard({ tool_name: 'Edit', tool_input: { file_path: '/ws/../other/src/a.ts' } })), true);
  assert.equal(denied(await guard({ tool_name: 'Write', tool_input: { file_path: 'package.json' } })), true);
  assert.equal(denied(await guard({ tool_name: 'Read', tool_input: { file_path: '/ws/.env.local' } })), true);
  assert.equal(denied(await guard({ tool_name: 'Read', tool_input: { file_path: '/elsewhere/secrets.txt' } })), true);
  assert.equal(denied(await guard({ tool_name: 'Read', tool_input: { file_path: '/ws/src/money/Price.tsx' } })), false);
  assert.equal(denied(await guard({ tool_name: 'Grep', tool_input: { pattern: 'x' } })), false);
});

test('a non-edit message is answered by triage alone', async () => {
  triageAnswer = { decision: 'admin_setting', large: false, reply: 'Prices are changed in Products in your dashboard.' };
  const chat = await runToEnd('make the price 10');
  assert.equal(chat.run.outcome, 'admin_setting');
  assert.equal(agentCalls.length, 0);
  assert.equal(chat.messages.at(-1).text, 'Prices are changed in Products in your dashboard.');
  assert.equal(chat.budget.spentUsd, 0.001);
});

test('an edit passes the checks, is committed on the draft and previewed', async () => {
  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'red header')];
  const chat = await runToEnd('make the header red');
  assert.equal(chat.run.outcome, 'preview', JSON.stringify(chat.messages.at(-1)));
  assert.equal(agentCalls[0].options.model, 'claude-sonnet-5-5');
  assert.equal(agentCalls[0].options.permissionMode, 'dontAsk');
  assert.deepEqual(agentCalls[0].options.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
  assert.ok(agentCalls[0].options.maxBudgetUsd <= 1);
  assert.match(chat.messages.at(-1).preview, /^http:\/\/localhost:347\d$/);
  assert.equal(chat.draft.branch, 'draft/acme');
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim(), 'draft/acme');
  assert.equal((await git(['status', '--porcelain'], workspace)).trim(), '');
  assert.equal(chat.budget.spentUsd, 0.102);
});

test('a question about the AI Designer is answered with the running preview link', async () => {
  triageAnswer = { decision: 'help', large: false, reply: 'Your preview is on the right of this page.' };
  const chat = await runToEnd('where can I see my changes?');
  assert.equal(chat.run.outcome, 'help');
  assert.equal(agentCalls.length, 0);
  assert.match(chat.messages.at(-1).preview, /^http:\/\/localhost:347\d$/);
});

test('a large request uses the strongest allowed model; the session continues', async () => {
  triageAnswer = { decision: 'edit', large: true, reply: 'A new home page.' };
  agentScript = [(cwd) => write(cwd, 'src/home.txt', 'new home')];
  const chat = await runToEnd('redesign the home page');
  assert.equal(chat.run.outcome, 'preview');
  assert.equal(agentCalls[0].options.model, 'claude-opus-5-5');
  assert.equal(agentCalls[0].options.resume, 'session-1');
  // the session total grew from 0.1 to 0.2: only the new 0.1 is charged
  assert.equal(chat.run.costUsd, 0.101);
});

test('a failed check goes back to the agent, which fixes it', async () => {
  agentScript = [
    async (cwd) => {
      await write(cwd, 'src/a.txt', 'a');
      await write(cwd, 'src/BROKEN');
    },
    async (cwd, prompt) => {
      assert.match(prompt, /type error in page/);
      await fs.rm(path.join(cwd, 'src/BROKEN'));
    },
  ];
  const chat = await runToEnd('add a block');
  assert.equal(chat.run.outcome, 'preview');
  assert.equal(agentCalls.length, 2);
});

test('a build failure also goes back to the agent', async () => {
  agentScript = [(cwd) => write(cwd, 'src/BADBUILD'), (cwd) => fs.rm(path.join(cwd, 'src/BADBUILD'))];
  const chat = await runToEnd('change the footer');
  assert.equal(chat.run.outcome, 'no_change', 'removing the file it added leaves nothing changed');
  assert.equal(agentCalls.length, 2);
  assert.match(agentCalls[1].prompt, /build boom/);
});

test('a change that never passes is dropped and refunded', async () => {
  const head = (await git(['rev-parse', 'HEAD'], workspace)).trim();
  const spentBefore = (await call('GET', '/stores/acme/budget')).body.spentUsd;
  agentScript = [(cwd) => write(cwd, 'src/BROKEN'), (cwd) => write(cwd, 'src/still.txt')];
  const chat = await runToEnd('break it');
  assert.equal(chat.run.outcome, 'checks_failed');
  assert.match(chat.messages.at(-1).text, /not charged/);
  assert.equal((await git(['rev-parse', 'HEAD'], workspace)).trim(), head);
  assert.equal((await git(['status', '--porcelain'], workspace)).trim(), '');
  assert.equal(chat.budget.spentUsd, Math.round((spentBefore + 0.001) * 1e6) / 1e6, 'only triage is charged');
});

test('a change to a locked file is refused even if the hook was bypassed', async () => {
  agentScript = [(cwd) => write(cwd, 'src/money/price.txt', 'hacked')];
  const chat = await runToEnd('change the price look');
  assert.equal(chat.run.outcome, 'outside_allowed_files');
  assert.equal(await fs.readFile(path.join(workspace, 'src/money/price.txt'), 'utf8'), 'locked');
});

test('an agent that explains instead of editing changes nothing', async () => {
  agentScript = [async () => ({ text: 'This needs data the store does not have yet.' })];
  const chat = await runToEnd('show visitor counts');
  assert.equal(chat.run.outcome, 'no_change');
  assert.equal(chat.messages.at(-1).text, 'This needs data the store does not have yet.');
});

test('one message at a time; an empty budget refuses', async () => {
  let release;
  agentScript = [() => new Promise((resolve) => (release = resolve))];
  const first = await call('POST', '/stores/acme/messages', { text: 'slow change' });
  assert.equal(first.status, 202);
  for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal((await call('POST', '/stores/acme/messages', { text: 'another' })).status, 409);
  assert.equal((await call('POST', '/stores/acme/draft/approve')).status, 409);
  release();
  for (let i = 0; i < 100 && (await call('GET', '/stores/acme/chat')).body.run.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));

  assert.equal((await call('POST', '/stores/poor/messages', { text: 'hi' })).status, 402);
  assert.equal((await call('POST', '/stores/acme/messages', { text: '  ' })).status, 422);
});

test('approve merges the draft into the store copy; discard drops it', async () => {
  const approved = await call('POST', '/stores/acme/draft/approve');
  assert.equal(approved.status, 200);
  assert.equal((await git(['rev-parse', 'store/acme'])).trim(), approved.body.commit);
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim(), 'store/acme');
  assert.equal(await fs.readFile(path.join(workspace, 'src/page.txt'), 'utf8'), 'red header');
  assert.equal((await call('POST', '/stores/acme/draft/approve')).status, 409);

  agentScript = [(cwd) => write(cwd, 'src/page.txt', 'blue header')];
  await runToEnd('make it blue');
  assert.equal((await call('POST', '/stores/acme/draft/discard')).status, 200);
  assert.equal(await fs.readFile(path.join(workspace, 'src/page.txt'), 'utf8'), 'red header');
  assert.equal((await call('GET', '/stores/acme/chat')).body.draft, null);
});

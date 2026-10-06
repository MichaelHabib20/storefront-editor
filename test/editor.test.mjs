/**
 * Store copies, starter updates and previews against a throw-away starter repository. The checks, the build
 * and the server are small node scripts in that repository, so a test can make them pass or fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';
import { createStores } from '../src/stores.mjs';

let dir, starter, app, base;

const git = (args, cwd = starter) => must('git', args, { cwd });

async function commitInStarter(file, content, message) {
  await fs.writeFile(path.join(starter, file), content);
  await git(['add', '.']);
  await git(['commit', '-q', '-m', message]);
}

async function call(method, url, payload) {
  const response = await fetch(base + url, {
    method,
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-'));
  starter = path.join(dir, 'starter');
  await fs.mkdir(starter);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  // the "checks" fail when a file named BROKEN exists; the "build" writes the API url it was given
  await fs.writeFile(path.join(starter, 'check.mjs'), "import fs from 'node:fs'; if (fs.existsSync('BROKEN')) { console.error('check failed'); process.exit(1); }\n");
  await fs.writeFile(path.join(starter, 'build.mjs'), "import fs from 'node:fs'; fs.writeFileSync('built.txt', process.env.SC_API_URL + '|' + (process.env.SC_API_KEY ?? ''));\n");
  await fs.writeFile(
    path.join(starter, 'serve.mjs'),
    "import fs from 'node:fs'; import http from 'node:http'; http.createServer((q, s) => s.end(fs.readFileSync('built.txt', 'utf8') + '|' + fs.readFileSync('page.txt', 'utf8'))).listen(Number(process.argv[2]), '127.0.0.1');\n",
  );
  await fs.writeFile(path.join(starter, '.gitignore'), 'built.txt\nnode_modules\n');
  await commitInStarter('page.txt', 'v1', 'starter v1');
  // installed dependencies the store copies share through a link
  await fs.mkdir(path.join(starter, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(starter, 'node_modules', '.bin', 'next.cmd'), 'keep me');

  process.env.EDITOR_TEST_KEY = 'secret-key';
  app = createApp({
    starterRepo: starter,
    starterBranch: 'main',
    workspacesDir: path.join(dir, 'workspaces'),
    dataDir: path.join(dir, 'data'),
    checks: [['node', ['check.mjs']]],
    build: ['node', ['build.mjs']],
    serve: ['node', ['serve.mjs', '{port}']],
    previewMode: 'production',
    previewPorts: [3451, 3460],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.previews.stopAll();
  await new Promise((resolve) => app.server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('creates a store copy on its own branch and workspace', async () => {
  const created = await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test', apiKeyEnv: 'EDITOR_TEST_KEY' });
  assert.equal(created.status, 201);
  assert.equal(created.body.branch, 'store/acme');
  assert.equal(await fs.readFile(path.join(created.body.workspace, 'page.txt'), 'utf8'), 'v1');
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], created.body.workspace)).trim(), 'store/acme');

  assert.equal((await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' })).status, 409);
  assert.equal((await call('POST', '/stores', { id: 'Bad Id', apiUrl: 'https://x.test' })).status, 422);
  assert.equal((await call('POST', '/stores', { id: 'other', apiUrl: 'ftp://x' })).status, 422);
  assert.equal((await call('GET', '/stores/missing')).status, 404);
  assert.deepEqual((await call('GET', '/stores')).body.stores.map((s) => s.id), ['acme']);
});

test('runs the checks on the copy', async () => {
  const workspace = app.stores.workspaceOf('acme');
  assert.equal((await call('POST', '/stores/acme/check')).body.ok, true);
  await fs.writeFile(path.join(workspace, 'BROKEN'), '');
  const failed = (await call('POST', '/stores/acme/check')).body;
  assert.equal(failed.ok, false);
  assert.match(failed.output, /check failed/);
  await fs.rm(path.join(workspace, 'BROKEN'));
});

test('brings in starter updates while keeping the store change', async () => {
  const workspace = app.stores.workspaceOf('acme');
  await fs.writeFile(path.join(workspace, 'store.txt'), 'acme colours');
  await git(['add', '.'], workspace);
  await git(['commit', '-q', '-m', 'store change'], workspace);

  assert.equal((await call('POST', '/stores/acme/update-starter')).body.reason, 'up_to_date');
  await commitInStarter('page.txt', 'v2', 'starter v2');
  const updated = (await call('POST', '/stores/acme/update-starter')).body;
  assert.equal(updated.reason, 'updated');
  assert.equal(await fs.readFile(path.join(workspace, 'page.txt'), 'utf8'), 'v2');
  assert.equal(await fs.readFile(path.join(workspace, 'store.txt'), 'utf8'), 'acme colours');
});

test('a conflicting starter update leaves the copy as it was', async () => {
  const workspace = app.stores.workspaceOf('acme');
  await fs.writeFile(path.join(workspace, 'page.txt'), 'acme page');
  await git(['commit', '-q', '-am', 'store edits the page'], workspace);
  const head = (await git(['rev-parse', 'HEAD'], workspace)).trim();

  await commitInStarter('page.txt', 'v3', 'starter v3');
  const result = (await call('POST', '/stores/acme/update-starter')).body;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal((await git(['rev-parse', 'HEAD'], workspace)).trim(), head);
  assert.equal((await git(['status', '--porcelain'], workspace)).trim(), '');
  // the starter settles on the store's wording, so later updates merge cleanly
  await commitInStarter('page.txt', 'acme page', 'starter takes the same page');
});

test('a starter update that breaks the checks is reverted', async () => {
  const workspace = app.stores.workspaceOf('acme');
  const head = (await git(['rev-parse', 'HEAD'], workspace)).trim();
  await commitInStarter('BROKEN', '', 'starter breaks the checks');
  const result = (await call('POST', '/stores/acme/update-starter')).body;
  assert.equal(result.reason, 'check_failed');
  assert.equal((await git(['rev-parse', 'HEAD'], workspace)).trim(), head);
  await git(['rm', '-q', 'BROKEN']);
  await git(['commit', '-q', '-m', 'starter fixed']);
});

test('serves a preview with the store API settings', async () => {
  const started = await call('POST', '/stores/acme/preview');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const page = await (await fetch(started.body.url.replace('localhost', '127.0.0.1'))).text();
  assert.equal(page, 'https://api.acme.test|secret-key|acme page');
  assert.deepEqual((await call('GET', '/previews')).body.previews.map((p) => p.id), ['acme']);

  assert.equal((await call('DELETE', '/stores/acme/preview')).body.stopped, true);
  assert.deepEqual((await call('GET', '/previews')).body.previews, []);
});

test('a dev preview skips the build and is reused while it runs', async () => {
  const first = await app.previews.start('acme', { production: false });
  const second = await app.previews.start('acme', { production: false });
  assert.equal(second.port, first.port);
  assert.equal(app.previews.list()[0].mode, 'dev');
  await app.previews.stop('acme');
});

test('the quick checks get only the changed code files', async () => {
  const workspace = app.stores.workspaceOf('acme');
  await fs.writeFile(path.join(workspace, 'args.mjs'), "import fs from 'node:fs'; fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));\n");
  const stores = createStores({ starterRepo: starter, workspacesDir: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data'), checks: [['node', ['args.mjs', '--files', '{codeFiles}']]] });
  assert.equal((await stores.check('acme', { files: ['public/logo.png'] })).ok, true);
  await assert.rejects(fs.access(path.join(workspace, 'args.json')), 'no code files: the command is skipped');
  assert.equal((await stores.check('acme', { files: ['src/a.tsx', 'b.css', 'src/c.ts'] })).ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, 'args.json'), 'utf8')), ['--files', 'src/a.tsx', 'src/c.ts']);
  await fs.rm(path.join(workspace, 'args.mjs'));
  await fs.rm(path.join(workspace, 'args.json'));
});

test('store copies must be on the starter drive', () => {
  assert.throws(() => createStores({ starterRepo: 'D:/repo', workspacesDir: 'C:/ws', dataDir: 'C:/data' }), /same drive/);
});

test('a failed build is reported with its output', async () => {
  const workspace = app.stores.workspaceOf('acme');
  await fs.writeFile(path.join(workspace, 'build.mjs'), "console.error('syntax boom'); process.exit(1);\n");
  const failed = await call('POST', '/stores/acme/preview');
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, 'build_failed');
  assert.match(failed.body.output, /syntax boom/);
  await git(['checkout', '--', 'build.mjs'], workspace);
});

test('reports the store budget', async () => {
  const budget = (await call('GET', '/stores/acme/budget')).body;
  assert.equal(budget.spentUsd, 0);
  assert.equal(budget.blocked, false);
  assert.ok(budget.allowedModels.includes(budget.editModel));
  assert.equal((await call('GET', '/stores/missing/budget')).status, 404);
});

test('removes the workspace but keeps the branch and the starter dependencies', async () => {
  const workspace = app.stores.workspaceOf('acme');
  assert.equal(await fs.readFile(path.join(workspace, 'node_modules', '.bin', 'next.cmd'), 'utf8'), 'keep me', 'the copy sees the shared dependencies');
  assert.equal((await call('DELETE', '/stores/acme')).status, 204);
  assert.equal(await fs.readFile(path.join(starter, 'node_modules', '.bin', 'next.cmd'), 'utf8'), 'keep me', 'removing a copy never deletes through the link');
  await assert.rejects(fs.access(workspace));
  assert.deepEqual((await call('GET', '/stores')).body.stores, []);
  assert.equal((await git(['branch', '--list', 'store/acme'])).trim().replace('* ', '').replace('+ ', ''), 'store/acme');
});

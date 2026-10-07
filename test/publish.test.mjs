/**
 * Publish and undo against a throw-away starter and a fake deploy command (it lists what was uploaded and prints a
 * Vercel-like address; it fails while `.vercel/FAIL` exists). No hosting account is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { deploymentUrlFrom } from '../src/publish.mjs';
import { must } from '../src/run.mjs';
import { createApp } from '../src/server.mjs';

let dir, starter, app, base, workspace, site;
const git = (args, cwd = starter) => must('git', args, { cwd });
const write = (cwd, file, content = 'x') => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));
const read = (file) => fs.readFile(file, 'utf8');

async function call(method, url, payload) {
  const response = await fetch(base + url, { method, headers: payload ? { 'content-type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

/** Waits until the publish (or undo) is over and answers the chat. */
async function settled() {
  for (let i = 0; i < 400; i++) {
    const chat = (await call('GET', '/stores/acme/chat')).body;
    if (chat.publish?.state === 'idle') return chat;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('publish did not finish');
}

/** Commits a change on the store's branch, as an approved AI change would. */
async function approveChange(file, content) {
  await write(workspace, file, content);
  await git(['add', '-A'], workspace);
  await git(['commit', '-q', '-m', `change ${file}`], workspace);
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-'));
  starter = path.join(dir, 'starter');
  site = path.join(dir, 'site');
  await fs.mkdir(path.join(starter, 'src'), { recursive: true });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await write(starter, '.gitignore', '.env.local\n');
  await write(starter, 'src/page.txt', 'v1');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);

  const deployScript = path.join(dir, 'fake-deploy.mjs');
  await write(
    dir,
    'fake-deploy.mjs',
    [
      "import fs from 'node:fs';",
      "if (fs.existsSync('.vercel/FAIL')) { console.error('Error: build failed'); process.exit(1); }",
      "if (fs.existsSync('.vercel/DROP')) { console.log('Deployment acme-shop-dropped-team.vercel.app building'); console.error('Error: read ECONNRESET'); process.exit(1); }",
      "const files = fs.readdirSync('.', { recursive: true }).filter((f) => !String(f).startsWith('.vercel')).map(String).sort();",
      "fs.appendFileSync('.vercel/deploys.log', JSON.stringify({ files, page: fs.existsSync('src/page.txt') ? fs.readFileSync('src/page.txt', 'utf8') : null }) + '\\n');",
      "console.log('Deployment acme-shop-' + Date.now().toString(36) + '-team.vercel.app ready.');",
      "console.log('Aliased https://acme-shop.vercel.app');",
    ].join('\n'),
  );
  // the host's answer for a deployment the deploy command lost track of: Ready unless `.vercel/BUILD_FAILED` exists
  const inspectScript = path.join(dir, 'fake-inspect.mjs');
  await write(dir, 'fake-inspect.mjs', "import fs from 'node:fs'; console.log('  status\\t● ' + (fs.existsSync('.vercel/BUILD_FAILED') ? 'Error' : 'Ready'));\n");
  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(aiConfigFile, JSON.stringify({ defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5'], routing: 'auto', effort: 'medium', monthlyLimitUsd: 5, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 }, files: { editable: ['src/**'], locked: [], generated: [], shared: [] } }));

  app = createApp(
    {
      starterRepo: starter,
      starterBranch: 'main',
      workspacesDir: path.join(dir, 'workspaces'),
      dataDir: path.join(dir, 'data'),
      checks: [],
      deploy: ['node', [deployScript]],
      inspect: ['node', [inspectScript, '{url}']],
      deployTimeoutMs: 30_000,
      previewPorts: [3481, 3490],
      aiConfigFile,
    },
    { triage: async () => ({}), query: () => (async function* () {})(), log: () => {}, browsers: null },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  workspace = (await call('POST', '/stores', { id: 'acme', apiUrl: 'https://api.acme.test' })).body.workspace;
  await call('POST', '/stores', { id: 'nosite', apiUrl: 'https://api.nosite.test' });
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('a store without a website has no publish part and cannot publish', async () => {
  assert.equal((await call('GET', '/stores/nosite/chat')).body.publish, null);
  const refused = await call('POST', '/stores/nosite/publish');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'not_set_up');
});

test('a publish folder that is not linked to a hosting project is refused', async () => {
  const file = path.join(dir, 'data', 'stores.json');
  const stores = JSON.parse(await read(file));
  stores.acme.publish = { dir: site, siteUrl: 'https://acme-shop.vercel.app' };
  await fs.writeFile(file, JSON.stringify(stores, null, 2));
  await fs.mkdir(site, { recursive: true });
  const refused = await call('POST', '/stores/acme/publish');
  assert.equal(refused.body.error, 'not_set_up');
  await fs.mkdir(path.join(site, '.vercel'));
});

test('publish uploads only the committed files of the approved copy and goes live', async () => {
  await write(site, 'stale.txt', 'from an old export');
  await write(workspace, '.env.local', 'SECRET=1');
  await write(workspace, 'src/not-committed.txt', 'draft');

  let chat = (await call('GET', '/stores/acme/chat')).body;
  assert.deepEqual(chat.publish, { siteUrl: 'https://acme-shop.vercel.app', state: 'idle', startedAt: null, lastPublishedAt: null, lastFailed: false, canUndo: false, unpublished: true });

  const started = await call('POST', '/stores/acme/publish');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await call('POST', '/stores/acme/publish')).body.error, 'publishing', 'one publish at a time');
  chat = await settled();

  const [deployed] = (await read(path.join(site, '.vercel', 'deploys.log'))).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(deployed.files, ['.gitignore', 'src', path.join('src', 'page.txt')]);
  assert.equal(deployed.page, 'v1');
  assert.equal(chat.publish.unpublished, false);
  assert.equal(chat.publish.canUndo, false);
  assert.ok(chat.publish.lastPublishedAt);
  assert.match(chat.messages.at(-1).text, /^Published\. Your changes are live on https:\/\/acme-shop\.vercel\.app/);

  const again = await call('POST', '/stores/acme/publish');
  assert.equal(again.body.error, 'nothing_to_publish');
  await fs.rm(path.join(workspace, '.env.local'));
  await fs.rm(path.join(workspace, 'src', 'not-committed.txt'));
});

test('a failed build leaves the live version and says so', async () => {
  await approveChange('src/page.txt', 'v2-broken');
  await write(site, '.vercel/FAIL', '1');
  await call('POST', '/stores/acme/publish');
  const chat = await settled();
  await fs.rm(path.join(site, '.vercel', 'FAIL'));
  assert.equal(chat.publish.lastFailed, true);
  assert.equal(chat.publish.unpublished, true);
  assert.equal(chat.publish.canUndo, false);
  assert.equal(chat.messages.at(-1).text, 'Publishing failed. Your website did not change.');
});

test('undo puts the code and the website back to the version published before', async () => {
  const firstLive = (await git(['rev-parse', 'HEAD~1'], workspace)).trim(); // the first publish, before the broken change
  await approveChange('src/page.txt', 'v2');
  await approveChange('src/extra.txt', 'added in v2');
  const undoneHead = (await git(['rev-parse', 'HEAD'], workspace)).trim();
  await call('POST', '/stores/acme/publish');
  let chat = await settled();
  assert.equal(chat.publish.lastFailed, false);
  assert.equal(chat.publish.canUndo, true);

  // an open draft blocks the undo
  await git(['checkout', '-q', '-b', 'draft/acme'], workspace);
  assert.equal((await call('POST', '/stores/acme/publish/undo')).body.error, 'draft_open');
  await git(['checkout', '-q', 'store/acme'], workspace);
  await git(['branch', '-q', '-D', 'draft/acme'], workspace);

  const started = await call('POST', '/stores/acme/publish/undo');
  assert.equal(started.status, 202, JSON.stringify(started.body));
  chat = await settled();
  assert.match(chat.messages.at(-1).text, /^Undid the last publish\./);

  assert.equal(await read(path.join(workspace, 'src', 'page.txt')), 'v1');
  await assert.rejects(fs.access(path.join(workspace, 'src', 'extra.txt')), 'files added since are removed');
  assert.equal((await git(['rev-parse', 'HEAD'], workspace)).trim(), firstLive, 'the branch is back at the earlier version');
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim(), 'store/acme');
  const kept = (await git(['for-each-ref', '--format=%(objectname)', 'refs/undone/acme'], workspace)).trim();
  assert.equal(kept, undoneHead, 'the undone commits are kept');
  const deploys = (await read(path.join(site, '.vercel', 'deploys.log'))).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(deploys.at(-1).page, 'v1');
  assert.equal(chat.publish.unpublished, false, 'the undo commit is what is live');
  assert.equal(chat.publish.canUndo, false, 'only one earlier version existed');
  assert.equal((await call('POST', '/stores/acme/publish/undo')).body.error, 'nothing_to_undo');
});

test('a starter update that was undone can be brought in again', async () => {
  await write(starter, 'src/starter-news.txt', 'new in the starter');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter news']);
  assert.equal((await call('POST', '/stores/acme/update-starter')).body.reason, 'updated');
  await call('POST', '/stores/acme/publish');
  assert.equal((await settled()).publish.canUndo, true);

  await call('POST', '/stores/acme/publish/undo');
  await settled();
  await assert.rejects(fs.access(path.join(workspace, 'src', 'starter-news.txt')));

  assert.equal((await call('POST', '/stores/acme/update-starter')).body.reason, 'updated');
  assert.equal(await read(path.join(workspace, 'src', 'starter-news.txt')), 'new in the starter');
});

test('a deploy command that loses its connection is judged by how the host build ended', async () => {
  await write(site, '.vercel/DROP', '1');
  await write(site, '.vercel/BUILD_FAILED', '1');
  await call('POST', '/stores/acme/publish');
  let chat = await settled();
  assert.equal(chat.publish.lastFailed, true, 'the host build failed too');

  await fs.rm(path.join(site, '.vercel', 'BUILD_FAILED'));
  await call('POST', '/stores/acme/publish');
  chat = await settled();
  await fs.rm(path.join(site, '.vercel', 'DROP'));
  assert.equal(chat.publish.lastFailed, false, 'the host finished the build: the site did change');
  assert.equal(chat.publish.unpublished, false);
  assert.match(chat.messages.at(-1).text, /^Published\./);
});

test('the deployment address is read from the deploy output', () => {
  assert.equal(deploymentUrlFrom('Deployment seif-storefront-78otn431o-team.vercel.app ready.\nAliased https://seif-storefront.vercel.app', 'https://seif-storefront.vercel.app'), 'https://seif-storefront-78otn431o-team.vercel.app');
  assert.equal(deploymentUrlFrom('no address here', 'https://x.vercel.app'), null);
});

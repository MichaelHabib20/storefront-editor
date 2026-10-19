import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEnv, baseEnv, deployEnv, sandboxed } from '../src/child-env.mjs';
import { createFetchGuard, ownHostsOf } from '../src/fetch-guard.mjs';
import { startProblem } from '../src/server.mjs';

const editorEnv = {
  PATH: '/usr/bin',
  HOME: '/home/editor',
  LC_ALL: 'C.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  VERCEL_TOKEN: 'vercel',
  EDITOR_SERVICE_KEY: 'service',
  EDITOR_TEAM_KEY: 'team',
  SEIF_SC_API_KEY: 'seif-key',
  EDITOR_TEST_LOGIN_PASSWORD: 'pw',
  npm_config__authToken: 'npm',
  GIT_SSH_COMMAND: 'ssh -i key',
};

test('checks and previews get the toolchain, never a key', () => {
  assert.deepEqual(baseEnv(editorEnv), { PATH: '/usr/bin', HOME: '/home/editor', LC_ALL: 'C.UTF-8' });
  // Windows spells it Path
  assert.deepEqual(baseEnv({ Path: 'C:\\node', SystemRoot: 'C:\\Windows', SECRET: 'x' }), { Path: 'C:\\node', SystemRoot: 'C:\\Windows' });
});

test('the agent gets its own credentials, the deploy only the host token', () => {
  const agent = agentEnv(editorEnv);
  assert.equal(agent.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(agent.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  for (const name of ['VERCEL_TOKEN', 'EDITOR_SERVICE_KEY', 'SEIF_SC_API_KEY', 'EDITOR_TEST_LOGIN_PASSWORD']) assert.equal(agent[name], undefined, name);

  const deploy = deployEnv(editorEnv);
  assert.equal(deploy.VERCEL_TOKEN, 'vercel');
  for (const name of ['ANTHROPIC_API_KEY', 'EDITOR_SERVICE_KEY', 'SEIF_SC_API_KEY']) assert.equal(deploy[name], undefined, name);
});

test('the sandbox prefix wraps the command, with the store id filled in', () => {
  assert.deepEqual(sandboxed(null, 'seif', 'npx', ['next', 'dev']), ['npx', ['next', 'dev']]);
  assert.deepEqual(sandboxed([], 'seif', 'npx', ['next', 'dev']), ['npx', ['next', 'dev']]);
  assert.deepEqual(sandboxed(['sudo', '-n', '-u', 'sf-{store}', '--'], 'seif', 'npx', ['next', 'dev']), ['sudo', ['-n', '-u', 'sf-seif', '--', 'npx', 'next', 'dev']]);
});

test('the service does not start without its key, unless told it is a local computer', () => {
  assert.match(startProblem({ serviceKey: null, allowNoKey: false }), /EDITOR_SERVICE_KEY/);
  assert.equal(startProblem({ serviceKey: null, allowNoKey: true }), null);
  assert.equal(startProblem({ serviceKey: 'k', allowNoKey: false }), null);
  assert.match(startProblem({ serviceKey: null, allowNoKey: true, previewDomain: 'preview.example' }), /EDITOR_PREVIEW_DOMAIN/);
});

test('the site reader never opens the preview domain', async () => {
  const guard = createFetchGuard({ resolve: async () => ['93.184.216.34'], ownHosts: ownHostsOf({ previewDomain: 'Preview.Example' }) });
  for (const value of ['https://0123456789abcdef0123456789abcdef.preview.example/', 'https://preview.example/', 'https://A.PREVIEW.EXAMPLE/en']) {
    await assert.rejects(guard.check(value), (error) => error.code === 'url_refused', value);
  }
  assert.equal((await guard.check('https://notpreview.example/')).hostname, 'notpreview.example');
});

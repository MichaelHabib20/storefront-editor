/**
 * Where things are. Everything can be overridden with environment variables (tests point them at a
 * throw-away starter repository).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  return {
    /** The starter storefront repository (its `main` is the base of every store copy). */
    starterRepo: env.EDITOR_STARTER_REPO ?? path.resolve(root, '..', 'headless-storefront-demo'),
    starterBranch: env.EDITOR_STARTER_BRANCH ?? 'main',
    /** One checkout (git worktree) per store. */
    workspacesDir: env.EDITOR_WORKSPACES_DIR ?? path.join(root, 'workspaces'),
    /** stores.json and change records. */
    dataDir: env.EDITOR_DATA_DIR ?? path.join(root, 'data'),
    /**
     * Quick checks after each edit, before the preview: types, the rules, and lint + tests for the changed files
     * only (`{codeFiles}` = the changed .ts/.tsx/.js files; a command whose list is empty is skipped). Minutes
     * matter here: the merchant is waiting in the chat.
     */
    checks: JSON.parse(env.EDITOR_CHECKS ?? 'null') ?? [
      ['npx', ['tsc', '--noEmit']],
      ['npm', ['run', 'check:rules']],
      ['npx', ['eslint', '--max-warnings=0', '{codeFiles}']],
      ['npx', ['vitest', 'related', '--run', '--passWithNoTests', '{codeFiles}']],
    ],
    /** The full checks: starter updates now, and before a publish (step 5, with the production build). */
    fullChecks: JSON.parse(env.EDITOR_FULL_CHECKS ?? 'null') ?? [
      ['npm', ['run', 'typecheck']],
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'check:rules']],
      ['npm', ['run', 'test']],
    ],
    /**
     * Previews: `dev` keeps a dev server per store running and it picks up each edit in seconds; `production`
     * builds and serves (slow: minutes per change; used for publishing). `{port}` is replaced.
     */
    previewMode: env.EDITOR_PREVIEW_MODE ?? 'dev',
    build: JSON.parse(env.EDITOR_BUILD ?? 'null') ?? ['npx', ['next', 'build']],
    serve: JSON.parse(env.EDITOR_SERVE ?? 'null') ?? ['npx', ['next', 'start', '-p', '{port}']],
    devServe: JSON.parse(env.EDITOR_DEV_SERVE ?? 'null') ?? ['npx', ['next', 'dev', '-p', '{port}']],
    /**
     * The address the merchant opens for a preview port, when previews are reached through a proxy or tunnel
     * (e.g. {"3301":"https://x.trycloudflare.com"}); default http://localhost:<port>.
     */
    previewPublicUrls: JSON.parse(env.EDITOR_PREVIEW_PUBLIC_URLS ?? '{}'),
    /** Ports previews are served on. */
    previewPorts: [Number(env.EDITOR_PREVIEW_PORT_FROM ?? 3301), Number(env.EDITOR_PREVIEW_PORT_TO ?? 3399)],
    /** Models and spending limits (static for now, agent design §6). */
    aiConfigFile: env.EDITOR_AI_CONFIG ?? path.join(root, 'config', 'ai.json'),
    /** The longest one AI turn (an edit or a fix round) may take before it is stopped and refunded. */
    turnTimeoutMs: Number(env.EDITOR_TURN_TIMEOUT_MS ?? 10 * 60_000),
    /** Shared secret the backend sends as `x-editor-key` (unset: no check, local development only). */
    serviceKey: env.EDITOR_SERVICE_KEY ?? null,
    /** The editor's own HTTP API. */
    port: Number(env.EDITOR_PORT ?? 4300),
  };
}

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
     * The checks a change must pass before a preview (the storefront's `verify` without the e2e run, which needs
     * the mock API and minutes; the full `verify` runs before a publish).
     */
    checks: JSON.parse(env.EDITOR_CHECKS ?? 'null') ?? [
      ['npm', ['run', 'typecheck']],
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'check:rules']],
      ['npm', ['run', 'test']],
    ],
    /** How a workspace is built for a preview, and how a preview is served (`{port}` is replaced). */
    build: JSON.parse(env.EDITOR_BUILD ?? 'null') ?? ['npx', ['next', 'build']],
    serve: JSON.parse(env.EDITOR_SERVE ?? 'null') ?? ['npx', ['next', 'start', '-p', '{port}']],
    /** Ports previews are served on. */
    previewPorts: [Number(env.EDITOR_PREVIEW_PORT_FROM ?? 3301), Number(env.EDITOR_PREVIEW_PORT_TO ?? 3399)],
    /** Models and spending limits (static for now, agent design §6). */
    aiConfigFile: env.EDITOR_AI_CONFIG ?? path.join(root, 'config', 'ai.json'),
    /** Shared secret the backend sends as `x-editor-key` (unset: no check, local development only). */
    serviceKey: env.EDITOR_SERVICE_KEY ?? null,
    /** The editor's own HTTP API. */
    port: Number(env.EDITOR_PORT ?? 4300),
  };
}

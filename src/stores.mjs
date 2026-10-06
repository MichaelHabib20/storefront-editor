/**
 * Store copies (design §1, §4): one branch `store/<id>` per store, cut from the starter's main, checked out in
 * its own workspace (a git worktree of the starter repository). The workspace shares the starter's
 * node_modules through a directory link: a store copy changes source files, not dependencies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { must, run } from './run.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createStores(config) {
  const file = path.join(config.dataDir, 'stores.json');
  const branchOf = (id) => `store/${id}`;
  const workspaceOf = (id) => path.join(config.workspacesDir, id);
  const git = (args, cwd = config.starterRepo) => must('git', args, { cwd });

  async function read() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return {};
    }
  }

  async function write(stores) {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(stores, null, 2) + '\n');
  }

  function checkId(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new StoreError('invalid_id', 'A store id is 1-40 lowercase letters, digits or dashes.');
  }

  async function branchExists(branch) {
    return (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: config.starterRepo })).code === 0;
  }

  /** Runs the configured checks in a workspace, in order; stops at the first that fails. */
  async function check(id) {
    const cwd = workspaceOf(id);
    for (const [command, args] of config.checks) {
      const result = await run(command, args, { cwd });
      if (result.code !== 0) return { ok: false, step: `${command} ${args.join(' ')}`, output: result.output.slice(-20_000) };
    }
    return { ok: true, step: null, output: '' };
  }

  return {
    branchOf,
    workspaceOf,
    check,

    async list() {
      return Object.values(await read());
    },

    async get(id) {
      checkId(id);
      const store = (await read())[id];
      if (!store) throw new StoreError('not_found', `No store copy "${id}".`);
      return store;
    },

    /**
     * Creates the store's copy: the branch (from the starter's main), the workspace and the record.
     * `apiUrl` / `apiKeyEnv` are how its previews reach the store's API (the key's value stays in the
     * editor's environment, never in the workspace).
     */
    async create(id, { apiUrl, apiKeyEnv = null } = {}) {
      checkId(id);
      if (typeof apiUrl !== 'string' || !/^https?:\/\//.test(apiUrl)) throw new StoreError('invalid_api_url', 'apiUrl must be an http(s) URL.');
      const stores = await read();
      if (stores[id]) throw new StoreError('exists', `The store copy "${id}" exists already.`);

      const branch = branchOf(id);
      if (!(await branchExists(branch))) await git(['branch', branch, config.starterBranch]);
      const workspace = workspaceOf(id);
      await fs.mkdir(config.workspacesDir, { recursive: true });
      await git(['worktree', 'add', workspace, branch]);
      // share the starter's dependencies (a junction on Windows: no admin rights needed)
      const modules = path.join(config.starterRepo, 'node_modules');
      try {
        await fs.access(modules);
        await fs.symlink(modules, path.join(workspace, 'node_modules'), 'junction');
      } catch {
        // a starter without installed dependencies (tests): nothing to link
      }

      stores[id] = { id, branch, workspace, apiUrl, apiKeyEnv, createdAt: new Date().toISOString(), starterCommit: (await git(['rev-parse', config.starterBranch])).trim() };
      await write(stores);
      return stores[id];
    },

    /**
     * Brings the starter's latest main into the store's copy (design §4). A conflict or a failed check
     * leaves the copy exactly as it was and says why.
     */
    async updateFromStarter(id) {
      const stores = await read();
      if (!stores[id]) throw new StoreError('not_found', `No store copy "${id}".`);
      const cwd = workspaceOf(id);
      // starter updates go into the approved copy only; an open draft is approved or discarded first
      if ((await must('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim() !== branchOf(id)) return { ok: false, reason: 'draft_open', output: '' };
      const before = (await must('git', ['rev-parse', 'HEAD'], { cwd })).trim();
      const merged = await run('git', ['merge', '--no-edit', config.starterBranch], { cwd });
      if (merged.code !== 0) {
        await run('git', ['merge', '--abort'], { cwd });
        return { ok: false, reason: 'conflict', output: merged.output.slice(-8000) };
      }
      const after = (await must('git', ['rev-parse', 'HEAD'], { cwd })).trim();
      if (after === before) return { ok: true, reason: 'up_to_date', output: '' };

      const checked = await check(id);
      if (!checked.ok) {
        await must('git', ['reset', '--hard', before], { cwd });
        return { ok: false, reason: 'check_failed', step: checked.step, output: checked.output };
      }
      stores[id].starterCommit = (await git(['rev-parse', config.starterBranch])).trim();
      await write(stores);
      return { ok: true, reason: 'updated', output: '' };
    },

    /** Removes the workspace and the record; the branch stays (it is the store's history). */
    async remove(id) {
      const stores = await read();
      if (!stores[id]) throw new StoreError('not_found', `No store copy "${id}".`);
      await run('git', ['worktree', 'remove', '--force', workspaceOf(id)], { cwd: config.starterRepo });
      delete stores[id];
      await write(stores);
    },
  };
}

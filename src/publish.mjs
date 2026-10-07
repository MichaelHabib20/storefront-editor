/**
 * Publishing a store's approved copy to its website, and undoing the last publish (docs/headless/publish-on-vercel-plan.md,
 * Phase 1).
 *
 * A store is publishable when its record has `publish: { dir, siteUrl }`. `dir` is a folder already linked to the
 * store's hosting project (for Vercel: `vercel link`, done once by hand). A publish:
 *   1. exports the committed files of the store's branch (`git archive`) into `dir`, keeping only the link folder
 *      (`.vercel`), so nothing that is not committed (keys, node_modules, build output) is ever uploaded;
 *   2. runs the deploy command there (`vercel deploy --prod --yes`); the host builds it and switches the site over
 *      only when the build succeeded, so a failed publish leaves the live site as it was;
 *   3. records the publish in the store's chat (`chat.publish`), which the admin page polls / streams.
 *
 * Undo moves the store's branch back to the commit of the publish before the last one and publishes that, so code
 * and website stay the same on any hosting plan. The branch is moved (not a revert commit) so a starter update that
 * was undone can be brought in again later; the commits it leaves are kept under `refs/undone/<store>/<id>`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { must, run } from './run.mjs';

export class PublishError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Folders in the publish dir that survive an export: the host's link to its project. */
const KEEP = new Set(['.vercel']);

/** The deployment's own address from the deploy command's output (the first *.vercel.app host that is not the site). */
export function deploymentUrlFrom(output, siteUrl) {
  const site = siteUrl ? new URL(siteUrl).host : '';
  for (const [host] of output.matchAll(/[a-z0-9][a-z0-9-]*\.vercel\.app/g)) {
    if (host !== site) return `https://${host}`;
  }
  return null;
}

export function createPublisher({ config, stores, chats, isBusy = () => false, log = () => {} }) {
  const git = (args, cwd = config.starterRepo) => must('git', args, { cwd });
  const [deployCommand, deployArgs] = config.deploy ?? ['vercel', ['deploy', '--prod', '--yes']];
  /** Stores with a publish or undo running in this process. */
  const running = new Set();

  const stateOf = (storeId) => chats.get(storeId).publish ?? { state: 'idle', history: [] };
  const setState = (storeId, change) =>
    chats.update(storeId, (chat) => {
      chat.publish ??= { state: 'idle', history: [] };
      change(chat.publish);
    });
  /** Publishes still live, oldest first (undone ones and undo entries are not "versions"). */
  const versions = (publish) => (publish.history ?? []).filter((e) => e.kind === 'publish' && e.ok && !e.undone);

  async function settings(storeId) {
    const store = await stores.get(storeId);
    if (!store.publish?.dir || !store.publish?.siteUrl) throw new PublishError('not_set_up', 'Publishing is not set up for this store yet.');
    try {
      await fs.access(path.join(store.publish.dir, '.vercel'));
    } catch {
      throw new PublishError('not_set_up', 'The publish folder is not linked to a hosting project yet.');
    }
    return store.publish;
  }

  function claim(storeId) {
    if (running.has(storeId)) throw new PublishError('publishing', 'A publish is already running.');
    running.add(storeId);
  }

  /** Empties `dir` except the link folder and fills it with the files committed at `commit`. */
  async function exportCommit(commit, dir) {
    for (const name of await fs.readdir(dir)) {
      if (!KEEP.has(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 });
    }
    const name = `publish-${randomUUID()}.tar`;
    const tar = path.join(os.tmpdir(), name);
    try {
      await git(['archive', '--format=tar', '-o', tar, commit]);
      // the archive by its bare name: GNU tar (Git for Windows' one) reads "C:\..." as a remote host
      await must('tar', ['-xf', name, '-C', dir], { cwd: os.tmpdir() });
    } finally {
      await fs.rm(tar, { force: true });
    }
  }

  /** Export + deploy; answers the history entry (ok or not). Never throws. */
  async function deploy(storeId, { kind, commit, siteDir, siteUrl, undoes = null }) {
    const entry = { id: randomUUID(), kind, commit, at: new Date().toISOString(), ok: false, deploymentUrl: null, ...(undoes ? { undoes } : {}) };
    try {
      await exportCommit(commit, siteDir);
      const result = await run(deployCommand, deployArgs, { cwd: siteDir, timeoutMs: config.deployTimeoutMs });
      entry.deploymentUrl = deploymentUrlFrom(result.output, siteUrl);
      entry.ok = result.code === 0;
      if (!entry.ok) entry.error = result.output.slice(-4000);
    } catch (error) {
      entry.error = String(error.message ?? error).slice(-4000);
    }
    entry.finishedAt = new Date().toISOString();
    log('publish', storeId, kind, entry.ok ? 'ok' : 'failed', commit.slice(0, 7));
    return entry;
  }

  const branchHead = async (storeId) => (await git(['rev-parse', stores.branchOf(storeId)])).trim();

  return {
    /** Starts publishing the approved copy; answers at once (`done` resolves when it is over, for tests). */
    async publish(storeId) {
      const { dir, siteUrl } = await settings(storeId);
      claim(storeId);
      let commit;
      try {
        commit = await branchHead(storeId);
        const live = versions(stateOf(storeId)).at(-1);
        if (live && (live.liveCommit ?? live.commit) === commit) throw new PublishError('nothing_to_publish', 'Everything approved is live already.');
      } catch (error) {
        running.delete(storeId);
        throw error;
      }
      setState(storeId, (p) => Object.assign(p, { state: 'publishing', startedAt: new Date().toISOString(), commit }));
      const done = (async () => {
        const entry = await deploy(storeId, { kind: 'publish', commit, siteDir: dir, siteUrl });
        setState(storeId, (p) => {
          p.history = [...(p.history ?? []), entry];
          Object.assign(p, { state: 'idle', startedAt: null, commit: null, lastFailed: !entry.ok });
        });
        chats.say(storeId, 'system', entry.ok ? `Published. Your changes are live on ${siteUrl}` : 'Publishing failed. Your website did not change.', { publish: entry.id });
        running.delete(storeId);
      })();
      return { started: true, commit, done };
    },

    /** Goes back to the version published before the last one: the code (one new commit) and the website. */
    async undo(storeId) {
      const { dir, siteUrl } = await settings(storeId);
      if (isBusy(storeId)) throw new PublishError('busy', 'A change is still running.');
      const cwd = stores.workspaceOf(storeId);
      const branch = stores.branchOf(storeId);
      if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim() !== branch) {
        throw new PublishError('draft_open', 'Approve or discard the open change first.');
      }
      const live = versions(stateOf(storeId));
      if (live.length < 2) throw new PublishError('nothing_to_undo', 'There is no earlier published version to go back to.');
      const [target, last] = live.slice(-2);
      claim(storeId);
      setState(storeId, (p) => Object.assign(p, { state: 'undoing', startedAt: new Date().toISOString(), commit: target.commit }));

      const done = (async () => {
        const before = (await git(['rev-parse', 'HEAD'], cwd)).trim();
        let entry;
        try {
          // keep what is left behind, then move the branch (and the workspace) to the earlier version
          await git(['update-ref', `refs/undone/${storeId}/${last.id}`, before], cwd);
          await git(['reset', '-q', '--hard', target.liveCommit ?? target.commit], cwd);
          const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
          entry = await deploy(storeId, { kind: 'undo', commit, siteDir: dir, siteUrl, undoes: last.id });
          if (!entry.ok) await git(['reset', '-q', '--hard', before], cwd);
        } catch (error) {
          await run('git', ['reset', '-q', '--hard', before], { cwd });
          entry = { id: randomUUID(), kind: 'undo', commit: before, at: new Date().toISOString(), ok: false, error: String(error.message ?? error).slice(-4000), undoes: last.id };
        }
        setState(storeId, (p) => {
          // after a good undo the last publish is gone and the earlier version is live again, now built from the
          // undo commit (same files): `liveCommit` is what the branch must match to have nothing unpublished
          p.history = (p.history ?? []).map((e) => {
            if (!entry.ok) return e;
            if (e.id === last.id) return { ...e, undone: true };
            if (e.id === target.id) return { ...e, liveCommit: entry.commit, deploymentUrl: entry.deploymentUrl ?? e.deploymentUrl };
            return e;
          });
          p.history.push(entry);
          Object.assign(p, { state: 'idle', startedAt: null, commit: null, lastFailed: !entry.ok });
        });
        chats.say(storeId, 'system', entry.ok ? `Undid the last publish. Your website is back to the version from ${target.at.slice(0, 10)}.` : 'Undo failed. Your website and your approved changes did not change.', { publish: entry.id });
        running.delete(storeId);
      })();
      return { started: true, done };
    },

    /** What the admin page needs; `approvedCommit` is the store branch's head (null when unknown). */
    view(chat, { siteUrl = null, approvedCommit = null } = {}) {
      if (!siteUrl) return null;
      const publish = chat.publish ?? { state: 'idle', history: [] };
      const live = versions(publish);
      const last = live.at(-1) ?? null;
      return {
        siteUrl,
        state: publish.state ?? 'idle',
        startedAt: publish.startedAt ?? null,
        lastPublishedAt: last?.finishedAt ?? last?.at ?? null,
        lastFailed: !!publish.lastFailed,
        canUndo: live.length >= 2,
        unpublished: approvedCommit ? approvedCommit !== (last?.liveCommit ?? last?.commit) : null,
      };
    },

    branchHead,
  };
}

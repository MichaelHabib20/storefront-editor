/**
 * Which files the agent may change (agent design §2.1). A path is editable when it matches an `editable` pattern and
 * no `locked` pattern. Patterns: `**` any depth, `*` within one path segment. Paths are relative to the workspace,
 * with forward slashes.
 */
import path from 'node:path';

function toRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') source += '[^/]*';
    else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function createFilePolicy({ editable, locked, shared = [] }) {
  const allow = editable.map(toRegExp);
  const deny = locked.map(toRegExp);
  const common = shared.map(toRegExp);
  return {
    /** Parts used across the whole store (site colours, shared components): changing them changes every page. */
    isShared(relative) {
      const p = relative.replaceAll('\\', '/');
      return common.some((r) => r.test(p));
    },
    /** @param {string} relative workspace-relative path */
    canEdit(relative) {
      const p = relative.replaceAll('\\', '/');
      if (p.startsWith('../') || path.isAbsolute(p)) return false;
      return allow.some((r) => r.test(p)) && !deny.some((r) => r.test(p));
    },
    /** Paths the agent may not even read (secrets). */
    canRead(relative) {
      const p = relative.replaceAll('\\', '/');
      return !p.startsWith('../') && !/(^|\/)\.env(\.|$)/.test(p);
    },
  };
}

/** A tool's path argument, as a workspace-relative path (null when outside the workspace). */
export function relativeTo(workspace, filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const absolute = path.resolve(workspace, filePath);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.replaceAll('\\', '/');
}

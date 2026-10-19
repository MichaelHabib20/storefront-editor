/**
 * What the editor's child processes get from its environment. The editor holds the keys (Claude, Vercel, the service
 * key, every store's API key, the test customer); the checks and previews run code the AI wrote, so they get only what
 * a toolchain needs, plus what the caller hands over on purpose (a store's own API settings, the deploy token).
 */

/** Names passed on as they are (Windows names included: its environment is case-insensitive). */
const NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'CI',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PLAYWRIGHT_BROWSERS_PATH', 'NEXT_TELEMETRY_DISABLED',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'ALLUSERSPROFILE',
  'PUBLIC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME',
]);
/** Prefixes passed on: locale, desktop dirs, Node version managers. */
const PREFIXES = ['LC_', 'XDG_', 'NVM_', 'VOLTA_', 'FNM_'];

const pick = (env, keep) => Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && keep(name.toUpperCase())));

/** The toolchain's share of `env`: no keys. */
export function baseEnv(env = process.env) {
  return pick(env, (name) => NAMES.has(name) || PREFIXES.some((p) => name.startsWith(p)));
}

/** For the Agent SDK's Claude Code process: the toolchain's share plus its own settings and credentials. */
export function agentEnv(env = process.env) {
  return { ...baseEnv(env), ...pick(env, (name) => name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_')) };
}

/** For the deploy command: the toolchain's share plus the host's token (`vercel` reads VERCEL_TOKEN). */
export function deployEnv(env = process.env) {
  return { ...baseEnv(env), ...pick(env, (name) => name.startsWith('VERCEL_')) };
}

/**
 * A command that runs the store's code, wrapped in the sandbox prefix when one is set (EDITOR_SANDBOX, e.g.
 * `["sudo","-n","-u","sf-{store}","--"]`: another user, which cannot read the editor's files or its environment).
 */
export function sandboxed(sandbox, storeId, command, args) {
  if (!sandbox?.length) return [command, args];
  const [first, ...rest] = sandbox.map((a) => a.replaceAll('{store}', storeId));
  return [first, [...rest, command, ...args]];
}

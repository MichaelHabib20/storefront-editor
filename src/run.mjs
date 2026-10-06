/**
 * Running commands: git and npm in a workspace. Output is captured (the agent loop reads it back when a
 * check fails); nothing goes through a shell string built from input — arguments are passed as a list.
 */
import { spawn } from 'node:child_process';

/**
 * @param {string} command  e.g. 'git', 'npm'
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ code: number, output: string }>}
 */
export function run(command, args, { cwd, env = {}, timeoutMs = 15 * 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      // npm and npx are .cmd files on Windows
      shell: process.platform === 'win32' && command !== 'git',
      windowsHide: true,
    });
    let output = '';
    const keep = (chunk) => {
      output += chunk.toString();
      // the tail is what matters for a failed check; keep memory bounded
      if (output.length > 400_000) output = output.slice(-300_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: output + String(error) });
    });
  });
}

/** Like run(), but throws with the output when the command fails. */
export async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed (${result.code})\n${result.output.slice(-4000)}`);
    error.output = result.output;
    throw error;
  }
  return result.output;
}

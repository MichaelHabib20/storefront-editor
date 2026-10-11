import fs from 'node:fs/promises';
import path from 'node:path';

const VIEWS = ['phone', 'desktop'];

/**
 * Which screen sizes the editing AI has not looked at since its last edit: [] when it saw its change on both phone and
 * desktop. Screenshots are the run's saved files ("03-phone-_en.jpg"); the last edit is the newest changed file.
 */
export async function missingLooks(cwd, changed, shotsDir) {
  let lastEdit = 0;
  for (const file of changed) {
    const stat = await fs.stat(path.join(cwd, file)).catch(() => null);
    if (stat) lastEdit = Math.max(lastEdit, stat.mtimeMs);
  }
  const seen = new Set();
  for (const name of await fs.readdir(shotsDir).catch(() => [])) {
    const view = name.match(/^\d+-(phone|desktop)-/)?.[1];
    if (!view) continue;
    const stat = await fs.stat(path.join(shotsDir, name)).catch(() => null);
    if (stat && stat.mtimeMs >= lastEdit) seen.add(view);
  }
  return VIEWS.filter((view) => !seen.has(view));
}

const UNCHECKED = [
  /\b(?:didn['’]t|did not|haven['’]t|have not|couldn['’]t|could not|wasn['’]t able to)\s+(?:yet\s+)?(?:check|look|open|view|see|test)/i,
  /\bnot (?:checked|viewed|looked at)\b/i,
  /لم أتحقق|لم أتمكن من (?:التحقق|الفحص|رؤية)|لم أفحص|لم أنظر|لم أفتح/,
];

/** The AI's message says it did not look at something (then it looks now instead of telling the owner). */
export function admitsUnchecked(text) {
  return UNCHECKED.some((pattern) => pattern.test(String(text ?? '')));
}

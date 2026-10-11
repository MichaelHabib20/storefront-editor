/**
 * Whether a diff only ADDS to a file: every removed line comes back extended (e.g. a list of icon names with one more
 * name: `'cart' | 'heart';` → `'cart' | 'heart' | 'truck';`). Adding to a shared part is allowed without asking.
 * @param {string} diff  `git diff -U0` of one file
 */
export function onlyExtends(diff) {
  const removed = [];
  const added = [];
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  const stem = (line) => line.trimEnd().replace(/[,;{(]\s*$/, '').trimEnd();
  return removed.every((line) => {
    const start = stem(line);
    return start.length > 0 && added.some((a) => a.trimEnd().startsWith(start) && a.trim().length > line.trim().length);
  });
}

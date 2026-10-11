// Quick check on the files a change touched: catches slips the store's linter lets through.
//   node tidy-check.mjs <file> [<file> ...]   (run in the store's copy; exits 1 with the places to fix)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// two JSX attributes with no space between them: src={logo}alt="..." or href="/x"className={...}
const GLUED = /<[A-Za-z][^>]*?(?:\}|"|')(?<name>[A-Za-z][\w-]*)=(?:\{|"|')/;
// a selector made only of plain element names (button, h1, h2, a, *...): it restyles every such element in the store
const BARE = /^\s*(?:[a-z][a-z0-9]*|\*)(?:\s*,\s*(?:[a-z][a-z0-9]*|\*))*\s*[,{]\s*$/;
// the at-rules and keyframe steps that also look like plain words
const NOT_A_SELECTOR = /^\s*(?:from|to|\d+%)\s*[,{]/;

/** Lines this change added to a file (against the last commit); every line for a new file. */
function addedLines(file) {
  try {
    const diff = execFileSync('git', ['diff', '-U0', 'HEAD', '--', file], { encoding: 'utf8' });
    if (diff) return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    const tracked = execFileSync('git', ['ls-files', '--', file], { encoding: 'utf8' }).trim();
    return tracked ? [] : fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

const problems = [];
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) continue;
  if (/\.(tsx|jsx)$/.test(file)) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(GLUED);
        if (m) problems.push(`${file}:${i + 1}: put a space before the "${m.groups.name}" attribute`);
      });
  }
  if (/\.css$/.test(file)) {
    for (const line of addedLines(file)) {
      if (BARE.test(line) && !NOT_A_SELECTOR.test(line)) {
        problems.push(`${file}: the new rule "${line.trim()}" styles every such element in the store. Style the parts the owner named (their own classes or the variable they use) instead.`);
      }
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

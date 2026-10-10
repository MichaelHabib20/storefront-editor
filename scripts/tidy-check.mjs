// Quick check on the files a change touched: catches slips the store's linter lets through.
//   node tidy-check.mjs <file> [<file> ...]   (run in the store's copy; exits 1 with the places to fix)
import fs from 'node:fs';

// two JSX attributes with no space between them: src={logo}alt="..." or href="/x"className={...}
const GLUED = /<[A-Za-z][^>]*?(?:\}|"|')(?<name>[A-Za-z][\w-]*)=(?:\{|"|')/;

const problems = [];
for (const file of process.argv.slice(2)) {
  if (!/\.(tsx|jsx)$/.test(file) || !fs.existsSync(file)) continue;
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(GLUED);
      if (m) problems.push(`${file}:${i + 1}: put a space before the "${m.groups.name}" attribute`);
    });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

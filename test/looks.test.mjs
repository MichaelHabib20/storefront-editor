import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { missingLooks } from '../src/looks.mjs';

const at = (file, seconds) => fs.utimes(file, seconds, seconds);

test('a change counts as seen only on the sizes shot after the last edit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'looks-'));
  const cwd = path.join(dir, 'ws');
  const shots = path.join(dir, 'shots');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.mkdir(shots);
  await fs.writeFile(path.join(cwd, 'src/a.css'), 'a {}');
  await fs.writeFile(path.join(cwd, 'src/b.css'), 'b {}');
  await at(path.join(cwd, 'src/a.css'), 1000);
  await at(path.join(cwd, 'src/b.css'), 2000);

  // nothing shot at all
  assert.deepEqual(await missingLooks(cwd, ['src/a.css', 'src/b.css'], shots), ['phone', 'desktop']);
  // a phone shot before the last edit does not count; a desktop one after it does
  await fs.writeFile(path.join(shots, '01-phone-_en.jpg'), '');
  await at(path.join(shots, '01-phone-_en.jpg'), 1500);
  await fs.writeFile(path.join(shots, '02-desktop-_en.jpg'), '');
  await at(path.join(shots, '02-desktop-_en.jpg'), 2500);
  assert.deepEqual(await missingLooks(cwd, ['src/a.css', 'src/b.css'], shots), ['phone']);
  await fs.writeFile(path.join(shots, '03-phone-_ar.jpg'), '');
  await at(path.join(shots, '03-phone-_ar.jpg'), 2600);
  assert.deepEqual(await missingLooks(cwd, ['src/a.css', 'src/b.css'], shots), []);
  // a deleted file and a missing folder do not break it
  assert.deepEqual(await missingLooks(cwd, ['src/gone.css'], path.join(dir, 'none')), ['phone', 'desktop']);
});

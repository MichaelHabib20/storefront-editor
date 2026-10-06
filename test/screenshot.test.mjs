/**
 * Eyes (plan step 5): the path guard, a real headless screenshot of a small page, and the agent getting the tool
 * when its store has a dev preview (with a fake model).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { must } from '../src/run.mjs';
import { createBrowserPool, safePreviewPath, SCREENSHOT_TOOL, takeScreenshot } from '../src/screenshot.mjs';
import { createApp } from '../src/server.mjs';

let dir;
let pool;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eyes-'));
  pool = createBrowserPool();
});

after(async () => {
  await pool.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('a shot can scroll to an element by its text, after closing the cookie banner', async () => {
  const server = http.createServer((q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end(`<html><body style="margin:0">
      <div id="cookies" style="position:fixed;bottom:0;left:0;right:0;height:300px;background:#000;color:#fff">Cookies
        <button onclick="document.getElementById('cookies').remove()">Accept</button></div>
      <div style="height:3000px;background:#fff"></div>
      <button style="background:#0a0;color:#fff;font-size:40px">Add to cart</button>
      <div style="height:3000px"></div></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const shot = await takeScreenshot(pool, { baseUrl: `http://127.0.0.1:${server.address().port}`, path: '/', viewport: 'desktop', scrollTo: 'Add to cart', saveDir: path.join(dir, 'run2'), index: 1 });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      // read the saved picture back: the green button is on it, the black cookie banner is not
      const page = await browser.newPage();
      await page.setContent(`<canvas id=c></canvas><img id=i src="data:image/jpeg;base64,${shot.data}">`);
      const colours = await page.evaluate(async () => {
        const img = document.getElementById('i');
        await img.decode();
        const c = document.getElementById('c');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, c.width, c.height).data;
        let green = 0;
        let black = 0;
        for (let p = 0; p < data.length; p += 4) {
          if (data[p] < 40 && data[p + 1] > 120 && data[p + 2] < 40) green++;
          if (data[p] < 20 && data[p + 1] < 20 && data[p + 2] < 20) black++;
        }
        return { green, black, total: data.length / 4 };
      });
      assert.ok(colours.green > 500, `the button is in view (${colours.green} green pixels)`);
      assert.ok(colours.black < colours.total * 0.05, 'the cookie banner was closed');
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
});

test('the browser is never closed while a shot is still running, only after a quiet spell', async () => {
  let closed = 0;
  const fake = { isConnected: () => true, close: async () => void (closed += 1) };
  const quick = createBrowserPool({ launch: async () => fake, idleMs: 50 });
  await quick.get();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(closed, 0, 'a long shot keeps the browser');
  quick.release();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(closed, 1, 'closed once nothing used it for a while');
});

test('only paths on the preview are allowed', () => {
  assert.equal(safePreviewPath('/en/p/shoe?size=2'), '/en/p/shoe?size=2');
  assert.equal(safePreviewPath(undefined), '/');
  for (const bad of ['https://evil.test/', '//evil.test', 'en', '/a b', '/x\\y']) assert.equal(safePreviewPath(bad), null, bad);
});

test('takes a phone screenshot of a page and saves it with the run', async () => {
  const server = http.createServer((q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end(`<html><body style="background:#ef6b01"><h1>${q.url}</h1></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const shot = await takeScreenshot(pool, { baseUrl: `http://127.0.0.1:${server.address().port}`, path: '/en', viewport: 'phone', saveDir: path.join(dir, 'run1'), index: 1 });
    assert.ok(shot.data.startsWith('/9j/'), 'a JPEG');
    assert.equal(shot.file, '01-phone-_en.jpg');
    assert.ok((await fs.stat(path.join(dir, 'run1', shot.file))).size > 1000);
  } finally {
    server.close();
  }
});

test('with a dev preview the editing AI gets the screenshot tool and the instructions to use it', async () => {
  const starter = path.join(dir, 'starter');
  await fs.mkdir(path.join(starter, 'src'), { recursive: true });
  const git = (args) => must('git', args, { cwd: starter });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await fs.writeFile(path.join(starter, 'src', 'page.txt'), 'v1');
  await fs.writeFile(path.join(starter, 'check.mjs'), '\n');
  await fs.writeFile(path.join(starter, 'serve.mjs'), "import http from 'node:http'; http.createServer((q, s) => s.end('<h1>preview</h1>')).listen(Number(process.argv[2]), '127.0.0.1');\n");
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'starter']);
  const aiConfigFile = path.join(dir, 'ai.json');
  await fs.writeFile(
    aiConfigFile,
    JSON.stringify({
      defaults: { editModel: 'claude-sonnet-5-5', triageModel: 'claude-haiku-4-5', allowedModels: ['claude-sonnet-5-5'], routing: 'fixed', effort: 'medium', monthlyLimitUsd: 5, perRequestMaxUsd: 1, minToStartUsd: 0.05, warnAt: 0.8, maxTurns: 10, maxFixRounds: 1 },
      files: { editable: ['src/**'], locked: [], generated: [], shared: [] },
    }),
  );

  const calls = [];
  const app = createApp(
    {
      starterRepo: starter,
      starterBranch: 'main',
      workspacesDir: path.join(dir, 'workspaces'),
      dataDir: path.join(dir, 'data'),
      checks: [['node', ['check.mjs']]],
      build: ['node', ['check.mjs']],
      serve: ['node', ['serve.mjs', '{port}']],
      devServe: ['node', ['serve.mjs', '{port}']],
      previewMode: 'dev',
      previewPorts: [3491, 3499],
      aiConfigFile,
    },
    {
      browsers: pool,
      triage: async () => ({ decision: 'edit', large: false, confirm: false, shared: false, task: 'Make the page say v2.', reply: 'On it.', options: [], model: 'claude-haiku-4-5', costUsd: 0.001 }),
      query: ({ prompt, options }) => {
        calls.push({ prompt, options });
        return (async function* () {
          await fs.writeFile(path.join(options.cwd, 'src', 'page.txt'), 'v2');
          yield { type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.05, session_id: 's1' };
        })();
      },
      log: () => {},
    },
  );
  try {
    await app.stores.create('eyes', { apiUrl: 'https://api.eyes.test' });
    const { done } = await app.runner.send('eyes', 'make it say v2');
    await done;
    assert.equal(app.chats.get('eyes').run.outcome, 'preview');
    const { options } = calls[0];
    assert.equal(options.mcpServers.editor.type, 'sdk');
    assert.ok(options.allowedTools.includes(SCREENSHOT_TOOL));
    assert.match(options.systemPrompt, /screenshot tool/);
    assert.ok(app.previews.list().some((p) => p.id === 'eyes' && p.mode === 'dev'), 'the preview ran while the agent worked');
  } finally {
    await app.previews.stopAll();
  }
});

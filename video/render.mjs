/**
 * Render the pitch video.
 *
 *   1. serves the repo root over HTTP (so the stage can load the product's own
 *      icon and the captured assets),
 *   2. drives the deterministic stage in headless Chromium, seeking one frame
 *      at a time,
 *   3. pipes the frames straight into ffmpeg (nothing large touches disk),
 *   4. writes the captions as .srt and a branded thumbnail.
 *
 * Usage:
 *   node video/render.mjs                       # full render
 *   node video/render.mjs --from 0 --to 6       # smoke test a few seconds
 *   node video/render.mjs --fps 30 --out docs/media/x402-gateway-demo.mp4
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const FPS = Number(argOf('fps', 30));
const OUT = path.resolve(ROOT, argOf('out', 'docs/media/x402-gateway-demo.mp4'));
const THUMB = path.resolve(ROOT, argOf('thumb', 'docs/media/x402-gateway-demo-thumbnail.png'));
const SRT = path.resolve(ROOT, argOf('srt', 'docs/media/x402-gateway-demo.srt'));
// JPEG at high quality: the frames are re-encoded to H.264 anyway, and the
// smaller pipe roughly triples capture throughput on constrained machines.
const VF = argOf('format', 'jpeg');
const CRF = argOf('crf', '20');
const PORT = Number(argOf('port', 4317));

const log = (m) => console.log(m);

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/tmp/video-tools/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (mod?.chromium || mod?.default?.chromium) return mod;
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found — set PLAYWRIGHT_MODULE');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** SRT cue list derived from the same narration the stage renders. */
function buildSrt(narration) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = (seconds) => {
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
  };
  const stripTags = (t) => t.replace(/<[^>]+>/g, '');

  let cursor = 0;
  const cues = [];
  for (const scene of narration.scenes) {
    const ordered = [...(scene.cues || [])].sort((a, b) => a.at - b.at);
    ordered.forEach((cue, i) => {
      const start = cursor + cue.at;
      const next = ordered[i + 1]?.at;
      // Hold each caption until the next one, but never past its own scene.
      const end = Math.min(
        cursor + scene.duration - 0.15,
        next !== undefined ? cursor + next : cursor + scene.duration - 0.15,
      );
      cues.push({ start, end: Math.max(end, start + 1.2), text: stripTags(cue.text) });
    });
    cursor += scene.duration;
  }

  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

async function main() {
  const narration = JSON.parse(await readFile(path.join(ROOT, 'video', 'narration.json'), 'utf8'));
  let start = 0;
  let total = narration.scenes.reduce((a, s) => a + s.duration, 0);
  if (args.includes('--from')) start = Number(argOf('from', 0));
  if (args.includes('--to')) total = Number(argOf('to', total));

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(SRT, buildSrt(narration));
  log(`  captions → ${path.relative(ROOT, SRT)}`);

  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default.chromium;
  const server = await serve(PORT);
  const browser = await chromium.launch({
    args: [
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--font-render-hinting=none',
      '--disable-lcd-text',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/video/stage.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__READY === true || window.__ERROR', null, { timeout: 60000 });
  const bootError = await page.evaluate('window.__ERROR || null');
  if (bootError) throw new Error(`stage failed to boot:\n${bootError}`);

  const timeline = await page.evaluate('window.__VIDEO.duration');
  log(`  timeline: ${timeline.toFixed(1)}s across ${narration.scenes.length} scenes`);

  if (args.includes('--thumb-only')) {
    const at = Number(argOf('thumb-at', 5));
    await page.evaluate((t) => window.__VIDEO.render(t), at);
    await page.screenshot({ path: THUMB });
    log(`  thumbnail → ${path.relative(ROOT, THUMB)}`);
    await browser.close();
    server.close();
    return;
  }

  const tmp = path.join(os.tmpdir(), `x402-video-${Date.now()}.mp4`);
  const encoder = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      VF === 'png' ? 'png' : 'mjpeg',
      '-r',
      String(FPS),
      '-i',
      '-',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      CRF,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      tmp,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const encoderDone = new Promise((resolve, reject) => {
    encoder.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
    encoder.on('error', reject);
  });

  const frameCount = Math.round((total - start) * FPS);
  const startedAt = Date.now();
  let pending = 0;

  for (let i = 0; i < frameCount; i++) {
    const t = start + i / FPS;
    await page.evaluate((time) => window.__VIDEO.render(time), t);
    const buffer = await page.screenshot({
      type: VF === 'png' ? 'png' : 'jpeg',
      ...(VF === 'png' ? {} : { quality: 96 }),
      animations: 'disabled',
    });
    if (!encoder.stdin.write(buffer)) {
      await new Promise((r) => encoder.stdin.once('drain', r));
    }
    pending++;
    if (i % 300 === 0 || i === frameCount - 1) {
      const done = i + 1;
      const rate = done / ((Date.now() - startedAt) / 1000);
      const eta = (frameCount - done) / Math.max(rate, 0.01);
      log(
        `  frame ${done}/${frameCount} (${((done / frameCount) * 100).toFixed(1)}%) ` +
          `${rate.toFixed(1)} fps · eta ${Math.round(eta)}s`,
      );
    }
  }

  encoder.stdin.end();
  await encoderDone;
  log(`  encoded ${pending} frames in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  // Final container pass so the audio track can be added later without a
  // second video encode.
  await rm(OUT, { force: true });
  await new Promise((resolve, reject) => {
    const c = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-c', 'copy', OUT],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mux exited ${code}`))));
  });
  await rm(tmp, { force: true });

  // Thumbnail from a chosen moment of the open scene.
  const thumbAt = Number(argOf('thumb-at', 5.0));
  await page.evaluate((t) => window.__VIDEO.render(t), thumbAt);
  await page.screenshot({ path: THUMB });
  log(`  thumbnail → ${path.relative(ROOT, THUMB)}`);

  await browser.close();
  server.close();

  const size = (await stat(OUT)).size;
  log(`\n  done: ${path.relative(ROOT, OUT)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

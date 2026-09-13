/**
 * Generate the voice-over and mux it onto the rendered video.
 *
 * The narration in `narration.json` is the single source of truth for both the
 * burned-in captions and the spoken track, so the audio always says exactly
 * what the video shows. Each cue is synthesized as its own utterance and placed
 * at that cue's own time, so a caption changes precisely when its line starts
 * being spoken. (Synthesizing a whole scene as one block instead makes the voice
 * run ahead of the later cues, because a continuous read does not take the
 * pauses the cue timings are built around.)
 *
 * Providers (all return 24 kHz, 16-bit mono PCM):
 *   - elevenlabs  (default) ELEVENLABS_API_KEY
 *   - openai                OPENAI_API_KEY
 *   - cartesia              CARTESIA_API_KEY
 *   - gemini                GEMINI_API_KEY | GOOGLE_API_KEY
 *   - piper                 PIPER_MODEL (+ PIPER_BIN) — local, no key, no network
 *
 *   node video/make-voiceover.mjs --dry-run             # estimate timing, no API call
 *   node video/make-voiceover.mjs --check               # same, but exit 1 on overrun (CI)
 *   ELEVENLABS_API_KEY=... node video/make-voiceover.mjs
 *   node video/make-voiceover.mjs --provider openai     # force a provider
 *   PIPER_MODEL=... node video/make-voiceover.mjs --provider piper
 *   node video/make-voiceover.mjs --out docs/media/x402-gateway-demo.mp4
 *                                                     # voice the featured cut in place
 *
 * Output: docs/media/x402-gateway-demo-voiced.mp4 by default. `--out` may point
 * at the input video to voice it in place; the mux is swapped in only once it
 * succeeds, so a failed run leaves the original untouched.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NARRATION = path.join(ROOT, 'video', 'narration.json');
const DEFAULT_VIDEO = path.join(ROOT, 'docs', 'media', 'x402-gateway-demo.mp4');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');
// `--check` is the dry run with a non-zero exit on overrun, so CI fails when a
// narration cue outgrows the scene budget it is spoken over.
const CHECK = args.includes('--check');
const VIDEO = path.resolve(ROOT, argOf('video', path.relative(ROOT, DEFAULT_VIDEO)));
const OUT = path.resolve(ROOT, argOf('out', 'docs/media/x402-gateway-demo-voiced.mp4'));

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (t) =>
  t
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Flatten a scene's cues into one block of spoken text. */
function sceneScript(scene) {
  return [...(scene.cues || [])]
    .sort((a, b) => a.at - b.at)
    .map((c) => stripTags(c.text))
    .join(' ');
}

// ── API key discovery ────────────────────────────────────────────────

/** Read a key from the environment or the repo's .env (names in order). */
async function findKey(names) {
  for (const n of names) {
    if (process.env[n]) return { key: process.env[n], source: n };
  }
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) {
    const text = await readFile(envFile, 'utf8');
    for (const n of names) {
      const m = text.match(new RegExp(`^\\s*${n}\\s*=\\s*(.+)$`, 'm'));
      if (m) return { key: m[1].trim().replace(/^["']|["']$/g, ''), source: `.env (${n})` };
    }
  }
  return null;
}

// ── PCM helpers ──────────────────────────────────────────────────────

/** Minimal 16-bit mono PCM WAV writer. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Decode any ffmpeg-readable audio (mp3/wav/…) to 16-bit mono PCM.
 * Used for providers whose raw-PCM output formats are plan-restricted:
 * requesting mp3 and decoding locally keeps the request valid on every tier.
 */
function decodeToPcm(input, rate = 24000) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate),
      'pipe:1',
    ]);
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg decode exited ${code}`)),
    );
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}

/**
 * Some providers return a RIFF/WAV container even when raw PCM was requested.
 * Strip a WAV header when present so the assembled track stays raw PCM.
 */
function stripWavHeader(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    // Walk the chunk list to find `data`.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'data') return buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
      offset += 8 + size + (size % 2);
    }
  }
  return buf;
}

/** Recursively find a base64 audio payload, whatever envelope it arrives in. */
function extractAudio(node, mimeHint = null) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractAudio(item, mimeHint);
      if (found) return found;
    }
    return null;
  }
  const mime = node.mimeType || node.mime_type || node.mime;
  const isAudioMime = typeof mime === 'string' && mime.startsWith('audio/');
  if (typeof node.data === 'string' && node.data.length > 512 && (isAudioMime || mimeHint)) {
    return { data: node.data, mime: mime || mimeHint };
  }
  for (const key of Object.keys(node)) {
    const found = extractAudio(node[key], isAudioMime ? mime : mimeHint);
    if (found) return found;
  }
  return null;
}

// ── Providers ────────────────────────────────────────────────────────

const DEFAULT_VOICES = {
  // 'Rachel' — the default voice in ElevenLabs' own API examples, so it is
  // present on every account/plan. Override under voice.providers.elevenlabs.
  elevenlabs: { voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2' },
  openai: { voice: 'onyx', model: 'gpt-4o-mini-tts' },
  cartesia: { modelId: 'sonic-2', voiceId: null },
  gemini: { model: 'gemini-3.1-flash-tts-preview', voiceName: 'Kore' },
  // piper is a local binary rather than an HTTP API: there is no key to find,
  // and `model` is a path on this machine (PIPER_MODEL). lengthScale >1 speaks
  // slower — but the cue windows are already tight (the narrowest line leaves
  // about 3% of slack), so much above 1 pushes a line past the next cue.
  piper: { model: null, lengthScale: 1.0, sentenceSilence: 0.2 },
};

/** Merge narration.voice.providers[provider] over the built-in defaults. */
function providerConfig(voice, provider) {
  return { ...DEFAULT_VOICES[provider], ...(voice.providers?.[provider] || {}) };
}

/** Retry once on 429/5xx — TTS endpoints are bursty under scene-by-scene load. */
async function fetchWithRetry(url, init, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429 || res.status >= 500) {
      log(`    retry ${attempt}/3 after HTTP ${res.status} (${label})`);
      await sleep(2000 * attempt);
      continue;
    }
    return res;
  }
  throw new Error(`${label} failed after 3 attempts`);
}

async function synthElevenLabs(cfg, text, key, voice) {
  // Request MP3 and decode locally: the raw-PCM output formats are
  // plan-restricted on some accounts, while mp3_44100_128 is universally
  // available. ffmpeg is already a hard dependency of this pipeline.
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}` +
    `?output_format=mp3_44100_128&optimize_streaming_latency=0`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: cfg.modelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    },
    'ElevenLabs',
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { pcm: await decodeToPcm(buf), rate: 24000 };
}

async function synthOpenAI(cfg, text, key, voice) {
  const res = await fetchWithRetry(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        response_format: 'pcm', // 24 kHz, 16-bit mono, little-endian
        instructions: voice.style,
      }),
    },
    'OpenAI',
  );
  if (!res.ok) {
    throw new Error(`OpenAI TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { pcm: stripWavHeader(buf), rate: 24000 };
}

async function synthCartesia(cfg, text, key, voice) {
  if (!cfg.voiceId) {
    throw new Error(
      'Cartesia needs a voice id — set voice.providers.cartesia.voiceId in video/narration.json',
    );
  }
  const res = await fetchWithRetry(
    'https://api.cartesia.ai/tts/bytes',
    {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Cartesia-Version': '2024-06-10',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model_id: cfg.modelId,
        transcript: text,
        voice: { mode: 'id', id: cfg.voiceId },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
        language: 'en',
      }),
    },
    'Cartesia',
  );
  if (!res.ok) {
    throw new Error(`Cartesia TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { pcm: stripWavHeader(buf), rate: 24000 };
}

async function synthGemini(cfg, text, key, voice) {
  const endpoint = cfg.endpoint || 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const models = [cfg.model, cfg.fallbackModel].filter(Boolean);
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: `${voice.style}\n\n${text}`,
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: cfg.voiceName }] },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        log(`    retry ${attempt}/3 after HTTP ${res.status} (Gemini ${model})`);
        await sleep(2000 * attempt);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        lastError = `Gemini TTS failed (HTTP ${res.status}, ${model}): ${JSON.stringify(json).slice(0, 300)}`;
        break; // try the next model
      }
      const audio = extractAudio(json);
      if (!audio) {
        lastError = `no audio in Gemini TTS response (keys: ${Object.keys(json || {}).join(', ')})`;
        break;
      }
      const mime = audio.mime || `audio/L16;codec=pcm;rate=${voice.sampleRate || 24000}`;
      const rate = Number(mime.match(/rate=(\d+)/)?.[1] || voice.sampleRate || 24000);
      return { pcm: stripWavHeader(Buffer.from(audio.data, 'base64')), rate };
    }
  }
  throw new Error(lastError || 'Gemini TTS failed');
}

/**
 * piper — local neural TTS (https://github.com/rhasspy/piper). No key, no
 * network. The binary and the voice model are resolved from the environment so
 * nothing machine-specific is committed, mirroring PLAYWRIGHT_MODULE in
 * render.mjs.
 */
async function synthPiper(cfg, text, key, voice) {
  const bin = process.env.PIPER_BIN || '/tmp/video-tools/piper/piper';
  const model = cfg.model || process.env.PIPER_MODEL;
  if (!existsSync(bin)) {
    throw new Error(`piper binary not found at ${bin} — set PIPER_BIN (see video/README.md)`);
  }
  if (!model || !existsSync(model)) {
    throw new Error(
      `piper voice model not found: ${model || '(PIPER_MODEL unset)'} — set PIPER_MODEL (see video/README.md)`,
    );
  }

  // `-f -` streams the finished WAV to stdout, so no temp file is needed.
  const wavOut = await new Promise((resolve, reject) => {
    const c = spawn(
      bin,
      [
        '-m', model,
        '-f', '-',
        '--length_scale', String(cfg.lengthScale ?? 1),
        '--sentence_silence', String(cfg.sentenceSilence ?? 0.2),
        '-q',
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const chunks = [];
    c.stdout.on('data', (d) => chunks.push(d));
    c.on('error', reject);
    c.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`piper exited ${code}`)),
    );
    c.stdin.on('error', () => {});
    c.stdin.end(text);
  });

  // piper voices are 22.05 kHz; the track is 24 kHz, so resample through ffmpeg
  // exactly like the cloud providers that hand back mp3 rather than raw PCM.
  return { pcm: await decodeToPcm(wavOut, 24000), rate: 24000 };
}

const PROVIDERS = {
  elevenlabs: { names: ['ELEVENLABS_API_KEY', 'ELEVEN_LABS_API_KEY'], synth: synthElevenLabs },
  openai: { names: ['OPENAI_API_KEY'], synth: synthOpenAI },
  cartesia: { names: ['CARTESIA_API_KEY'], synth: synthCartesia },
  gemini: {
    names: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_AI_API_KEY'],
    synth: synthGemini,
  },
  'google-gemini': {
    names: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_AI_API_KEY'],
    synth: synthGemini,
  },
  // `local: true` marks a provider with no credential to discover — main()
  // skips the key lookup for it.
  piper: { names: [], synth: synthPiper, local: true },
};

/** Words-per-minute estimate used only for the dry run. */
function estimateSeconds(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (words / 165) * 60 + 1.2;
}

async function main() {
  const narration = JSON.parse(await readFile(NARRATION, 'utf8'));
  const voice = narration.voice || {};
  const scenes = narration.scenes;
  const total = scenes.reduce((a, s) => a + s.duration, 0);

  const requested = argOf('provider', process.env.TTS_PROVIDER || voice.provider || 'elevenlabs');
  log(`  narration: ${scenes.length} scenes, ${total}s timeline`);

  if (DRY_RUN || CHECK) {
    const rate = voice.sampleRate || 24000;
    const problems = [];
    log('  scene          budget   cue windows (spoken estimate vs window)');
    for (const scene of scenes) {
      const cues = [...(scene.cues || [])].sort((a, b) => a.at - b.at);
      const windows = cues.map((cue, i) => {
        const next = cues[i + 1]?.at ?? scene.duration;
        const window = next - cue.at;
        const estimate = estimateSeconds(stripTags(cue.text));
        if (estimate > window) {
          problems.push({ scene: scene.id, cue: cue.text.slice(0, 44), estimate, window });
        }
        return `${estimate.toFixed(1)}s/${window.toFixed(1)}s`;
      });
      const lastCue = cues[cues.length - 1];
      const spokenEnd = lastCue ? lastCue.at + estimateSeconds(stripTags(lastCue.text)) : 0;
      if (spokenEnd > scene.duration) {
        problems.push({ scene: scene.id, cue: '(final cue)', estimate: spokenEnd, window: scene.duration });
      }
      const words = sceneScript(scene).split(/\s+/).filter(Boolean).length;
      log(
        `  ${problems.some((p) => p.scene === scene.id) ? '✗' : '✓'} ${scene.id.padEnd(13)} ` +
          `${String(scene.duration).padStart(3)}s   ${words} words · ${windows.join('  ')}`,
      );
    }
    if (problems.length === 0) log('\n  All cues fit their windows.');
    else {
      log(`\n  ${problems.length} cue(s) overrun:`);
      for (const p of problems) {
        log(
          `    ${p.scene}: needs ~${p.estimate.toFixed(1)}s but has ${p.window.toFixed(1)}s ` +
            `— “${p.cue}…”`,
        );
      }
      log('  Shorten the text or lengthen the scene in video/narration.json, then re-render.');
      if (CHECK) process.exit(1);
    }
    log(`\n  (estimate at 165 wpm — real audio is measured after synthesis)`);
    log(`  track: ${(total / 60).toFixed(1)} min at ${rate} Hz mono`);
    return;
  }

  const provider = PROVIDERS[requested] ? requested : 'gemini';
  if (provider !== requested) {
    log(`  unknown provider "${requested}" — falling back to gemini`);
  }
  const impl = PROVIDERS[provider];
  const found = impl.local
    ? { key: null, source: 'local binary (no API key)' }
    : await findKey(impl.names);
  if (!found) {
    log(
      `\n  No ${provider} API key found (looked for ${impl.names.join(', ')}).\n` +
        '  Add one to the repo .env or export it, then re-run, e.g.\n' +
        `    ${impl.names[0]}=... node video/make-voiceover.mjs\n` +
        '  Render only the captions with --dry-run (no key needed).\n' +
        `  Other providers: --provider ${Object.keys(PROVIDERS).filter((p) => p !== 'google-gemini').join('|')}\n`,
    );
    process.exit(2);
  }
  log(`  provider: ${provider} (using ${found.source})`);
  const cfg = providerConfig(voice, provider);

  const rate = voice.sampleRate || 24000;
  const totalSamples = Math.ceil(total * rate);
  const track = Buffer.alloc(totalSamples * 2);
  const clips = [];

  let cursor = 0;
  const overruns = [];
  for (const scene of scenes) {
    const cues = [...(scene.cues || [])].sort((a, b) => a.at - b.at);
    log(`  synthesizing ${scene.id} (${cues.length} cue${cues.length === 1 ? '' : 's'})`);
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      // The cue's window runs to the next cue, or to the end of the scene.
      const window = (cues[i + 1]?.at ?? scene.duration) - cue.at;
      const { pcm, rate: gotRate } = await impl.synth(cfg, stripTags(cue.text), found.key, voice);
      if (gotRate !== rate) log(`    note: model returned ${gotRate} Hz (expected ${rate} Hz)`);
      const duration = pcm.length / 2 / gotRate;
      const start = cursor + cue.at;
      const startSample = Math.round(start * rate);
      const maxSamples = totalSamples - startSample;
      const copySamples = Math.min(pcm.length / 2, maxSamples);
      pcm.copy(track, startSample * 2, 0, copySamples * 2);
      clips.push({ scene: scene.id, cue: i + 1, at: cue.at, start, duration, window });
      const fits = duration <= window + 1e-9;
      if (!fits) overruns.push({ scene: scene.id, cue: i + 1, duration, window });
      log(
        `    cue ${i + 1}/${cues.length}  ${duration.toFixed(1)}s / ${window.toFixed(1)}s — ${
          fits ? 'fits' : `OVER by ${(duration - window).toFixed(1)}s`
        }`,
      );
    }
    cursor += scene.duration;
  }

  if (overruns.length) {
    log(`\n  WARNING: ${overruns.length} cue(s) overran their window and overlap the next cue:`);
    for (const o of overruns) {
      log(`    ${o.scene} cue ${o.cue}: ${o.duration.toFixed(1)}s / ${o.window.toFixed(1)}s`);
    }
    log('  Shorten the line or move the cue times in video/narration.json, then re-run.');
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  const tmpWav = path.join(os.tmpdir(), `x402-voice-${Date.now()}.wav`);
  await writeFile(tmpWav, wav(track, rate));
  await writeFile(
    path.join(ROOT, 'video', 'assets', 'live', 'voiceover-manifest.json'),
    JSON.stringify({ provider, voice: cfg, total, clips, generatedAt: new Date().toISOString() }, null, 2),
  );

  if (!existsSync(VIDEO)) {
    log(`\n  voice track written, but ${path.relative(ROOT, VIDEO)} does not exist yet.`);
    log(`  render it first: node video/render.mjs`);
    return;
  }

  // Voicing the featured cut in place (`--out` == `--video`) is a supported
  // workflow, and ffmpeg refuses to read and write the same path. Mux beside
  // the target and swap the finished file in only once ffmpeg has succeeded, so
  // a failed run leaves the original video intact rather than truncated.
  const inPlace = VIDEO === OUT;
  const muxTarget = inPlace ? `${OUT}.voicing-${process.pid}.mp4` : OUT;

  await rm(muxTarget, { force: true });
  try {
    await new Promise((resolve, reject) => {
      const c = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', VIDEO,
          '-i', tmpWav,
          // Map explicitly. Re-voicing an already-voiced file is normal — that is
          // exactly what `--out` == `--video` does — and without this, ffmpeg's
          // default stream selection keeps the audio already inside the input
          // video and silently drops the track we just synthesized.
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          '-movflags', '+faststart',
          muxTarget,
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mux exited ${code}`))));
    });
  } catch (err) {
    await rm(muxTarget, { force: true });
    throw err;
  }
  if (inPlace) await rename(muxTarget, OUT);
  await rm(tmpWav, { force: true });
  log(`\n  voiced video → ${path.relative(ROOT, OUT)}${inPlace ? ' (voiced in place)' : ''}`);
}

main().catch((err) => {
  console.error(`\n  ERROR: ${err.message}\n`);
  process.exit(1);
});

/**
 * Deterministic timeline driver.
 *
 * Mounts every scene once, then exposes `window.__VIDEO.render(tSeconds)`.
 * A capture harness seeks frame by frame, screenshots, and pipes the frames
 * into ffmpeg — so the same timestamp always produces the same pixels.
 */

import { el, style, clamp01, easeOut } from './ui.js';
import { buildScene } from './scenes.js';

const CROSSFADE = 0.55;

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json();
}

async function main() {
  const narration = await loadJson('/video/narration.json');
  const data = await loadJson('/video/assets/live/video-data.json');

  const host = document.getElementById('scenes');
  const captionHost = document.getElementById('captions');
  const caption = el('div', { class: 'caption' });
  captionHost.append(caption);

  const scenes = [];
  let cursor = 0;

  for (const spec of narration.scenes) {
    const wrapper = el('div', { class: 'scene', style: { opacity: '0' } });
    if (spec.fill) wrapper.dataset.fill = 'flush';
    const built = buildScene(spec.id, { data, spec });
    wrapper.append(built.node);
    host.append(wrapper);

    const cues = [...(spec.cues || [])].sort((a, b) => a.at - b.at);
    scenes.push({
      ...spec,
      wrapper,
      cues,
      start: cursor,
      end: cursor + spec.duration,
      update: built.update,
    });
    cursor += spec.duration;
  }

  const total = cursor;

  let lastCaption = null;
  let captionSince = -10;

  function render(t) {
    for (const scene of scenes) {
      const local = t - scene.start;
      const inP = clamp01(local / CROSSFADE);
      const outP = clamp01((scene.end - t) / CROSSFADE);
      const alpha = Math.min(inP, outP);
      if (alpha <= 0) {
        if (scene.wrapper.style.opacity !== '0') scene.wrapper.style.opacity = '0';
        continue;
      }
      scene.wrapper.style.opacity = String(alpha);
      style(scene.wrapper, {
        transform: `translate3d(0, ${(1 - easeOut(inP)) * 26 - (1 - easeOut(outP)) * 18}px, 0)`,
        zIndex: String(10 + Math.round(alpha * 10)),
      });
      scene.update(Math.max(0, local));
    }

    // ── captions ──────────────────────────────────────────────────────
    const active =
      [...scenes].reverse().find((s) => t >= s.start && t < s.end) ?? scenes[scenes.length - 1];
    const local = t - active.start;
    let cue = null;
    for (const c of active.cues) if (local >= c.at) cue = c;

    const text = cue ? cue.text : '';
    if (text !== lastCaption) {
      lastCaption = text;
      captionSince = t;
      caption.innerHTML = text;
    }
    style(caption, {
      opacity: String(easeOut(clamp01((t - captionSince) / 0.3)) * (text ? 1 : 0)),
    });
  }

  render(0);

  window.__VIDEO = {
    duration: total,
    render,
    scenes: scenes.map((s) => ({ id: s.id, start: s.start, end: s.end, title: s.title })),
  };

  await document.fonts.ready;
  // Give the browser one layout pass with real fonts before capturing starts.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__READY = true;
}

main().catch((err) => {
  window.__ERROR = String(err?.stack || err);
  console.error(err);
});

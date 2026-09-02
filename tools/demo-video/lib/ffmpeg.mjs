import { existsSync } from 'node:fs';

import { paths } from '../config.mjs';
import { run } from './run.mjs';

/**
 * Which ffmpeg to use.
 *
 * **Playwright's bundled ffmpeg cannot produce the deliverable.** It is configured
 * `--disable-everything` with VP8 and the WebM muxer switched back on — no mp4 muxer, no
 * H.264 encoder, no `fps`/`concat`, so it can write the scene `.webm` files (which is what
 * Playwright itself uses it for) and nothing else. So: `DEMO_FFMPEG`, then a full ffmpeg on
 * PATH, and the bundled one only to fail with a sentence that says why.
 */
export function resolveFfmpeg() {
  if (process.env.DEMO_FFMPEG) return process.env.DEMO_FFMPEG;
  return 'ffmpeg';
}

export async function ffmpegCapabilities(binary) {
  try {
    const { out } = await run(binary, ['-hide_banner', '-encoders'], { quiet: true });
    const muxers = await run(binary, ['-hide_banner', '-muxers'], { quiet: true });
    return { h264: out.includes('libx264'), mp4: /\smp4\s/.test(muxers.out) };
  } catch {
    return { h264: false, mp4: false };
  }
}

export async function requireFullFfmpeg() {
  const binary = resolveFfmpeg();
  const caps = await ffmpegCapabilities(binary);
  if (caps.h264 && caps.mp4) return binary;

  const bundled = existsSync(paths.bundledFfmpeg) ? `\n  (Playwright's bundled ffmpeg at ${paths.bundledFfmpeg} is a stripped VP8/WebM-only build and cannot mux mp4.)` : '';
  throw new Error(
    `No usable ffmpeg. "${binary}" is missing, or has no libx264 / mp4 muxer.\n` +
      `Install a full build (winget install Gyan.FFmpeg) or set DEMO_FFMPEG to one.${bundled}`,
  );
}

export function ffmpeg(binary, args) {
  return run(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    quiet: true,
    label: 'ffmpeg',
  });
}

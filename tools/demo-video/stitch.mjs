/**
 * Scenes -> one H.264 mp4.
 *
 * The three device classes have three aspect ratios, so they cannot simply be concatenated.
 * Every scene is normalised first: scaled to fit a 1920x1080 frame, centred on a dark matte,
 * forced to a constant 30 fps and yuv420p, encoded with libx264. Once every part carries
 * identical stream parameters the concat demuxer can join them without re-encoding.
 *
 * **Playwright's bundled ffmpeg cannot do this** (see lib/ffmpeg.mjs): it is built
 * `--disable-everything` plus VP8 and WebM, which is all Playwright itself needs. A full ffmpeg
 * is required, from PATH or from `DEMO_FFMPEG`.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from './config.mjs';
import { ffmpeg, requireFullFfmpeg } from './lib/ffmpeg.mjs';

const binary = await requireFullFfmpeg();

const scenes = (await readdir(config.scenesDir))
  .filter((name) => name.endsWith('.webm'))
  .sort();

if (scenes.length === 0) {
  throw new Error(`No scenes in ${config.scenesDir}. Run \`npm run record\` first.`);
}

const partsDir = resolve(config.scenesDir, 'parts');
await rm(partsDir, { recursive: true, force: true });
await mkdir(partsDir, { recursive: true });

const { width, height, fps, matte } = config.video;
const parts = [];

for (const scene of scenes) {
  const source = resolve(config.scenesDir, scene);
  const part = resolve(partsDir, scene.replace(/\.webm$/, '.mp4'));
  process.stdout.write(`· ${scene} -> ${width}x${height} … `);

  await ffmpeg(binary, [
    '-i', source,
    '-vf',
    [
      `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${matte}`,
      `fps=${fps}`,
      'format=yuv420p',
    ].join(','),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '21',
    '-profile:v', 'high',
    '-level', '4.1',
    '-movflags', '+faststart',
    part,
  ]);

  parts.push(part);
  process.stdout.write('ok\n');
}

/** The concat demuxer wants a list file with escaped single quotes. */
const listPath = resolve(partsDir, 'concat.txt');
await writeFile(
  listPath,
  `${parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')}\n`,
  'utf8',
);

process.stdout.write(`· joining ${parts.length} scenes … `);
await ffmpeg(binary, [
  '-f', 'concat',
  '-safe', '0',
  '-i', listPath,
  '-c', 'copy',
  '-movflags', '+faststart',
  config.finalVideo,
]);
process.stdout.write('ok\n');

const info = await stat(config.finalVideo);
console.log(`\n${config.finalVideo}`);
console.log(`  ${(info.size / 1024 / 1024).toFixed(1)} MB · ${width}x${height} · ${fps} fps · H.264`);

/**
 * Everything the recorder needs to know about this machine and this demo.
 *
 * Two of these values are credentials to accounts this tool creates in the LOCAL dev database.
 * They are throwaways for a laptop demo and they never leave it — but they are still passwords,
 * so they live here and are deliberately not repeated in README.md.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(toolDir, '..', '..');
export const outDir = resolve(toolDir, 'out');

export const config = {
  /** The founder's API. We never bind it and never restart it — we proxy to it. */
  apiOrigin: 'http://localhost:5080',

  /**
   * Our own static server. Deliberately not 4200 (his `ng serve`) and not 5080 (his API):
   * the whole point is that nothing this tool does touches a process he is using.
   */
  port: 4310,

  /** Where the built PWA lands. `@angular/build:application` writes into `<path>/browser`. */
  distDir: resolve(outDir, 'dist'),

  scenesDir: resolve(outDir, 'scenes'),
  assetsDir: resolve(outDir, 'assets'),
  statePath: resolve(outDir, 'state.json'),
  finalVideo: resolve(outDir, 'teren-demo.mp4'),

  /** Serbian site audio that already lives in the repo (the STT spike sample). */
  sourceAudio: resolve(repoRoot, 'tools', 'SttSpike', 'Audio', 'sample.m4a'),

  /** The seeded foreman and the standing demo code. Both are contracts — see CLAUDE.md. */
  worker: {
    username: 'zoran.jovanovic',
    code: 'DEM0-TEST',
    displayName: 'Zoran Jovanović',
  },

  /** The seeded owner of Vodoinstal Petrović d.o.o. `invite-admin` mints him a link. */
  companyAdmin: {
    email: 'petar.petrovic@vodoinstal-petrovic.example.com',
    displayName: 'Petar Petrović',
    password: 'gradiliste-vojvode-2026',
  },

  /**
   * A DEMO member of Teren staff, created by this tool. Never the founder's own super admin —
   * that account is his and this tool does not touch it.
   */
  superAdmin: {
    email: 'milica.nikolic@teren.example.com',
    displayName: 'Milica Nikolić',
    password: 'teren-platforma-2026',
  },

  /** Vojvode Stepe 212, Voždovac — the seeded site the recording scene belongs to. */
  geolocation: { latitude: 44.7692, longitude: 20.4787, accuracy: 12 },

  /** Deliberate demo pacing, in milliseconds. Raise `beat` to slow the whole film down. */
  pace: {
    slowMo: 180,
    beat: 700,
    dwell: 2000,
    longDwell: 3200,
    title: 2400,
    typeDelay: 90,
    /** How long the fake microphone runs on camera. The sample audio is 18 s. */
    recordSeconds: 19,
  },

  /** Final film geometry. */
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    /** Letterbox colour behind portrait scenes. */
    matte: '0x141311',
  },
};

export const paths = {
  /** Playwright's own ffmpeg is a stripped build: no mp4 muxer, no H.264. Kept as a last resort. */
  bundledFfmpeg: resolve(
    process.env.LOCALAPPDATA ?? '',
    'ms-playwright',
    'ffmpeg-1011',
    'ffmpeg-win64.exe',
  ),
};

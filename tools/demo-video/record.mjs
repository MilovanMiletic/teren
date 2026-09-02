/**
 * Records the demo, one scene per browser context, against the production PWA build served on
 * our own port with `/api` proxied to the founder's API.
 *
 * Three device classes, as the founder asked for:
 *   phone   390 x 844   the foreman - joining, recording, and what came back
 *   tablet  834 x 1194  the foreman's diary, then the owner's office (ARCHITECTURE §5 "medium")
 *   desktop 1728 x 1080 Teren's own staff
 *
 * The sessions are real. Zoran activates with the seeded code on camera; Petar sets a password
 * from a real single-use link and signs in; Milica signs in with a password `prepare` set. The
 * phone's device session is carried into the tablet with `storageState` rather than by activating
 * a second time - a second activation would revoke the first, which is the product working as
 * designed and would end the film's own credential.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

import { config, repoRoot } from './config.mjs';
import { startServer } from './serve.mjs';
import { cursorScript } from './lib/cursor.mjs';
import { titleCardHtml, sitePhotoHtml } from './lib/titlecard.mjs';
import { dwell, fill, glide, park, read, tap, wait } from './lib/driver.mjs';
import { run } from './lib/run.mjs';

const { beat } = config.pace;

/**
 * ## How each class is sized, and why `scale` is a launch argument
 *
 * A Playwright screencast frame comes out at the **CSS** viewport size: `deviceScaleFactor` on
 * the context does not raise it, and a `recordVideo.size` larger than the viewport is *padded*,
 * not filled — the first cut of this tool recorded the phone as a 390x844 picture in the corner
 * of a 780x1688 grey frame. `--force-device-scale-factor` does raise it, and it is a browser
 * argument, so one browser is launched per scale.
 *
 * Every scene is then letterboxed into 1920x1080 by `stitch.mjs`, and each `video` below is
 * chosen so that step only ever has to scale **down**:
 *
 *   phone    390x844  at 2x -> 780x1688 -> 499x1080   (x0.64)
 *   tablet   834x1194 at 1x -> 834x1194 -> 754x1080   (x0.90)
 *   desktop 1728x1080 at 1x -> 1728x1080 -> 1728x1080 (1:1, no resampling at all)
 *
 * The desktop viewport is 1728x1080 rather than 1440x900 for exactly that last reason. It is the
 * same expanded class either way — content is max-width 1200 and centred above 1024.
 */
const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, scale: 2, video: { width: 780, height: 1688 } },
  tablet: { viewport: { width: 834, height: 1194 }, scale: 1, video: { width: 834, height: 1194 } },
  desktop: {
    viewport: { width: 1728, height: 1080 },
    scale: 1,
    video: { width: 1728, height: 1080 },
  },
};

const state = JSON.parse(await readFile(config.statePath, 'utf8'));
const rawDir = resolve(config.scenesDir, 'raw');
await mkdir(rawDir, { recursive: true });

const demoAssetsDir = resolve(config.distDir, 'browser', '_demo');
await mkdir(demoAssetsDir, { recursive: true });

/** The title cards, written into the served build so they come from the recording origin. */
const CARDS = {
  '01-join': {
    eyebrow: 'Telefon &middot; poslovo&#273;a',
    title: 'Telefon se pridru&#382;uje jednom',
    body:
      'Poslovo&#273;a unese svoje korisni&#269;ko ime i kod koji je dobio od vlasnika firme. ' +
      'Posle ovoga se vi&#353;e nikada ne prijavljuje.',
  },
  '02-record': {
    eyebrow: 'Telefon &middot; gradili&#353;te',
    title: 'Trideset sekundi govora',
    body: 'Jedno dugme, jedna fotografija, &bdquo;Gotovo&ldquo;. Ni&#353;ta se ne kuca na gradili&#353;tu.',
  },
  '03-understood': {
    eyebrow: 'Telefon &middot; provera',
    title: 'Njegove re&#269;i i ono &#353;to je sistem razumeo',
    body:
      'Radovi, ljudstvo i materijal izdvojeni iz snimka. &#268;ovek proverava i potvr&#273;uje &mdash; ' +
      'ni&#353;ta ne ide klijentu bez njega.',
  },
  '04-diary': {
    eyebrow: 'Tablet &middot; poslovo&#273;a',
    title: 'Dnevnik po gradili&#353;tu i po danu',
    body:
      'Isti unosi na ve&#263;em ekranu. Za svaki dan ostaje transkript, fotografije i izve&#353;taj ' +
      'koji je klijent dobio.',
  },
  '05-office': {
    eyebrow: 'Tablet &middot; vlasnik firme',
    title: 'Kancelarija vlasnika',
    body:
      'Petar Petrovi&#263; vodi Vodoinstal Petrovi&#263; d.o.o.: svoje poslovo&#273;e, njihove kodove ' +
      'i njihove telefone.',
  },
  '06-platform': {
    eyebrow: 'Ra&#269;unar &middot; Teren tim',
    title: 'Teren vidi naloge, nikada dnevnik',
    body: 'Firme, nalozi i log servera. Nikada transkript, fotografija ni izve&#353;taj jedne firme.',
  },
  '07-close': {
    eyebrow: 'Teren',
    title: '&bdquo;Snimi&#353; trideset sekundi. Klijent dobije izve&#353;taj. Ti ima&#353; dokaz.&ldquo;',
    body: 'Gra&#273;evinski dnevnik koji se sam pi&#353;e.',
  },
};

for (const [slug, cardText] of Object.entries(CARDS)) {
  await writeFile(resolve(demoAssetsDir, `${slug}.html`), titleCardHtml(cardText), 'utf8');
}
await writeFile(resolve(demoAssetsDir, 'site-photo.html'), sitePhotoHtml, 'utf8');

const { origin, close: closeServer } = await startServer();
console.log(`serving ${origin} (api -> ${config.apiOrigin})\n`);

const LAUNCH_ARGS = [
  // The microphone. A real Serbian site recording from `tools/SttSpike/Audio`, so the pipeline
  // running behind the scene is the real one: Azure STT (sr-RS) then Claude extraction.
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${state.fakeAudio}`,
  '--autoplay-policy=no-user-gesture-required',
  // A scrollbar in a screencast reads as a rendering fault.
  '--hide-scrollbars',
];

/** One browser per screencast scale — see DEVICES. */
const browsers = new Map();
async function browserFor(scale) {
  if (!browsers.has(scale)) {
    browsers.set(
      scale,
      await chromium.launch({
        slowMo: config.pace.slowMo,
        args: [...LAUNCH_ARGS, `--force-device-scale-factor=${scale}`],
      }),
    );
  }
  return browsers.get(scale);
}

/**
 * A scene that throws must not leave a Chromium and a listening socket behind: the next attempt
 * would fail on the port and the founder would be left with an orphaned browser.
 */
const shutdown = async () => {
  for (const browser of browsers.values()) {
    await browser.close().catch(() => {});
  }
  await closeServer().catch(() => {});
};
process.on('unhandledRejection', async (error) => {
  console.error(error);
  await shutdown();
  process.exit(1);
});
process.on('uncaughtException', async (error) => {
  console.error(error);
  await shutdown();
  process.exit(1);
});

/** Where the finished photo lands once the first scene has drawn it. */
const sitePhoto = resolve(config.assetsDir, 'site-photo.jpg');
const timeline = [];

async function record({ id, device, storageState, work }) {
  const profile = DEVICES[device];
  const browser = await browserFor(profile.scale);
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.scale,
    locale: 'sr-Latn-RS',
    timezoneId: 'Europe/Belgrade',
    colorScheme: 'light',
    // The production build registers a service worker. A cached shell is exactly the wrong
    // thing in a recording, and it is not what any scene is about.
    serviceWorkers: 'block',
    permissions: ['microphone', 'camera', 'geolocation'],
    geolocation: config.geolocation,
    recordVideo: { dir: rawDir, size: profile.video },
    storageState,
  });
  await context.addInitScript(cursorScript);

  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const started = Date.now();

  let carried;
  try {
    carried = await work(page, context);
  } finally {
    const video = page.video();
    await context.close();
    const seconds = (Date.now() - started) / 1000;
    if (video) {
      const target = resolve(config.scenesDir, `${id}.webm`);
      await rm(target, { force: true });
      await rename(await video.path(), target);
      timeline.push({ id, device, seconds, file: target });
      console.log(`  -> ${id}.webm  ${seconds.toFixed(1)} s`);
    }
  }
  return carried;
}

/** Shows a title card inside the scene's own video, then hands the screen to the app. */
async function card(page, slug) {
  await page.goto(`${origin}/_demo/${slug}.html`, { waitUntil: 'load' });
  await wait(page, config.pace.title);
}

/** An optional beat. One missing control must not cost a four-minute run. */
async function optional(label, work) {
  try {
    await work();
  } catch (error) {
    console.log(`    (skipped: ${label} - ${String(error).split('\n')[0]})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Scene 1 - the phone joins.
// ---------------------------------------------------------------------------------------------
console.log('scene 01 - phone - joining');
const phoneAfterJoin = await record({
  id: 'scene-01-phone-join',
  device: 'phone',
  work: async (page, context) => {
    // Drawn once, here, because `<input type=file capture>` never sees the fake camera: the
    // photo the foreman "takes" has to be a real file on disk.
    const shot = await context.newPage();
    await shot.setViewportSize({ width: 1600, height: 1200 });
    await shot.goto(`${origin}/_demo/site-photo.html`, { waitUntil: 'load' });
    await shot.screenshot({ path: sitePhoto, type: 'jpeg', quality: 80 });
    await shot.close();

    await card(page, '01-join');

    // A fresh phone holds no session, so `/` is refused by `requiresDevice` and Welcome answers.
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const join = page.getByRole('button', { name: 'Pridruži se gradilištu kodom' });
    await join.waitFor({ timeout: 30_000 });
    await read(page);

    await tap(page, join);

    await fill(page, page.locator('#activate-username'), config.worker.username);
    // Whatever the owner's own screen would read for him — `DEM0-TEST` on a healthy database,
    // a freshly issued code otherwise. `prepare` resolves it; the film never invents one.
    await fill(page, page.locator('#activate-code'), state.activationCode);
    await dwell(page, beat);
    await tap(page, page.getByRole('button', { name: 'Pridruži se', exact: true }));

    await page.locator('.record__button').waitFor({ timeout: 30_000 });
    await park(page);
    await read(page);

    return context.storageState({ indexedDB: true });
  },
});

// ---------------------------------------------------------------------------------------------
// Scene 2 - the day, recorded.
// ---------------------------------------------------------------------------------------------
console.log('scene 02 - phone - recording the day');
const phoneAfterCapture = await record({
  id: 'scene-02-phone-record',
  device: 'phone',
  storageState: phoneAfterJoin,
  work: async (page, context) => {
    await card(page, '02-record');
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.record__button').waitFor({ timeout: 30_000 });
    await dwell(page);

    // Which site. He works the same one for weeks, so this is shown once and never again.
    await tap(page, page.locator('button.picker'));
    await dwell(page, beat);
    await tap(page, page.locator('.sheet__option', { hasText: 'Vojvode Stepe 212' }).first());
    await park(page);
    await dwell(page);

    await tap(page, page.locator('.record__button'));
    await page.locator('.rec-badge').waitFor({ timeout: 20_000 });
    await park(page, { x: 195, y: 60 });
    // The whole on-site burden, in real time: the timer runs and the waveform moves.
    await wait(page, config.pace.recordSeconds * 1000);

    await tap(page, page.locator('button.stop'));

    // One photo. The label opens a file chooser, so the tap is real and the file is the one
    // drawn in scene 1.
    await page.locator('.photos__add').waitFor({ timeout: 25_000 });
    await dwell(page, beat);
    const chooser = page.waitForEvent('filechooser');
    await tap(page, page.locator('.photos__add'), { after: 200 });
    await (await chooser).setFiles(sitePhoto);
    await page.locator('.photos__thumb').first().waitFor({ timeout: 25_000 });
    await park(page);
    await read(page);

    await tap(page, page.locator('[data-log="capture.send"]'));

    // Home, with the entry rising into the list and its chip catching up with the server.
    await page.locator('.record__button').waitFor({ timeout: 25_000 });
    await park(page);
    await wait(page, 7000);
    await glide(page, 320);
    await wait(page, 2500);

    return context.storageState({ indexedDB: true });
  },
});

// ---------------------------------------------------------------------------------------------
// Scene 3 - his words, and what the system understood.
// ---------------------------------------------------------------------------------------------
console.log('scene 03 - phone - his words vs the structure');
await record({
  id: 'scene-03-phone-understood',
  device: 'phone',
  storageState: phoneAfterCapture,
  work: async (page) => {
    await card(page, '03-understood');
    await page.goto(`${origin}/diary`, { waitUntil: 'domcontentloaded' });
    await page.locator('.row-button.row').first().waitFor({ timeout: 30_000 });
    await dwell(page);

    // The seeded day that is waiting for a person: structure on one side, his own words on the
    // other. Chosen by its status chip rather than by position, so a new entry at the top of the
    // list cannot silently become the subject of this scene.
    const awaiting = page
      .locator('.row-button.row', { has: page.locator('.chip', { hasText: 'Čeka proveru' }) })
      .first();
    await tap(page, awaiting);
    await page.locator('.card').first().waitFor({ timeout: 25_000 });
    await park(page);
    await read(page);
    await glide(page, 700);
    await glide(page, 700);
    await wait(page, 1500);

    // The gate itself - read only. Nothing here presses "Potvrdi unos": that would seal a
    // seeded day and mail a report, and this is a film, not an edit of the founder's database.
    await optional('the confirmation gate', async () => {
      await tap(page, page.locator('[data-log="confirm.open"]').first());
      await page.locator('.screen').first().waitFor();
      await park(page);
      await read(page);
      await glide(page, 800);
      await glide(page, 800);
      await wait(page, 1800);
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Scene 4 - the same diary on a tablet.
// ---------------------------------------------------------------------------------------------
console.log('scene 04 - tablet - the diary');
await record({
  id: 'scene-04-tablet-diary',
  device: 'tablet',
  storageState: phoneAfterCapture,
  work: async (page) => {
    await card(page, '04-diary');
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.record__button').waitFor({ timeout: 30_000 });
    await park(page);
    await read(page);

    await tap(page, page.locator('.recent__all'));
    await page.locator('.row-button.row').first().waitFor({ timeout: 30_000 });
    await dwell(page);

    // The day the client already has. The report card is shown, not downloaded - the seeded row
    // records that a report went out without an object in storage behind it.
    const reported = page
      .locator('.row-button.row', { has: page.locator('.chip', { hasText: 'Poslat' }) })
      .first();
    await tap(page, reported);
    await park(page);
    await read(page);
    await glide(page, 800);
    await glide(page, 800);
    await wait(page, 2000);
  },
});

// ---------------------------------------------------------------------------------------------
// Scene 5 - the owner's office.
// ---------------------------------------------------------------------------------------------
console.log('scene 05 - tablet - the office');
await record({
  id: 'scene-05-tablet-office',
  device: 'tablet',
  work: async (page) => {
    await card(page, '05-office');

    // The real invite chain: a single-use link minted by `invite-admin`, opened here.
    await page.goto(`${origin}/set-password?token=${state.passwordToken}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('#set-password').waitFor({ timeout: 30_000 });
    await read(page);
    await fill(page, page.locator('#set-password'), config.companyAdmin.password);
    await tap(page, page.getByRole('button', { name: 'Sačuvaj i nastavi' }));

    await page.getByRole('button', { name: 'Prijavi se' }).first().waitFor({ timeout: 25_000 });
    await dwell(page);
    await tap(page, page.getByRole('button', { name: 'Prijavi se' }).first());

    await page.locator('#login-email').waitFor({ timeout: 25_000 });
    await fill(page, page.locator('#login-email'), config.companyAdmin.email);
    await fill(page, page.locator('#login-password'), config.companyAdmin.password);
    await tap(page, page.getByRole('button', { name: 'Prijavi se', exact: true }));

    await page.locator('.head__title').waitFor({ timeout: 30_000 });
    await park(page);
    await read(page);

    // How the codes work - a popover, because on a phone hover-only help is unreachable.
    await optional('the codes popover', async () => {
      await tap(page, page.getByRole('button', { name: 'Kako kodovi rade' }));
      await read(page);
      await page.keyboard.press('Escape');
      await wait(page, beat);
    });

    /**
     * A foreman, added the way his owner adds him. `add()` navigates to the new man's own screen
     * on success, code already issued - one URL, one man, one credential - so the code scene
     * comes for free out of the add.
     *
     * The name input carries no `id` and no `name` attribute, so it is reached through the form
     * it lives in.
     */
    async function addForeman(name, { linger }) {
      await tap(page, page.getByRole('button', { name: 'Dodaj poslovođu' }));
      await page.locator('.add__form').waitFor();
      await dwell(page, beat);
      await fill(page, page.locator('.add__form input.field__input').first(), name);
      await tap(page, page.getByRole('button', { name: 'Dodaj i napravi kod' }));

      // His own screen, with the code he can type. Nothing in the list he came from can show it.
      await page.locator('.code-block').waitFor({ timeout: 25_000 });
      await park(page);
      await read(page);

      if (linger) {
        // The ready-made message: one man, one message, never a group chat.
        await optional('the share message', async () => {
          await tap(page, page.locator('[data-log="company.code.reveal"]').first());
          await park(page);
          await read(page);
        });
        await glide(page, 420);
        await wait(page, 1600);
      }

      await tap(page, page.getByRole('button', { name: 'Vrati se na ljude' }).first());
      await page.locator('.people').waitFor({ timeout: 25_000 });
      await dwell(page, beat);
    }

    // The names the seeded sites already list as his men.
    await optional('adding Nenad', () => addForeman('Nenad', { linger: true }));
    await optional('adding Miloš', () => addForeman('Miloš', { linger: false }));
    await park(page);
    await dwell(page);

    // One control at the head of every column (2026-09-02): sort, then a filter that says
    // loudly how many of how many rows are drawn, then back to all of them.
    await optional('the column menu', async () => {
      await tap(page, page.locator('th.col--person button.more').first());
      await page.locator('.menu').first().waitFor();
      await dwell(page);
      await tap(page, page.locator('.menu__item').first());
      await dwell(page);

      await tap(page, page.locator('th.col--person button.more').first());
      await fill(page, page.locator('.menu__input').first(), 'Nenad', { after: 1200 });
      await page.keyboard.press('Escape');
      await park(page);
      await read(page);
      await tap(page, page.locator('.table-bar__clear').first());
      await dwell(page);
    });

    // His own account - the third profile surface, reached by tapping his own row exactly as a
    // super admin taps his own row in the platform directory.
    await optional("the owner's own account", async () => {
      await tap(page, page.getByRole('button', { name: /Otvori moj nalog/ }).first());
      await page.locator('.head__title').waitFor();
      await park(page);
      await read(page);
      await glide(page, 500);
      await wait(page, 1800);
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Scene 6 - Teren's own surface.
// ---------------------------------------------------------------------------------------------
console.log('scene 06 - desktop - the platform');
await record({
  id: 'scene-06-desktop-platform',
  device: 'desktop',
  work: async (page) => {
    await card(page, '06-platform');

    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-email').waitFor({ timeout: 30_000 });
    await read(page);
    await fill(page, page.locator('#login-email'), config.superAdmin.email);
    await fill(page, page.locator('#login-password'), config.superAdmin.password);
    await tap(page, page.getByRole('button', { name: 'Prijavi se', exact: true }));

    await page.locator('.head__title').waitFor({ timeout: 30_000 });
    await park(page);
    await read(page);

    await optional('what staff can see', async () => {
      await tap(page, page.getByRole('button', { name: 'Šta se ovde vidi' }));
      await park(page, { x: 60, y: 500 });
      await read(page);
      await page.keyboard.press('Escape');
      await wait(page, beat);
    });

    await optional("the directory's column menu", async () => {
      await tap(page, page.locator('th button.more').first());
      await page.locator('.menu').first().waitFor();
      await dwell(page);
      await tap(page, page.locator('.menu__item').first());
      await dwell(page);
      await tap(page, page.locator('th button.more').first());
      await fill(page, page.locator('.menu__input').first(), 'Petar', { after: 1200 });
      await page.keyboard.press('Escape');
      await park(page);
      await read(page);
      await tap(page, page.locator('.table-bar__clear').first());
      await dwell(page);
    });

    // The customers. A screen of its own, because suspending a paying customer is the heaviest
    // action in the product and does not belong beside a row about somebody's phone.
    await optional('the customers', async () => {
      await tap(page, page.getByRole('button', { name: 'Firme' }).first());
      await page.locator('.head__title').waitFor();
      await park(page);
      await read(page);
      await optional('what suspension does', async () => {
        await tap(page, page.getByRole('button', { name: 'Šta radi suspenzija' }));
        await park(page, { x: 60, y: 520 });
        await read(page);
        await page.keyboard.press('Escape');
      });
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('.head__title').waitFor();
      await dwell(page);
    });

    // One account: his link, and the switch that takes him out of service. Neither is pressed.
    await optional('one account', async () => {
      await tap(page, page.getByRole('button', { name: /Otvori .*Petar/ }).first());
      await page.locator('.head__title').waitFor();
      await park(page);
      await read(page);
      await glide(page, 400);
      await wait(page, 1600);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('.head__title').waitFor();
      await dwell(page, beat);
    });

    // The log. Every line the server wrote and every action the app recorded, in one stream.
    await optional('the log', async () => {
      await tap(page, page.getByRole('button', { name: 'Otvori log' }));
      await page.locator('.head__title').first().waitFor({ timeout: 25_000 });
      await park(page);
      await read(page);

      await optional('a level chip', async () => {
        await tap(page, page.getByRole('button', { name: 'Upozorenje' }).first());
        await park(page);
        await read(page);
        await tap(page, page.getByRole('button', { name: 'Upozorenje' }).first());
        await dwell(page, beat);
      });

      await optional('one line, in full', async () => {
        await tap(page, page.getByRole('button', { name: 'Prikaži celu liniju' }).first());
        await park(page, { x: 60, y: 120 });
        await read(page);
        await glide(page, 400);
        await wait(page, 1600);
      });
    });

    await card(page, '07-close');
    await wait(page, 1400);
  },
});

await shutdown();

// The activation code this film spent, minted again, so the founder's own phone can re-join.
// Tolerant on purpose: on a database where `seed` cannot insert the demo worker (see the header
// of prepare.mjs) a hard failure here would throw away six recorded scenes over a re-seed.
console.log('\nre-seeding so DEM0-TEST is live again ...');
try {
  await run(
    'dotnet',
    [
      'run',
      '--project',
      resolve(repoRoot, 'src', 'Teren.Api'),
      '-c',
      'Release',
      '--no-build',
      '--no-launch-profile',
      '--',
      'seed',
    ],
    { cwd: repoRoot, env: { ASPNETCORE_ENVIRONMENT: 'Development' }, quiet: true, label: 'seed' },
  );
  console.log('  seeded.');
} catch (error) {
  const reason = /MessageText: ([^\n]+)/.exec(String(error))?.[1] ?? 'see prepare.mjs';
  console.log(`  ! seed FAILED (${reason}).`);
  console.log("  ! The demo code the film spent was NOT re-minted. Issue the foreman a new one");
  console.log('  ! from /company, or run reset-demo, before demoing from a phone.');
}

const total = timeline.reduce((sum, scene) => sum + scene.seconds, 0);
console.log('\nscenes');
for (const scene of timeline) {
  console.log(`  ${scene.id.padEnd(30)} ${scene.device.padEnd(8)} ${scene.seconds.toFixed(1)} s`);
}
console.log(`  ${'total'.padEnd(30)} ${''.padEnd(8)} ${total.toFixed(1)} s`);
await writeFile(
  resolve(config.scenesDir, 'timeline.json'),
  `${JSON.stringify(
    timeline.map(({ id, device, seconds }) => ({ id, device, seconds })),
    null,
    2,
  )}\n`,
  'utf8',
);
console.log('\nNow: npm run stitch');

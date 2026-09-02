/**
 * Everything that must be true before a camera rolls:
 *
 *  1. the founder's API answers on 5080 (we never start it, stop it, or bind its port);
 *  2. `seed` has run, so the three sites exist and — on a healthy database — `DEM0-TEST` is live;
 *  3. a demo member of Teren staff exists with a known password;
 *  4. the seeded company owner has a password (set here, through the real `/auth/password`) so
 *     that a **live activation code** can be resolved through the product's own route, and a
 *     second, unspent set-password link is left for the camera;
 *  5. the PWA is built in its **production** shape (same-origin `apiBaseUrl`);
 *  6. the Serbian site recording is a WAV Chromium's fake microphone can read.
 *
 * ## Why the activation code is resolved and not assumed
 *
 * `DEM0-TEST` is a contract, and on this machine it is currently broken: a worker named
 * "Zoran Jovanovic" was added by hand through `/company`, so `app_user` holds the username
 * `zoran.jovanovic` under a **different id** from `DemoSeeder.WorkerId`. `DemoSeeder` guards its
 * insert with `ON CONFLICT (id)`, which cannot see a username collision, so `seed` dies on
 * `23505 ux_app_user_username` and the demo code is never minted
 * (`src/Teren.Infrastructure/Seeding/DemoSeeder.cs:498`).
 *
 * So `seed` is run and its failure is reported rather than fatal, and the code the film types is
 * whatever the owner's own screen would read: `GET /api/workers/{id}/activation-code` if one is
 * live, otherwise a fresh `POST`. That is the same call the office scene makes, so the film is
 * never typing a credential the product would not have given him.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { config, outDir, repoRoot } from './config.mjs';
import { ngArgs, run } from './lib/run.mjs';
import { ffmpeg, requireFullFfmpeg } from './lib/ffmpeg.mjs';

const api = resolve(repoRoot, 'src', 'Teren.Api');
const dotnetEnv = { ASPNETCORE_ENVIRONMENT: 'Development' };
const warnings = [];

/** `dotnet run` against the Release output, so the founder's locked Debug build is untouched. */
function dotnetCommand(verb, extra = []) {
  return run(
    'dotnet',
    [
      'run', '--project', api, '-c', 'Release', '--no-build', '--no-launch-profile',
      '--', verb, ...extra,
    ],
    { cwd: repoRoot, env: dotnetEnv, quiet: true, label: `dotnet ${verb}` },
  );
}

async function step(name, work) {
  process.stdout.write(`· ${name} … `);
  const started = Date.now();
  const value = await work();
  process.stdout.write(`ok (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  return value;
}

async function json(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${config.apiOrigin}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* a problem+json body that is not json is still a status we can act on */
  }
  return { ok: response.ok, status: response.status, body: parsed, text };
}

const ffmpegBinary = await step('ffmpeg', () => requireFullFfmpeg());

await step('the API on 5080', async () => {
  const health = await json('/health').catch(() => ({ ok: false }));
  if (health.ok) return;
  throw new Error(
    `Nothing answered ${config.apiOrigin}/health.\n` +
      "Start the founder's stack first: docker compose up -d, then\n" +
      '  dotnet run --project src/Teren.Api -- migrate\n' +
      '  dotnet run --project src/Teren.Api',
  );
});

await mkdir(config.assetsDir, { recursive: true });
await rm(config.scenesDir, { recursive: true, force: true });
await mkdir(config.scenesDir, { recursive: true });

await step('building the API (Release, so his Debug output stays unlocked)', () =>
  run('dotnet', ['build', resolve(api, 'Teren.Api.csproj'), '-c', 'Release', '-v', 'q'], {
    cwd: repoRoot,
    env: dotnetEnv,
    quiet: true,
    label: 'dotnet build',
  }),
);

await step('seed', async () => {
  try {
    const seed = await dotnetCommand('seed');
    const activation = /Demo activation: username (\S+), code (\S+?)\./.exec(seed.out);
    if (activation && activation[2] !== config.worker.code) {
      warnings.push(
        `\`seed\` prints code ${activation[2]}, config.mjs expects ${config.worker.code}.`,
      );
    }
  } catch (error) {
    // Not fatal: the sites and the seeded entries this film shows are already in the database,
    // and the credential the film needs is resolved below through the product's own route.
    const reason = /MessageText: ([^\n]+)/.exec(String(error))?.[1] ?? 'see the output above';
    warnings.push(`\`seed\` FAILED (${reason}). The demo credential was resolved instead.`);
  }
});

await step(`Teren staff account ${config.superAdmin.email}`, () =>
  run(
    'dotnet',
    [
      'run', '--project', api, '-c', 'Release', '--no-build', '--no-launch-profile', '--',
      'create-super-admin',
      '--email', config.superAdmin.email,
      '--name', config.superAdmin.displayName,
      '--reset-password',
    ],
    {
      cwd: repoRoot,
      env: dotnetEnv,
      quiet: true,
      stdin: `${config.superAdmin.password}\n`,
      label: 'create-super-admin',
    },
  ),
);

/** One single-use link, spent here so the owner has a password we can sign in with. */
async function mintPasswordToken() {
  const invite = await dotnetCommand('invite-admin', ['--email', config.companyAdmin.email]);
  const token = /^\s*token:\s*(\S+)\s*$/m.exec(invite.out)?.[1];
  if (!token) {
    throw new Error(`\`invite-admin\` printed no token:\n${invite.out.slice(-1200)}`);
  }
  return token;
}

const activationCode = await step("the foreman's live activation code", async () => {
  const setupToken = await mintPasswordToken();
  const set = await json('/auth/password', {
    method: 'POST',
    body: { token: setupToken, password: config.companyAdmin.password },
  });
  if (!set.ok) throw new Error(`/auth/password answered ${set.status}: ${set.text.slice(0, 300)}`);

  const login = await json('/auth/login', {
    method: 'POST',
    body: { email: config.companyAdmin.email, password: config.companyAdmin.password },
  });
  if (!login.ok) throw new Error(`/auth/login answered ${login.status}: ${login.text.slice(0, 300)}`);
  const bearer = login.body.session_token;

  const workers = await json('/api/workers', { token: bearer });
  if (!workers.ok) throw new Error(`/api/workers answered ${workers.status}`);
  const worker = workers.body.workers.find((row) => row.username === config.worker.username);
  if (!worker) {
    throw new Error(
      `No worker with username ${config.worker.username} in ${config.companyAdmin.displayName}'s ` +
        'company. The demo seed is further gone than a broken code — run ' +
        '`dotnet run --project src/Teren.Api -- reset-demo --yes-delete-demo-data`.',
    );
  }

  // The GET must stay a GET (§7.1): reading the live code does not spend it. Only when there is
  // none does this issue one, which is exactly what the owner's own screen does.
  const live = await json(`/api/workers/${worker.id}/activation-code`, { token: bearer });
  if (live.ok && live.body?.code) return live.body.code;

  const issued = await json(`/api/workers/${worker.id}/activation-code`, {
    method: 'POST',
    token: bearer,
  });
  if (!issued.ok) throw new Error(`issuing a code answered ${issued.status}: ${issued.text.slice(0, 300)}`);
  warnings.push(
    `No live code existed, so a fresh one was issued for ${config.worker.username}. ` +
      'It is single use and the film spends it.',
  );
  return issued.body.code;
});

/** The one the camera opens. Minted last so nothing else can consume it first. */
const passwordToken = await step(`set-password link for ${config.companyAdmin.email}`, () =>
  mintPasswordToken(),
);

/**
 * The PWA sources as `HEAD` has them, in a throwaway directory, with the real `node_modules`
 * linked in.
 *
 * **Why this exists.** The founder's working tree is where his half-finished increment lives, and
 * a half-finished increment does not build: on 2026-09-02 a mid-edit `app.config.ts` imported a
 * file that had not been written yet, and the film would have died on it. `--from-head` films the
 * committed, reviewed state instead — which is the state that is supposed to be demo-ready
 * anyway (PROJECT.md invariant 6). Installing dependencies again would cost half a gigabyte, so
 * the existing `node_modules` is linked rather than copied.
 *
 * ## Two rules here are scars, not preferences
 *
 * **This is `git archive`, never `git worktree`.** The first cut used a worktree, and
 * `git worktree remove --force` deletes the tree recursively — **straight through the junction**,
 * which emptied ten packages out of the founder's real `node_modules` and left his app unable to
 * build. Nothing that recursively deletes may ever be pointed at a directory holding a link to
 * something that matters.
 *
 * **And the junction comes down before anything is deleted.** `rmdir` on a Windows junction
 * removes the reparse point and leaves its target alone; a recursive delete does not. So the link
 * is removed first and its absence is *checked* before the directory goes, because the cost of
 * being wrong is the founder's dependency tree.
 */
async function headSources() {
  const dir = resolve(tmpdir(), 'teren-demo-pwa');
  const link = resolve(dir, 'web', 'teren-pwa', 'node_modules');

  if (existsSync(link)) {
    await rmdir(link);
  }
  if (existsSync(link)) {
    throw new Error(
      `Could not unlink ${link}. Refusing to delete ${dir} while it holds a link into the ` +
        "founder's node_modules.",
    );
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Only the PWA subtree: a few megabytes of sources, and nothing that could be mistaken for a
  // checkout somebody might later run git commands against.
  const archive = resolve(dir, 'head.tar');
  await run('git', ['archive', '--format=tar', '-o', archive, 'HEAD', 'web/teren-pwa'], {
    cwd: repoRoot,
    quiet: true,
    label: 'git archive',
  });
  // Relative, with cwd set: GNU tar reads an absolute Windows path as a remote host ('C:').
  await run('tar', ['-xf', 'head.tar'], { cwd: dir, quiet: true, label: 'tar' });
  await rm(archive, { force: true });

  // 'junction' needs no privilege on Windows, unlike a directory symlink.
  await symlink(
    resolve(repoRoot, 'web', 'teren-pwa', 'node_modules'),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  return resolve(dir, 'web', 'teren-pwa');
}

const fromHead = process.argv.includes('--from-head') || process.env.DEMO_FROM_HEAD === '1';

await step(`building the PWA (production${fromHead ? ', from HEAD' : ''})`, async () => {
  await rm(config.distDir, { recursive: true, force: true });
  const webRoot = fromHead
    ? await headSources()
    : resolve(repoRoot, 'web', 'teren-pwa');
  return run(
    process.execPath,
    ngArgs(webRoot, ['build', '--configuration', 'production', '--output-path', config.distDir]),
    { cwd: webRoot, quiet: true, label: 'ng build' },
  ).catch((error) => {
    if (fromHead) throw error;
    throw new Error(
      `${error.message}\n\n` +
        'The working tree does not build. If that is a half-finished increment rather than a\n' +
        'defect, film the committed state instead:  node prepare.mjs --from-head',
    );
  });
});

const indexHtml = resolve(config.distDir, 'browser', 'index.html');
if (!existsSync(indexHtml)) {
  throw new Error(`The build produced no ${indexHtml}`);
}

/**
 * Chromium's fake microphone reads 16-bit PCM WAV only, and it loops the file — which is why the
 * recording scene may run a second or two past the 18 s sample without going silent.
 */
const fakeAudio = resolve(config.assetsDir, 'site-note.wav');
await step('the Serbian site recording as WAV', () =>
  ffmpeg(ffmpegBinary, [
    '-i', config.sourceAudio,
    '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le',
    fakeAudio,
  ]),
);

await writeFile(
  config.statePath,
  `${JSON.stringify(
    { passwordToken, activationCode, fakeAudio, preparedAt: new Date().toISOString() },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`\nReady. Scene inputs in ${outDir}`);
console.log(`  activation code     ${config.worker.username} / ${activationCode}`);
console.log(`  set-password token  ${passwordToken.slice(0, 8)}… (out/state.json, single use)`);

if (warnings.length > 0) {
  console.log('\nwarnings');
  for (const warning of warnings) console.log(`  ! ${warning}`);
}

console.log('\nNOTE: recording spends that activation code, which revokes whichever phone holds');
console.log("Zoran's session right now — the founder's own browser included. `npm run demo`");
console.log('re-seeds at the end; on a healthy database that mints DEM0-TEST again.\n');

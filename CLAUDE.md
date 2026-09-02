# Teren — instructions for Claude

Teren is a digital site diary for small Serbian contractors: a foreman takes photos and records a
voice note (~30 s), the system turns it into a structured, evidence-grade daily record and a PDF
report emailed to the client. Solo-founder project, AI-driven development: Claude builds, the
founder decides and reviews.

## Documents (read order, higher wins on conflict)

1. `PROJECT.md` — vision, users, business, principles, decisions. Source of truth for *why*.
2. `JOURNAL.md` — day-by-day trace of discussions, decisions, work. **Read the latest entry at
   session start; append/extend today's entry before session end.**
3. `ROADMAP.md` — milestones and the increment sequence. Source of truth for *what next*.
4. `ARCHITECTURE.md` — stack, repo layout, data model, API surface, AI pipeline, ops. Source of
   truth for *how*. Update it when a technical decision changes; do not let code and this file
   drift.
5. `archive/` — superseded working material, kept as raw input only (never authoritative):
   `original-brief.md` (the initial product brief) and `initial-analysis-notes.md` (first-pass
   notes). Both have now been harvested into PROJECT.md / ROADMAP.md / ARCHITECTURE.md — consult
   them only for historical context.

Every decision made in a session must land in the right document (usually `PROJECT.md` §Decided
or `ROADMAP.md`) — undocumented decisions are lost between sessions.

## Stack (fixed — do not propose alternatives)

- **Frontend:** Angular PWA (`@angular/pwa`), Dexie over IndexedDB for local store + upload queue.
- **Backend:** .NET Minimal API + EF Core + PostgreSQL. Hangfire for background jobs. QuestPDF
  for reports. Single deployable (API + Hangfire in one process).
- **Storage:** S3-compatible object storage; media uploads go direct via presigned URLs, never
  through the API.
- **AI:** server-side transcription (provider TBD by real-audio spike); Claude API (Sonnet 5,
  structured outputs) for transcript → structured entry extraction.
- **Hosting:** Hetzner VPS + Postgres + object storage.
- **Dev environment:** docker-compose with Postgres + MinIO.

## Non-negotiable rules

Product invariants (from PROJECT.md §5 — changing one requires an explicit founder decision):

1. Entry must be faster than the paper notebook (~30 s on site).
2. Raw evidence (transcript, photos) is never altered. Entries are immutable once their report
   is sent; corrections are new entries referencing the original (`supersedes_entry_id`).
3. The phone is the source of truth until the server confirms receipt. Client-generated UUID is
   the idempotency key. Nothing is deleted locally before server confirmation.
4. External service calls (STT, LLM, weather, email) never block a request from the phone.
   Accept immediately, process via Hangfire, expose status.
5. The confirmation screen is mandatory before any report is sent. Store the user's corrections
   (transcript, extracted, corrected triples) — they are the eval set and training signal.
6. **Main branch is always demo-ready.** The distributor demos from his phone at any moment:
   seeded demo project with realistic Serbian data, core flow (speak → structured entry → PDF)
   never broken. Do not merge half-finished states of the money path.

Engineering conventions:

- **UI text: English source strings with Serbian translation** (Transloco, `en`/`sr` JSON
  dictionaries). Never hardcode a user-facing string — every one goes through a translation key,
  starting with the first component. **Serbian is the default runtime locale**; the users are
  Serbian tradesmen. Code, comments, commit messages, docs: English.
- Reports and emails go out in the **project's** language (Serbian by default) — the client's
  language, not the foreman's phone setting.
- Never translate content: transcripts and extracted values stay in the language spoken. Only
  the UI chrome is localised.
- **Every screen ships with a deliberate layout for all three device classes** (compact <768,
  medium 768–1023, expanded ≥1024 — see ARCHITECTURE §5). A centred phone column on desktop is
  not a desktop layout; a screen without a designed ≥1024 layout is not done. Design artboards
  come in pairs: 390 phone + 1280 desktop.
- Photos: compress client-side (1600 px long edge, JPEG ~80) — extract GPS/metadata **before**
  compressing. Web capture has no EXIF; read GPS via Geolocation API separately.
- Audio: Opus in OGG, mono, 16 kHz.
- Entry structure lives in a JSONB column, not rigid schema — fields differ per trade.
- Pick AI models for quality, not cost — AI COGS are negligible vs. subscription price
  (~€0.30/site/month against €30–80 revenue). No cost-optimization machinery.
- Prefer boring solutions: polling over SignalR, one process over services, until proven needed.

## Working style

- Cut work into increments the founder can review in one evening; finish increments, don't
  leave the tree in a half-state.
- Founder-hours are scarce (evenings/weekends): reserve them for decisions, reviews, real-device
  testing, recording real site audio, and contractor conversations. Everything else, do
  autonomously.
- When tests fail or something is skipped, say so plainly in the session summary.
- The travel-industry plugins from the user's work environment are disabled for this project
  (`.claude/settings.json`); ignore any that still appear in a session.

## Repo commands

```bash
docker compose up -d                      # Postgres + MinIO
dotnet run --project src/Teren.Api        # API on http://localhost:5080 (/health)
dotnet run --project src/Teren.Api -- reset-demo   # dry run: what a reset would destroy
dotnet run --project src/Teren.Api -- reset-demo --yes-delete-demo-data
                                          # DESTRUCTIVE: wipes everything belonging to the demo
                                          # company (reported entries included) and re-seeds it.
                                          # Refuses unless ASPNETCORE_ENVIRONMENT=Development or
                                          # Demo__ResetEnabled=true. See ARCHITECTURE §6.
npm start --prefix web/teren-pwa          # PWA on http://localhost:4200
dotnet build                              # whole solution
dotnet test                               # backend tests (needs Docker; plain `dotnet test` — the
                                          # --nologo flag is forwarded to the runner and rejected)
npx ng test --watch=false                 # PWA tests (vitest), run from web/teren-pwa
docker compose exec postgres psql -U teren -d teren   # no local psql client
```

`launchSettings.json` overrides `ASPNETCORE_URLS`, so an API started for verification binds to the
default **5080** and collides with the founder's running instance — use
`dotnet run --project src/Teren.Api --no-launch-profile -- --urls http://localhost:5099` (with
`ASPNETCORE_ENVIRONMENT=Development`, which the profile would otherwise have set).

Translation dictionaries live in `web/teren-pwa/public/i18n/{en,sr}.json` (Angular 22 serves
static files from `public/`, not `src/assets/`).

## Agents

Four standing agents in `.claude/agents/`: `teren-backend-dev` (Opus) and `teren-frontend-dev`
(Opus) implement; `teren-backend-reviewer` and `teren-frontend-reviewer` (Fable, read-only)
adversarially review with accept / accept-with-fixes / reject verdicts. Plus `teren-data-model`
and `teren-screen-design` (Fable). **Every implementation increment goes through its reviewer
before being presented as done; gating fixes go back to the implementer and are re-proven.**

## Current state (update as it changes)

- **Phase:** ROADMAP **M0 fully built, not done — and the gap is not code** (2026-09-02). B0–B7 are
  ☑ and the money path is proven end to end against real Postgres, storage and SMTP, **on the
  founder's laptop only**. B3a's deployment machinery is built, reviewed and locally proven, and
  **nothing is deployed because there is no VPS and no domain.** That single purchase gates the two
  unmet clauses of M0's own definition — *on a real phone*, *without touching a terminal* — and with
  them the whole real-device debt, which needs **https** and not merely a hostname.
- **The identity work is nearly finished.** `plans/profile-and-identity.md` is the specification;
  ROADMAP's *Identity and profiles* table is the live tracker. **Start there.** Done and reviewed:
  F1, D1, F2, **D2 (accept)**, **D3 (accept-with-fixes)**, **F4 / F4b (accept-with-fixes, both
  gating items closed)**, **F5, F6, F8, D7/F9 (all accept-with-fixes, 2026-09-01)**, **D8**,
  **D4** (`/api/platform/*`, **REJECT** — see below), **D6** (invite email, 2026-09-01) and
  **F10** (`/company/profile`, 2026-09-02, unreviewed). **F3's rejection is discharged.**
  **What is left: D5** (`app_log` + sink + retention + the redaction test), then the **health page
  and log viewer**, which are the two of F7's five screens that wait on it.
- **D4's rejection is open and it is a founder decision, not a code fix.** The authenticated
  invite/reset hatch lets Teren staff mint a working set-password link for a company admin, take his
  account, and read his diaries — exactly what plan decision 2 says is impossible. It predates D4
  (`invite-admin` since D2); D4 put a button on it. Plan §13.6. **Until it is settled, do not repeat
  the privacy claim to a customer unqualified**: it is true of every typed route and false of one
  deliberate door.
- **The privacy guard has two halves, and the second is the one plan §12 actually asked for.** A
  reflection walk over `PlatformDirectory` catches a signature that *reaches* `Entry`/`Media`/
  `Report`; it cannot catch `entry_count`, which is an `int`. So platform DTO **property names** are
  checked against an evidence vocabulary too. Both were mutation-proven on 2026-09-01 by adding
  `EntryCount` to the company DTO — two tests went red, revert, green.
  *`PlatformAuditListResponse` names its rows `actions`, not `entries`: in this product an "entry"
  is a day of a foreman's work, and the guard caught the collision the moment it was written.*
- **Validators are registered one by one in `Program.cs` — there is no assembly scan.** Adding
  `AddEndpointFilter<ValidationFilter<T>>()` and writing the validator is two thirds of the job;
  miss the third and `GetRequiredService` throws *before the handler*, so **every** POST to that
  route answers 500, including the malformed ones that should answer 400. It cost six red tests on
  2026-09-01 before the cause was obvious. `ValidatorWiringTests` now reads both files and fails on
  the mismatch.
- **The company-admin surface was rebuilt on 2026-09-01 (founder: "this genuinely now is a bad UI").**
  `/company` is a **people directory** — a real `<table>` at ≥768, a tappable row list below it,
  grouped `VLASNIK FIRME` (the signed-in admin, from the session — there is **no** directors
  endpoint, `WorkersOf(companyId)` returns workers only) then `POSLOVOĐE`. Per-worker detail moved to
  a new route, **`/company/worker/:workerId`**, and the rail is gone: "Kako kodovi rade" is an info
  popover and the add-foreman form and the PODACI block are modals, all three reached from a head
  cluster beside the reload button (`ui/info-popover.ts`, `ui/modal-sheet.ts`).
  *Decision 13 is now **structural** rather than stateful: `CompanyPage` never calls
  `readCode`/`issueCode` and holds no code state, so no list can ever carry two men's credentials —
  a source-scanning spec forbids the very words in the list files, and it is load-bearing (planting
  `data-code` turns it red).* The popover opens on hover **and** tap **and** keyboard: hover-only
  help is unreachable on the device this product is built around, and an admin does reach these
  screens on a phone.
- **"Mutation-proven" is a claim that has now been false once, on the screen that hands out
  credentials.** The first cut of the rework claimed four freshness defences were mutation-proven;
  the reviewer re-ran them and **two survived removal with the whole suite green** — the `code`
  computed filter and, worse, the **`issue()` mid-flight guard**. With both gone, confirming a new
  code for one foreman and navigating to another mid-POST paints the first man's code and share
  message under the second man's name. Witnessed now, and **re-verified independently**: removing
  the `issue()` guard turns two specs red, and the file was restored byte-identical (sha256).
  *The read paths were pinned and the destructive path was not — check which half a proof covers.*
- **The F7 layout pass has now been SEEN (2026-09-01) — this note said the opposite for two days.**
  The founder's four notes off a 1920 screenshot of `/company` are all answered — `showCompany` kills
  the dead header button, `ui/session-link.ts` puts the session in the chrome, the crew grid stays
  two-up above 1023, and Home's expanded grid finally claims the window's height. The frontend
  reviewer installed a throwaway Playwright into its own temp dir and **actually drove the app at
  390/767/768/833/834/1023/1024/1280/1920**: no horizontal overflow at any width, the crew grid is
  two-up from 768 through 1920, and Home's record pane fills a 1080 viewport. **There is still no
  browser driver committed to the repo** — the next agent that needs one installs it the same way.
  *`session-link.ts` renders in **two** places on `/company` — the header, and that screen's own
  compact bar — because the header is `display: none` below 768 and an admin can reach `/company` on
  a phone. Delete either one and he is stranded with no way to end a password-backed session.*
- **D7/F9 — the token flip — is DONE (2026-08-31), and it was the point of the whole exercise.**
  `environment.deviceToken` is now `''` in **both** environment files. Until it was, a working
  credential was compiled into the bundle, readable from devtools by anyone, so `usable()` was
  always true, the gate could not bite, and the login screens were decoration. **Do not restore a
  value to make a box "demo out of the box" — activate the box instead.** A spec now pins the
  constant empty, because every other spec would still pass if someone put it back.
- **Worker activation is PROVEN end to end against the live API** (2026-08-31, port 5099 against
  the dev database): `POST /auth/activate` with `zoran.jovanovic` + `DEM0-TEST` returns a real
  `trn_d_…` device token; that token gets 200 from `/api/projects` and the right worker, company
  and device from `/api/me`; **replaying the same code returns 401**, so single-use holds; and the
  new activation auto-revoked the worker's previous device, as designed.
- **The `PasswordToken` blocker is resolved** — `InviteAdminCommand` (`invite-admin`) mints one and
  prints a single-use link, so an admin password can be set without D4/D6. `create-super-admin`
  reads its password from stdin, never argv.
- **`seed` prints what you need to test with:** `username zoran.jovanovic, code DEM0-TEST`. The
  demo `company_admin` deliberately ships with **no password** — there is no seeded credential
  anywhere — so use `invite-admin` to get into `/login`.
- **A route rename is producer-side only — which is why a half-finished one is invisible.**
  `ee37f04` shipped an app that could not be navigated: every consumer was on English paths while
  `app.routes.ts` alone had been hand-restored to Serbian, so only `/` and the three auth routes
  matched and everything else fell through the wildcard to Home. `ng build` was clean and 538 specs
  were green. The specs that should have caught it were structurally blind — `provideRouter([])`
  and hardcoded path strings, both asserting the *future* behaviour. **F4b added the guards that
  are the compiler this coupling does not have** (`src/app/testing/route-table.ts` resolves paths
  from the real `routes` array keyed on component class *by reference* — name-keyed lookup fails
  because the build renames classes). Never rename a path without running them.
- Design system + 10 artboards in
  `design/` (tokens.md is binding). B2 capture flow done incl. review fixes (Dexie v2, per-second
  chunk persistence, orphan rescue) **plus the adaptive-layout rework** (app header ≥768 with
  global language switcher, three device classes, layer/band tokens, `overflow:hidden` on base
  card, 91 specs) — founder-approved on desktop and tablet. B3 server side done incl. review
  fixes (idempotent entries, presigned PUTs, sealed evidence at `/complete`, media caps, storage
  time-budget). Wire format is **snake_case**.
- **B3 is DONE (2026-08-29), both halves reviewed.** Client side: `environments/`, API client, lazy
  SHA-256 on Dexie **v4**, capped jittered backoff (5 s ×2, 10 min ceiling, ±30%),
  terminal-vs-retryable classification, stranded-`in_flight` recovery on start-up, real Serbian
  stuck-state UI. Proven end to end against the live API and MinIO, failure paths included.
- **B4 is DONE (2026-08-29), reviewed, gating race closed.** `received` → Azure STT → Claude
  extraction → `awaiting_confirmation`, else parked in `needs_review` with the evidence intact.
  Hangfire + a minutely sweeper; `[AutomaticRetry(Attempts = 0)]` because the processor owns retry
  policy — and for the same reason **the Anthropic and S3 SDK internal retries are now 0**. The
  reviewer's find worth remembering: a live pass could outlive `StaleProcessingAfter`, the sweeper
  would park it, the foreman would confirm it, and the late worker's *unconditional* write dragged
  a `confirmed` entry back to `awaiting_confirmation` — silently out of the set B6 reports from.
  Terminal writes are now `ExecuteUpdateAsync ... WHERE status = 'processing'`; 0 rows means the
  sweeper took it. `StaleProcessingAfter` is **45 min** against a ~21.5 min worst case, and
  `PipelineOptionsTests` recomputes that budget from the shipped defaults — restore a retry count
  and a test fails instead of a foreman's afternoon.
- **C3 is ☑ as of 2026-08-31 — the photo read path is closed, both halves.** The server half
  (`GET /api/entries/{id}/media/{mediaId}`) had in fact shipped in `52646ba`, marked *WIP* in the
  commit message; **this file went on saying "there is no read path" for a day after it existed**,
  which is exactly how a stale note costs an afternoon — check the tree before believing this
  section. What was genuinely missing was the client, so the screen could only ever *count* the
  pictures it was not showing. `ArchiveService.getMedia` now fetches the bytes with the bearer —
  an `<img src>` sends no `Authorization` header, and a presigned GET was refused as a credential
  to a customer's site photographs that nobody can take back — and local and fetched pictures
  render in one strip, indistinguishable on purpose. Only `verified` media is requested (anything
  else is a guaranteed 409); every failure the blob response flattens into one becomes one sentence
  and a retry. **The owner-on-a-tablet case works.**
- **B5 fixed the Home-vs-archive status disagreement.** `EntryStatusRefresher` re-reads
  `GET /api/entries` — the same list the archive merges — and writes the live status back to the
  Dexie row, so Home no longer says "Primljen" over an entry sitting in `needs_review`. Recorded
  here because the defect note outlived the fix by two days.
- **Failure taxonomy (binding for B4+):** terminal = `rejected` (400/404/422, refusing 409),
  `unauthorized`, `not_configured`, `insecure_context`. **All 5xx including 500 are retryable** —
  the entry stays in the outbox and heals unattended after a server-side repair; a terminal 4xx
  would make the phone abandon an entry the server holds. A 409 is never judged alone: re-read
  `GET /api/entries/{id}` and decide on `received_at`, never on the English detail string.
- **`crypto.subtle` needs a secure context** — so the phone-test tunnel must be **https**, not just
  a stable hostname. See ARCHITECTURE §13.
- **Browser CORS to MinIO: VERIFIED 2026-08-29.** The founder captured an entry in Chrome at
  `localhost:4200`; it reached `received_at`, which is stamped only when `/complete` confirms every
  declared object is in storage at the declared size. So the browser presigned PUT succeeded,
  OPTIONS preflight included. Caveat: proven against **local MinIO defaults** — Hetzner Object
  Storage may need its own CORS rules, so re-check once at B3a rather than assuming.
- **B5 ☑ and B6 ☑ (2026-08-29/30) — the money path is closed.** Speak → transcript → confirm →
  PDF → email → sealed, proven end to end against real Postgres, MinIO and SMTP. Then, after the
  founder used it on a real entry, four rounds of polish: the report lost its record id and
  coordinates and gained a place name, project-local timestamps and a TEREN wordmark; the PDF
  downloads from the app; a `confirmed`-but-unreported entry routes back to the gate; and a
  verbatim day renders as prose.
- **The floor is now "his own words", not "type it yourself".** `needs_review` no longer conflates
  *recording unreadable* with *words fine, structuring failed* — that copy was live and false. When
  there is a transcript and no structure, **one tap ("Pošalji moje reči") confirms the transcript as
  the record**, sending `described_verbatim: true` with the transcript in `notes`; the report then
  renders the day as prose, marked as his words rather than extracted data. `extracted` stays null
  and `corrected` records approval-as-is, so the eval triple can still tell approval from typing.
- **Next, in order: D5** (`app_log` + the sink, allow-list, exception scrubbing, retention, the
  source-scanning redaction test), then **F7's remaining two screens** — the health page and the log
  viewer — which wait on it. **Then B3a for real**: a VPS, a domain, a stable **https** origin. That
  purchase is what unblocks the whole real-device debt and both unmet clauses of M0's definition.
- **Demo seed is now three sites** (`d3a0c1f0-5b8e-4f1a-9c62-` + `000000000002/3/4`), and those ids
  are a **contract** with `web/.../core/projects/project-source.ts`: if they drift, every
  `POST /api/entries` 404s and captured entries can never leave the phone. See ARCHITECTURE §6.
- **The demo activation code is a contract too, for the same reason.** Since F4's `canMatch` gate, a
  fresh install has no session and lands on `/welcome`, so the demo needs a code that exists before
  anyone can issue one — there is no admin screen until F6. `DemoSeeder` mints `zoran.jovanovic` a
  fixed live code, **`DEM0-TEST`** (canonical `DEM0TEST`; typing the letter O also works, Crockford
  folds `O→0`). Effectively non-expiring, and **re-minted by every `seed`** the way the three
  withdrawal stamps are cleared — so a spent demo code heals. It is written down in
  `docs/demo-script.md`: change it in `DemoSeeder` and the written-down code silently stops working.
  **It is a real credential to the demo company published in the repo**, and redeeming it revokes the
  demo phone until the next `seed`. Harmless on a laptop; **needs a decision at B3a**, when that
  company goes behind a public URL.
- **Each role now has its own profile surface, and the third one was the missing one (2026-09-02).**
  `/company/profile` — the owner's own account, reached by tapping his row at the top of `/company`
  exactly as a super admin taps his own row in the platform directory. It could not be built without
  widening `GET /api/me` (`email`, `created_at`, `last_login_at`), because **a company admin appears
  in no list he is allowed to read**: `/api/workers` is `WorkersOf(companyId)` and excludes him by
  construction, and `/api/platform/users` is Teren staff only.
  *The trap on that screen is the bearer.* `ProfileService` already calls `/api/me` through
  `TerenApiClient`, which sends the **device** token — on the founder's browser, which is the demo
  phone and the office console at once, that call succeeds and describes **Zoran**. The account
  screen goes through `CompanyGateway.me()` so it carries the admin bearer, and a spec pins it.
  No sign-out on the screen (`session-link.ts` is already in its chrome and argues for one place)
  and **no change-password control — there is no authenticated route for it**, which is a real gap
  for a locked-out owner and the honest thing the screen says instead.
- **Language switching is chrome, and only chrome (2026-09-02).** `/company/profile` shipped with a
  language block of its own, which made it the **third** copy on one screen — the app header carries
  the switcher from 768 up, and each admin screen's `.bar--compact` carries it below that, where the
  header is `display: none`. No screen puts one in its content. *The same day, that screen was
  rebuilt into `platform/person-page`'s shape (founder: "build this profile screen similar to the
  super admin"): name as the title, a `detail` card of chips and facts, an `actions` card beside it,
  7/5 at ≥1024. Until then the owner's own account looked like a different product from the screen
  Teren staff read about the same man.*
  *The trap in copying that head row: `person-page`'s subtitle names one thing from **one** source,
  and this screen's names a **server-only** address under a `known()` that is true from the stored
  session — so it flashed "no address on file" under his name on every load, and printed that claim
  above the "nothing was confirmed" notice when the server was unreachable. **A caveat that arrives
  after the claim is not a caveat.***
- **Every table in the product is one control now (2026-09-02).** The founder's three screenshots:
  `/platform/companies` drew black bold headings while the two screens either side of it drew muted
  uppercase ones. **The colour was the symptom.** `/company` and `/platform` each had a hand-built
  sortable header — same four helpers, written twice — and the customers screen had no sort at all,
  so there was nothing in its `<th>` but text and the browser's default is what he saw. Now:
  `ui/table-controls.ts` (sort + per-column filters, Serbian folding — **`đ` is folded explicitly**,
  it has no Unicode decomposition) and `ui/column-menu.ts` (label sorts on one tap; the funnel beside
  it opens both directions **named in words** and that column's filter box; below 768 the same
  component travels as a pill), plus `.data-table` / `.table-bar` / `.column-bar` in `styles.css`.
  *The filter matches **the words the cell shows**, which is what lets one box serve a name, a date
  and a row of chips. A live filter is loud on purpose — tinted funnel, and a strip reading
  "Prikazano 1 od 12" with one tap back — because a table quietly showing one of twelve rows is how
  a screen makes an owner believe a foreman was removed from his company.*
  *`/company`'s third column is **Aktivnost**: "Poslednji kontakt" broke over two lines once the head
  cell had to hold a control as well as a word.*
  *Two traps found while doing it: `/platform/companies` had an icon named **Ljudi** on a screen with
  a column headed **Ljudi** (it is "Idi na ljude" now — a spec pressed the wrong one and looked like
  a broken sort), and the menu must be `position: fixed`, because the table sits in a horizontal
  scroller and the phone's pill bar is another one — absolutely positioned, a **two-row** table
  clipped it, and two rows is what the founder's screenshots show.*
  ***A fixed menu must be placed every frame, not once.*** The reviewer's two gating finds were the
  same mistake seen twice: measured at open, the filter box landed **56 px below the fold** on a
  390×660 phone — and `focus()` cannot scroll a fixed element into view, while the scroll that would
  reach it closed the menu — and at every width the first keystroke inserted the "showing 1 of 12"
  strip, moving every column head 61 px down while the menu stayed over the row being searched for.
  `ui/menu-placement.ts` is a pure function (clamped, spans the gutters below 768, **flips above**
  when the room below is short, pinned and scrollable when neither fits) and `column-menu.ts` re-runs
  it once an animation frame while open. *`ng test` cannot see any of this — jsdom lays nothing out;
  the geometry is spec'd through the pure function and the follow loop through a stubbed rect.*
  *Two more from that review worth carrying: the funnel was **white on pale tint** inside a sorted
  pill (1.2:1, in `/company`'s default state), and a 28 px tap target against the token minimum of
  44 — it is drawn small and hit large (`::after { inset: -8px }`).*
- **Suites: 1368 PWA specs** (74 files) and **910 backend tests** (`tests/Teren.Api.Tests`, xunit.v3 + Shouldly
  + Testcontainers over real Postgres, ~66 s; PdfPig in tests only, so report assertions read text
  back out of the rendered PDF). `dotnet test` needs Docker running.
  *The figures here were stale before 2026-08-30 (403/447 recorded against an actual 436/476) —
  both were re-measured off the tree, not carried forward.*
- **Check at session start:** the tree is green — **910 backend tests and 1368 PWA specs, the PWA
  suite re-verified by execution 2026-09-02**, `dotnet build` clean with 0 warnings, `ng build` clean with
  no budget warning.
- **"It doesn't work" has meant "it isn't running" twice in a row (2026-09-01).** First "frontend was
  destroyed, build again" — a stopped `ng serve`. Then "backend also doesn't work" — no `Teren.Api`
  process on 5080. **Neither was a code fault, and in both cases the tree was untouched and green.**
  Nothing is supervised here, so a reboot or a Docker restart leaves four things down; the founder
  reports what his browser shows, not what `git status` says. **Before changing a line, check: is the
  process listening (`ss -ltnp`), are the containers up (`docker compose ps`), does it build, do the
  suites pass.** Regenerating the frontend on that first report would have destroyed 179 reviewed
  files — F5–F8 and the just-fixed `entry-detail` freshness guard among them — to repair a stopped
  process.
  *The local stack is four manual steps (`docker compose up -d`, `migrate`, `dotnet run`,
  `npm start`) and there is no one-command "bring it all up". That is why this keeps happening.*
  *A third variant on 2026-09-01: `ng serve` was **running and serving a stale bundle**. Its watcher
  had stopped, so hours-old code was on 4200 while the tree was green. `touch` any source file to
  wake it; before disbelieving a passing suite, check that what the browser holds is what you wrote.*
- **A route can be registered, guarded correctly, fully tested — and unreachable.** The founder's
  "the super admin pages aren't wired in" (2026-09-01) was not about the pages: `/login` was gated on
  `requiresNoDevice`, so a browser holding a *device* session was bounced off it. **His browser is
  the demo phone.** `/welcome` — where the app's only sign-in link lives — bounces for the same
  reason, and `session-link.ts` renders nothing for a device session by design. Three individually
  correct guards, and no reachable door to the admin or platform surfaces at all. `/login` is now
  gated on `requiresNoAdminSession`, and `ui/platform-link.ts` is the way *back* (the header and
  Home's footer), which nothing had been until now — `login-page.ts`'s post-sign-in navigation was
  the only route into `/platform` in the whole app.
  *`app.routes.spec.ts` proves every navigation resolves to a route. **That is the wrong
  direction** and cannot see this class of defect: reachability is a property of the guards in
  combination. The journey is pinned in `device.guard.spec.ts` instead — sign in with a device
  session, reach `/platform`, go Home, come back through the chrome, at 1280 and at 390.*
  *`requiresNoAdminSession` sends a signed-in admin to his surface by **role**, never to `?next=`:
  honouring it would let `/login?next=/company` bounce a super admin between two guards for ever.*
  ***Re-run both suites after every review.*** Twice on 2026-08-31 a reviewer or a stopped implementer
  left its own mutation in the working tree — a typo'd unique-constraint name that turned a duplicate
  email into a 500, and a removed `pathMatch: 'full'` that made the PWA suite hang forever instead of
  running in five seconds. Both agents were stopped before reporting, so neither said so.
  *The PWA suite is **load-flaky**: under memory pressure it produces a different random set of 5 s
  vitest timeouts each run, in specs unrelated to the change. Green and stable at load average < 6 —
  re-run under lower load before believing a failure. On 2026-08-31 the machine (23/31 GB used, swap
  exhausted) SIGKILLed a test run and took **Docker Desktop** down with it, which surfaced as API
  500s; `systemctl --user start docker-desktop` then `docker compose up -d` restores it.*
  *If `dotnet build` reports `MSB3027 ... file is locked by Microsoft Visual Studio`, that is the
  founder's IDE or a running API holding the output, not a code error — **never kill `dotnet.exe`**;
  build to a scratch path with `-p:BaseOutputPath=` instead.* **Gates as of 2026-09-02:** cleared — the verbatim pair, the
  report-polish/download pair, B3a, D1, F1+F2, D2, D3, F4, F4b, and F5/F6/F8/D7-F9 (all
  accept-with-fixes, 2026-09-01). **F3's rejection is discharged**: its two gating defects were the
  route bugs F4b fixed, its third is a founder action, and the screens themselves were re-read in the
  2026-09-01 pass and found sound. **D4 was REJECTED and its finding is now an open founder decision**
  (§13.6), not a code fix. **Never reviewed at all: D6, D8 and F10** — built, green, and unseen by a
  reviewer. **D1, F1+F2 and D3 had no delta review
  after their gating fixes** — and D3's implementer was *stopped before reporting its mutation
  proofs*, so that increment's fixes are verified only by a clean build and green tests plus a
  reading of the diff. Treat "mutation-proven" as unproven for D3.
  The adaptive-rework *delta review* verdict is **permanently lost** (its session closed mid-run),
  so that increment never passed its gate; the salvage bug found afterwards was traced to async
  state sequencing, not to the rework. Design canvas still owes the 1280 desktop artboard variants.
  **B4's own delta review was not re-run** — the implementer mutation-proved its fix instead.
- **Migrations are not applied by running the API.** `dotnet run --project src/Teren.Api -- migrate`
  is a separate step, and skipping it fails at runtime with a bare Npgsql `42703 column does not
  exist` — it has now bitten twice, once silently killing the money path on the dev database.
  **Since D1 there are two migration histories**: the evidence schema, and
  `__EFMigrationsHistory_identity` for `TerenIdentityDbContext`. `migrate` and `reset-demo` both
  apply both; `dotnet ef` needs `--context`. The D1 review caught `reset-demo` applying only one and
  dying with the same bare `42P01` on its *safe dry run* — the third time this class has bitten.
- **Identity landed 2026-08-30 (increment D1)**, per `plans/profile-and-identity.md`: three roles
  (super_admin / company_admin / worker), a worker's **username** is his durable identity, the
  device credential proves it. `StaticTokenDeviceAuthenticator` is **deleted** — `Auth:DeviceToken`
  is now just the demo device's token, provisioned into the `device` table as its SHA-256, which is
  what keeps the PWA's baked-in token working. Nothing user-facing exists yet: no login screen, no
  activation screen, no admin page. Those are D2/D3/F3 onward.
- **`seed` clears three withdrawal stamps on existing rows** — `device.revoked_at`,
  `app_user.disabled_at`, `company.suspended_at` — because each one silently makes the demo
  unauthenticable while `seed` reports success. It never restores *content* the founder edited; a
  test pins that line.
- **Confirming clears `failure_reason`** (`EntryEndpoints.cs`, deliberate — it is what makes "fix the
  cause and confirm again" the retry path). Consequence: the record of *why the AI produced nothing*
  is destroyed the moment a foreman confirms, so diagnose a pipeline failure **before** confirming.
- **Committing:** the founder commits and pushes himself. Identity set repo-locally (Milovan
  Miletić <milovanmiletic230@gmail.com>); secrets audit passed 2026-08-29.
- **Real-device debt:** mic behaviour (Android + iOS), offline cold-start of installed PWA, iOS
  camera/HEIC, GPS — blocked on the HTTPS tunnel (founder's ngrok signup) or B3a staging.
- **No blockers.** A2 (real site audio) is **deferred by founder decision**, not waiting on anyone;
  A3 is decided (Azure AI Speech, `sr-RS`, fast REST — `docs/stt-evaluation.md`). B4 has its
  provider. Track A is parked; the harness stays for the day real audio exists.
- **STT proven end to end in a browser (2026-08-29):** the founder captured an entry in Chrome; it
  reached `needs_review` with `raw_transcript` populated **in Latin**, failing only at
  `extraction_not_configured` (no Anthropic key yet). The transcript is written and made write-once
  *before* extraction is attempted, so a missing downstream key cannot cost the evidence.
- **Top open risk (now an *accepted* risk):** Serbian transcription accuracy on real site audio is
  still unmeasured — the provider was chosen on one 18 s clip in a quiet room. Known failure mode:
  compressed material codes (`PPR cev 25` → *pipr cevi dvaes 5*). The mitigation is downstream —
  canonical-name mapping in the Claude extraction call (ARCHITECTURE §9.2), which is now
  **load-bearing**, plus the mandatory confirmation screen.
- **Founder-veto queue:** "Gotovo" as queue moment; recording-as-route; zero-chunk = no entry;
  noiseSuppression on; Tailwind dropped for token CSS (§5 mismatch); ti vs vi; "Prijavi se"
  visibility pre-M2; recent-entry titles; **which SMTP relay** (transport decided, relay not —
  needed by B6; do not send direct from the VPS: port 25 blocks and IP reputation, and the report
  is the product's face).
- **Verified toolchain (re-read off the machine 2026-08-29):** .NET 10.0.300, Angular CLI 22.1.6,
  Node 24.19.0, npm 11.17.0, Docker 29.4.3, Compose v5.1.3. No local `psql`. Node was 22.12.0 —
  below Angular CLI 22 minimum, so the PWA could not build or test at all — and was installed this
  session. **`ng test` exits 0 even when specs fail; read the summary line, never the exit code.**

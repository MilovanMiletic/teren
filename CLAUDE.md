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

- **Phase:** ROADMAP **B0–B7 ☑, C3 ◐, identity work in progress** (2026-08-30). The current subject
  is **profiles and identity** — `plans/profile-and-identity.md` is the approved specification and
  ROADMAP's *Identity and profiles* table is the live increment tracker. **Start there.** Done and
  reviewed: F1, D1, F2. **Built and UNREVIEWED: F3, D2, D3** — three increments owe their gate, which
  is the largest unaudited surface this project has carried; review them before building anything on
  top. F4/F4b was started and backed out (it left the PWA unbuildable); it restarts from scratch.
  **The single most important ordering fact:** a login screen secures nothing while
  `environment.deviceToken` is still baked into the PWA bundle — anyone can read it from devtools
  and call the API directly. Emptying it (D7/F9) is what shuts the door, and it must not happen
  until activation is proven end to end against the real API, or the founder is locked out of his
  own app with no way back in but editing an environment file.
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
- **C3 archive + entry detail built (2026-08-29, founder request, pulled ahead of M1)** and its
  review fixes are in. **Still ◐: there is no read path for media** — no presigned GET, so photos of
  an entry captured on another device cannot be displayed at all. That is the owner-on-a-tablet
  case, i.e. the buyer's reason to pay. See ARCHITECTURE §8.
- **Known defect, in scope for B5:** Home and the archive disagree about an entry's status. Home
  reads `entry.serverStatus` from Dexie, written **once** at upload time from `/complete`
  (`received`) and never refreshed; the archive merges live `GET /api/entries`. So Home says
  "Primljen" while the entry actually sits in `needs_review`. Home is the screen the foreman looks
  at, so this is how a day's evidence quietly fails to become a report.
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
- **Next: B3a staging** — stable **https** origin, one-command deploy; still unblocks the whole
  real-device debt. Then the founder's **welcome + login gate** (see below).
- **Demo seed is now three sites** (`d3a0c1f0-5b8e-4f1a-9c62-` + `000000000002/3/4`), and those ids
  are a **contract** with `web/.../core/projects/project-source.ts`: if they drift, every
  `POST /api/entries` 404s and captured entries can never leave the phone. See ARCHITECTURE §6.
- **Suites: 538 PWA specs** and **786 backend tests** (`tests/Teren.Api.Tests`, xunit.v3 + Shouldly
  + Testcontainers over real Postgres, ~66 s; PdfPig in tests only, so report assertions read text
  back out of the rendered PDF). `dotnet test` needs Docker running.
  *The figures here were stale before 2026-08-30 (403/447 recorded against an actual 436/476) —
  both were re-measured off the tree, not carried forward.*
- **Check at session start:** the tree is green (`dotnet build` clean, **786 backend tests, 538 PWA
  specs**, both verified by execution 2026-08-30 at session end).
  *If `dotnet build` reports `MSB3027 ... file is locked by Microsoft Visual Studio`, that is the
  founder's IDE or a running API holding the output, not a code error — **never kill `dotnet.exe`**;
  build to a scratch path with `-p:BaseOutputPath=` instead.* **Every increment has now passed its reviewer** —
  the verbatim pair, the report-polish/download pair, B3a, and the identity pair (D1, F1+F2) all
  cleared their gates. **Neither D1 nor F1+F2 had a delta review after its gating fixes** — both
  implementers mutation-proved the fixes instead, as B4 did.
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

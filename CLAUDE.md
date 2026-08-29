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
npm start --prefix web/teren-pwa          # PWA on http://localhost:4200
dotnet build                              # whole solution
npx ng test --watch=false                 # PWA tests (vitest), run from web/teren-pwa
docker compose exec postgres psql -U teren -d teren   # no local psql client
```

Translation dictionaries live in `web/teren-pwa/public/i18n/{en,sr}.json` (Angular 22 serves
static files from `public/`, not `src/assets/`).

## Agents

Four standing agents in `.claude/agents/`: `teren-backend-dev` (Opus) and `teren-frontend-dev`
(Opus) implement; `teren-backend-reviewer` and `teren-frontend-reviewer` (Fable, read-only)
adversarially review with accept / accept-with-fixes / reject verdicts. Plus `teren-data-model`
and `teren-screen-design` (Fable). **Every implementation increment goes through its reviewer
before being presented as done; gating fixes go back to the implementer and are re-proven.**

## Current state (update as it changes)

- **Phase:** ROADMAP **B0 ☑ B1 ☑ B2 ☑ B3 ◐** (2026-08-29). Design system + 10 artboards in
  `design/` (tokens.md is binding). B2 capture flow done incl. review fixes (Dexie v2, per-second
  chunk persistence, orphan rescue) **plus the adaptive-layout rework** (app header ≥768 with
  global language switcher, three device classes, layer/band tokens, `overflow:hidden` on base
  card, 91 specs) — founder-approved on desktop and tablet. B3 server side done incl. review
  fixes (idempotent entries, presigned PUTs, sealed evidence at `/complete`, media caps, storage
  time-budget). Wire format is **snake_case**.
- **Remaining for B3:** wire the PWA outbox to the API (upload loop, retry/backoff,
  `confirmed_by_server`).
- **Check at session start:** the adaptive-rework *delta review* verdict (was still running when
  the session closed) — handle any findings first. Design canvas still owes the 1280 desktop
  artboard variants (design agent retrofit).
- **Committing:** the founder commits and pushes himself. Identity set repo-locally (Milovan
  Miletić <milovanmiletic230@gmail.com>); secrets audit passed 2026-08-29.
- **Real-device debt:** mic behaviour (Android + iOS), offline cold-start of installed PWA, iOS
  camera/HEIC, GPS — blocked on the HTTPS tunnel (founder's ngrok signup) or B3a staging.
- **Only real blocker:** ROADMAP A2 — founder records 3–5 real site voice notes. Track B proceeds
  regardless (transcription sits behind `ITranscriptionProvider`).
- **Top open risk:** Serbian transcription accuracy on real site audio (A3 decides the provider).
- **Founder-veto queue:** "Gotovo" as queue moment; recording-as-route; zero-chunk = no entry;
  noiseSuppression on; Tailwind dropped for token CSS (§5 mismatch); ti vs vi; "Prijavi se"
  visibility pre-M2; recent-entry titles; email provider (Resend vs Postmark, needed by B6).
- **Verified toolchain (2026-08-29):** .NET 10.0.111, Angular CLI 22.1.6, Node 24.19.0,
  Docker 29.7.2, Compose v5.4.0. No local `psql`.

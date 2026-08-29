# Teren — Journal

Day-by-day trace of what was discussed, decided, and built. Newest entry on top.
Every working session appends (or extends) the entry for its date before ending.

Entry format:
- **Talked about** — topics of the session, one line each
- **Decided** — decisions made (mirror important ones into `PROJECT.md` §Decided)
- **Built** — files/code produced or changed
- **Founder actions** — things only the founder can do, with status
- **Next** — what the following session starts with

---

## 2026-08-29 (night, gate closed) — Adaptive rework landed; founder approved; commit is his

**Outcome:** the adaptive-layout rework is done and the founder approved it visually ("everything
seems fine"). Orchestrator verified independently by DOM/pixel probes at 1280 and 768: clean 24px
band under the header, the strip between header and first card hits only bare canvas, switcher in
the header, two-pane grid live, zero unclipped cards, no horizontal overflow. Build clean,
**91/91 specs**, zero console errors on all routes at 390/768/834/1280/1920.

**What the rework changed (structural, not cosmetic):**
- Root cause of the founder's tablet overlap: no defined header→content gap + sticky header.
  Fixed with `--band-top` token (one gap, defined once) and a **static** header that owns its band.
- `overflow: hidden` moved to the base `.card` class — no decoration can escape any card, ever.
- Layer tokens `--z-content/header/overlay`; ad-hoc z-indexes removed.
- App header (wordmark, project, date, **language switcher**) on all screens ≥768; switcher at the
  foot of Home and Pending on compact. Switching from Home works and persists (verified).
- Home ≥1024: two panes (capture 7 cols / sync+recent 5) on a 1200 frame; Pending: 720 list +
  summary rail; Recording/Saved: deliberate focused columns, scaled controls. Hover/`:focus-visible`
  behind pointer media queries. Compact (<768) pixel-untouched.
- Honest flag from the implementer: component style budget raised 4/8 → 6/10 kB (Home carries
  three device classes; 5.07 kB). Recorded so the budget still means something.

**Accepted-for-now decisions (founder saw both, did not object):** static header (scrolls away on
long lists — revisit if it annoys); no back affordance on Recording/Saved (each has explicit,
labelled exits; "back" beside "Otkaži" would be two exits with opposite consequences).

**Still open, honestly:** the reviewer *delta* pass on this rework is running in the background —
its verdict lands async and any findings are the first item of the next session. The design canvas
does not yet carry the 1280 desktop artboard variants (retrofit pending). Real-device debt
unchanged (mic on Android/iOS, offline cold-start, camera/GPS — needs the tunnel/B3a).

**Next:** founder commits and pushes (identity configured; secrets audit passed; suggested 4-commit
split: docs+workspace / backend / frontend / design). Then: B3 wiring (PWA outbox → API), A1 spike
harness, B3a staging.

## 2026-08-29 (night, pre-commit hold) — Founder rule: adaptive layouts per device class

**Decided (founder, after seeing Home at 1920 in desktop Chrome):** the commit is held; the
centred-phone-column-on-desktop UI is rejected. **Binding rule: a desktop layout is designed, not
inherited — a screen without a deliberate ≥1024 layout is not done.** Three device classes
(compact <768 artboard-true / medium 768–1023 proportioned / expanded ≥1024 real application
layout with app header, 1200 max-width, 12-col composition). Language switching must be reachable
from every screen, including Home. Recorded in ARCHITECTURE §5, CLAUDE.md conventions, and the
frontend-dev / frontend-reviewer / screen-design agent definitions (design artboards now ship in
390+1280 pairs).

**In flight:** frontend-dev reworking Home/Pending/Recording/Saved to the three-class system with
the global header + language switcher; compact layouts must not regress. Pending after it lands:
orchestrator visual check at 4 widths, reviewer pass on the delta, design canvas retrofit of the
desktop variants, then the held commit proceeds.

## 2026-08-29 (night, conclusion) — B2 done, B3 server done; both reviewed and fixed

**Outcome:** both parallel increments implemented, adversarially reviewed (verdicts:
accept-with-fixes), all gating fixes applied and re-proven with the reviewers' own attack
sequences, then independently spot-checked by the orchestrator (builds, 87/87 + backend suite,
live curl replay of the sealed-entry and audio-cap attacks → 409/409, happy path intact).

**Review catches that mattered (all proven live, not speculated):**
- *Backend F1:* media could be declared after `/complete` — the evidence set wasn't sealed.
  Fixed: `received_at` seals; late declares → 409. *F2:* no audio cap (5×25 MB accepted) — now
  1 audio, 21 media total. Also: pending/failed distinction, storage verification under a 10 s
  whole-pass budget → 503 + Retry-After, handler-level size ceilings.
- *Frontend #1 (critical):* recording chunks lived only in memory — a dead battery at minute 3
  lost everything despite the "≤1 s loss" claim. Fixed: Dexie v2 chunk table, per-second flush,
  orphan rescue on start + visibilitychange. *#2:* Android back during recording silently
  destroyed the take — now persists a draft; cancel is the only discard. *#3:* service worker
  didn't cache i18n — installed PWA offline had no UI text. *#4:* IndexedDB failure bricked boot.
  *#5:* store failure at stop stranded the blob. Plus: saved-screen rescue exemption + heartbeat,
  addPhoto guards, pending count includes drafts (home can never claim "Sve poslato" over unsent
  work), mic-revocation (incoming call) salvages chunks into a draft.

**Deferred cleanups noted by reviewers (non-gating):** racy photo cap; ETag capture at
verification; fallback image-decode orientation on old Safari; `pending.failed.reason` canned
string (B3 must replace); `setOutboxState` seam may need widening for confirmed_by_server;
tokens.md additions to document (`--shadow-stop` etc.); 32 kbps ≈ 240 KB/min vs §5's estimate.

**Decisions embedded in code, pending founder veto:** "Gotovo" is the queue moment (not stop);
recording is a route (back = leave recording, now safely); zero-chunk recordings produce no entry;
audio noiseSuppression=true (test in STT spike); Tailwind dropped in favour of token CSS
(ARCHITECTURE §5 still says Tailwind — founder to bless or reverse).

**Pre-commit sweep done:** secrets audit clean (only documented throwaway dev creds:
`teren_dev_only`, `teren-dev-device-token-not-a-secret`); no build artifacts leak through
.gitignore; git identity set repo-locally (Milovan Miletić <milovanmiletic230@gmail.com>).
**Awaiting founder's word to commit.**

**Real-device debt (needs founder's phone + HTTPS tunnel):** microphone MIME/behaviour on real
Android + iOS, offline cold-start of the installed PWA, iOS camera/HEIC/orientation, GPS on site.

## 2026-08-29 (night) — Implementation team formed; B2 + B3-server running in parallel

**Decided (founder)**
- Four standing agents in `.claude/agents/`: **teren-backend-dev** (.NET senior, Opus) and
  **teren-frontend-dev** (Angular senior, Opus) implement; **teren-backend-reviewer** and
  **teren-frontend-reviewer** (both Fable, read-only) adversarially review every increment before
  acceptance, with explicit accept / accept-with-fixes / reject verdicts.
- Frontend must be **responsive on every device** (phone/tablet/desktop): mobile-first from the
  390 artboards, centered column upward, ≥48 px targets, no horizontal scroll — written into the
  frontend agent definition as a standing convention.

**Started (parallel, non-conflicting: web/ vs src/)**
- B2 capture flow (offline-only): Home/Recording/Saved/Pending from the artboards, tokens → CSS
  custom properties, self-hosted IBM Plex Sans, Dexie stores + outbox modelled for B3.
- B3 server side: entries/media/complete/list endpoints, idempotent POST /entries, presigned PUT
  to MinIO (15-min TTL, exact key), static-token auth resolving the demo tenant (M0 compromise),
  HEAD verification on complete; entry left in `received` for B4. Hangfire deliberately not yet.

**Review gate:** when each implementer reports, the matching reviewer runs before anything is
presented as done; reviewer verdict gates acceptance.

## 2026-08-29 (evening, round 2) — Visual reference adopted; identity model planned

**Decided (founder)**
- **Visual language pinned to a reference** (warm dashboard aesthetic): warm off-white canvas
  (~`#EFEDE8`), borderless white cards with soft shadows, generous radii (cards 20–24 px, pill
  buttons), near-black ink, one coral-orange accent family, near-black pills as the secondary
  strong element. Supersedes the earlier "hairline borders / 4–8 px radii" rules; everything else
  from the professional register stands (type, no emoji, field constraints, muted status).
  Recorded in `.claude/agents/teren-screen-design.md`; `design/tokens.md` to be updated as the
  binding set. All 8 artboards being re-skinned; 3 new screens ordered: Welcome, Login, Home.
- **Identity model:** deliberate that B1 has no user/profile table. Plan recorded in
  ARCHITECTURE.md §12 — `device` (C5: phone→project binding via join code, `entry.device_id` is
  provenance) and `app_user` (M2: owners/office with email+password; role owner|office|foreman;
  nullable device→user link). Tables land with the increments that use them, not speculatively.

**Done (design round 2 delivered and spot-checked)**
- All artboards re-skinned to the reference language; verified visually (Home matches: warm
  canvas, borderless white cards, coral record button).
- New: `Welcome.dc.html`, `Login.dc.html`, `Home.dc.html`; `Main.dc.html` folded into Home and
  deleted (home *is* the capture entry point — a separate idle screen duplicated it).
- `design/tokens.md` now the binding set, incl. the accent split: coral `#E8674A` for large fills
  only (cannot carry AA text), deep `#C2410C` for primary pills/links. Status chips as muted tint
  pills. ~20 new i18n keys (`welcome.*`, `login.*`, `home.*`, `entry.status.*`) in the README.
- Canvas artifact updated (same URL as round 1).

**Founder decisions pending (design/README.md):** ti vs vi; whether "Prijavi se" appears in M0/M1
builds at all (auth is M2); recent-entry titles from `work_done[0]` vs date+status; stop-recording
auto-queue vs explicit send; cancel silent vs confirmed; native Serbian copy review.

## 2026-08-29 (evening) — Design direction set: professional register

**Decided (founder)**
- The first design pass read as "playable"/consumer-toy. **Binding direction: full-on professional
  design** — enterprise-field-software register (PlanRadar/Procore class): neutral surfaces, one
  accent colour, Inter/IBM Plex Sans, 4–8 px radii, hairline borders, no emoji, muted status
  chips, strict spacing grid. Field constraints (huge record button, ≥48 px targets, AA+ contrast,
  first-class sync state) remain — they are not in tension with professionalism.
- Recorded permanently in `.claude/agents/teren-screen-design.md`; `design/tokens.md` will be the
  canonical token set the running design work must produce and follow.

**Done**
- Mid-flight course correction sent to the design agent: restyle the four existing artboards
  (Main, CaptureRecording, CaptureSaved, Pending) before adding the remaining M0 screens
  (Confirmation + its failure states).

## 2026-08-29 (later) — B1: data model + seed

**Talked about**
- Making ARCHITECTURE.md §6 real: EF Core mapping, migration, immutability enforcement, demo seed.

**Decided**
- **No PostGIS** — plain `double precision` latitude/longitude (+ `gps_accuracy_m`); nothing on
  the roadmap needs spatial queries and `postgres:17-alpine` has no PostGIS. §6 updated.
- `media` also carries `company_id` (the draft schema missed it) — every tenant-owned table is
  covered by the EF global query filter, which is **deny-by-default**: an unset tenant sees no
  rows rather than everyone's rows.
- Statuses stored as CHECK-constrained snake_case text; `structure`/`corrected` CHECK that
  `schema_version` is present; all FKs `ON DELETE RESTRICT`.
- Immutability is trigger-enforced beyond the brief: reported entries reject UPDATE **and**
  DELETE, and `raw_transcript` is write-once even before reporting. Same rules mirrored in
  `TerenDbContext.SaveChanges` so EF callers fail fast.
- Local dev Postgres connection string lives in `appsettings.Development.json` (throwaway
  credential, not a secret); production overrides via `ConnectionStrings__Postgres`.

**Built**
- `Teren.Core/Entities` (Company, Project, Entry, Media, Report + status enums, no EF
  attributes), `Teren.Core/Tenancy/TenantContext`.
- `Teren.Infrastructure/Persistence`: `TerenDbContext` (query filters + immutability guard),
  explicit `IEntityTypeConfiguration<T>` per entity, snake_case mapping, explicit enum↔text
  converters; `InitialSchema` migration incl. trigger SQL.
- `Teren.Infrastructure/Seeding/DemoSeeder`: idempotent Serbian demo data — *Vodoinstal
  Petrović d.o.o.*, site *Stambena zgrada Vojvode Stepe 212* (Voždovac, Beograd), three entries
  (reported / confirmed / awaiting_confirmation) with realistic transcripts, v1 structure JSON,
  correction deltas, weather and GPS.
- `Teren.Api`: DbContext + TenantContext DI; `-- migrate` / `-- seed` one-shot commands.
- Local `dotnet-ef` tool manifest (`.config/dotnet-tools.json`).

**Verified, not assumed**
- `dotnet build` — 0 warnings, 0 errors. Migration applied against compose Postgres.
- Seed run twice: first run 5 rows, second run "nothing inserted"; counts stayed 1/1/3.
- psql: UPDATE on reported entry → trigger exception; DELETE → exception; transcript rewrite on
  an unreported entry → exception; legitimate status flip → succeeds. Test row restored after.
- EF-level: same three cases verified through `TerenDbContext` (scratch console app, not in
  repo); tenant filter returns 3 entries with tenant set, 0 with it unset.
- `/health` still serves after the DI changes.

**Next**
- A1 (STT spike harness) still open; then B2 (capture flow) / B3 (upload path).

---

## 2026-08-29 — Roadmap and architecture

**Talked about**
- Moving down a level from the high-level document: the increment plan, and the detailed stack.
- Probed the dev machine so the plan rests on real versions rather than assumptions.

**Decided**
- **Milestones:** M0 demo-ready (money path) → M1 pilot-ready → M2 sellable → M3 repeatable.
- **Two parallel tracks in M0:** Track A (transcription risk, founder-blocked on real audio) and
  Track B (money path, never waits — transcription sits behind `ITranscriptionProvider`).
- **Three backend projects** (Api / Core / Infrastructure), one process, one container.
- **Polling over SignalR**; media never passes through the API (presigned PUT, 15-minute TTL).
- **Extraction:** Anthropic .NET SDK, Sonnet 5 from config, structured outputs against a v1 JSON
  schema, adaptive thinking. Sonnet vs Opus settled later by evals, not by price (~$0.008 vs
  ~$0.02 per entry — both noise against €30–80/site/month).
- **Correction triples** stored from day one and replayed from `evals/` before any prompt change.
- **Weather:** Open-Meteo (free, no key, historical by lat/lon/date).
- **Auth staged honestly:** static device token for the M0 demo (no real data), join codes in M1,
  real accounts in M2.
- **Entry immutability** enforced by a Postgres trigger, not only by application code.
- Client-side and server-side entry states kept as deliberately separate vocabularies.
- **Localisation (changed from the earlier "Serbian-only UI" convention):** English source
  strings with Serbian translation, both in one build. **Transloco** (`@jsverse/transloco` 8.4.0)
  over `@angular/localize`, because build-time locales would mean two bundles and two deploy
  paths for a PWA. Serbian stays the **default runtime locale**. No user-facing string may be
  hardcoded, from the first component. Script is Serbian Latin (`sr-Latn-RS`); Cyrillic later is
  one more dictionary file. Report language is a **per-project** setting (new `report_language`
  column), because it follows the client, not the foreman's phone. Content — transcripts and
  extracted values — is never translated.

**Built**
- `ROADMAP.md` — M0 increments A1–A3 / B0–B7 with "done when" criteria, critical path, blockers.
- `ARCHITECTURE.md` — toolchain, topology, repo layout, backend/frontend detail, data model with
  JSONB entry schema and state machine, API surface, media and AI pipelines, offline/sync,
  security, ops, open technical decisions.
- `CLAUDE.md` updated: document list now points at ROADMAP/ARCHITECTURE; current state refreshed;
  UI-language convention replaced with the bilingual rule.
- Localisation folded into `ARCHITECTURE.md` (new §5 subsection, `report_language` column) and
  `ROADMAP.md` (B0 now wires i18n; B5/B6 language-aware; founder copy review added).

**Findings worth remembering**
- Verified toolchain: .NET 10.0.111 LTS, Angular CLI 22.1.6, Node 24.19.0, Docker 29.7.2,
  Compose v5.4.0. No local `psql` client.
- iOS Safari does not record OGG/Opus (it produces MP4/AAC) — audio format must be negotiated and
  possibly normalised server-side. Needs verification on a real iPhone.
- Licensing to watch for a commercial product: QuestPDF Community licence has a revenue threshold;
  Hangfire Core (LGPL) is fine.

**Decided (later in the day)**
- **Domain registration deferred** until production deployment (C7). Accepted: the name is not
  reserved meanwhile; staging runs on a tunnel/VPS hostname.
- **Three environments, added to the plan:** local, phone-testable dev (HTTPS tunnel, from B0),
  staging on a small VPS (new increment **B3a**), production (C7). Driver: the product's core
  features — recording, camera, GPS, service worker, install-to-home-screen — only work on a real
  device over HTTPS, so every increment must be testable on the founder's phone the same evening.
- The tunnel must give a **stable hostname**: IndexedDB, service-worker registration and the
  installed app are origin-scoped, so a URL that changes each restart wipes local state and makes
  offline-queue testing meaningless.
- Staging carries **seeded demo data only** until C5 (device binding) and C7 (hardening).

**Founder actions**
- [x] ~~Register `teren.rs`~~ — deliberately deferred to C7.
- [ ] **A2 — record 3–5 real site voice notes.** The only thing that can stall the project.
- [ ] Review ROADMAP.md and ARCHITECTURE.md; disagree loudly where the plan is wrong.
- [ ] Later, at B5: review the Serbian translations — trade vocabulary needs a native ear.

**Built (evening — B0 complete)**
- Git repo initialised; `.gitignore` covering .NET, Node, secrets, local data volumes, Obsidian,
  and real site audio (never committed).
- .NET 10 solution `Teren.slnx`: `Teren.Api` (Minimal API, OpenAPI, CORS, `/health` on port 5080),
  `Teren.Core`, `Teren.Infrastructure`, with references wired Api → Core/Infrastructure → Core.
- Angular 22 PWA at `web/teren-pwa`: service worker via `@angular/pwa`, Transloco 8.4.0 wired with
  `sr`/`en` dictionaries, Serbian default, persisted language choice, working switcher.
- `docker-compose.yml`: Postgres 17 + MinIO with a healthcheck-gated one-shot that creates the
  `teren-media` bucket.
- `README.md` with run instructions, credentials, phone-testing note and conventions.

**Verified, not assumed**
- `dotnet build` — succeeded, 0 warnings.
- `curl /health` → `{"status":"ok","service":"teren-api"}`, HTTP 200.
- `npx ng build` — succeeded; `npx ng test` — 3/3 passing (vitest 4.1.11).
- Browser check at localhost:4200: renders Serbian by default, and the date formats natively as
  *subota, 29. avgust 2026.* — confirming `sr-Latn` locale registration works. Clicking English
  switches text instantly while the date stays Serbian, which is the documented `LOCALE_ID`
  behaviour (fixed at bootstrap).

**Corrections to the design docs, from contact with reality**
- Angular 22 serves static files from `public/`, not `src/assets/` → dictionaries live at
  `public/i18n/{en,sr}.json`. ARCHITECTURE.md updated.
- Angular ships the locale as **`sr-Latn`**; there is no `sr-Latn-RS` locale file. Doc corrected.

**Open**
- Nothing committed yet, and `git config user.name` / `user.email` are unset — commits will fail
  until the founder sets them.
- B0's loose end: the HTTPS tunnel for phone testing (needs the founder's ngrok signup).

**Next**
- A1 (STT spike harness) and B1 (data model + EF migration + Serbian seed). Independent.

---

## 2026-08-28 — Project start, high-level layer

**Talked about**
- Project kickoff from the initial brief (digital site diary for Serbian contractors).
- Ambition, roles, working style: real business; founder plans and builds, father (doming.rs
  network) acts as distributor; AI-driven development; evenings/weekends, as fast as possible.
- Product name — candidates from the brief plus Serbian-language options, domain checks.

**Decided**
- Name: **Teren** (runner-ups recorded: MojRaport, Gradilog).
- Hosting: Hetzner VPS + Postgres + S3-compatible object storage.
- Vision, users/buyers, market entry (installation trades, Serbia, Serbian), product principles
  incl. "always demo-ready" — all confirmed in `PROJECT.md`.
- No field-observation step; early pilot foreman replaces it (accepted risk).
- Minimal offline queue belongs in Phase 1; Phase 1 identity = seeded project, no accounts.
- First working docs (brief, first-pass analysis) demoted to `archive/` — raw input, not
  authoritative; real technical analysis to be written after/alongside the roadmap.
- Travel-work plugins disabled for this project (`.claude/settings.json`).

**Built**
- `PROJECT.md` — high-level project document (complete for this stage).
- `CLAUDE.md` — development operating instructions for future sessions.
- `JOURNAL.md` — this file.
- `archive/` — original-brief.md, initial-analysis-notes.md (renamed, cross-refs cleaned).

**Founder actions**
- [ ] Register `teren.rs` (optionally `mojteren.rs` as hedge) — DNS says available, confirm at
      registrar.

**Next**
- ROADMAP.md: Milestone 0 (demo-ready) + Phase 1 cut into evening-sized increments; Claude
  drafts, founder tears apart. Then the deep technical analysis document.

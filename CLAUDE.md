# Teren — instructions for Claude

Teren is a digital site diary for small Serbian contractors: a foreman takes photos and records a
voice note (~30 s), the system turns it into a written, evidence-grade daily record and a PDF
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
  structured outputs) for transcript → the day's written record. **Since 2026-09-04 that record is
  prose plus an optional problems line (`schema_version: 2`), not extracted fields** — see PROJECT.md
  §11 and ROADMAP C11. The v1 field shape is kept and still rendered, never migrated.
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
   seeded demo project with realistic Serbian data, core flow (speak → written daily record → PDF)
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
- Entry structure lives in a JSONB column, not rigid schema. *The original reason was "fields
  differ per trade"; since 2026-09-04 there are no fields — the trade lives only in the extraction
  vocabulary, and the column now holds prose. `schema_version` is what lets v1 and v2 coexist.*
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

**CI/CD (2026-09-02):** `.github/workflows/ci.yml` runs both suites on every push to `main` and
every PR (backend over real Postgres — the runners have Docker; frontend parses vitest's summary
line because `ng test` exits 0 on failure, and fails on any `ng build` warning).
`deploy-dev.yml` runs `deploy/deploy.sh` against the dev host after a green CI on `main`; it is
**dormant until the `TEREN_DEV_*` secrets exist**. ARCHITECTURE §13 has the detail and the one seam
(`web.Dockerfile`'s device-token substitution) that must close before the first real deploy.

## Agents

Four standing agents in `.claude/agents/`: `teren-backend-dev` (Opus) and `teren-frontend-dev`
(Opus) implement; `teren-backend-reviewer` and `teren-frontend-reviewer` (Fable, read-only)
adversarially review with accept / accept-with-fixes / reject verdicts. Plus `teren-data-model`
and `teren-screen-design` (Fable). **Every implementation increment goes through its reviewer
before being presented as done; gating fixes go back to the implementer and are re-proven.**

## Current state (update as it changes)

- **THE SCOPE WAS CUT HARD ON 2026-09-04, and the biggest change is that THE REPORT IS NO LONGER A
  FORM.** PROJECT.md §11's two top entries are authoritative. The report body becomes AI-tidied prose
  plus a highlighted problems line; **structured extraction is gone and nothing is extracted silently
  behind the prose** (the transcripts are kept forever, so numbers can be extracted later, and a
  field nobody sees is a number no human confirmed). The confirmation screen becomes one editable
  paragraph. **v1 entries are never migrated** — the demo days and the founder's real ones stay v1 and
  the renderer keeps both paths on `schema_version`. `described_verbatim` survives as the *degraded*
  case, so three provenances now exist and the report must not let a reader confuse *his words* with
  *his words rewritten by a machine and approved by him* (ARCHITECTURE §6, §14 decision 12). This is
  **ROADMAP C11, and it goes before C9.**
  *Also cut, each now a decision and not a deferral: no client-facing web view (the client's channel
  stays the emailed PDF; what it became points inward at the owner — **C9**), no in-app billing and
  no billing record at all, no self-serve signup, no per-trade layouts or labels, no eval harness, no
  second-vertical increment, no legal-diary research, and **M3 is deleted**. The native shell is cut
  **conditionally**: the founder chose to support iPhone recording, so iOS capture is the one route
  that could reopen it. Two gaps found while answering him: **there is no create-project route in the
  API at all** (sites exist only because `DemoSeeder` writes three rows) and **nothing can edit
  `project.recipients`** — both are **C10**.*

- **THE FOUNDER MOVED MACHINES AT THE END OF 2026-09-03, to bring up the dev server from home.**
  Several notes in this file are facts about **that Linux laptop** and are not true anywhere else:
  the **two Docker engines** (`desktop-linux` vs `default`), the **disk at 98 %** and the `df -h /c`
  advice, and the **`sent` report row whose PDF `reset-demo` destroyed**. A fresh machine has one
  engine, its own database, and no dangling row — do not hunt for any of them there, and do not
  carry the workarounds. What a fresh machine *does* need is the four manual steps
  (`docker compose up -d` → **`migrate`** → `seed` → `dotnet run` + `npm start`) and `invite-admin`
  for an admin password, because the demo `company_admin` ships with none.
- **Phase:** ROADMAP **M0 fully built, not done — and the gap is not code** (2026-09-03). B0–B7 are
  ☑ and the money path is proven end to end against real Postgres, storage and SMTP, **on the
  founder's laptop only**. B3a's deployment machinery is built, reviewed and locally proven, and
  **nothing is deployed because there is no VPS and no domain.** That single purchase gates the two
  unmet clauses of M0's own definition — *on a real phone*, *without touching a terminal* — and with
  them the whole real-device debt, which needs **https** and not merely a hostname.
- **The identity work is CODE-COMPLETE as of 2026-09-03; what is left of it is review debt.**
  `plans/profile-and-identity.md` is the specification;
  ROADMAP's *Identity and profiles* table is the live tracker. **Start there.** Done and reviewed:
  F1, D1, F2, **D2 (accept)**, **D3 (accept-with-fixes)**, **F4 / F4b (accept-with-fixes, both
  gating items closed)**, **F5, F6, F8, D7/F9 (all accept-with-fixes, 2026-09-01)**, **D8**,
  **D4** (`/api/platform/*`, **REJECT** — see below), **D6** (invite email, 2026-09-01) and
  **F10** (`/company/profile`, 2026-09-02, unreviewed). **F3's rejection is discharged.**
  **D5 and the log viewer are done (2026-09-02).** **F7 is complete** — `/platform/health` shipped
  2026-09-03 — and so are **D9** (the report's supersedes band + D4's closure) and **D10**
  (`DEM0-TEST` Development-only). **Every increment in the ROADMAP table is built and green.**
  Unreviewed: **D9** (no mutation proofs — its implementer was killed before reporting; **start
  here**), F7's health page, D6, D8, F10, D10, and F13's four founder-screenshot rounds.
- **`docker compose ps` returning nothing can mean "wrong engine", not "your stack is gone"
  (2026-09-03) — and the recovery step is what destroys something.** *Machine-local: this is about
  the founder's Linux laptop, not any machine you happen to be on — check `docker context ls`
  before assuming it applies.* That machine runs **two Docker engines**: the context is `desktop-linux` (Docker Desktop), and that is where the founder's data
  lives (`teren_postgres-data`, created 2026-08-29). An agent working against the native `default`
  engine saw `docker compose ps -a` list **nothing**, read it as a wiped stack, ran `docker compose
  up -d`, and **built a parallel stack with brand-new volumes on the other daemon** — then reported
  the founder's database and MinIO destroyed, three accounts and a report row lost. **Nothing was
  lost.** A throwaway container against the original volume read `entries=3 reports=1 users=5
  devices=7 projects=3`, exactly its previous contents. **Check `docker context show` and
  `docker volume inspect <v> --format '{{.CreatedAt}}'` before believing a loss report**, and prefer
  `DOCKER_CONTEXT=` over changing the global context. *Fifth variant of "it doesn't work" meaning "it
  isn't running", and the first where the agent's own fix looked like the damage.*
- **A claim proven only through a substituted seam is not proven about the shipped code
  (2026-09-03).** The test fixture substitutes `IJobQueueDepth`, so every "the queue reads unknown
  when Hangfire is off" assertion was really an assertion about the fake: turning the **shipped**
  `DisabledJobQueueDepth` into a lie left the whole suite green. A test now asserts the production
  class directly. *Sibling of the same day's microtask finding — both are specs that could not fail.
  When a seam is substituted in tests, something must also assert the real implementation.*
- **A widening of the model is a widening of what the privacy guard must forbid, and the guard cannot
  infer it (2026-09-03).** `GET /api/platform/health` needed entry and report aggregates, which
  `TerenIdentityDbContext` could not see, so it gained `Project` (three columns, seven properties
  `Ignore()`d) plus **keyless** four-column read-throughs `EntryHealthRow`/`ReportHealthRow`.
  `db.Set<Entry>()` still throws, so §12's sentence stayed literally true — **the barrier is now "no
  evidence content", not "no evidence tables"** — but `PlatformPrivacyTests.Forbidden` still listed
  only `Entry`/`Media`/`Report`, so a `PlatformDirectory` member returning `EntryHealthRow` (whose
  `FailureReason` carries the provider's own words) passed **all eleven privacy tests**. Both types
  are on the list now. ARCHITECTURE §12 carries the reasoning, the rejected SQL-view alternative and
  two residual risks: that context has **no query filters**, so `Projects` there is cross-tenant and a
  future company-scoped handler could read it unnoticed; and a `Project` materialised from it has
  `Address` reading as *absent* rather than *not loaded* — the F10 shape.
- **`entry.failure_reason` carries codes from BOTH vocabularies, and forgetting it hid the one state
  that matters (2026-09-03).** `EntryProcessor.ParkAsync` writes a `ProcessingFailure`;
  `EntryReporter.FailAsync` and `RecordSupersededAfterSendAsync` write a **`ReportFailure`** to the
  same column deliberately, and **`superseded_after_send` exists nowhere else at all**. The health
  tally folded entry reasons through the pipeline vocabulary alone, so every delivery failure was
  counted twice — once right, once as `unrecognised` — and that one terminal state was anonymous on
  the screen whose job is saying what is wrong. Entry buckets fold through `Pipeline ∪ Delivery` now,
  and `NeedsAttention` is documented as a severity **signal, not a partition**: the terms overlap on
  purpose, and undercounting is the only failure mode that matters because it is what lets the
  500-site cap drop a site somebody needed to see.
- **A phone the server refuses now signs itself out (F14, 2026-09-03) — and this REVERSES a decision
  this file used to state as an invariant.** Plan §10.3 and F8 said revocation is "never a locked
  door"; the founder revoked a worker's phone, watched it carry on exactly as before, was shown that
  reasoning with two milder options, and chose **full sign-out**. PROJECT.md §11 (top entry) and the
  amended plan §10.3 are authoritative; the old paragraph is kept there as superseded. **The backend
  was never at fault** — the authenticator has no cache and refuses a revoked device, a disabled
  worker and a suspended company on first contact. The phone learned it every 20 s from
  `EntryStatusRefresher` and **discarded it in silence**, and the one notice that existed was derived
  from an outbox row failed **eight** times, so **an empty outbox meant the phone never said anything
  at all, ever**. Detection is `TerenApiClient.bearing()` over the four `authHeaders()` funnels — 401
  only, `putObject` excluded, **not an interceptor** (`api-config.ts` gives three reasons, one fatal:
  `baseUrl` is `''` in production, so a prefix match matches object storage). `SessionService.discard()`
  removes one `localStorage` row and **cannot reach Dexie** — a source guard forbids a store handle in
  those three files. *The cost is accepted and written down: a mis-revoke, an accidental disable or a
  suspended company now stops a foreman recording until somebody sends him a code.*
  *Three things there are load-bearing and mutation-proven: the navigation fires **only** off a screen
  whose `canMatch` holds `requiresDevice` **by function reference** (the founder's browser is the demo
  phone and the office console at once — revoking from `/company` must not throw him off it); the
  navigation, never the discard, **defers while the microphone is live**; and the 401-only test, whose
  removal turns ten specs red. The bearer is also captured **before** the await, because
  `config.deviceToken` is a live getter and an in-flight 401 landing after a re-activation would sign
  the man out seconds after he fixed it.*
  ***F8's Home and pending notices are now a fallback, not the mechanism*** — the sentence a
  signed-out foreman reads is on `/welcome`, and the only rows that can still reach that surface are
  ones an older build left in the queue.
  **Known gap, deliberate:** `session.device.refused` is **undeliverable from a foreman's phone** —
  the row is filed under the credential `discard()` removes in the next synchronous statement, so the
  next flush deletes it. "Why did this phone stop" is not answerable from the log stream without a
  change to `ActionLogService`.
- **`reset-demo`'s object purge prefix is GLOBAL, so a throwaway database isolates nothing
  (2026-09-03) — and it cost a report PDF.** *The lost PDF is machine-local
  (the founder's laptop); the trap is not.* `DemoReset` purges `company/{DemoSeeder.CompanyId}/`,
  which is byte-identical across databases. An agent verifying the deployed path pointed the command
  at a scratch database, and it emptied the **shared** bucket: three objects, one of them the PDF of
  the founder's `sent` report (entry …0012). Verified afterwards — `media` has 0 rows so **no
  photograph or voice note was lost**, all three entries are seeded ids, and the `report` row still
  names a `report.pdf` that no longer exists. The content is reproducible; the artefact whose
  `pdf_sha256` is on record is not. ***"Use a throwaway database" is safe for `seed` and unsafe for
  `reset-demo`*** — run the dry run first, which prints the object count, and remember that on
  `dev.teren.rs` the same demo company id will exist.
- **A fix with two layers cannot be mutation-proven one layer at a time (2026-09-03).** The
  correction-lookup guard checks `stillMine(generation)` twice — after the network await, and again
  after `beginCapture` (that second one discards the session, because an empty correction session on
  disk is what the rescue sweep turns into a draft of a day nobody recorded). Removing **only** the
  first left the whole suite green, because the second still stopped the recorder. The honest
  mutation is the **absence of the fix**; with both gone, two specs go red and nothing else does.
  *And the round before that was worse: the deferred lookup resolved with `entry: null`, which the
  `no-target` blocker refuses anyway, so the specs passed with the guard removed — they asserted an
  outcome the code reaches either way. A deferred-dependency spec must resolve **successfully**, or
  it proves nothing.* Both rounds were mine, written while quoting this pathology at other agents.
- **The microphone could open after the man had left the screen (2026-09-03, review of `fc5737f`).**
  `begin()` awaited the correction-target lookup — up to `API_TIMEOUT_MS`, thirty seconds — while
  Otkaži stayed enabled and the back gesture worked, and nothing after the await re-checked
  ownership. The chunks would land under a **correction** session, the sweep would assemble them and
  `queueAbandonedDrafts` would send it: a correction of a client's day, carrying ambient audio,
  delivered to that client. Fixed with `beginGeneration` + `stillMine()`, bumped by `cancel()`,
  `leave()` and `ngOnDestroy`. *Any new `await` in `begin()` needs the same check after it.*
- **A negative assertion that settles on microtasks proves nothing (2026-09-03).** The first
  mutation of F14's device-gated check left **the whole suite green**: the spec's `settle()` turned
  only `Promise.resolve()`, and a router navigation does not finish inside a microtask chain, so every
  "it did not navigate" in that file was vacuous. `settle()` awaits macrotasks now and the reviewer
  re-proved the vacuity on purpose. **Third instance of the `ee37f04` family** — a spec asserting the
  shape of the future rather than the behaviour of the present, after the half-finished route rename
  and F12's 26 unemittable slugs. *Ask of any "it did not happen" spec: could the thing have happened
  yet, at the moment you asserted it had not?*
- **A caveat shown once is not shown (2026-09-03).** F14's `/welcome` sentence was read at field init
  and cleared in the constructor, so it survived one paint — and a foreman signed out mid-shift whose
  OS drops the tab reopened to the plain first-run screen with the record button gone and **no
  explanation**, which is the complaint that started the increment, one reload later. The marker is
  durable now and `ActivationService` is its only clearer, because it describes a **condition** and
  not a handoff. *`ArrivalHandoff.take()` was cited as the precedent for take-once; it is a handoff
  between two screens inside one navigation, which is a different thing.*
- **D4's rejection is CLOSED (2026-09-03), and the plan's three options were aimed at the wrong
  hole.** All three predated D6, which had already removed the plaintext from every response body —
  the token is minted inside `AdminInviteJob` and mailed, and **no platform route can change an
  admin's email**. The wider hole was `POST /api/platform/users`: an email plus a `company_id` mints a
  **brand-new company_admin inside any customer's company**, which reads that company's diaries and,
  unlike a password reset, **locks nobody out and disturbs nothing the customer would notice**. The
  decision (PROJECT.md §11, plan §13.6, both authoritative): **the capability stays, the silence
  goes.** Every *other* administrator of that company is emailed when an administrator is added or a
  credential issued — company's language, no token, no link, via `AdminAccessNoticeJob`, which like
  `AdminInviteJob` never puts a credential in a Hangfire argument. A **structural guard** forbids any
  type reachable from `PlatformDirectory` naming a token, link, secret, password, code, credential,
  url or hash. `invite-admin` (CLI) still prints a link on purpose: shell on that box already means
  the database.
  **The claim you may now make to a customer**, replacing decision 2's literal wording: *staff cannot
  read a customer's diary with their own credentials; minting or resetting an administrator's
  credential is possible, is audited, and emails every other administrator of that company.*
  *The notification copy is customer-visible mail in the founder's voice and has not been reviewed by
  him.*
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
- **Next, in order — and NOTHING IS IN FLIGHT (state saved 2026-09-03, tree clean, `origin/main` at
  `dbc6a1f`, six commits out today).** A `teren-backend-reviewer` on `3716283` was started and
  stopped before it read anything; it left nothing behind. **All M0/identity code items are built and
  green**, `/platform/health` completed F7, and `DEM0-TEST` is Development-only. The `fc5737f`
  frontend review is **closed** (accept-with-fixes; both gating items fixed and mutation-proven — the
  microphone-after-leaving guard and the compact pill bar at 360).
  **What is left is review debt and one named UI gap:**
  1. **D9 (`3716283`) has never been reviewed** — the report's supersedes band, D4's
     `AdminAccessNoticeJob`, the credential guard. Its implementer was killed before reporting, so
     there are no mutation proofs on it. **Start here.**
  2. **F7's `/platform/health` is unreviewed**, and so is **D10** (`DEM0-TEST`, green at 1142, and
     its implementer *did* report, with proofs).
  3. **Never reviewed at all: D6, D8, F10, and F13's four founder-screenshot rounds.**
  4. **A replaced day's record screen does not say it was replaced** and offers a *second*
     correction — the archive list marks both ends, the evidence screen does not. **My commit
     message for `fc5737f` claimed otherwise; that claim was wrong.** Needs the archive page's
     merged rows or a design call about what the screen may claim when the replacement was recorded
     on another phone. Non-gating, and the next frontend item.
  5. Four non-gating review items: no in-flight guard on `HealthPage.load()`; two "Prikazano"
     totals in one card; `capture.blocked.correction.body` blames the network in all three refusal
     cases including the one where retrying can never help; `health.reason.unrecognised` says "this
     version of the app does not know" when the **server** is what did not recognise the code.
  **Then B3a**, which is now a 12-step checklist in `deploy/README.md` §2 with every decision made.
- **A correction now names the document it replaces (2026-09-03).** The decision was delegated and
  taken: the report names the superseded record by **work date and site, never a GUID** (PROJECT.md
  §11 ruling 1), in the project's language and time zone, with **two variants** — one for a superseded
  report that reached a relay, one for a document still waiting, because the honest sentence differs.
  The superseded report is never rewritten. *Report assertions read text back out of the rendered PDF
  with PdfPig, so these are proven on the page rather than at the builder.*
- **Demo seed is now three sites** (`d3a0c1f0-5b8e-4f1a-9c62-` + `000000000002/3/4`), and those ids
  are a **contract** with `web/.../core/projects/project-source.ts`: if they drift, every
  `POST /api/entries` 404s and captured entries can never leave the phone. See ARCHITECTURE §6.
- **`DEM0-TEST` is Development-only as of 2026-09-03 (founder).** On any deployed environment `seed`
  mints a random activation code and prints it once; the fixed code survives only where
  `ASPNETCORE_ENVIRONMENT=Development`. Its original justification expired when F6 shipped — a code
  can be issued from `/company` in seconds. **The paragraph below is the history and still describes
  the local behaviour**; read it with that change applied.
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
  scroller (the phone's pill bar was one too until 2026-09-02, when it became a single fixed row) — absolutely positioned, a **two-row** table
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
- **Every table paginates at ten rows (2026-09-02), and one round of it is a scar worth reading.**
  `TABLE_PAGE_SIZE = 10` and the clamp/slice arithmetic live in `ui/table-controls.ts`; `ui/table-pager.ts`
  draws it (numbered ≥768, `‹ n / N ›` below). `/platform/logs` imports the **constant** while holding no
  `TableControls` — its filters run on the server, so it is fetched in fifties and read in tens, and it
  still never prints a total the server has not given. **The clamp is applied on every read, not on the
  events somebody remembered**: a filter, a sort, a reload and a shrinking list are four paths and there
  will be a fifth.
  *Two defects found by review, both the same shape — a list cut in one order and drawn in another.*
  `/platform` sliced the **flat** sort and then regrouped into bands, so 17 accounts under the default
  sort put **no `Teren tim` band on page 1** and split the admins across pages. Slice the drawn order.
  ***And the middle round is the one to remember.*** The founder reported the log table "overlapping
  down"; the measurement came back `unreachablePx: -32` — **nothing was unreachable**, the foot was
  simply below the fold before he scrolled. It was engineered away anyway with `.screen { height: 100dvh }`,
  which made every card a flex item in a container that could not grow, and `.card { overflow: hidden }`
  (deliberately on the base class) then **sliced `UČITANO 50` through the middle of its digits** and cut
  the NIVO chips in half. A clipped number is a wrong number, on the screen whose whole job is telling
  the truth. Reverted whole. **When a measurement says there is nothing to fix, that is the finding —
  not a reason to look for a different fix.** No screen on this route claims the window's height; the
  page scrolls and cards size to their content.
  *Below 1024 the log stream is a **list, not a squeezed table** — filter card shut by default, the
  `GREŠKE`/`UPOZORENJA` counts tappable as filters, because the question a founder asks a phone is
  "is anything wrong", not "show me line #444". The medium class had never been pinned: every table
  spec passed `render(true, true)`, so all of them were really testing expanded.*
- **A head cluster has a width, and `/platform`'s is the widest (2026-09-02, late).** Five 44 px
  controls and four gaps are 252 px; the compact column at 390 is 358 px; so "Platforma" ran under
  the icons in the founder's screenshot. Below 768 that screen's `.head` **wraps**, title on the
  first line and the cluster under it; from 768 up it is one line as before. Any screen that grows a
  fifth head control needs the same rule — `/company` has three, `/platform/companies` four, and both fit. *Same fix, second trap:
  bottom-aligning the stat numbers with `margin-top: auto` did nothing under `.stats__value` alone,
  because `.stats dd { margin: 0 }` outranks a lone class. The Playwright measurement caught it
  (bottoms 298/298/315); the eye would not have on a laptop. The review found the identical defect
  on `/company`'s tiles; both screens carry the same two rules now.*
  ***The compact pill bar is one row, and it does not scroll*** (founder, same evening: "remove the
  scroll", then "it needs to be in one row"). `.column-bar` no longer has `overflow-x: auto`; the
  budget that had to fit is the office bar on a **360 px Samsung** — `Osoba` sorted, `Stanje`,
  `Aktivnost`, 20 px too wide — found in the bar's side padding (`space-2`), the pill's padding
  (`space-2`/`space-1`) and the pill label at `text-label`, never in the 44 px hit areas. Ten px to
  spare at 360; `flex-wrap: wrap` remains as the fallback below that. Any new column word longer than
  `Aktivnost` re-opens this.
- **Two whole-codebase state reviews ran on 2026-09-02 (backend B+, frontend B-; JOURNAL has both in
  full) and they set the order of work before the dev server.** The finding that outranks everything:
  **`RescueService` truncates a LIVE recording** — it runs on every `visibilitychange→visible`,
  exempts only `/entry/:id`, and `rescue.service.spec.ts:45` *pins* that `/record` is not exempt;
  `finishCapture` deletes the session and every later chunk is silently dropped while the timer keeps
  climbing. **Proven against the production build: a 6 s take with one tab switch saved 2.2 s.** A
  screen lock mid-sentence does this on a phone, and 1575 green specs could not see it because the
  only relevant spec asserted the defect. Then, in order: the deploy chain (`web.Dockerfile`'s token
  substitution fails on both targets), the seal/confirm race in `EntryReporter.SealAsync`, a real
  `/health`, the unauthenticated `/auth/activation-code` that destroys a code and mails nothing, a
  partial index on `report(status='sending')`, and a 401 that never clears the admin session.
- **View transitions were tried and REMOVED, and the measurement is the reason (2026-09-02).**
  `withViewTransitions()` suppresses input for the **whole lifetime** of the transition — twelve real
  `page.mouse.click` runs at 1 ms, 300 ms and 1000 ms fades: the tap is swallowed every time, and
  `::view-transition { pointer-events: none }` on the pseudo tree changes nothing. On saved → Home
  that made the **record button dead for a third of a second**. Screens fade themselves instead
  (`.screen { animation: teren-screen-in }`, **opacity only** — a transform there would make every
  screen the containing block for the fixed column menu). *Do not reintroduce view transitions
  without re-running that measurement with a real mouse click; `element.click()` skips hit-testing
  and reports success either way.*
- **There is a demo film now: `tools/demo-video/`, `npm run demo`.** Six scenes, ~6 min, phone +
  tablet + desktop, driven against a production build proxying the dev API. **Recording it revokes
  the founder's own Zoran session** (single-use code); the run re-mints `DEM0-TEST`.
- **The founder's disk is at 98 % and it took Docker down once (2026-09-02).** *Machine-local to
  that laptop.* A full backend run
  makes ~a thousand scratch databases inside Docker's VHDX, which grows and gives space back only when
  the distro stops; C: hit 31 MB free mid-review, the engine died, and the founder's Postgres, MinIO
  and Mailpit went with it. Recovery: `docker desktop restart` (engine up in ~10 s), then
  `docker compose up -d`. **Before running `dotnet test`, check `df -h /c`**; `docker builder prune -f`
  and deleting scratch build outputs are the safe reclaims, `src/Teren.Api/bin` + `tests/.../bin`
  hold Debug and Release side by side (~600 MB). Build and test with `-c Release` while the founder's
  Debug API is running — it never locks that output.
- **The review-fix round (2026-09-02, backend accept-with-fixes → proven, frontend accept) closed
  the two must-do lists.** Deploy chain fixed and rehearsed locally to `Deployed`; `/health/ready`
  exists and is what compose and `deploy.sh` probe; the seal is conditional on `corrected` with a new
  terminal reason `superseded_after_send`; `/auth/activation-code` writes nothing and a job mints;
  `report(status='sending')` has its partial index; `/api/client-events` is rate-limited; the
  recorder is exempt from rescue and keeps its tail. **Open from it:** `superseded_after_send` is a
  dead end on the phone (the PWA reads `failure_reason` nowhere and the confirm gate loops) — needs a
  frontend gesture for `supersedes_entry_id`; no tappable route to `/login` after a 401 sign-out on a
  browser that also holds a device session (veto-queue item, now the ordinary case); Otkaži during
  `saving()` discards a kept take (design call).
- **The PWA suite was red on Windows before 2026-09-02 and every "1575 green" was measured from a
  Linux shell.** `action-wiring.spec.ts` built its file map with `relative()`, which answers with
  backslashes here, so both hand-written checks failed at their first entry. `shortPath` normalises
  `sep` now. *If a spec fails only on one OS, suspect the path separator before the code.*
- **Suites: 1878 PWA specs** (93 files) and **1142 backend tests** (`tests/Teren.Api.Tests`, xunit.v3 + Shouldly
  + Testcontainers over real Postgres, ~66 s; PdfPig in tests only, so report assertions read text
  back out of the rendered PDF). `dotnet test` needs Docker running.
  *The figures here were stale before 2026-08-30 (403/447 recorded against an actual 436/476) —
  both were re-measured off the tree, not carried forward.*
- **Check at session start:** the tree is green and **clean**, and everything is pushed — **1878 PWA
  specs (93 files) and 1142 backend tests, both re-verified by execution 2026-09-03**, `ng build`
  with zero warning lines, `dotnet build -c Release` succeeding. The stash is empty.
  `dotnet build` succeeds
  with **one** warning: `CS9107` in `DemoIdentitySeedTests.cs:400`. **It is pre-existing** — confirmed by
  building a worktree at `a42adaf` — so the long-standing "0 warnings" claim in this file was simply
  wrong. Do not go hunting for it in your own diff.
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
  build to a scratch path with `-p:BaseOutputPath=` instead.* **F13 (ten rows a page) had one review — accept-with-fixes, both gating findings closed and re-proven — and then FOUR more rounds off founder screenshots that NOBODY reviewed**: the pager reshape, the `height: 100dvh` mistake, its revert, and the compact/medium redesign. Its delta review was stopped mid-run so it would not test a tree being edited. **Gates as of 2026-09-02:** cleared — the verbatim pair, the
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
- **A green suite cannot see a mutation left in the tree, and this is now the THIRD time (2026-09-02).**
  D5's implementer was stopped before reporting and left a fabricated `AiProviderException` in
  `RoleFilter.cs` — a Serbian sentence and an email address, logged on **every 403**, under a comment
  saying *"RESTORED IMMEDIATELY"*. **979 tests passed with it in place.** Every previous instance was
  the same shape: a stopped agent, a mutation, a green tree. **Read `git diff` and account for every
  hunk before believing any suite**, and be specific about files that have no business in the
  increment — `QuestPdfReportRenderer.cs` in a *logging* diff turned out to be legitimate, and
  checking cost thirty seconds.
- **"No free text can reach the log table" was false for the one caller who proves nothing.** The
  sink's allow-list admitted `Path`, `BearerAuthFilter` logs `http.Request.Path`, and that filter runs
  **before** any credential is checked — so an anonymous `GET /api/entries/<a whole sentence>` wrote
  the sentence verbatim into the table Teren staff read. The fix is to log the **matched route
  template** (`LoggableRoute.Of(http)` → `/api/entries/{id}`), which is always available in a filter
  and can never be written from outside. *An allow-list works on **names**, so a name as general as
  `Path` or `Message` is a hole with a respectable label on it.*
- **A vocabulary can ship complete and emit nothing.** F12's 33 action slugs were declared, and 26 of
  them had no `data-log` attribute and no `record()` call anywhere — the whole money path would have
  logged as `ui.app-capture-page.button.btn`. **Every spec passed**, because each asked whether what
  *is* wired is wired correctly and none asked whether a declared name is reachable at all. Same blind
  spot as `ee37f04`'s half-finished route rename, in a different costume. `action-wiring.spec.ts` now
  fails on a slug nothing can emit. *When you add a registry — routes, slugs, keys — the guard that
  matters is the one that walks it and asks "can this entry ever happen?"*
- **`Serilog.Extensions.Logging` renders a pre-rendered MEL state as the literal `{State:l}`.** Every
  Hangfire line arrived that way and the sink dropped `State` as not allow-listed, so **half the log
  table was a placeholder** — on precisely the source "what is failing" depends on. No test saw it
  because no test emitted a MEL event of that shape.
- **`Serilog.Debugging.SelfLog` is off unless someone calls `SelfLog.Enable`.** Every failure channel
  in the D5 sink reported through it, and nothing enabled it — so a host started without `migrate`
  would drop every batch on a `42P01` and show an **empty log screen** rather than an error. A comment
  saying "reported to SelfLog" is not a report.
- **`pkill -f "<pattern>"` matches the shell running it** if the pattern appears in your own command
  line. It killed my own command mid-script (exit 144). Match on something narrower, or check what
  ran afterwards.
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
  noiseSuppression on; Tailwind dropped for token CSS (§5 mismatch); "Prijavi se" visibility pre-M2;
  recent-entry titles. **Cleared 2026-09-03: `ti` vs `vi` → `vi`** (consistent with every string
  already written, and the same copy faces owners and clients), and **the SMTP relay → Resend**
  (free tier for dev, ~€20/month later; Postmark the fallback; never direct from the VPS).
- **Verified toolchain (re-read off the machine 2026-08-29):** .NET 10.0.300, Angular CLI 22.1.6,
  Node 24.19.0, npm 11.17.0, Docker 29.4.3, Compose v5.1.3. No local `psql`. Node was 22.12.0 —
  below Angular CLI 22 minimum, so the PWA could not build or test at all — and was installed this
  session. **`ng test` exits 0 even when specs fail; read the summary line, never the exit code.**

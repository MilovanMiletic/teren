# Teren — Architecture

The technical layer: stack, structure, data model, pipelines, and the decisions behind them.
`PROJECT.md` says why, `ROADMAP.md` says in what order, this file says how.

Status: partly built. §6 (data model) now describes the real schema as migrated; the pipelines
and ops sections are still design ahead of code. Sections marked `[to verify]` are unconfirmed.
Last updated: 2026-08-29.

---

## 1. Toolchain (re-verified on the dev machine, 2026-08-29)

| Tool | Version | Note |
|---|---|---|
| .NET SDK | 10.0.300 | LTS — target `net10.0` |
| Angular CLI | 22.1.6 | current major |
| Node | 24.19.0 | Installed 2026-08-29; the machine was on 22.12.0, below Angular CLI 22 minimum |
| npm | 11.17.0 | As Angular resolves it. A stale shim in `%APPDATA%\npm` makes a bare `npm --version` report 10.8.3 |
| Docker | 29.4.3 | |
| Docker Compose | v5.1.3 | `docker compose`, not `docker-compose` |
| PostgreSQL | via container | no local `psql` client — use `docker compose exec` |

These versions are read off the machine, not carried over from an earlier note. A previous
version of this table recorded versions that did not match reality — Node in particular was
never 24.19.0 here until it was installed — which left the PWA unbuildable while the docs
claimed a verified toolchain. Re-read the versions before trusting this table again.

**`ng test` exits with code 0 even when specs fail.** Judge the suite by its summary line, never
by its exit code: a check that reads only the exit status reports a broken suite as green.

### Licensing to keep an eye on (this is a commercial product)

- **Hangfire Core** — LGPL, free. Hangfire Pro is paid; we do not need it.
- **QuestPDF 2026.8.0** — **terms re-read at adoption, 2026-08-29 (B6), and the previous note here
  was wrong in kind.** It is *not* dual-licensed with an OSI licence: QuestPDF's own LICENSE.md
  says "This is a source-available commercial license. It is not an OSI-approved open-source
  license, and the MIT License does not govern use." Three tiers — Community (free),
  Professional, Enterprise. The threshold the old note recorded does hold: Community is free for
  "an organisation with annual gross revenue under USD 1,000,000 in its most recently completed
  fiscal year, measured on a consolidated basis across entities under common control". Teren
  qualifies, and will for years. **The tier must be declared in code** or the library throws at
  document generation; the declaration lives in `QuestPdfReportRenderer`'s static constructor so
  no start-up refactor can drop it. **Revisit before the company's first million** — at that
  point this is a paid licence, not a re-read.
- **MailKit / MimeKit 4.17** — MIT, no threshold. Chosen as a protocol client rather than a
  vendor SDK (§10).
- **Mailpit** — MIT, and a dev-only container in `docker-compose.yml`; nothing ships with it.
- **Lato** — the font the report is set in, shipped inside the QuestPDF package (its `LatoFont`
  folder) under the SIL Open Font License. Covers Serbian Latin in full (§14 decision 6).
- **Dexie** — Apache 2.0, no issue.
- **Test stack** — xunit.v3 (Apache-2.0), Shouldly (BSD-3-Clause), Testcontainers (MIT): all
  permissive, no commercial threshold. **FluentAssertions is deliberately excluded** — from v8 it
  requires a paid licence for commercial use, which this product would trip.

---

## 2. System topology

```
┌────────────────────────┐
│  Angular PWA (phone)   │  camera, MediaRecorder, Geolocation
│  Dexie / IndexedDB     │  local store + upload queue = source of truth until confirmed
└───────────┬────────────┘
            │ HTTPS (JSON)                     ┌───────────────────────────┐
            ├─────────────────────────────────►│  Teren.Api (.NET 10)      │
            │                                  │  Minimal API + Hangfire   │
            │ HTTPS (PUT, presigned)           │  single process           │
            └──────────────┐                   └──────┬─────────┬──────────┘
                           │                          │         │
                           ▼                          ▼         ▼
                  ┌─────────────────┐        ┌────────────┐  ┌──────────────────┐
                  │ Object storage  │        │ PostgreSQL │  │ External services │
                  │ (S3 / MinIO)    │        │            │  │ STT · Claude ·    │
                  │ audio + photos  │        │ entries,   │  │ weather · email   │
                  └─────────────────┘        │ jobs, JSONB│  └──────────────────┘
                                             └────────────┘
```

Two rules this topology exists to enforce:

1. **Media never passes through the API.** The phone uploads directly to object storage with
   short-lived presigned URLs. The API only ever handles small JSON.
2. **External services are only ever called from Hangfire jobs**, never inside a request from the
   phone (PROJECT.md principle 4).

---

## 3. Repository layout

Directories marked *planned* do not exist yet; they arrive with the increment that needs them.

```
teren/
├── src/
│   ├── Teren.Api/              # Minimal API endpoints, DI, Hangfire host, auth
│   ├── Teren.Core/             # domain entities, state machine, jobs, prompts, report templates
│   └── Teren.Infrastructure/   # EF Core + Npgsql, S3 client, STT/LLM/weather/email adapters
├── web/
│   └── teren-pwa/              # Angular 22 PWA
├── tests/
│   └── Teren.Api.Tests/        # xunit.v3 + Testcontainers — endpoints and the invariants
├── design/                     # screen artboards, design tokens (tokens.md is binding)
├── tools/
│   └── SttSpike/               # A1 — throwaway transcription benchmark (delete after A3)
├── evals/                      # planned (B4) — extraction fixtures from correction triples
├── deploy/                     # planned (B3a) — compose files, Caddyfile, backup scripts
├── docker-compose.yml          # Postgres + MinIO for local dev
└── docs/                       # planned (A3) — stt-evaluation.md and friends
```

Three backend projects, not seven. A solo project pays for every layer boundary it creates;
these three exist because they have genuinely different reasons to change (transport, business
rules, external I/O). Collapse further if even this feels heavy.

---

## 4. Backend

**Stack:** .NET 10 Minimal API + EF Core 10 + Npgsql + Hangfire (Postgres storage) + QuestPDF,
all in **one process, one container**. API and background worker split only when a real load
problem proves it necessary.

**Key conventions**

- Endpoints grouped per resource in `Teren.Api/Endpoints/*.cs`, registered via extension methods.
- No repository-per-entity ceremony: EF `DbContext` used directly from handlers. This is a small
  app with one developer; indirection is cost, not safety.
- Every query is scoped by `CompanyId` through an EF **global query filter** — multi-tenant
  correctness comes from the infrastructure, not from remembering to add a `Where` clause.
- FluentValidation for request payloads; problem-details responses.
- Serilog structured logging with the entry id on every pipeline log line.

**Configuration and secrets**

`appsettings.json` for shape, **user-secrets** in development, **environment variables** in
production. Secrets needed: `Anthropic__ApiKey`, `Stt__Azure__Key`, `Stt__Azure__Region`,
`Storage__{Endpoint,AccessKey,SecretKey,Bucket}`, `Auth__DeviceToken`,
`Hangfire__{DashboardUser,DashboardPassword}`, `Reporting__Smtp__{Username,Password}`.
No secret is ever committed.

**Config sections added by B4** (shape in `appsettings.json`, real values from the above):

| Section | Keys | Notes |
|---|---|---|
| `Stt` | `Azure:Key`, `Azure:Region`, `Azure:FastApiVersion`, `Azure:RequestTimeout` | Key and region are secrets. There is deliberately **no** `Stt:Azure:Locale` — the locale is `Pipeline:TranscriptionLocale` and one setting gets one knob. |
| `Anthropic` | `ApiKey`, `Model`, `MaxTokens`, `RequestTimeout` | `Model` is validated at start-up, `ApiKey` is not (see below). |
| `Pipeline` | `MaxAttempts`, `RetryDelay`, `StaleProcessingAfter`, `SweepInterval`, `SweepBatchSize`, `TranscriptionLocale` | `SweepInterval` is rendered to a cron expression and that expression is what both the scheduler and the start-up log get. |
| `Hangfire` | `Enabled`, `WorkerCount`, `DashboardUser`, `DashboardPassword` | `Enabled: false` runs the whole upload path with no job server — that is how the test host works. |
| `Reporting` (B6) | `FromAddress`, `FromName`, `ReplyToAddress`, `Smtp:{Host,Port,Security,Username,Password,Timeout}`, `RenderBudget`, `StaleAfter`, `PhotoRasterDpi`, `AttachmentSizeWarningBytes` | Username/password are secrets. **An empty `Smtp:Host` does not stop the host booting** — same policy as the AI keys. `StaleAfter` must outlast `RenderBudget + MaxAttempts x Smtp:Timeout`; `ReportingContractTests` recomputes that rather than trusting the comment. |

**The two AI keys, and the mail relay, deliberately do not stop the host from booting.** Most machines that build this
have neither, and an API that refused to start without them would make the entire upload path —
which needs neither — impossible to run or test. A missing key is logged loudly once at start-up
and then parks entries in `needs_review` with an honest reason, never a silent success. Everything
else required (`Storage`, `Auth`) still refuses to boot when empty (`ValidateOnStart`).

**Two traps worth writing down.** `Newtonsoft.Json` is pinned to 13.0.4 in both `Teren.Api` and
`Teren.Infrastructure`: Hangfire pulls in 11.0.1 transitively, which trips NU1903 (a known
vulnerability). The pin is the fix; do not drop it when tidying package references. And .NET's
JSON encoder escapes `&` as the six characters `\u0026` — so a presigned URL pulled out of an
API response **by grep or by eye** is not the URL, and it will fail to authenticate on use.
Parse the JSON (`jq -r`) instead. This is a standing trap, not a one-off.
One deliberate exception class: **local-dev throwaway credentials** live in
`appsettings.Development.json` — the Postgres connection string, the MinIO keys, and the static
dev device token, all matching `docker-compose.yml` (`teren/teren_dev_only`) and worthless outside
localhost. Production supplies all of them via environment variables, and startup refuses to boot
with the required ones empty (`ValidateOnStart`).

---

## 5. Frontend

**Stack:** Angular 22 (standalone components, signals), `@angular/pwa` service worker,
Dexie 4 over IndexedDB, plain CSS on the design-token custom properties (Tailwind was
deliberately dropped at B2 — the token contract is the styling system), Transloco for
localisation.

### Adaptive layout — a founder rule (2026-08-29)

**A desktop layout is designed, not inherited. A screen without a deliberate ≥1024 layout is not
done.** "Responsive" meaning "the phone column survives centred on a big screen" is explicitly
rejected. Three device classes, breakpoints owned by the token layer:

| Class | Width | Layout contract |
|---|---|---|
| Compact | <768 | Artboard-true phone layout — the foreman's experience, never regressed |
| Medium | 768–1023 | Wider cards, two-up where content allows; proportioned column, never a stretched phone view |
| Expanded | ≥1024 | Real application layout: full-width app header (wordmark, project context, date, language switcher), content max-width 1200 centred, screens composed on a 12-col grid (e.g. Home: capture pane + status/recent pane); hover and `:focus-visible` affordances |

Single-task screens (recording, saved) stay deliberately focused at expanded — one centred column
under the header — but that is a designed decision per screen, not a default. Language switching
is reachable from every screen via the header (compact places it unobtrusively off the capture
path). Design artboards ship in pairs from M0 onward: 390 phone + 1280 desktop per screen.

### Localisation

Both languages ship in **one build**. English is the **source language** — translation keys and
base strings are English, consistent with the code/comments/docs convention — and **Serbian is the
default runtime locale**, because the people using this on a site do not read English.

- **Library: Transloco** (`@jsverse/transloco` 8.4.0, peer `@angular/core >=16`). Runtime
  dictionaries mean one bundle, one service-worker scope, and instant language switching.
  `@angular/localize` 22.1.4 was rejected deliberately: it bakes a locale into each bundle, which
  would mean two builds and two deploy paths for a PWA — real cost, no gain at two locales.
  `@ngx-translate/core` 18 is an equivalent fallback if Transloco disappoints.
- **Dictionaries:** `web/teren-pwa/public/i18n/{en,sr}.json`, served at `/i18n/{lang}.json`
  (Angular 22 serves static files from `public/`, not `src/assets/`). Feature-prefixed keys
  (`capture.record.start`). Plain JSON on purpose, so a non-developer can read and correct the
  Serbian without touching code.
- **Hard rule: no user-facing string is ever hardcoded** in a template or component. Enforced from
  the very first component — retrofitting i18n costs many times what starting with it costs.
- **Script: Serbian Latin.** Standard in the construction trades. Cyrillic remains possible later;
  it is one more dictionary file, not a rewrite.
- **Formatting:** Angular ships this locale as **`sr-Latn`** (there is no `sr-Latn-RS` locale
  file), registered at bootstrap so dates, numbers and units format natively. Never hand-roll a
  date string. `LOCALE_ID` is fixed at bootstrap, so switching language re-renders text at once
  but reformats dates only on the next load — acceptable, since the switcher is a demo and
  development convenience rather than something a foreman touches daily.
- **Language switcher** in settings, persisted locally — useful for the distributor when demoing
  to a non-Serbian audience, and for reading screenshots during development.

**What is never translated: the content.** Transcripts and extracted values stay in the language
they were spoken, because raw evidence is never altered (PROJECT.md principle 2). Only the chrome
is localised. Note that the entry schema already splits this correctly — keys like `work_done` and
`headcount` are English while their values are Serbian. That split is intentional and stays.

**Reports:** the PDF goes to a Serbian client, so **Serbian is the default report language**, set
**per project** rather than per device — the recipient's language has nothing to do with the
foreman's phone setting. Templates are localised the same way, which leaves the door open to an
English report for a foreign investor without any new machinery.

**Screens (M0)**

1. **Capture** — the only screen that matters. Project picker → big record button → photo button
   → done. Target: under 30 seconds, usable one-handed with muddy hands, so large hit targets and
   no typing on site.
2. **Pending** — what has not reached the server yet, with a clear count. The foreman must never
   wonder whether his work vanished.
3. **Confirmation** — what the system understood, editable in a couple of taps. Mandatory gate
   before a report is sent.
4. **Archive** (M1) — past entries by project and date.

**Media capture**

- **Photos:** `<input type="file" accept="image/*" capture="environment">`. Compress client-side
  to 1600 px long edge, JPEG ~80. Web capture carries **no EXIF**, so GPS comes separately from
  the Geolocation API and is attached to the entry, not to the file.
- **Audio:** `MediaRecorder`, target Opus in OGG, mono, 16 kHz — roughly 100–150 KB per minute.
  **Platform caveat:** iOS Safari does not produce OGG/Opus; it yields MP4/AAC. So negotiate with
  `MediaRecorder.isTypeSupported()`, record the actual MIME type alongside the file, and let the
  server normalise (ffmpeg) if the chosen STT provider is fussy. Do not assume one container.
  `[to verify on a real iPhone]`

---

## 6. Data model

Postgres. Structured entry content lives in JSONB because fields differ per trade; everything
that must be queried, joined, or proven lives in real columns. Built in B1 — this section
describes the real schema (migration `InitialSchema` in `src/Teren.Infrastructure/Migrations`).

```sql
company (id uuid PK, name, created_at)

project (id uuid PK, company_id → company, name, address,
         latitude double precision null,    -- WGS84; plain columns, no PostGIS (see below)
         longitude double precision null,
         recipients jsonb,             -- [{name, email, role}]
         vocabulary jsonb,             -- work items, worker names, materials → STT/LLM hints
         report_language text NOT NULL DEFAULT 'sr',   -- report/email language for this client
         created_at)

entry (id uuid PRIMARY KEY,            -- generated on the phone; the idempotency key
       company_id → company, project_id → project, entry_date date,
       status text NOT NULL,           -- CHECK-constrained; see state machine below
       raw_transcript text,            -- evidence; write-once (trigger-enforced)
       structure jsonb,                -- what the model extracted (schema below)
       corrected jsonb,                -- what the human approved (may equal structure)
       weather jsonb,
       latitude double precision null, longitude double precision null,
       gps_accuracy_m double precision null,
       supersedes_entry_id uuid null → entry,
       device_id uuid null,
       created_at, received_at, confirmed_at, reported_at,   -- all timestamptz, UTC
       processing_started_at timestamptz null,  -- B4: when the pipeline claimed this entry
       failure_reason text null)

media (id uuid PRIMARY KEY,            -- generated on the phone, like entry.id
       company_id → company,           -- every tenant-owned table carries it (see §12)
       entry_id → entry,
       kind text,                      -- CHECK: audio | photo
       object_key text UNIQUE, content_type text, byte_size bigint,
       sha256 char(64),                -- integrity / evidence
       captured_at timestamptz,
       upload_status text,             -- CHECK: pending | uploaded | verified | failed
       created_at)

report (id uuid PK, company_id → company, project_id → project,
        entry_id uuid null → entry,    -- B6: the daily report's subject. UNIQUE where not null
        kind,                          -- CHECK: daily | weekly
        period_start date, period_end date,
        pdf_object_key text, recipients jsonb,
        status text NOT NULL,          -- CHECK: sending | sent | failed
        sent_at timestamptz null,      -- CHECK: (status = 'sent') = (sent_at IS NOT NULL)
        delivery_detail text null,     -- what the relay actually said when it took custody
        attempts integer NOT NULL DEFAULT 0,
        attempt_started_at timestamptz null,   -- the claim, like entry.processing_started_at
        failure_reason text null,
        created_at)
```

**No PostGIS.** The original draft used `geography(Point,4326)`, but nothing on the roadmap needs
spatial queries — coordinates are only ever stored and echoed back (weather lookup, report
footer). Plain `double precision` latitude/longitude plus an accuracy column does that without
adding a Postgres extension the `postgres:17-alpine` dev image does not carry.

**Mechanical enforcement in the schema** (not just conventions):

- `entry` statuses, `media.kind`/`upload_status` and `report.kind` are CHECK-constrained;
  enums are stored as snake_case text (readable in psql, in dumps, and in a courtroom).
- `structure` and `corrected` each CHECK that `schema_version` is present.
- Triggers `trg_entry_guard_update` / `trg_entry_guard_delete` on `entry`: once `reported_at`
  is set, UPDATE and DELETE are rejected; and `raw_transcript`, once written, can never be
  changed even on an unreported entry. The same rules are enforced in `TerenDbContext` so EF
  callers fail fast with a clear exception, but the trigger is what makes the promise hold
  against any SQL.
- All FKs are `ON DELETE RESTRICT` — evidence is never cascade-deleted.
- `ux_report_entry_id` is **unique where `entry_id IS NOT NULL`** and it is not an ordinary
  index: it is the mechanism that makes one entry produce at most one report. See the report
  state machine below.

**Indexes:** `entry(project_id, entry_date desc)`, `entry(status)` for the job sweeper,
`media(entry_id)`, `media(object_key) unique`, `report(project_id, period_start desc)`, plus
`company_id` on every tenant-owned table.

**EF Core mapping:** domain entities live in `Teren.Core` with no EF attributes; explicit
`IEntityTypeConfiguration<T>` classes in `Teren.Infrastructure/Persistence/Configurations` map
PascalCase to snake_case. JSONB columns are mapped as `string` (boring on purpose — the server
treats them as opaque payloads; Postgres validates what must be validated). `dotnet-ef` is a
**local** tool (`.config/dotnet-tools.json`), so the repo is self-contained.

**Demo seed:** `dotnet run --project src/Teren.Api -- seed` (idempotent; `-- migrate` applies
migrations only). Seeds the demo company *Vodoinstal Petrović d.o.o.* and **three sites**:

| Id suffix | Site | Entries |
|---|---|---|
| `…000000000002` | Stambena zgrada Vojvode Stepe 212, Voždovac, Beograd | 3 |
| `…000000000003` | Poslovni prostor Bulevar oslobođenja 84, Novi Sad | 0 |
| `…000000000004` | Kuća Miloša Obrenovića 17, Zemun, Beograd | 0 |

(full ids share the prefix `d3a0c1f0-5b8e-4f1a-9c62-`; the company is `…000000000001`)

Three sites rather than one because the Home project picker is a dead control with a single item
and the buyer runs 3–20 active sites (PROJECT.md §2). Only site 1 carries entries — three
realistic Serbian ones (reported / confirmed / awaiting_confirmation) dated relative to the first
seed run; an empty site is realistic and keeps the demo narrative on one site. Site 2 carries two
recipients (investor + `nadzorni organ`), which is how commercial jobs run in Serbia and gives B6
a real multi-recipient case rather than discovering the array shape late.

**These ids are a contract with the PWA.** `web/teren-pwa/src/app/core/projects/project-source.ts`
mirrors them as its offline fallback list; if the two ever drift, every `POST /api/entries` 404s
and locally captured entries become unsendable. Seeding is **idempotent per row, not per run**: a
database seeded at an earlier state gains exactly the rows it lacks and existing rows are never
updated.

### Entry structure JSONB (v1)

```json
{
  "schema_version": 1,
  "work_done": [
    { "description": "Razvod od kotla do kupatila",
      "location": "zapadno krilo, 2. sprat",
      "quantity": { "value": 40, "unit": "m" } }
  ],
  "headcount": { "total": 3, "roles": [{ "role": "vodoinstalater", "count": 3 }] },
  "materials": [
    { "name": "PPR cev 25mm", "quantity": { "value": 40, "unit": "m" }, "delivered": true }
  ],
  "blockers": [
    { "description": "čeka se štemovanje", "waiting_on": "električari" }
  ],
  "hidden_work": [
    { "description": "cevi u zidu pre zatvaranja", "media_ids": ["…"] }
  ],
  "notes": "…"
}
```

`schema_version` is there from day one so a future trade template can evolve the shape without a
migration. `hidden_work` is called out separately because it is the highest-value evidence in the
product — the thing that cannot be proven after the wall closes.

**`described_verbatim` — one extra top-level key, only ever in `corrected`.** When extraction has
failed and the foreman confirms his own transcript as the day's record (founder, 2026-08-29,
PROJECT.md §11), the confirmation screen sends `"described_verbatim": true` at the top level with
the transcript **verbatim in `notes`** and every structured section empty. It is not in
`EntryStructureSchema` and never will be: that schema is the shape the *model* must answer in, and
this is a human's statement that the model's answer is absent. Consequences, all deliberate:

- **`/confirm` accepts it.** Validation checks only that `corrected` is a JSON object carrying
  `schema_version` (Postgres CHECKs the same), so an unknown top-level key passes through and is
  stored untouched. Nothing strips it — the report generator keys on it, and a validator that
  quietly dropped it would give the client an empty page and the server a 200.
- **The report renders the day as prose instead of as sections**, under its own heading, with a
  printed statement that the text is a verbatim transcript and was not broken down into items,
  and a `Vrsta zapisa` line repeating that in the evidence block. Without this the template lays
  out an empty structured day — no work, no materials — which reads as "nothing happened".
- **It is a rendering difference, not a pipeline difference.** Photos, GPS, timestamps, the
  photo-checksum verification and the whole B6 report state machine are untouched.
- **The flag alone is a claim, not content.** `described_verbatim` with a blank `notes` is still
  `nothing_to_report` and the page announces no transcript it does not have. Only a real JSON
  `true` counts — this key is read strictly while the rest of the document is read forgivingly,
  because it changes what the document claims about its own provenance.
- The eval triple stays honest: `raw_transcript` and `structure` are untouched, and `corrected`
  recording approval-as-is is distinguishable from a foreman having typed the day.

### Entry state machine

Client-side (Dexie) and server-side states are **deliberately different vocabularies**; conflating
them is how sync bugs are born.

```
phone:   draft ──► queued ──► uploading ──► confirmed_by_server ──► (safe to prune locally)

server:  received ──► processing ──► awaiting_confirmation ──► confirmed ──► reported
                          │                                          
                          └──► needs_review   (STT or extraction failed — entry NEVER lost,
                                               raw transcript/audio shown to the human instead)
```

Rules that fall out of this:
- The phone deletes nothing before `confirmed_by_server`, and even then only after a grace period.
- `POST /entries` with an id that already exists returns the current state with **200**, not a
  conflict — retries must be free.
- Once `reported_at` is set the row is immutable: enforced in the application layer *and* by
  Postgres triggers rejecting both UPDATE and DELETE. Corrections insert a new entry with
  `supersedes_entry_id`.
- **`received_at` means "the server holds the complete entry"** — stamped by a successful
  `/complete` (all declared media verified), **not** by `POST /entries` (decided at B3, review
  F1/F9). Once stamped, the evidence set is sealed: further `/media` declarations are rejected
  (409) and `/complete` replays return the recorded state without re-verifying. **B4's pickup
  predicate is `status = received AND received_at IS NOT NULL`.**
- `media.upload_status` vocabulary: `pending` (declared, not yet seen in storage) → `verified`
  (present with the declared size) or `failed` (present but wrong size). `uploaded` is reserved
  for a future client-reported hint and is currently unused.
- **`processing_started_at` is the claim, and the claim is the authority** (B4). The move
  `received → processing` is one conditional UPDATE that stamps it; a second worker handed the
  same entry sees zero rows affected and goes away. The sweeper parks anything still `processing`
  after `Pipeline:StaleProcessingAfter`, which is the only way an entry abandoned by a crash or a
  deploy becomes visible again.
  **Every terminal write in the pipeline is conditional on the row still being `processing`**
  (B4 review, F1). Without that, a pass that outlived the stale window — one provider brownout is
  enough — would be parked by the sweeper, confirmed by the foreman, and then dragged back to
  `awaiting_confirmation` by its own late worker, silently dropping a confirmed entry out of the
  set reporting draws from. A pass that no longer holds the claim writes nothing and reports
  `Skipped`. `StaleProcessingAfter` must therefore always exceed the worst-case pass; the
  arithmetic is spelled out on the option and checked by a test.

### Report state machine (B6)

```
report:  (no row) ──► sending ──► sent      (entry becomes `reported`, and is sealed)
                         │
                         └──────► failed    (nothing left the building, or the relay refused)
                                     │
                                     └──► sending   (a later pass reclaims it)
```

**The row is the claim, and it is created as late as possible.** Everything reversible happens
first — read the entry, verify every photograph's SHA-256, lay out the PDF, store it. Only then
is the row inserted, and only then is the relay called. `ux_report_entry_id` means two concurrent
passes cannot both get there: the loser takes a unique violation and sends nothing, having wasted
a render. This is why there is no `rendering` state — until the PDF exists, nothing has happened
that anyone outside the process could observe, and a claim guarding nothing is a row that strands.

Rules that fall out of it:

- **`reported_at` is stamped only after the PDF is in storage *and* a relay has accepted the
  message**, and it is stamped conditionally (`WHERE status = 'confirmed' AND reported_at IS
  NULL`). The stamp is irreversible — the trigger makes the row immutable and undeletable — so
  nothing may stamp it on the strength of an intention. A refused delivery leaves the entry
  `confirmed` and therefore still correctable.
- **Every terminal write in the report pass is claim-conditional**, exactly as in B4: the report
  row must still be `sending`, the entry must still be `confirmed` and unreported. A pass that
  lost its claim writes nothing.
- `sent_at` means **the relay took custody**, never that a person received it. SMTP gives no
  bounce and no delivery telemetry (§10); `delivery_detail` holds the relay's own response line,
  which is the strongest claim this system can honestly make.
- **A report abandoned mid-send is never re-sent automatically.** The sweeper moves it to
  `failed` with `report_interrupted` after `Reporting:StaleAfter` and stops. Because SMTP tells us
  nothing, the server genuinely cannot say whether the client has that report; guessing "no" puts
  a second copy of a site diary in an investor's inbox and guessing "yes" seals an entry that was
  never sent. It says what it knows and a person decides.
- **Custody-unknown is a class, not a single state, and nothing automatic may resolve it** (B6
  review G1/G1b). Two reasons carry it: `report_interrupted` (the pass died anywhere) and
  `delivery_custody_unknown` (the SMTP conversation broke *after transmission began* and the relay
  never answered — a content scanner slower than the budget, a reset after acceptance). Both are
  refused by three independent guards, because the promise above was previously enforced only
  against the sweeper: **(1)** a replayed `/confirm` neither clears such a reason nor re-queues —
  a wire retry is not a person; **(2)** the report pass refuses before it renders and writes the
  reason back onto the entry, so a *changed* re-confirmation cannot launder it into a resend
  either; **(3)** the reclaim UPDATE excludes those reasons in the same statement as the claim, so
  the check cannot be raced. An explicit resend must therefore take a gesture no network retry can
  carry — **the founder owns that decision and it is not built**.
- **A changed confirmation is refused (409) while a report row is `sending`**, and a pass that
  finds `corrected` changed after taking its claim releases the claim (`superseded`) and sends
  nothing (B6 review G3). "A person can revise his answer up until the report goes out" is only
  true if enforced: without this, a foreman correcting his own typo twenty seconds after
  confirming ends with v1 in the client's inbox and v2 sealed in the archive — the contractor's
  own record contradicting the report he sent. The endpoint check alone is not enough: the claim
  is created as late as possible, so the whole render is a window it cannot see.
  **Trade-off, accepted:** if a pass dies holding the claim, that 409 stands until the sweeper
  marks the row failed — up to `Reporting:StaleAfter` (30 min) — during which a correction is
  told to come back later. A rare crash window against a routine correctness hazard.
- **A `sent` report whose entry was never sealed is swept up.** The report-enqueue predicate is
  `r.id IS NULL OR r.status IN ('failed','sent')`; without `sent`, a crash between recording the
  hand-over and stamping `reported_at` left the client holding a report the contractor's archive
  said was never sent, permanently and silently (B6 review G2). The pass seals such a report, it
  never re-sends it.
- **The report sweep only picks up entries with no `failure_reason` at all** — i.e. nothing has
  gone wrong that anyone was told about, so the only explanation is a lost enqueue. Anything that
  failed with a reason waits for a person, the same call B4 made for `needs_review`. The retry
  path is fixing the cause and confirming again: **`/confirm` clears `failure_reason` and
  re-queues the report even on a replayed, byte-identical confirmation**, because the realistic
  retry (a recipient added, a relay configured) changes nothing about the entry itself.

### Verification obligations B3 hands to B4 and reporting (review F3 — binding)

`/complete` verifies existence + byte size only; the API never reads media bytes. Therefore:
- **B4 must verify the audio's sha256** when it downloads it for transcription; mismatch parks the
  entry in `needs_review` — never silent.
- **Report generation must verify each photo's sha256** before embedding it in a PDF. **Done at
  B6**, and a mismatch refuses the *whole* report rather than dropping the one exhibit — this
  document is what a contractor hands a client in a dispute, and quietly omitting an image would
  make every other page less trustworthy. One implementation serves both obligations
  (`VerifiedMediaReader`), so the promise cannot hold for audio and lapse for photographs.
- **B4 must handle entries with zero media** (allowed at `/complete` to keep the typed-shorthand
  fallback open): an entry with no audio and no text parks in `needs_review`, never flows into a
  report empty.

---

## 7. API surface (M0)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/projects` | projects visible to this device |
| `POST` | `/api/entries` | create entry from client UUID → **202**, returns upload targets. Idempotent |
| `POST` | `/api/entries/{id}/media` | request presigned PUT URLs for audio/photos |
| `POST` | `/api/entries/{id}/complete` | all uploads finished → enqueue processing |
| `GET` | `/api/entries/{id}` | status, `raw_transcript`, extracted structure, `failure_reason` (client polls this) |
| `POST` | `/api/entries/{id}/confirm` | human-approved structure → enqueue report |
| `GET` | `/api/entries` | archive list, filtered by project and date range |
| `GET` | `/health` | liveness for the deploy |
| — | `/hangfire` | job dashboard, behind auth |

**Polling, not SignalR.** Processing takes roughly 20–60 seconds and exactly one screen cares.
A 3-second poll is a handful of lines; a realtime transport is a dependency. Revisit only if the
UX proves it.

**`raw_transcript` is on the poll response** (B4). It is what makes "extraction failed" survivable
rather than a dead end: the foreman still gets his own words back on the confirmation screen and
can type the rest himself. It is never overwritten by anything the human does — `raw_transcript`,
`structure` and `corrected` stay three separate columns (§9.3).

**`/hangfire` auth.** Basic auth from `Hangfire:DashboardUser` / `Hangfire:DashboardPassword`.
With **no credentials configured the dashboard serves loopback requests only** — which is exactly
the laptop case, and means a staging box that forgets to set them gets an unreachable dashboard
rather than an open one. Set both in staging (B3a).

---

## 8. Media pipeline

1. Phone captures, extracts metadata **before** compressing, then compresses (photos).
2. Phone computes SHA-256 of the bytes it will actually upload, stores it locally with the record.
3. Phone asks the API for a presigned PUT URL per file — **15-minute TTL, PUT only, exact object
   key**, no wildcards.
4. Phone uploads directly to object storage, then reports success to `/complete`.
5. Server verifies **existence and size** against what the phone declared (checksums are verified
   where the bytes are actually read — B4 for audio, report generation for photos; see §6).
   `/complete` distinguishes `pending` (not yet in storage) from `failed` (present, wrong size).
   A successful `/complete` stamps `received_at` and **seals the evidence set** — later media
   declarations are rejected (409).

**Media limits (as built, B3):** 1 audio per entry, ≤ 20 photos, 21 media total (the total cap is
an invariant guard so raising a per-kind cap can never silently unbound verification). Audio
≤ 25 MB, photo ≤ 10 MB.

**Storage verification is time-budgeted:** the whole `/complete` verification pass runs under
`Storage:VerificationBudget` (10 s default) with per-call timeout and `Storage:MaxRetries = 0`;
unreachable storage returns **503 + Retry-After** and never writes a verdict on any media row.
These knobs live beside `Storage:UploadUrlTtl` (15 min) in configuration.

**There is no read path for media, and that is now a known gap (found at C3, 2026-08-29).** §8
describes uploads only: the phone gets a presigned **PUT** and the API never serves bytes. So a
device that did not capture an entry cannot display its photos at all — the archive can report the
count and say the files are on the server, but an owner opening the diary on a tablet sees no
evidence. That is precisely the buyer's reason to pay (PROJECT.md §2). Closing it needs a presigned
**GET** (short TTL, exact key, same tenancy check) or a media proxy endpoint; the presigned GET is
the cheaper option and keeps bytes out of the API, consistent with the topology rule in §2. Needed
by **M1-C3** for the owner view and by **M2** for the client-facing web view; the report generator
(B6) reads bytes server-side and is unaffected.

**There is one write path, added at B6, and it is not media.** `IObjectStorage.PutAsync` stores
the generated report PDF. A report is the one artefact the server *produces* rather than receives,
so there is no presigned PUT to hand anybody; it is written from a Hangfire job, never from a
request the phone is waiting on, and the §2 rule that media never passes through the API is
untouched. The key is derived from the entry rather than from the report row's id, so a pass that
failed before delivery and is run again overwrites its own output instead of leaving an orphan
object nobody will fetch and everybody pays to store.

**Object key layout** (no personal data in keys, ever):

```
company/{companyId}/project/{projectId}/entry/{entryId}/{mediaId}.{ext}
company/{companyId}/project/{projectId}/entry/{entryId}/report.pdf
```

(The PDF's *attachment file name* does carry the site and the date, folded to ASCII — that is for
a human who already has the report, and is a different thing from a key.)

**Upload order:** entry JSON → audio → photos one at a time. The report only needs the audio, so
processing can start while photos are still climbing over a bad connection.

---

## 9. AI pipeline

Two external calls, both from Hangfire jobs, both behind interfaces so a provider swap is a
one-file change.

### 9.1 Transcription

```csharp
public interface ITranscriptionProvider
{
    Task<TranscriptResult> TranscribeAsync(
        Stream audio, TranscriptionContext context, CancellationToken ct);
}

// context carries: language "sr-RS", project vocabulary (work items, worker names, materials)
// as recognition hints where the provider supports them
```

Provider is **undecided on purpose** — roadmap A3 decides it from real site audio, not from
marketing pages. Candidates to benchmark: OpenAI Whisper API, Azure AI Speech (`sr-RS`, supports
phrase lists), Google Cloud STT, ElevenLabs Scribe, and self-hosted `whisper large-v3` as the
cost/control floor. Judge them only on the words that carry money: work items, quantities, names.

### 9.2 Structure extraction (Claude)

Official Anthropic .NET SDK (`dotnet add package Anthropic`), called from
`Teren.Infrastructure`. Shape of the call:

```csharp
using Anthropic;
using Anthropic.Models.Messages;

var response = await client.Messages.Create(new MessageCreateParams
{
    Model = options.ExtractionModel,          // "claude-sonnet-5" — config, never hardcoded
    MaxTokens = 4000,
    Thinking = new ThinkingConfigAdaptive(),
    System = new List<TextBlockParam>
    {
        new() { Text = extractionInstructions,   // stable prefix
                CacheControl = new CacheControlEphemeral() },
        new() { Text = projectVocabulary },      // per-project, volatile → after the breakpoint
    },
    OutputConfig = new OutputConfig
    {
        Format = new JsonOutputFormat { Schema = EntryStructureSchema.V1 },
    },
    Messages = [ new() { Role = Role.User, Content = transcript } ],
});
```

Decisions embedded above, and why:

- **Structured outputs (`OutputConfig.Format`), not prompt-and-pray.** The response is validated
  against the v1 schema server-side, so the pipeline never has to parse hopeful JSON.
- **Adaptive thinking**, the current mode for this model generation. `budget_tokens` is gone and
  returns a 400 on current models — do not carry that pattern in from older code.
- **Model comes from config.** Start on **Sonnet 5**; the extraction task is short-transcript
  normalisation, which it should handle comfortably, and lower latency matters because a human is
  waiting. Escalate to Opus 5 if the eval set shows Serbian trade jargon slipping. Per-entry cost
  is about **$0.008 on Sonnet 5 versus $0.02 on Opus 5** — against €30–80 per site per month, both
  are noise, so this choice is settled by measured quality, never by price (PROJECT.md principle).
- **Canonical-name mapping happens inside this call**: the project vocabulary is passed as
  context and the model is instructed to normalise variants to canonical names. A separate mapping
  stage is only worth building if the evals show the single call failing.
- **Failure is never data loss.** If extraction fails after retries, the entry moves to
  `needs_review` with the raw transcript intact and visible. The human still gets his evidence.

### 9.3 The quality loop (free, if we do not throw the data away)

Every confirmation produces a **(transcript, extracted, corrected)** triple. Stored in
`entry.raw_transcript` / `structure` / `corrected`, these become fixtures in `evals/`. Before any
prompt or model change ships, a console runner replays the fixtures and reports where extraction
got better or worse. This costs one JSONB column now and is the only thing that makes prompt
changes safe later.

---

## 10. Other external services

| Service | Choice | Rationale |
|---|---|---|
| Weather | **Open-Meteo** | Free, no API key, historical archive by lat/lon/date — exactly the shape we need |
| Email | **SMTP via MailKit** (decided 2026-08-29; MIT licence) behind `IReportDelivery` | Protocol, not a vendor SDK — the relay stays swappable, and every transactional provider offers an SMTP endpoint if one is wanted later. **The relay host is still open**, and it matters: sending straight from the VPS is the one option to avoid (Hetzner blocks outbound port 25 by default and fresh VPS IPs have poor reputation, so reports land in spam). Use an authenticated relay, and configure SPF + DKIM + DMARC on the sending domain. Note SMTP gives no bounce or delivery telemetry — for an evidence product, *sent* is not *received* |
| Object storage | MinIO locally, Hetzner Object Storage in production | S3-compatible both sides, so one client and no code difference |

Each sits behind an interface (`IWeatherProvider`, `IReportDelivery`) for the same reason as STT.

**Built at B6.** `SmtpReportDelivery` (MailKit) behind `IReportDelivery`, configured from a
`Reporting` section: `Reporting:FromAddress`, `FromName`, `ReplyToAddress`,
`Reporting:Smtp:{Host,Port,Security,Username,Password,Timeout,ConversationBudget}`, plus
`RenderBudget`, `StaleAfter`, `PhotoRasterDpi` and `AttachmentSizeWarningBytes`.

**`Smtp:Timeout` bounds one protocol operation; `Smtp:ConversationBudget` bounds one attempt**
(B6 review N1). MailKit's timeout applies per command — greeting, AUTH, MAIL FROM, one RCPT TO per
recipient, DATA, the content upload — so multiplying it by the attempt count described a healthy
pass rather than bounding any pass, and three slow attempts could outrun `StaleAfter`.
`SmtpReportDelivery` enforces the conversation budget (3 min, vs a 1 min per-command timeout) with
a linked `CancellationTokenSource`, and `WorstCasePass` is computed from it: 5 min render + 3 × 3
min delivery + backoff ≈ 14.1 min against a 30 min `StaleAfter`. An **absent relay host does not stop the host
booting** — capture and upload need no mail server — it stops confirmed entries with a visible
`delivery_not_configured`, exactly the policy the AI keys get. Failures are classified on the
exception's **type and SMTP status code**, never on the relay's banner: 5xx and an unusable
address are terminal (`delivery_rejected`), a refused credential is terminal
(`delivery_unauthorized`), 4xx / socket / TLS / timeout are retryable.

**The relay host is still the open sub-decision** (Resend vs Postmark vs other). Locally,
`docker compose` runs **Mailpit** on `localhost:1025` with its inbox at `http://localhost:8025`,
which makes the whole PDF-and-email path provable before any relay account exists. Mailpit rather
than MailHog: actively maintained (MailHog's last release was 2020), MIT, it shows the HTML and
text alternatives side by side — which is what needs checking on a report read on a phone — and it
can be told to require SMTP authentication, so the *authenticated relay* shape production will
run on is exercised locally rather than only anonymous localhost SMTP. Swapping in a real relay is
`Reporting:Smtp:*` and nothing else.

**Failures are classified on where in the conversation they happened, not only on their type**
(B6 review G1b). A relay that answers — any `SmtpCommandException` — is never ambiguous: 5xx is
`delivery_rejected`, 4xx is retryable, a refused credential is `delivery_unauthorized`. A relay
that *stops answering* is judged by position: before the message transaction begins (connect,
greeting, AUTH) it is retryable; once transmission has begun it is `delivery_custody_unknown` and
the pass stops, because a relay may have taken the message and failed to say so, and every retry
of that is another copy in a real inbox. The rule is deliberately over-inclusive — a protocol
fault at MAIL FROM is caught by it too — because the cost of over-caution is a person clicking
resend and the cost of under-caution is an investor holding three copies of the same day.
Every message also carries a **stable `Message-ID` derived from the report row**
(`report.{report_id}@{sending domain}`), identical across retries and reclaims, so a receiving
server can collapse duplicates. That is the only duplicate suppression SMTP offers.

**Config for the two services B4 wired up** — full key list in §4. `Stt:Azure:{Key,Region}` and
`Anthropic:ApiKey` are secrets and are the only settings whose absence is tolerated at start-up.
`Anthropic:Model` is configuration, never a constant in code (§14 decision 3).

**No SDK retries under the pipeline.** Both adapters run with their client's own retry loop
turned off — `AnthropicClient.MaxRetries = 0`, `Storage:DownloadRetries = 0` — because the
processor already owns retry policy through `Pipeline:MaxAttempts` and is the only layer that can
write an honest `failure_reason`. Two stacked retry loops do not make a call more likely to
succeed; they multiply the worst-case wall-clock of a pass, invisibly, until it outruns
`Pipeline:StaleProcessingAfter` (§6). Any new external adapter follows the same rule.

---

## 11. Offline and sync

The phone is the source of truth until the server confirms (PROJECT.md principle 3).

**Dexie stores:** `entries`, `media`, `outbox`. The outbox drives every network operation.

**Sync loop:** on app open, on connectivity regained, and on a timer — take the oldest outbox
item, attempt it, apply exponential backoff with jitter on failure, never block the UI. Attempt
only when the OS reports connectivity.

**Web platform limits, planned around rather than discovered later:**

- **No background upload.** When the tab closes or the phone locks, uploads stop; iOS has no
  Background Sync at all. Mitigation: an explicit "uploading — don't close this" state and
  resumption on next open. This is the strongest argument for a native shell later, and only real
  user pain should trigger that move.
- **Storage eviction.** iOS evicts data for sites unused for long stretches. Mitigation: prompt
  Add-to-Home-Screen, keep local retention short once the server has confirmed.
- **Quota.** Photos dominate; prune confirmed entries' local media after a grace period.

---

## 12. Security and tenancy

- **Tenancy:** every table carries `company_id`; EF global query filters apply it automatically.
- **Presigned URLs:** 15-minute TTL, single object key, PUT only. No listing, no wildcards.
- **Immutability:** application check plus a Postgres trigger blocking UPDATE on entries with
  `reported_at IS NOT NULL`. Evidence value depends on this being mechanical, not conventional.
- **Auth, honestly staged:**
  - *M0 (demo):* a static device token baked into the build. This is a **deliberate temporary
    compromise for the distributor demo, and no real customer data goes into that environment.**
  - *M1:* join codes bind a device to a project and issue a per-device token (roadmap C5) — still
    no login screen, because a foreman with muddy hands will not type a password.
  - *M2:* real accounts and roles, when there are customers who are not friends.

### Identity model (planned; each table lands with the increment that uses it)

There is deliberately no user/profile table in the B1 schema — B2–B4 have no one to authenticate.
Two tables arrive later, both tenant-scoped under `company` like everything else:

```sql
-- C5 (M1): who is this phone? Identity of the DEVICE, not a person.
device (id uuid PK, company_id → company,
        project_id → project,          -- what the join code bound it to
        name text,                     -- "Zoranov telefon"
        token_hash text,               -- per-device bearer token, hashed
        created_at, last_seen_at, revoked_at timestamptz null)

-- M2: who is this person? Owners log in; foremen mostly keep using bound devices.
app_user (id uuid PK, company_id → company,
          email text UNIQUE, password_hash text,
          display_name text, role text,          -- owner | office | foreman
          language text NOT NULL DEFAULT 'sr',
          created_at, last_login_at, disabled_at timestamptz null)
```

How they relate: `entry.device_id` (already in the B1 schema) records provenance — which phone
captured the evidence — and keeps meaning even after accounts exist. A `device` may later gain an
optional `app_user_id` when a company wants entries attributed to named people; that link is
nullable on purpose, because the foreman's phone is bound to a *project* first and a *person*
second. The two identities serve different questions: `device` answers "is this phone allowed to
write into this project", `app_user` answers "who may see, confirm, and administer".

Why not create these tables now: the columns depend on decisions not yet made (password vs. magic
link, whether foremen ever log in at all). Speculative schema is churn; the shape is recorded here
so the design (welcome/login screens) and the schema stay aligned, and the migration is written
when C5 respectively M2 starts.
- Personal data stays out of URLs, object keys, and logs.

---

## 13. Operations

### Environments

Three, and the reason there are three is that **this product cannot be judged in a desktop
browser**. Voice recording (`MediaRecorder`), camera capture, Geolocation, the service worker and
add-to-home-screen all require a real device on a **secure origin**. A laptop tells you the logic
compiles; only a phone tells you the product works.

| Environment | What it is | From | Purpose |
|---|---|---|---|
| **Local** | `docker compose up` + `dotnet run` + `ng serve` on the founder's machine | B0 | Fast loop; API and data logic |
| **Phone-testable dev** | The local stack exposed over HTTPS through a tunnel | B0 | The founder opens the app on his own phone the same evening something is built |
| **Staging** | Small VPS running the same compose stack at a stable subdomain | B3a | Runs continuously without the laptop; where background jobs, email and the demo actually get exercised |
| **Production** | Same stack, `teren.rs`, backups and alerting | C7 | Real customers |

**The tunnel needs a stable *https* hostname, not a random one — and https is not optional.**
Uploads compute a SHA-256 per file with `crypto.subtle`, which exists **only in a secure context**.
`https://`, `http://localhost` and `http://127.0.0.1` qualify; a plain-http tunnel or
`http://192.168.1.x` does **not**, and it fails by being `undefined` rather than throwing — so on a
plain-http origin nothing uploads and the cause is nowhere near the symptom. The PWA detects this
up front and reports it as a terminal `insecure_context` state rather than a mystery. Beyond the
scheme, the hostname must also be stable: IndexedDB, the service-worker
registration and the installed home-screen app are all scoped to the origin, so a tunnel URL that
changes on every restart silently wipes local state between sessions — which makes testing the
offline queue meaningless, since that is precisely the thing that must survive. Use a tool that
gives a fixed hostname (ngrok's free tier includes one static domain `[to verify at signup]`; a
Cloudflare named tunnel is the alternative once a domain exists).

**Why staging arrives at B3a and not at the end:** from B4 onward the interesting behaviour is
asynchronous — Hangfire jobs, transcription and extraction calls, email delivery. The founder
needs to record an entry, put the phone down, and check the result later. That requires the stack
to be up when his laptop is not.

**Data rule:** staging carries seeded demo data only. No real customer entry goes into any
environment before device binding (C5) and production hardening (C7).

### Deployment and monitoring

- **Deployment:** single Hetzner VPS, `docker compose` (api, postgres, caddy), **Caddy** for
  automatic TLS. Object storage is managed and external. Staging and production are the same
  compose file with different environment variables — if they diverge, staging stops being
  evidence about production.
- **Backups:** nightly `pg_dump` to object storage, 30-day retention. A restore rehearsal is part
  of C7 — an unrehearsed backup is a rumour, and this product's whole promise is that evidence
  survives.
- **Monitoring:** `/health`, Hangfire dashboard behind auth, Serilog to stdout with the entry id
  on pipeline lines, and email alerts on failed jobs. No observability platform until something
  actually hurts.

---

## 14. Open technical decisions

| # | Decision | Needed by | Note |
|---|---|---|---|
| 1 | ~~STT provider~~ **Decided 2026-08-29: Azure AI Speech, `sr-RS`, fast-transcription REST** | — | See `docs/stt-evaluation.md`. Note the basis is one 18 s test clip, not real site audio (A2 deferred). Phrase-list hinting proved **inert for `sr-RS`**, so the original reason for preferring Azure over Whisper did not hold; `sr-RS` first-class support is the surviving ground |
| 8 | ~~Transcript script~~ **Decided 2026-08-29: Latin everywhere.** Azure returns Cyrillic, so the pipeline transliterates once at ingestion and stores `raw_transcript` in Latin | — | Cyrillic→Latin is lossless and deterministic **in that direction** (the reverse is not — `nadživeti` is ambiguous). One tested pure function, idempotent on text that is already Latin, correct on the digraphs љ→lj, њ→nj, џ→dž. **The audio remains the untouched raw evidence** and the transcript can always be regenerated from it, which is what keeps principle 2 honest |
| 2 | ~~Email provider~~ **Decided 2026-08-29: SMTP (MailKit) behind `IReportDelivery`**; built at B6 | B3a | Remaining sub-decision: **which relay**. B6 no longer blocks on it — Mailpit locally proves the path, and swapping in a relay is `Reporting:Smtp:*` only. Needed for real before staging sends anything to a real address. Not direct-from-VPS — see §10 |
| 3 | ~~Extraction model (Sonnet 5 vs Opus 5)~~ **Now a config switch, not an open question (B4)** | after first evals | `Anthropic:Model`, never hardcoded. Ships on `claude-sonnet-5`; moving to Opus 5 is one environment variable and no code. What remains open is only *which* — decided by measured quality on the correction triples (§9.3), never by price |
| 4 | Audio container on iOS | B2 | Verify what a real iPhone actually records; server-side normalisation if needed |
| 5 | ~~QuestPDF licence tier~~ **Decided 2026-08-29 (B6): Community**, declared in code (`QuestPDF.Settings.License`) | revisit before USD 1M revenue | Terms re-read at adoption and the old note here was wrong in kind — it is a source-available *commercial* licence, not MIT. Free under USD 1M annual gross revenue, consolidated. See §1 |
| 6 | ~~PDF typography~~ **Decided 2026-08-29 (B6): Lato**, which ships inside the QuestPDF package and therefore travels with the app | — | Covers Serbian Latin in full and serves the English template unchanged. `UseEnvironmentFonts` is **off** so the founder's Windows machine and a Hetzner container render identically, and `CheckIfAllTextGlyphsAreAvailable` is forced **on** (QuestPDF enables it only under a debugger) so a glyph the font cannot draw throws instead of becoming a placeholder box in a PDF already in an investor's inbox |
| 7 | Serbian copy review | B5 | Translations are written by Claude and **must be reviewed by the founder** — a native check on trade vocabulary, not just grammar |

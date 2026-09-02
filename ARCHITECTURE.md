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
├── deploy/                     # B3a — Dockerfiles, compose, Caddyfile, deploy.sh, backup + CORS scripts
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
else required (`Storage`) still refuses to boot when empty (`ValidateOnStart`). **`Auth:DeviceToken`
is optional** (it has been since the token flip, and 2026-09-02 made that explicit): it is only the
demo device's server-side credential, `seed` provisions no phone without it, and the host logs one
NOTE at start-up. `Logging:ClientEvents:RateLimitPerMinute` (60) bounds `POST /api/client-events`
per client address plus a hash of the presented bearer, because that limiter runs before any
credential is checked and a single looping phone must not evict the server's own error lines from
the log queue.

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

### Tables — one control at the head of every column (2026-09-02)

Every list of rows in the product (`/company`, `/platform`, `/platform/companies`) is built from
three shared pieces rather than a per-screen implementation. This is a founder rule in the same
sense as the layout one: **a fourth table inherits the behaviour, it does not re-implement it.**

| Piece | Where | What it owns |
|---|---|---|
| `ui/table-controls.ts` | a `TableControls<K>` per screen | the sort (column + direction, with a useful default direction per column) and the per-column filters, plus Serbian-aware folding for matching |
| `ui/column-menu.ts` | inside every `<th>` from 768 up, and as a pill in the compact list's control bar | the label (one tap sorts), the funnel beside it, and the menu: both directions **named in words** per column kind (`text` / `date` / `state` / `number`) and that column's filter box |
| `.data-table`, `.table-bar`, `.column-bar` in `styles.css` | the three screens | the furniture: the zero-padded header cell the control fills (`--col-pad` crosses the component boundary), the "showing 3 of 12 / show all" strip, the phone's control bar |

Rules that are not negotiable per screen:

- **A filter matches the text the cell shows**, not the field behind it — which is what lets one box
  serve a name, a date and a row of status chips without any column declaring a type. Screens
  translate their own chips to produce that text, and re-run it on a language change.
- **A live filter is loud.** The funnel is tinted on the column, and the strip above the list says
  how many of how many are drawn with one tap back to all of them. A table quietly showing one of
  twelve rows is the state in which a screen can make an owner believe a foreman was removed from
  his company.
- **The sort and the filter never enter the URL.** They are ways of looking at a list, not places in
  the app: a query parameter per keystroke would re-run the route guard and re-read the whole list.
- Filtering happens on the client, over a list already fetched whole. It stops being right when the
  server stops sending the whole list; the filter then moves into the query and `TableControls`
  keeps its shape.
- **That case arrived one increment later, on `/platform/logs` (D5), and the shape held**: the same
  `column-menu` sits in every head, but its output drives the *query* rather than a `computed` over
  rows in hand. The one thing that could not come with it is the count strip. Every other table
  says "showing 3 of 12" because it holds all twelve; a keyset-paged stream holds one page and does
  not know the total, so the log screen says how many lines are loaded and whether the server is
  holding more behind them — and never a total. A screen that guessed one would be committing the
  exact deception the loud-filter rule above exists to prevent, on the one screen a founder opens
  because he already suspects something is wrong.

### Telemetry — what was clicked (D5)

`core/telemetry` records the action vocabulary (`area.thing.verb`) to `POST /api/client-events`:
route entries, explicit calls at the moments that matter, and a global capture-phase click listener
for breadth. It buffers in a bounded Dexie store and flushes in batches.

**Its privacy boundary is `action-descriptor.ts`, and it is structural.** A descriptor is built from
a declared `data-log` slug, the element's tag, and its class names — **never `textContent`,
`aria-label`, `title` or `value`**, because every one of those is a translated user-facing string and
some of them carry a project name or a site address. Reading one would ship a customer's commercial
data into the table Teren staff read. A spec scans the file for the four forbidden accessors, since a
future edit reaching for `textContent` "to make the logs readable" is the change that would look like
an improvement.

Two rules keep it away from the money path: it never blocks or throws into a click handler, and it
drops quietly when the endpoint or the network is gone. Evidence leaving the phone always outranks
knowing that a button was pressed.

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

Since D1 the seed also provisions identity rows on the same prefix: `…0000000000a1` the demo
company_admin (Miloš Petrović, **no password** — no seeded credential exists anywhere), `…0000000000a2`
the demo worker (Zoran Jovanović), and `…0000000000dd` the demo **device**, which was previously a
dangling uuid on `entry.device_id` with no table behind it.

Since F4 the seed also mints **one fixed activation code for the demo worker — `DEM0-TEST`** — and
that string is part of this contract. F4's `canMatch` gate sends a phone with no stored session to
`/welcome`, and until F6 there is no screen that can issue a code, so without a seeded one a fresh
install cannot reach the record button at all. `seed` re-mints it whenever it has been spent or has
expired, exactly as it clears the three withdrawal stamps. Two consequences worth stating plainly:
redeeming it **revokes the demo device** (one worker, one live phone), which `seed` then heals; and
it is a working credential to the demo company that is published in this repo, which is fine on a
laptop and is an open decision for B3a's public URL.

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
updated — **with one deliberate exception, the demo device row.** Its `token_hash` is derived from
`Auth:DeviceToken` rather than being demo content the founder might have edited, so it is upserted:
a stale hash after a token rotation would make `seed` report success while every phone got a 401
with nothing anywhere saying why. A no-change re-seed still reports zero rows.

**Demo reset (B7):** `dotnet run --project src/Teren.Api -- reset-demo --yes-delete-demo-data`.
Because the seed is idempotent *per row*, it can add what is missing but can never undo a demo:
each demo the distributor gives leaves a real entry behind ("test test", a photo of a desk) which
is confirmed, reported and then **sealed permanently** by `trg_entry_guard_delete`. Ten demos
later the archive is junk with the three good Serbian entries buried in it. `reset-demo` deletes
everything belonging to the demo company and re-seeds it, in one transaction.

- **Guarded three ways.** The word `reset-demo` has to be typed (no ambient default); the host has
  to be a demo host — `ASPNETCORE_ENVIRONMENT=Development` **or** `Demo__ResetEnabled=true`, the
  latter because staging runs as `Production` (§13) and the environment name alone cannot tell the
  demo box from a real one; and `--yes-delete-demo-data` has to be given. Without the flag the
  command reports what it *would* destroy and exits 2 without touching anything. `--dry-run` does
  the same and exits 0. A host that has declared nothing is refused before it even reads.
- **Company scope is asserted, not trusted.** Every statement is `WHERE company_id = <demo>`, and
  the row counts of every *other* company are compared before and after the deletes inside the
  same transaction; one row of difference rolls the whole thing back.
- **The immutability guard comes back with the data.** Only `trg_entry_guard_delete` is stood
  down, only inside the transaction, and it is re-enabled and then re-read from `pg_trigger`
  before the commit. `ALTER TABLE … DISABLE TRIGGER` is transactional DDL, so *any* failure
  between the disable and the commit restores the trigger together with the rows.
  `trg_entry_guard_update` is never touched — the reset deletes and re-seeds, it never edits.
- **Delete order** is reports → media → entries → sites → company, because `fk_media_entry`,
  `fk_report_entry` and `fk_entry_project` are RESTRICT rather than CASCADE. Entries are peeled
  leaf-first, because `fk_entry_supersedes_entry` is RESTRICT too and a correction chain (C4)
  would otherwise fail on whatever order Postgres happened to choose.
- **Objects and jobs are dealt with after the commit**, because neither is transactional.
  Everything under `company/<demo-company-id>/` is removed from the bucket — orphaned bytes have
  no row left to be evidence for, and nothing else in the system ever deletes them. Pending
  Hangfire jobs (enqueued/fetched/scheduled/processing) are deleted; the recurring sweep and the
  job history are left alone. Deleting all pending work is safe because the only two enqueue
  paths produce states `PipelineSweeper` re-picks up within the minute, so the purge can delay
  work but cannot lose it. Committing before sweeping is deliberate: the worst case is leftover
  objects, which the next reset removes — never bytes destroyed for rows that still exist.
- **Idempotent**, and it ends by printing rows removed, objects removed, jobs removed, the final
  state (including the site ids) and the guard's real state.

The two destructive seams — `IDemoObjectPurge` and `IDemoJobPurge` — are registered in the
container **only** when the process was started with `reset-demo`. The running API therefore has
no injectable way to erase an object or cancel a job at all: no endpoint, no job, no accident.

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
- **A `sent` report whose entry was never sealed is swept up — and sealed only if the entry still
  holds what went out.** The report-enqueue predicate is `r.id IS NULL OR r.status IN
  ('failed','sent')`; without `sent`, a crash between recording the hand-over and stamping
  `reported_at` left the client holding a report the contractor's archive said was never sent,
  permanently and silently (B6 review G2). The pass seals such a report, it never re-sends it.
  **The seal is conditional on content (2026-09-02):** the 409-while-`sending` check and the
  post-claim re-read of `corrected` leave one window — a confirm whose check ran before the claim
  and whose write landed after the re-read — in which the old code stamped `reported_at` on
  content that never left. `SealAsync` now stamps only `WHERE corrected = <the document that was
  rendered>` (jsonb equality, so a re-serialisation of the same document still seals), and every
  claim records `report.corrected_sha256` so the recovery pass in another process can make the
  same comparison without the document. Zero rows means a person changed the record after the
  relay took custody: the entry gets the **terminal** reason `superseded_after_send`, the report
  row keeps its truthful `sent`, and it is logged as critical. Terminal because `ux_report_entry_id`
  plus the absence of `sent → sending` means the newer content can never get its own report — the
  documented answer is a new entry with `supersedes_entry_id`. Pre-column rows (no hash) seal
  unconditionally, logged as such.
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
| `GET` | `/api/entries/{id}/media/{mediaId}` | stream one photo or voice note — authenticated bytes, never a presigned GET (§8) |
| `GET` | `/api/entries/{id}/report` | stream the PDF that was sent (B6) |
| `GET` | `/health` | liveness: Kestrel answers, nothing more |
| `GET` | `/health/ready` | readiness (2026-09-02): `SELECT 1` on both contexts, no pending migration on either history, a Hangfire server heartbeat within 2 min when the job server is enabled. 503 with a plain body naming only the failing check. The compose healthcheck and `deploy.sh`'s verify step read this one |
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

### 7.1 Identity surface (D2–D6, F5–F7, F10)

**The public routes live under `/auth/*`, deliberately not under `/api`**, so that
`TenancyTests.Every_api_route_sits_behind_the_token` stays *literally* true rather than "true with
exceptions" — an exception list on that test is how it stops being worth running. They carry a fixed
window rate limit by client IP.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/auth/activate` | `{username, activation_code, device_name}` → a device token. Single use |
| `POST` | `/auth/activation-code` | `{username}` → **always 202**, whether or not the username exists. **The handler writes nothing** (2026-09-02): it enqueues `WorkerCodeMailJob` with the worker's id (or an empty id) and the job mints a fresh code *only after* it has confirmed the worker, his email, his company and a configured relay — so a request that cannot mail supersedes nothing, and nobody can invalidate a foreman's live code by typing his username. Before this the route superseded the code and mailed nothing |
| `POST` | `/auth/login` | `{email, password}` → session token, role, company. Dummy-verifies an unknown email so the two answers cost the same wall-clock |
| `POST` | `/auth/password` | `{token, password}` — serves invite *and* reset, consumes the token, revokes existing sessions |

Everything below is behind the bearer. **Filter order is established once, in `Program.cs`:**
`BearerAuthFilter` (group) → `RoleFilter` (sub-group) → `ValidationFilter<T>` (route), which is what
makes **401 beat 403 beat 400** — an anonymous caller learns nothing about which roles a route
admits, and a caller of the wrong role learns nothing about its payload shape. Asserted by a test.

| Method | Route | Gate | Purpose |
|---|---|---|---|
| `GET` | `/api/me` | any role | who is holding this credential |
| `POST` | `/api/auth/logout` | admins | revokes **this** session and no other |
| `GET/POST/PATCH` | `/api/workers`, `/api/workers/{id}` | company_admin | his foremen |
| `GET|POST` | `/api/workers/{id}/activation-code` | company_admin | **read** the live code, or issue a fresh one. The GET must stay a GET |
| `GET` | `/api/workers/{id}/share-text` | company_admin | the ready-made message for one man, code included |
| `GET|DELETE` | `/api/devices`, `/api/devices/{id}` | company_admin | the company's phones; DELETE is a soft revoke |
| `GET|POST` | `/api/platform/companies` (+ `/{id}/suspend`, `/{id}/resume`) | super_admin | the customers |
| `GET|POST` | `/api/platform/users` (+ `/{id}/invite`, `/{id}/disable`, `/{id}/enable`) | super_admin | every account, keyset-paged |
| `GET` | `/api/platform/audit` | super_admin | the admin audit trail |
| `GET` | `/api/platform/logs` | super_admin | the log stream, keyset-paged over `(at DESC, id DESC)`; `level`, `source`, `company_id`, `entry_id`, `q`, `from`, `to` |
| `GET` | `/api/platform/logs/export` | super_admin | the same query as a CSV download, capped at 50 000 rows |
| `POST` | `/api/client-events` | any credential | what was pressed in the app, as slugs |

**`POST /api/client-events` is the one write path open to both credentials** (D5), because the
founder asked for every action in the app and a foreman's phone is most of the app. It is also the
only route in the product that accepts input destined for a table Teren staff read, so its
validation *is* the boundary rather than a convenience: `action` must be a slug
(`^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,4}$`), `route` may carry an id but **never a query string**, and a
`detail` value may only be a number, a boolean or a short slug. A free-text value is dropped and the
key with it; a bad `action` or `route` rejects that event whole. Nothing about a partly bad batch is
a `4xx` — the answer is always `202 {accepted, rejected}`, because a phone that retried a malformed
batch would retry it for ever. `company_id` comes from the caller's scope and never from the body.

**`GET /api/me` answers for all three roles, and it is the only description of himself a company
admin can obtain** (F10, 2026-09-02). He is in no list he may read: `/api/workers` returns
`WorkersOf(companyId)` — the men who record — and `/api/platform/users` is 403 to every role but
staff. So the route carries `role`, `user_id`, `display_name`, `username`, `email`, `language`,
`company`, `device`, `created_at` and `last_login_at`; fields that do not apply to a role are null
by constraint rather than by omission. It is not a disclosure — the route answers only for the
credential presented.

*Which bearer is sent decides who the answer is about.* `ProfileService` calls this route with the
**device** token and `CompanyGateway.me()` calls it with the **admin** token. On a browser holding
both — the founder's, which is the demo phone and the office console at once — sending the wrong one
succeeds and describes the wrong person. Two clients, two tokens, and no code path from one to the
other.

**No bulk activation-code export exists, and must not.** A code plus a *username* activates a phone,
so a message carrying several names and codes pasted into a site group chat lets any man in that
chat record evidence signed with another man's name. Attribution is what the whole identity model
exists to establish. One man, one message, one screen.

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

### The read path (built 2026-08-31, closes the C3 gap)

`GET /api/entries/{id}/media/{mediaId}` streams one photograph or voice note. Until it existed the
API only ever handed out **PUT** permissions, so a device that did not capture an entry could not
display its photos at all — the archive could report the count and say the files were on the
server, and an owner opening the diary on a tablet saw no evidence. That is precisely the buyer's
reason to pay (PROJECT.md §2).

**Authenticated bytes, not a presigned GET.** The presigned GET is cheaper and keeps bytes out of
the API, which is what the topology rule in §2 asks for on the *upload* side. The asymmetry is
deliberate:

- A presigned URL is **a bearer credential that outlives the request**. For its whole TTL it works
  for whoever ends up holding it — forwarded, pasted into a chat, in a browser history or a proxy
  log — and it sits outside the role gate, outside the tenant filter and outside device revocation
  for that window. Revoke a stolen phone and its outstanding photo URLs keep working. That is an
  acceptable trade for a one-key *write* permission the phone is about to use anyway; it is not one
  for *read* access to a client's site diary, which is the thing this product asks to be trusted
  with.
- Every access here passes `RoleGates.Evidence` and the tenant query filter, so "Teren staff cannot
  look at a customer's photographs" stays true of the photographs and not merely of the rows
  describing them.
- The bytes are **proven against the SHA-256 the phone declared before any of them is served**
  (`VerifiedObjectReader`, shared with the report download). Storage handing a client the wrong file
  directly is not something a presigned URL leaves anybody able to notice.

The cost is API bandwidth, and it is bounded: photos are compressed on the phone to ~300 KB, an
entry carries at most 20, and this is a read an owner performs a handful of times a day. If it ever
shows up on a bill the answer is a CDN in front of the route, not a URL nobody can take back.

**Shape.**

| | |
|---|---|
| Route | `GET /api/entries/{id}/media/{mediaId}`, inside the `/entries` group — so it inherits the evidence role gate by construction rather than by memory |
| 200 | the stored bytes, `Content-Type` from the sealed row (never from the caller, never from what storage claims), `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes` |
| Caching | `Cache-Control: private, max-age=31536000, immutable`, `Vary: Authorization`, `ETag` = the media checksum. Sealed media never changes, so `immutable` is honest; `private` keeps a company's photographs out of any shared cache; `Vary` stops a re-activated phone's new token reading the old token's entry. A conditional request is answered **304 from the row, without touching object storage** |
| 404 | no such media *on that entry, for this company*. A foreign photo, an unknown id, and a real id paired with the wrong entry are one answer — any difference between them is an existence oracle |
| 409 `media_not_ready` | yours, but `/complete` never certified the bytes (`pending`/`failed`). Worth re-checking, not an error about lost evidence |
| 409 `media_unavailable` | certified once; the object is gone, or no longer matches its checksum |
| 503 | storage did not answer inside `Storage:MediaReadBudget` (20 s). Says nothing about the evidence |

The read borrows the **bulk** storage client — a 10 MB photo would not survive the 5 s phone-facing
`Storage:RequestTimeout` — and that client waits `Storage:DownloadTimeout` (2 min) because it was
built for a Hangfire job nobody is watching. `Storage:MediaReadBudget` is what stops an owner's
tablet inheriting that, exactly as `Storage:VerificationBudget` does for `/complete`. The copy is
also bounded by the size the record declares, so a substituted object cannot decide how much gets
spooled to the temp volume.

**The client cannot point `<img src>` at this**: an image element sends no `Authorization` header.
The PWA fetches with its bearer token and renders the blob, as it already does for the report
download. **The entry response deliberately carries no URL for media** — with authenticated bytes
there is no per-URL secret to convey, so the URL is a pure function of two ids the client already
has (`entry_id`, `media_id`); `media[].upload_status` is what tells it whether a fetch will 409.
A `url` field would be a second spelling of the same fact.

M2's client-facing web view is a different problem — a client has no device credential — and is
still open: it needs either a scoped share token or a signed short-lived link, decided then.

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
- **Auth:** a bearer token on every `/api` request, resolved by `DbCredentialAuthenticator` against
  a hashed credential row. There is no static token in code any more — the M0 compromise ended with
  increment D1 (2026-08-30). `Auth:DeviceToken` survives only as *the demo device's* token, which
  `DemoSeeder` provisions into the `device` table as `SHA-256(...)`, so the value baked into the PWA
  bundle authenticates as a genuine device row like any other.

### Identity model (shipped, increment D1 — 2026-08-30)

Three roles: **super_admin** (Teren staff), **company_admin** (the customer), **worker** (the
foreman who records). Full rationale in `plans/profile-and-identity.md`; the shipped shape:

```sql
app_user (id uuid PK,
          company_id uuid NULL → company,   -- NULL if and only if super_admin
          role text,                        -- super_admin | company_admin | worker
          username text NULL,               -- workers: required, globally unique. The durable identity.
          display_name text, email text NULL, password_hash text NULL,
          language text NOT NULL DEFAULT 'sr',
          created_at, last_login_at, disabled_at timestamptz null)

device (id uuid PK, company_id → company, user_id → app_user,
        name text, token_hash char(64),     -- ux_device_token_hash IS the auth path
        created_at, last_seen_at, revoked_at, revoked_by_user_id)

activation_code, password_token, admin_session, admin_audit   -- see the plan for columns

app_log (id bigserial PK,               -- the one non-uuid key in the product; it is a firehose
         at, level, source,             -- level: Verbose | Debug | Information | Warning | Error | Fatal
         template,                      -- the message template, UNRENDERED
         message,                       -- rendered from allow-listed properties only
         properties jsonb NULL,         -- allow-listed names only; an unknown one is dropped
         exception text NULL,           -- scrubbed: type + stack always, message only by type
         company_id NULL, entry_id NULL, correlation text NULL)
--  ix_app_log_at DESC, ix_app_log_level_at, ix_app_log_company_id_at
```

`app_log` is in the **identity** model, which is what keeps the log viewer on the super-admin-safe
side of the split rather than reaching into `TerenDbContext`. Retention is a decision, not a
default: `Logging:RetentionDays` (14) with a daily Hangfire job, and `Verbose`/`Debug` dropped
outside Development — without both, the log table becomes the largest object in the nightly backup.
The sink writes through a bounded queue on a background flush, so a log call never waits on Postgres
and a database outage costs log lines rather than the request that emitted them.

Four constraints carry the role rules mechanically rather than conventionally, in the taste
`ck_entry_status` sets: `ck_app_user_company_scope` (`(role = 'super_admin') = (company_id IS NULL)`)
makes a super_admin *inside a tenant* unrepresentable; `ck_app_user_worker_has_no_password` makes a
second door into the diary unrepresentable. `email` is a **partial** unique index over non-null
values, because a worker need not have one.

**The two-context split is the mechanism behind the product's central privacy claim.**
`TerenIdentityDbContext` maps a closed set of identity types by name and has **no `DbSet<Entry>`,
`Media` or `Report`** — `db.Set<Entry>()` throws, because the type is not in the model. A super_admin
carries `CompanyId = null`, so the evidence query filters (deny-by-default) match nothing for him
anyway. "Teren staff cannot read a customer's diary" is therefore a property of the model the
platform code path is compiled against, not a policy anyone has to remember. Both contexts are now
explicit closed sets — `ApplyConfigurationsFromAssembly` was removed from `TerenDbContext` so an
identity configuration cannot be swallowed into the evidence model — and each has a
model-composition test asserting the other's types are absent.

It has its own migration history table, `__EFMigrationsHistory_identity`; `migrate` applies both.

Note the caveat, so nobody over-claims it: this is a **model** barrier, not a connection barrier.
Both contexts share a connection string, so raw SQL on the identity context can still reach
`entry`. The barrier holds against every typed route; a string is not a type. **That scan is no
longer owed — `PlatformRawSqlTests` (D5) is it**, and D5 is what made it fall due: `LogRetentionJob`
genuinely needs raw SQL (a set-based chunked `DELETE` over a firehose table, where loading rows to
delete them would be absurd), so "no raw SQL on this path" stopped being a rule anyone could keep.
The rule that replaced it is narrower and exact — **raw SQL under `Api/Platform`, `Api/Endpoints`
and `Infrastructure/Logging` may name `app_log` and nothing that holds evidence** — and it is
anti-vacuous: a second assertion pins that the one allowed statement exists and deletes `app_log`,
so "the scan found nothing" can never come to mean "the scan is looking in the wrong place".

`entry.device_id` keeps its original meaning — provenance, which phone captured the evidence —
distinct from the `created_by_user_id` / `confirmed_by_user_id` attribution columns arriving in D8.
**It has no foreign key**, deliberately: adding one would validate every existing row on a live
database. So "revoking a device stamps `revoked_at`, never deletes the row" is a code-level
discipline backed by a test, not a database guarantee.

- Personal data stays out of URLs, object keys, and logs. **Since D5 this is a security boundary
  rather than a discipline**, because the super admin's log viewer puts the result on a screen in
  Teren's office. Three enforcements, not one: a **named property allow-list** at the sink (an
  unknown property is dropped, not stored, so new logging that wants a new property adds it in a
  diff a reviewer sees); **exception scrubbing** allow-listed by exception *type* — and
  `AiProviderException` is deliberately not on that list even though it is ours, because
  `ClaudeStructureExtractor` folds `ex.Message` from the provider into its own and an allow-list by
  assembly would have admitted exactly the message the enforcement exists to exclude; and
  **`LogRedactionTests`**, which reads every `.cs` under `src/` and fails on a log call site that
  interpolates evidence. The rule there is "the expression, unless it is immediately reduced to a
  count" — `RawTranscript.Length` and `Recipients.Count` are the discipline, not breaches of it.

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
| **Staging** | Small VPS running the same compose stack at a stable subdomain | B3a — **machinery built and proven locally 2026-08-30; no host bought yet** | Runs continuously without the laptop; where background jobs, email and the demo actually get exercised |
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

### Continuous integration and deployment (2026-09-02)

**GitHub Actions, two workflows in `.github/workflows/`.**

- **`ci.yml`** runs on every push to `main` and every pull request: a `backend` job (`dotnet build`
  Release, then `dotnet test` — the 991 tests over a real Postgres, since the Ubuntu runners ship
  Docker and Testcontainers needs nothing else) and a `frontend` job (`npm ci`, `ng build`
  production, `ng test`) in parallel. **Two gates are hand-rolled because the tools lie:** `ng test`
  exits 0 on failing specs, so the job parses vitest's summary line and fails on `N failed` or on a
  missing summary; and a budget *warning* does not fail `ng build`, so the job greps the build log
  for one. The backend is deliberately not built with warnings-as-errors — the one pre-existing
  `CS9107` is documented, and the pipeline should report a warning, not hide it. A newer push to the
  same ref cancels the run it superseded.
- **`deploy-dev.yml`** runs after `CI` completes green on `main` (and on demand) and executes
  `deploy/deploy.sh` from the runner against the dev host — the same command the founder would type,
  so "the dev box is the latest green tree" is a property of the repository. It is **dormant until
  three secrets exist** (`TEREN_DEV_ENV` = the whole `deploy/.env`, `TEREN_DEV_SSH_KEY`, and
  `TEREN_DEV_SSH_KNOWN_HOSTS` from `ssh-keyscan`, which pins the host key); without them it logs a
  notice and exits green. It deploys the exact SHA CI approved, one deploy at a time, and scrubs
  `.env` and the key from the runner afterwards. Secrets never enter the repository.
- **The seam that would have failed the first real run is closed (2026-09-02, same day).**
  `deploy/web.Dockerfile` used to substitute a device-token placeholder that D7/F9 had removed from
  `environment.ts`, and stopped with `FATAL` on any non-default `TEREN_DEVICE_TOKEN`; `deploy.sh`
  required the variable. The substitution is deleted, the variable is optional and server-side only,
  and `DeployContractTests` reads `deploy/` off disk to keep it that way. Proven by
  `deploy.sh --target local --seed` running to `Deployed` with `/health/ready` answering `Healthy`
  through Caddy — which also caught that the `@backend` matcher listed `/health` exactly and would
  have served the SPA shell for `/health/ready`; both Caddyfiles now match `/health/*`.

### Deployment and monitoring

**Built at B3a (2026-08-30). It all lives in `deploy/`, and `deploy/README.md` is the runbook** —
what to buy in what order, the first deploy, backups, and the traps. What follows is the shape;
that file has the detail.

- **Deployment:** single Hetzner VPS, `docker compose` (api, postgres, web/caddy), **Caddy** for
  automatic TLS. Object storage is managed and external. Staging and production are the same
  compose file (`deploy/docker-compose.prod.yml`) with different environment variables — if they
  diverge, staging stops being evidence about production. `deploy/docker-compose.local.yml` is an
  overlay that adds only the *managed* services a real host would rent (object storage, mail, TLS
  in front of storage) so the whole stack can be stood up on a laptop; it changes nothing about
  api, web, postgres or the routing, because those are the parts being rehearsed.
- **One command:** `deploy/deploy.sh`, whose order is the point of it —
  *preflight → build → ship → database up → **migrate** → app up → bucket CORS → verify*.
- **Migrations are never implicit.** `dotnet Teren.Api.dll migrate` runs as its own compose
  service (`--profile tools`), against a healthy database, before the new API serves anything. A
  container that migrated on start-up would re-attempt the schema change on every restart of a
  crash loop, and two replicas would race. Forgetting the step has bitten twice; a deploy that
  cannot forget is the fix.
- **Two images.** `deploy/api.Dockerfile` (multi-stage, non-root `app` uid 1654, no SDK in the
  final layer) and `deploy/web.Dockerfile` (Angular production build served by Caddy, which also
  proxies `/api` — one origin, which is what makes `apiBaseUrl: ''` correct and means no CORS
  preflight for the app at all).
- **The API trusts `X-Forwarded-Proto`/`-For` only when `Hosting:BehindProxy` is set**, and that
  is safe only because the compose file publishes no port for the api service. Publish one and it
  becomes a header-spoofing hole. Without it, `UseHttpsRedirection` would answer every request —
  the container healthcheck included — with a 307 to a port nothing listens on.
- **The runtime image needs more than the .NET runtime**, and each addition closes a failure that
  surfaces far from its cause: `icu-libs` + `icu-data-full` (Alpine defaults to invariant
  globalization, under which a Serbian report renders `12.5` where a Serbian reader expects
  `12,5` — silently, because `ReportStrings` falls back to invariant by design), `tzdata`
  (**without it every report fails**: B6 reports carry project-local timestamps and confirming
  parked entries at `time_zone_unknown: 'Europe/Belgrade' is not a time zone this host can
  resolve`, while `/health` said `ok` throughout), `fontconfig` + `freetype` for QuestPDF's Skia,
  and `curl` for the healthcheck.
- **Cache policy is load-bearing for the PWA.** Content-hashed assets are `immutable` for a year;
  everything with a stable name — `index.html`, `ngsw.json`, `ngsw-worker.js`,
  `manifest.webmanifest`, `/i18n/*.json`, `/icons/*` — is `no-cache` (store, but revalidate). A
  far-future `max-age` on `ngsw.json` is exactly how an installed app stops ever seeing a new
  version. The SPA fallback is narrowed to navigations (`Accept: text/html`, file absent) so a
  missing asset 404s honestly instead of handing the service worker an HTML shell to parse as its
  manifest.
- **Backups:** nightly `pg_dump -Fc` (cron on the host, not a scheduler container — a backup that
  needs the stack it backs up to be healthy is not a backup), verified by reading its table of
  contents back, copied to object storage, 30-day retention both places.
  `deploy/backup/pg-restore.sh` restores. **Two deliberate exclusions:** object storage is not in
  the dump (the rows point at media that must still exist in that bucket), and neither is
  Hangfire's schema — restoring job state would resurrect a queue whose reports have already been
  delivered, and §10's rule about not putting three copies of the same day in an inbox applies.
  The rehearsal C7 asks for has now been done once, and it found a real defect on the first
  attempt: a restore that cleared only the `public` schema died halfway on "schema hangfire
  already exists" and left the database with no application tables at all.
- **Object-storage CORS is an applied artefact** (`deploy/storage/`), run by every deploy rather
  than remembered once. **The two stores this project uses do not agree on the mechanism:**
  Hetzner Object Storage (Ceph RGW) implements the S3 bucket CORS API, and **MinIO does not** —
  `mc cors set` answers "functionality that is not implemented", because MinIO's CORS is the
  server-level `MINIO_API_CORS_ALLOW_ORIGIN`, whose default is `*`. That default is why the
  2026-08-29 browser-upload verification proved less than it appeared to: it showed that an
  *unconfigured* store lets everything through. The local stack now pins MinIO to the app origin,
  and a wrong origin is refused.
- **Monitoring:** `/health` for liveness and **`/health/ready`** for the truth (database on both
  contexts, both migration histories current, a job-server heartbeat — §7), Hangfire dashboard behind Basic auth (unreachable rather than open
  when unconfigured), Serilog to stdout with the entry id on pipeline lines, json-file logging
  capped at 10 MB × 5 so a small VPS disk is not a scheduled outage. Email alerts on failed jobs
  and any observability platform still wait until something actually hurts.

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

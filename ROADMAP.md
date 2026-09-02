# Teren — Roadmap

Milestones and the increment sequence. `PROJECT.md` says *why*; this file says *in what order*.
Technical detail lives in `ARCHITECTURE.md`.

Status legend: ☐ not started · ◐ in progress · ☑ done · ⏸ blocked (reason given)
`[F]` = requires founder hours (nobody else can do it).

Last updated: 2026-08-29.

---

## How we work

- **Increment = one reviewable unit.** Each has a "done when" the founder can verify in one
  evening without reading every line of code. Nothing merges half-finished.
- **Two tracks run in parallel:** Track A de-risks the product (transcription), Track B builds
  the money path. Track A is founder-blocked on real audio; Track B never waits for it, because
  transcription sits behind an interface from day one.
- **Main is always demo-ready** (PROJECT.md principle 7). From B7 onward, every merge is
  something the distributor could show on his phone.
- **Order is risk-first, not feature-first.** The things that can kill the product get answered
  before the things that make it pretty.

---

## Milestone 0 — Demo-ready (the money path)

**Goal:** the distributor can pull out his phone and show: speak → structured entry → PDF report.
**Done when:** M0 demo runs end to end on a real phone, with seeded Serbian demo data, without
the founder touching a terminal.

> **State, 2026-09-02: every increment is built. M0 is not done, and the gap is not code.**
> B0–B7 are ☑ and the money path is proven end to end against real Postgres, real object storage
> and real SMTP — but only on the founder's laptop. **B3a's machinery is built and reviewed and
> nothing is deployed, because there is no VPS and no domain.** Two clauses of the sentence above
> are therefore unmet: *on a real phone*, and *without touching a terminal*.
>
> Everything else queues behind that one purchase. The real-device debt — microphone on Android and
> iOS, offline cold start of the installed app, iOS camera and HEIC, GPS — needs **HTTPS
> specifically**, not merely a stable hostname: `crypto.subtle` refuses to run in an insecure
> context, so the upload path cannot hash a file. The published demo activation code needs its
> decision the same day. **A2 is deferred by founder decision, not blocked**, and remains the
> highest-value hour available: the top product risk is measured on one clip from a quiet room.

### Track A — transcription risk

| #   | Increment                      | Done when                                                                                                                                                  | Notes                                                                             |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | ☑ STT spike harness            | `dotnet run --project tools/SttSpike -- sample.ogg` prints side-by-side transcripts from every configured provider                                         | Throwaway console app; no product code depends on it                              |
| A2  | ⏸ `[F]` Record real site audio | 3–5 voice notes from an actual site, Opus/OGG mono 16 kHz, with noise and trade jargon                                                                     | **The single most valuable founder hour in the project**                          |
| A3  | ☑ STT provider decision        | `docs/stt-evaluation.md` compares providers on the words that matter (work items, quantities, names); one provider chosen, decision recorded in PROJECT.md | If nothing is good enough → product pivot discussion, better now than in week six |

### Track B — money path

| #   | Increment                     | Done when                                                                                                                                                                                                                   | Depends on                                              |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| B0  | ☑ Repo + dev environment      | Done 2026-08-29 — git repo, .NET 10 solution (Api/Core/Infrastructure), Angular 22 PWA with Transloco (`sr` default, `en` switchable), Postgres + MinIO via compose, `/health` endpoint, README. **Outstanding:** HTTPS tunnel for phone testing still to be set up (needs the founder's ngrok signup) | —                                                       |
| B1  | ☑ Data model + seed           | Done 2026-08-29 — EF `InitialSchema` migration (company/project/entry/media/report, snake_case, check constraints), immutability triggers verified against live UPDATE/DELETE, tenant query filters (deny-by-default), idempotent Serbian demo seed via `dotnet run --project src/Teren.Api -- seed` | B0                                                      |
| B2  | ☑ Capture flow (offline-only) | Done 2026-08-29 (incl. adversarial review + 10 fixes, then the adaptive-layout rework — app header ≥768, global language switcher, three device classes, founder-approved): Home/Recording/Saved/Pending, Dexie v2 with per-second chunk persistence and orphan rescue, photo pipeline (GPS-before-compression), full sr/en i18n, offline-cached dictionaries. 91 specs green at 390/768/834/1280/1920. **Real-device checks (mic, offline cold-start, iOS) still owed — needs the HTTPS tunnel.** Delta-review verdict pending | B0                                                      |
| B3  | ☑ Upload path                 | Done 2026-08-29. Server side (idempotent POST /entries, presigned PUTs, sealed-evidence /complete, media caps, storage time-budget) plus the PWA outbox: env config, API client, lazy SHA-256 on Dexie v4, capped jittered backoff, terminal-vs-retryable classification, stranded-`in_flight` recovery on start-up. Both halves adversarially reviewed; proven end to end against the live API and MinIO. 154 backend tests, 195 PWA specs | B1, B2 |
| B3a | ◐ Staging environment         | **Machinery built and reviewed (accept) 2026-08-30, but nothing is deployed — there is no VPS and no domain.** `deploy/`: production images (non-root, no SDK), same-origin Caddy serving the PWA and proxying `/api`, one-command `deploy.sh` with an explicit migrate step, applied bucket CORS, rehearsed backup/restore. Proven locally end to end; the reviewer live-tested it, including a spoofed `X-Forwarded-For` against the Hangfire gate. The local stand-up caught three bugs that would have hit staging: **missing tzdata** (every report would have failed while `/health` said ok), **globalization-invariant mode** (Serbian decimal commas rendered as points, silently), and a **restore that would have resurrected Hangfire jobs** and re-sent delivered reports. **Not done until a domain + VPS exist** — TLS, the ship step and managed-provider CORS are all unproven | B3
| B4  | ☑ Processing pipeline         | Done 2026-08-29, reviewed. `received` → Azure STT (`sr-RS`, Latin) → Claude extraction → `awaiting_confirmation`, else parked in `needs_review` with the evidence intact. Hangfire + sweeper; transcript persisted write-once **before** extraction is attempted. Review's gating find: a live pass outliving `StaleProcessingAfter` could be parked, confirmed by the foreman, then dragged back by its own late worker — terminal writes are now claim-conditional and the stale window (45 min) outlasts a computed ~21.5 min worst case | B3; A3 |
| B5  | ☑ Confirmation screen         | Done 2026-08-29, reviewed. Editable record, (transcript, extracted, corrected) triples, Dexie v5 drafts so nothing typed is lost, honest offline/5xx handling. **Plus, after the founder hit it live:** `needs_review` no longer conflates "recording unreadable" with "words fine, structuring failed", and a **one-tap "Pošalji moje reči"** confirms the transcript as the record (`described_verbatim`) — the product's floor is now a voice-backed record in his own words, not "type it yourself". Home's stale-status bug fixed; archive → confirm wired for `confirmed`-but-unreported entries | B4 |
| B6  | ☑ PDF + email                 | Done 2026-08-29, reviewed. QuestPDF report in the project's language, photo SHA-256 verified before embedding, MailKit SMTP behind `IReportDelivery`, Mailpit locally, entry sealed after delivery. Review gated on four custody defects — replay-resend, post-DATA retry double-send, a sent-but-unsealed entry stranded forever, and a mid-pass re-confirmation sealing content that was never sent. **Founder polish:** record id removed, place name instead of coordinates, project-local timestamps (new `time_zone` column), TEREN wordmark, a **prose variant** for verbatim days, and **`GET /api/entries/{id}/report`** — the system's first storage read path | B5 |
| B7  | ☑ Demo polish                 | Done 2026-08-30 (`4bcd52a`): Teren wordmark and icon set, `manifest.webmanifest` and the install-to-home-screen path, the seeded three-site demo company, `docs/demo-script.md`, and a destructive `reset-demo` that wipes and re-seeds everything belonging to the demo company (refuses outside Development unless `Demo__ResetEnabled`). **Never verified on the distributor's actual phone** — that needs B3a                                                                                             | B6                                                      |

**M0 founder actions:** A2 (record audio), Serbian copy review at B5 (trade vocabulary needs a
native ear, not just correct grammar), B7 review on a real phone.

**Testing rhythm:** every increment from B0 onward is verifiable on the founder's own phone, not
just in a desktop browser. This is not a nicety — voice recording, camera, GPS, offline behaviour
and install-to-home-screen all require a real device on a secure (HTTPS) origin, and none of them
can be judged from a laptop. See `ARCHITECTURE.md` §13 for the three environments.

---

## Milestone 1 — Pilot-ready

**Goal:** one real foreman can use it daily on a real site.
**Done when:** PROJECT.md Phase 1 test starts running — one foreman, three weeks, unreminded.

| #   | Increment                    | Done when                                                                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | ☐ Offline queue hardening    | Entries survive airplane mode, app kill, and flaky signal; "N pending" always visible; upload resumes on next open                                |
| C2  | ☐ Weather enrichment         | Entry auto-carries conditions and temperature for its date and GPS location                                                                       |
| C3  | ☑ Archive view               | Built 2026-08-29 (founder request, pulled ahead of M1): archive list + read-only entry record — structure, transcript, photos, audio, GPS, weather; offline-first from Dexie merged with `GET /api/entries`; three device classes incl. a two-pane desktop master-detail; a `confirmed`-but-unreported entry routes back to the gate; the report PDF downloads from the record. **The photo read path closed it on 2026-08-31.** The server half (`GET /api/entries/{id}/media/{mediaId}`, authenticated streaming, checksum-verified, `private, immutable` + `Vary: Authorization`) shipped in `52646ba` marked WIP; the client half was missing entirely, so the screen could still only *count* the pictures it was not showing. Now `ArchiveService.getMedia` fetches the bytes with the bearer — an `<img src>` cannot carry one, and a presigned GET was refused as a credential nobody can take back — and phone-held and fetched photographs render in one strip. Verified-only fetching (anything else is a guaranteed 409), sequential, one retry action for every failure the blob response makes indistinguishable. **The owner-on-a-tablet case works: this is the buyer's reason to pay** |
| C4  | ☐ Immutability + corrections | Reported entries cannot change; a correction creates a new entry via `supersedes_entry_id`                                                        |
| C5  | ⊘ Device binding             | **Absorbed into the identity work 2026-08-30** — no longer a separate increment. The join code became a worker activation code; a device now binds to a *worker in a company*, not to a project (the project picker is a live control). See `plans/profile-and-identity.md` and the identity table below |
| C6  | ☐ Weekly recap               | Weekly PDF summarising the week's entries                                                                                                         |
| C7  | ☐ Production deploy          | Running on Hetzner with TLS, automated Postgres backups, error alerting                                                                           |
| C8  | ☐ `[F]` Pilot onboarding     | A foreman from the distributor's network has it installed, understands it in under five minutes, and the founder has a channel for his complaints |

### Identity and profiles (started 2026-08-30)

Absorbs **C5** and pulls **M2** forward. Full specification in `plans/profile-and-identity.md`;
increment ids below match its §11 table. Every increment lands green and demo-ready, so the
sequence can be stopped at any point.

| # | Increment | State |
|---|---|---|
| F1 | Outbox fix — a rejected credential no longer strands a day of evidence | ☑ reviewed, fixes in |
| D1 | Identity schema, credentials, `DbCredentialAuthenticator`, closed identity model | ☑ reviewed, fixes in |
| F2 | Session plumbing, `API_CONFIG` getter, the `pass()` gate | ☑ reviewed, fixes in |
| F3 | `/welcome`, `/activate`, `/login` — verified in a browser at six widths | ☑ **REJECT (2026-08-31) discharged.** Its two gating route defects were fixed by F4b and the third — no 1280 artboard — is a founder action. The screens it built were re-reviewed on 2026-09-01 as part of the F5/F6/F7 pass and found sound. Its two gating route defects are fixed by F4b; the third is a founder action — no 1280 artboard exists for any of the three screens |
| D2 | Principal, role gates, 403/404 doctrine, rate limiter, login, `create-super-admin` | ☑ **reviewed: accept** (2026-08-31), no gating findings |
| D3 | `/auth/activate`, self-service code, company-admin surface (workers, codes, devices) | ☑ **reviewed: accept-with-fixes**, fixes in — timing oracle on both unauthenticated activation routes closed; 786 → 788 tests. **No delta review, and the implementer was stopped before reporting its mutation proofs** |
| F4b | English route rename — all six paths, plus the guards that make a rename-without-consumer break visible | ☑ **reviewed: accept-with-fixes**, gating fix (`ARCHIVE_ENTRY_PARAM`) in |
| F4 | The `canMatch` gate + `?next=` deep links | ☑ **reviewed: accept-with-fixes**. Code fixes in, **and both gating items are now closed (2026-08-31)**: `DemoSeeder` mints the fixed `DEM0-TEST` code, and plan §8 was amended to the flat `ActivateResponse` first, then the serialized field names pinned exhaustively server-side, and only then was the client's dual-shape read deleted. That order was the point — dropping the tolerance before the pin existed would have restored the original failure, where a renamed field surfaced to the founder as "joining failed, your code is not used up" and both halves were false |
| — | **Mint the first company_admin password** — nothing in `src/` ever creates a `PasswordToken`, so no admin can sign in and no activation code can be issued through the product | ☑ resolved by `invite-admin`, which mints one and prints a single-use link. `create-super-admin` reads its password from stdin, never argv |
| — | **Prove activation end to end against the real API** | ☑ **proven 2026-08-31** — Petar → code → `/auth/activate` → working device token; replay 401, `consumed`. **But done by hand**: the first admin password needed a `password_token` row inserted from psql, so the row above is still open |
| D7/F9 | **Empty `environment.deviceToken`** — the increment that actually shuts the door | ☑ built 2026-08-31, **reviewed 2026-09-01: accept-with-fixes** (frontend), sound. Empty in both environment files; a spec pins the constant empty, because every other spec would still pass if someone put it back |
| F5 | `/profile` — the worker's own account | ☑ built 2026-08-31, **reviewed 2026-09-01: accept-with-fixes** (frontend), sound |
| F6 | `/company` — workers, codes, share text, devices, revoke | ☑ built 2026-08-31, **reviewed 2026-09-01: accept-with-fixes** (frontend), sound. +230 specs written after the fact found three real defects on the code-issuing path. The layout pass that followed (dead header button, session moved into the chrome, desktop space on `/company` and Home) is in and green but **has not been looked at at any width** |
| D4 | Platform surface: companies, users, filters, keyset paging, `admin_audit` | ☑ built and verified 2026-09-01 (861 → 892 tests). **Reviewed: REJECT**, and its gating finding is now an open founder decision rather than a code fix — see plan §13.6: the invite/reset escape hatch lets Teren staff take a company admin's account and read his diaries, which plan decision 2 says is impossible. The capability predates D4 (`invite-admin` since D2); D4 made it reachable through the product. The false reasoning in the doc comments is corrected, the privacy guard was strengthened (a plain `string? Summary` passed both walks), and `InviteAdminCommand` now shares `PasswordTokens.IssueAsync` instead of duplicating the supersede. `/api/platform/*` behind `RoleGates.SuperAdmin`: companies (list/create/suspend/resume), users (company/role/status/free-text filters), the §9 authenticated invite that returns a readable link, disable/enable, and the audit trail. All of it behind one named type, `PlatformDirectory`, so the privacy guard has one surface to inspect. **Suspension is proven on the phone, not on the column** — a worker's next request 401s with no sleep in the test, so a token cache could not fake it. **Keyset paging is proven by the property offset paging cannot have**: every company appears exactly once across pages while a row is inserted mid-scroll. A malformed cursor is a 400, never a silent reset to page one |
| D5 | `app_log` + Serilog sink, allow-list, exception scrubbing, retention, redaction test | ☐ **next.** The one increment that turns a logging *convention* into a security boundary, so it ships with three enforcements, not one: a property allow-list at the sink, exception scrubbing (the real risk is `BoundedRetry`'s `LogWarning(ex, …)` — a third-party exception from Anthropic or Azure can echo request content back in its message), and a test that reads every `.cs` under `src/` and fails on a log call site that interpolates evidence. Retention is a decision, not a default: 14 days, `Verbose`/`Debug` dropped in production, or the log table becomes the largest object in the nightly backup |
| F7 | `/platform` — companies, users, invites, health, log viewer | ◐ **three of five built** 2026-09-01 and reviewed (accept-with-fixes): `/platform` (all accounts, add, invite), `/platform/companies` (the customers, suspend/resume), `/platform/user/:userId` (one account, his link, disable). **The health page and the log viewer are what remain, and both wait on D5.** The log viewer's compact layout is the hard part — plan it as a filtered list of collapsed entries that expand on tap, never a shrunken table |
| D6 | `IMailSender` split, `InviteStrings`, Hangfire mail jobs | ☑ built and proven end to end 2026-09-01 against Mailpit (`8c166a4`, 901 → 908 tests). **It was never blocked on the relay** — the transport is `IMailSender`/`SmtpMailSender` sharing `ReportingOptions`, deliberately *not* reusing `SmtpReportDelivery`, whose custody machinery encodes four B6 findings that do not apply to an invite. **The founder killed the on-screen link the same day** ("bad behaviour, I don't like that"), which resolved the design tension: `AdminInviteJob` mints the token *inside* the job that mails it, so plaintext is never a Hangfire argument — Hangfire serialises arguments into its own storage and keeps them in job history — and no response body carries a credential. `InviteSentResponse` says only the address and whether it went; with no relay the screen says nothing was sent rather than implying it was. Live proof: create → mail in Mailpit → link → password set → sign in → **replay 401**. Which relay to use in production is still open |
| F8 | Revocation surface on Home and the pending screen | ☑ built 2026-08-31, **reviewed 2026-09-01: accept-with-fixes** (frontend), sound. A stalled row whose failure is `unauthenticated` offers "Unesi novi kod" instead of "Pokušaj ponovo" — the loop is already retrying it and another press changes nothing — and Home carries a notice above the confirmation gate. Derived from the queue past `STALLED_AFTER_ATTEMPTS`, never a stored flag: the server is the only thing that knows, and a local flag goes stale in a basement. **Never a locked door** — the record button is untouched, pinned by spec. One deliberate narrowing: "Pokušaj sve ponovo" no longer sweeps credential rows, because releasing one resets the attempt count that *is* the notice, so the single press would fail instantly and hide the answer for another half hour |
| D8 | `entry.created_by_user_id` / `confirmed_by_user_id`. **No backfill** | ☑ built and verified 2026-08-31 (6 new tests; 855 → 861). Both values come from the bearer and nothing else — there is no field in either request that names a person, and there must never be one. Confirming stamps the approver and a replay writes nothing, so the column records who decided rather than whose retry timer fired last. **No FK to `app_user`, a deliberate deviation from plan §4**: `TerenDbContext` migrates before `TerenIdentityDbContext` everywhere, so `app_user` does not exist when `entry` is altered on a fresh database. Nothing is lost today — no path deletes a user — but **the constraint must arrive with D4**, in the identity history |

| F10 | `/company/profile` — the company admin's own account | ☑ built 2026-09-02 (`a0e1edc`, 908 → 910 tests, 1302 → 1311 specs). **The third of decision 10's three profile surfaces, and the one nobody had noticed was missing**: a foreman has `/profile`, a super admin opens his own row in the platform directory, and the owner of a paying company had one inert line at the top of his own people list. It was not buildable without widening `GET /api/me` (`email`, `created_at`, `last_login_at`), because **he appears in no list he may read** — `/api/workers` is `WorkersOf(companyId)` and excludes him by construction, and `/api/platform/users` is 403 to every role but staff. The trap is the bearer: `ProfileService` already calls `/api/me` through `TerenApiClient`, which sends the **device** token, and on a browser that is both the demo phone and the office console that call succeeds and describes *Zoran*. The screen goes through `CompanyGateway.me()` and a spec pins which gateway it used. No sign-out (`session-link.ts` is already in its chrome and argues for one place) and **no change-password control — there is no authenticated route for one**, which the screen says rather than hides. **Rebuilt and reviewed 2026-09-02 (accept-with-fixes, all closed):** the founder found it carrying a *third* language switcher — the chrome has one in the header above 768 and one in the compact bar below it — and asked for the screen itself to be *"similar to the super admin"*. It is `platform/person-page`'s shape with this role's facts now (name as title, a `detail` card of chips and facts, an `actions` card beside it, 7/5 at ≥1024), which also ended a smaller drift: the owner's own account looked like a different product from the screen Teren staff read about the same man. The review's find worth keeping: **the copied head subtitle named a server-only address under a `known()` that is true from the stored session**, so every load flashed "no address on file" under his name and the unreachable state printed that claim *above* the notice saying nothing was confirmed |
| F11 | One column control for every table (`ui/column-menu.ts`, `ui/table-controls.ts`) | ☑ built and reviewed 2026-09-02 (accept-with-fixes; 1311 → 1363 specs). Founder, off three screenshots: `/platform/companies` drew **black bold headings** while the two screens either side of it drew muted uppercase ones, `/company`'s third column wrapped over two lines and he disliked its name, and *"one standard option right beside all columns so I can filter or sort"*. **The colour was the symptom** — two screens had a hand-built sortable header each and the customers screen had none, so its `<th>` held nothing but text and the browser's default is what he saw. Now one component in every head at every width: the label sorts on one tap, the funnel beside it opens both directions **named in words** and that column's filter box; below 768 the same component travels as a pill. The filter matches **the words the cell shows** (so the state column is filtered by typing *kod ga čeka*), and a live filter is loud — tinted funnel, and a strip reading *Prikazano 1 od 12* with one tap back — because a table quietly showing one of twelve rows is how a screen makes an owner believe a foreman was removed from his company. The third column is **Aktivnost**. The review's two gating finds were the same mistake twice: a `position: fixed` menu measured **once** put the filter box 56 px below the fold on a 390×660 phone and drifted off its trigger the moment the filter strip appeared; placement is a pure function now (`ui/menu-placement.ts`, flips and pins) re-run once a frame while open |

**The ordering that matters:** a login screen secures nothing while `environment.deviceToken` is
still baked into the bundle — anyone who opens devtools can read it and call the API directly. The
row marked *gates the flip* is the one that turns this from screens into a closed door, and it must
not be done before a code can actually be redeemed, or the founder is locked out of his own app.

**What the 2026-08-31 session found, and why the back-out note above was wrong.** The F4 back-out
of 2026-08-30 was recorded as "nothing of F4 survives". The opposite was true: **every consumer had
already been flipped to English paths** — `home-page.ts`, `archive-page.ts`, `confirm-page.ts`,
`pending-page.ts`, `entry-detail.ts` and all three capture exits — while `app.routes.ts` alone was
hand-restored to Serbian. Only `/` and the three auth routes matched anything, so record, pending,
the archive and the confirmation gate all fell through the wildcard to Home. **`ee37f04` shipped an
app that could not be navigated**, in breach of invariant 6, while `ng build` was clean and 538
specs were green.

Nothing caught it because the two specs guarding those couplings were structurally blind:
`capture-recording-page.spec.ts` used `provideRouter([])`, an empty table, and
`rescue.service.spec.ts` asserted `openEntryIds()` against hardcoded strings — both validating the
*future* behaviour. `rescue.service.ts` claimed in a comment that a spec derived the paths from the
route table; no such spec existed. F4b builds it, plus a source-scanning guard over every
`router.navigate` literal in the app.

**The lesson worth carrying:** a route rename is producer-side only, so a half-finished one type-checks,
builds, and passes a green suite. The guards are the compiler this coupling does not have.

**Everything that note used to list is done** (F4b reviewed, F4 reviewed and its two gating items
closed, `invite-admin` mints the first password, the token flip shipped as D7/F9). What remains in
this table is **D5**, then the two screens of **F7** that wait on it — and one thing that is not an
increment at all:

**D4's rejection is unresolved, and it is a founder decision rather than a code fix.** The
authenticated invite/reset escape hatch lets Teren staff mint a working set-password link for a
company admin, take his account, and read his diaries — which is exactly what decision 2 says is
impossible. The capability predates D4 (`invite-admin` has existed since D2); D4 made it reachable
through the product, on a screen with a button. Plan §13.6 carries the options. Until it is settled,
the privacy claim in §6 is true of every typed route and false of one deliberate door.

---

## Milestone 2 — Sellable

**Goal:** it can be sold to someone the founder has never met.

- ☐ Accounts, companies, roles (owner / foreman), multi-project
- ☐ Client-facing web view of a project's diary (the thing that stops the client phoning)
- ☐ Billing and subscription per site
- ☐ Per-trade entry templates and report layouts (plumbing/heating first)
- ☐ Legal-diary research outcome applied (compliance mode or explicit "evidence, not the legal diary" positioning)
- ☐ Serbian-language onboarding material for the distributor

---

## Milestone 3 — Repeatable

- ☐ Second vertical (electricians, then general builders)
- ☐ Self-serve signup and trial
- ☐ Quality loop from correction triples driving prompt and vocabulary improvements
- ☐ Native shell — only if PWA limits actually block real users

---

## Deliberately not building yet

Scheduling, quoting/invoicing, chat, worker time-tracking, BIM/drawing integration, an offline map,
Android/iOS native apps, anything multi-language beyond Serbian. Each one is a real product on its
own; none of them is why a contractor would pay in month one.

---

## Critical path and blockers

```
A1 ──► A2 [F] ──► A3 ──┐
                       ├──► B4 ──► B5 ──► B6 ──► B7 ──► M0 demo
B0 ──► B1 ──► B3 ──────┘
  └──► B2 ──────┘
```

- **Only A2 can stall the project**, and only the founder can clear it. Everything on Track B
  proceeds without it.
- If A3 concludes Serbian STT is not usable on site audio, stop and rethink the input method
  (typed shorthand + photos) before B4 — do not build the pipeline around a broken assumption.

## Open decisions blocking later work

| Decision                                        | Needed by | Recommendation                                                        |
| ----------------------------------------------- | --------- | --------------------------------------------------------------------- |
| ~~Email delivery provider~~ **Decided: SMTP (MailKit)** | —         | Open sub-decision: which SMTP relay. Avoid direct-from-VPS — port 25 blocks and IP reputation |
| STT provider                                    | B4        | Decided by A3, not by opinion                                         |
| Legal status of electronic site diary in Serbia | M2        | Research task, ~1 day, Claude can do it                               |
| **A VPS and a domain**                          | **B3a, and therefore M0** | The one purchase the whole milestone waits on. Hetzner + a name; the deploy machinery is built, reviewed and locally proven |
| **Which SMTP relay**                            | production | Transport decided (MailKit) and D6 proven against Mailpit. Do not send direct from the VPS — port 25 blocks and IP reputation, and the report is the product's face |
| **The invite/reset impersonation path** (plan §13.6) | before the privacy claim is made to a customer | D4's rejection. Teren staff can mint a working set-password link for a company admin and read his diaries. Decision 2 says that is impossible; today it is impossible everywhere except one deliberate door |
| **1280 artboards for the three auth screens**   | before B3a is shown to anyone | The only screens in the product with no expanded artboard |

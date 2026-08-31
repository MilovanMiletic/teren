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
| B7  | ☐ Demo polish                 | Teren branding, installable on the distributor's phone (A2HS), seeded demo project that always looks good, one-page demo script                                                                                             | B6                                                      |

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
| C3  | ◐ Archive view               | Built 2026-08-29 (founder request, pulled ahead of M1): archive list + read-only entry record — structure, transcript, photos, audio, GPS, weather; offline-first from Dexie merged with `GET /api/entries`; three device classes incl. a two-pane desktop master-detail; a `confirmed`-but-unreported entry routes back to the gate; the report PDF downloads from the record. **Not done until *photos* have a read path** — B6 built an authenticated streaming endpoint for the report and shaped `IObjectStorage` so photos can reuse it, but the photo endpoint itself is not built, so an owner on a second device still sees no evidence (ARCHITECTURE §8) |
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
| F3 | `/welcome`, `/activate`, `/login` — verified in a browser at six widths | ☑ **awaiting review** |
| D2 | Principal, role gates, 403/404 doctrine, rate limiter, login, `create-super-admin` | ☑ **built, UNREVIEWED** — 610 → 786 tests, build clean |
| D3 | `/auth/activate`, self-service code, company-admin surface (workers, codes, devices) | ☑ **built, UNREVIEWED** — same run as D2 |
| F4 | The `canMatch` gate + `?next=` deep links · **F4b** English route rename | ☐ **started and backed out** — see note below |
| — | **Prove activation end to end against the real API** | ☐ **gates the flip below** |
| D7/F9 | **Empty `environment.deviceToken`** — the increment that actually shuts the door | ☐ |
| F5 | `/profile` — the worker's own account | ☐ |
| F6 | `/company` — workers, codes, share text, devices, revoke | ☐ |
| D4 | Platform surface: companies, users, filters, keyset paging, `admin_audit` | ☐ |
| D5 | `app_log` + Serilog sink, allow-list, exception scrubbing, retention, redaction test | ☐ |
| F7 | `/platform` — companies, users, invites, health, log viewer | ☐ |
| D6 | `IMailSender` split, `InviteStrings`, Hangfire mail jobs | ☐ blocked on an SMTP relay |
| F8 | Revocation surface on Home and the pending screen | ☐ |
| D8 | `entry.created_by_user_id` / `confirmed_by_user_id`. **No backfill** | ☐ |

**The ordering that matters:** a login screen secures nothing while `environment.deviceToken` is
still baked into the bundle — anyone who opens devtools can read it and call the API directly. The
row marked *gates the flip* is the one that turns this from screens into a closed door, and it must
not be done before a code can actually be redeemed, or the founder is locked out of his own app.

**Where the session of 2026-08-30 stopped.** D2 and D3 are on disk, green and unreviewed — the
implementer was adding one shared test helper when the session ended, so treat the increment as
complete but unaudited. **F4/F4b was started and deliberately backed out**: the agent had rewritten
`app.routes.ts` with guards and English paths but had not yet written `device.guard.ts` or updated
`rescue.service.ts`'s pathname parsing, which left the PWA unable to build. `app.routes.ts` was
restored to its F3 state (Serbian paths, three auth routes, no guard) and re-verified at 538/538.
**F4/F4b starts from scratch**; nothing of it survives except the knowledge that renaming routes and
adding guards in one pass is the right grouping.

Next session, in order: **review D2/D3 and F3**, then F4/F4b, then prove activation end to end
against the real API, then the token flip.

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

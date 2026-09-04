# Teren — production-readiness checklist

The live tick list for everything between here and a product running on a real phone, on a real
domain, for a real contractor. **`ROADMAP.md` says why each item exists and in what order;
this file is only the ticking.** When the two disagree, ROADMAP wins and this file is stale.

Nothing in **M2** (`ROADMAP.md` §Milestone 2 — E1–E4) is on this list: M2 is *sell to a stranger*,
not *production-ready*.

Every item has a stable id (`P1`…`P39`, plus `P11b`) so a session can say "P12 done" without ambiguity.
**Never renumber.** A new item takes the next free number and goes in the right section.

Marking done: tick the box and append `✅ 2026-09-04 — how it was proven` to the item.
An item is done when it is *proven*, not when it is written — see `CLAUDE.md` on what "proven"
means (a green suite is not a proof; a substituted seam is not the shipped code).

**Progress: 7 / 42** — **SECTION 2 (review debt) IS FULLY CLOSED, 2026-09-04**: P10, P11, P11b, P11c, P11d, P12, P13. Reviews *and* fixes, every fix mutation-proven. Backend **1157**, PWA **1911**. Next: **C11 before C9** (§3). *(P11b added 2026-09-04 — see the note above on never renumbering.)*

---

## 0. Blocked on the founder — nothing else moves without P1

- [ ] **P1** Buy the VPS and the domain `teren.rs`. *The single gate on M0's last two clauses —
      "on a real phone", "without touching a terminal".*
- [ ] **P2** Run `deploy/README.md` §2 — the 12-step checklist, every decision already made.
- [ ] **P3** Resend: verify the sending domain and set **SPF + DKIM + DMARC** on `teren.rs`.
      *Nothing sends until this is done, and the report is the product's face.*
- [ ] **P4** Add the three `TEREN_DEV_*` secrets — this is what wakes `deploy-dev.yml`, dormant today.
- [ ] **P5** `create-super-admin` for the founder's own account on the box.
      *The deployed image has no SDK, so `dotnet run` is not available there.*
- [ ] **P6** `[F]` **A2 — record 3–5 real site voice notes.** Opus/OGG mono 16 kHz, with noise and
      trade jargon. *Still the highest-value hour in the project: the top product risk is measured
      on one 18 s clip from a quiet room.*
- [ ] **P7** `[F]` Serbian copy review of customer-visible mail and claims: `AdminAccessNoticeJob`
      today, C11's provenance sentence (P17) when it exists. *Both are in the founder's voice and
      neither has been read by him.*

## 1. Close the deploy seam

- [ ] **P8** `web.Dockerfile`'s device-token substitution — the one seam that must close before the
      first real deploy (`ARCHITECTURE.md` §13).
- [ ] **P9** Decide what happens to the **seeded demo company** behind a public URL. *D10 made
      `DEM0-TEST` Development-only; the demo company itself still goes public.*

## 2. Review debt — close before building on any of it

- [x] **P10** ✅ 2026-09-04 — reviewed accept-with-fixes; both gating findings closed and mutation-proven (backend 1142 → 1146). See JOURNAL.
- [x] ~~**P10** (original text below)~~ **D9 (`3716283`)** — never reviewed, and its implementer was killed before reporting,
      so there are **no mutation proofs**. The report's supersedes band, `AdminAccessNoticeJob`, the
      credential guard. *Start here.*
- [x] **P11** ✅ 2026-09-04 — **ALL REVIEW DEBT DISCHARGED.** Backend: `a78cc05` accept-with-fixes (2 gating), D6 `8c166a4` accept-with-fixes (1 gating), D10 `dbc6a1f` accept, D8 accept. Frontend delta: accept. **Gating fixes are NOT all in — see P11d.**
- [x] **P11d** ✅ 2026-09-04 — **G1, G2 and G3 all closed and mutation-proven, with counter-mutations reproducing each original finding.** G3's config rides the existing `TEREN_APP_ORIGIN` rather than a new variable (one URL, one setting — the `Storage__Endpoint`/`PublicEndpoint` confusion avoided), now required by `deploy.sh` on **both** targets. The `Program.cs` check stays a **warning**, deliberately: refusing to boot would turn an onboarding-blocking setting into a total outage of a running box at its next restart, and the defect was never that the host started — it was that the screen claimed a send, which is now impossible at the request. Backend 1150 → **1157**.
- [x] ~~**P11d** (original)~~ Finish the backend gating fixes. **G1 and G2 are in and green (1146 → 1150); G3's code is in but owes two halves:** fix (c) `Auth__AppUrl` into `deploy/.env.example`, `deploy/docker-compose.prod.yml` and `deploy/README.md` §2 (no `deploy/` file touched yet), and fix (d) a test asserting no token is superseded and no row minted on the no-AppUrl path. **Then mutation-prove G1, G2 and G3 — none of the three has a proof.** *G3 is a real defect: the invite screen says "sent" when nothing was sent, and "send again" retires the previous working link.* **This item's original list was wrong in three places** — corrected
      2026-09-04 by both reviewers reading `JOURNAL.md` against `git log` instead of trusting the
      trackers. *A tracker is not evidence; the commit history is.*
      - **Backend, genuinely unreviewed:** **`a78cc05`** ("A phone can make a correction, and staff
        can see what is failing") — the **higher-value target than anything in the old list**: the
        `/api/platform/health` endpoint, the `TerenIdentityDbContext` widening (`Project` plus keyless
        `EntryHealthRow`/`ReportHealthRow` — the change that moved the privacy barrier from *no
        evidence tables* to *no evidence content*), the `IJobQueueDepth` seam, and the correction
        endpoint with `EntrySupersedesTests`. Then **D6** (`8c166a4`), **D8**, **D10** (`dbc6a1f`).
      - **Frontend: CLOSED 2026-09-04** — accept-with-fixes, three gating findings, fixes in and
        then **delta-reviewed: accept**, every fix mutation-proven. Covered F10's unreviewed plumbing
        and F13's unreviewed rounds.
      - **Already reviewed, needs nothing** — do not re-review these: **`fc5737f`** carries the
        `/platform/health` **frontend** (the old list called it unreviewed; it is the *backend* half
        in `a78cc05` that was), **F10's shipped form** was rebuilt and reviewed inside `a42adaf`
        (delta review: accept), and **`c97c0e1`** records its own accept-with-fixes plus a delta
        accept. F13's genuinely unreviewed rounds all live inside **`9e33b8f`**.
- [x] **P11c** ✅ 2026-09-04 — all four closed, each mutation-proven. (a) `goToPage` captures the generation before the await; (b) the triage tiles are now genuinely withheld until an answer exists — **the claim was made true rather than the comment made honest**; (c) the pager left the loading branch, with `Učitaj još` disabled while a load is out and the page reset moved to the head of `load()`; (d) the four Serbian strings are listed for the founder. *Watch: the page-reset move is a visible behaviour change beyond the letter of (c) — a reload snaps the foot to page 1 immediately.*
- [x] ~~**P11c** (original)~~ Four non-gating items from the frontend delta review (2026-09-04), all on `/platform/logs`:
      **(a)** `goToPage` re-applies a stale page after a discarded batch (`logs-page.ts:458-467`) — press
      › with a slow `loadMore` in flight, then tap a level chip, and the clamp lands on the *new* list's
      last page instead of page 1; fix is to capture `reads.current()` before the await. **(b)** the triage
      tiles read `0 / 0 / 0` during the first load — **pre-existing**, but the template comment and the new
      spec both claim they are withheld when there is no answer, which is the same false-claim class the
      empty-sentence fix closed. **(c)** the pager sits inside `@if (!loading())`, so the card's foot
      vanishes on every keystroke-triggered refilter. **(d)** `[F]` four new Serbian strings are
      customer-facing and unheard by the founder: `capture.blocked.correctionUnknown.title/body`,
      `health.sites.omitted.title`, `health.reason.unrecognised`.
- [x] **P11b** ✅ 2026-09-04 — `<app-sign-in-again />` in `worker-page.html`'s empty state, three specs on a fixture holding **both** an admin and a device session, mutation-proven. *Finding: the sentence that survives a 401 there is `company.reason.notSignedIn`, not `signedOut` — `listWorkers` reads the `admins.token()` **signal** inside the component's `effect`, so discarding the credential invalidates the effect and the screen re-loads with nothing in hand. Harmless today; it stops being harmless when a second signal read joins that synchronous head.*
- [x] ~~**P11b** (original)~~ `worker-page.html:103-114` has the **identical 401 hole** the frontend review found on
      `/company/profile` — offers only "reload" when the session is gone. It is **F6, already
      reviewed and accepted**, so it was deliberately left out of the fix increment rather than
      edited under another increment's name. Needs its own small round.
- [x] **P12** ✅ 2026-09-04 — **delta review: accept.** All three gating fixes and every P12 item mutation-proven (remove fix → named spec red → restore, sha256-verified), and the vacuity question is answered: the replacement logs-loading spec genuinely renders a loading frame, so it can fail. Measured in a browser at 360–1920. **code is in and both suites are green, but its implementer was stopped before reporting, so there are NO mutation proofs and no account of intent. Treat exactly like D9: needs a delta review.** Four non-gating fixes: no in-flight guard on `HealthPage.load()`; two "Prikazano"
      totals in one card; `capture.blocked.correction.body` blames the network in the one case where
      retrying can never help; `health.reason.unrecognised` says the app did not recognise a code
      when the **server** is what did not.
- [x] **P13** ✅ 2026-09-04 — **(1) `superseded_after_send` is genuinely closed end to end and nothing was changed** — the whole route was traced, not the two symbols: server writes the reason and refuses the seal → the list withholds "Ispravi" → Home routes to the record, not the gate → `entry-detail` draws the notice and the single correction control → `supersedes_entry_id` reaches the wire → and the loop is cut at `confirm-page.ts:266`, which tests `supersededAfterSend` **before** the status switch. Residual, deliberate and documented: it reads the server's answer only, so offline the phone behaves as before. **(2)** No third screen — every other admin surface carries the control under `unconfirmed() && reasonKey()`, which a 401 satisfies there; the one control-less empty state left is the **foreman's** own profile, correctly, because his way back is a code at `/activate`. **(3)** Behaviour unchanged — see the founder question below.
- [x] ~~**P13** (original)~~ Three items carried from the 2026-09-02 fix round: `superseded_after_send` is a dead
      end on the phone; no tappable route to `/login` after a 401 on a browser that also holds a
      device session; Otkaži during `saving()` discards a kept take.

## 3. C11 — the report becomes a day's account *(before C9)*

- [ ] **P14** Extraction answers `schema_version: 2` — a `narrative` plus an optional `problems`
      list. *Correct and order the words; never invent, summarise away or reorganise into categories.*
- [ ] **P15** Report body renders prose + the problems band, **keeping the v1 path** for entries that
      already exist. *v1 is never migrated.*
- [ ] **P16** Confirmation screen becomes **one editable paragraph** plus the problem line.
- [ ] **P17** The provenance sentence: a reader must never confuse v2 **tidied prose**,
      `described_verbatim` **raw transcript**, and v1 **sections** (`ARCHITECTURE.md` §14 dec. 12).

## 4. C10 — sites and assignments, by the owner

- [ ] **P18** **Project write routes — they do not exist at all today.** Create and edit a site.
      *Sites exist only because `DemoSeeder` writes three fixed rows.*
- [ ] **P19** Worker↔site assignment as a **join** — a worker is on several sites, which is the
      normal case on a small crew.
- [ ] **P20** The assignment is a **restriction**: the picker shows a foreman only his sites and
      `POST /api/entries` refuses any other.
- [ ] **P21** Unassignment must **never** hide a worker's existing entries. They are evidence
      (invariant 2); the assignment gates *writing*, never *reading history*.
- [ ] **P22** Edit `project.recipients`. *Multi-recipient delivery already works server-side and
      nothing in the product can change the field, so a client who changes email cannot be reached.*
- [ ] **P23** Migration + demo seed + the seeded-id contract in `core/projects/project-source.ts`.
      *If those ids drift, every `POST /api/entries` 404s and captured entries can never leave the phone.*

## 5. C9 — the owner's company-wide diary *(largest single piece)*

- [ ] **P24** `GET /api/entries` and the media read path accept a **company_admin** bearer with
      company scope. *Both authenticate a **device** bearer only today. Do not solve it by handing
      the admin a device token, and do not reach for presigned GETs — §8 refused those on purpose.*
- [ ] **P25** The admin surface: **reuse** C3's archive and entry-record screens behind an admin
      session, filters by site / worker / date, all three device classes.
- [ ] **P26** "Send this report again to its recipients." *What the cut client portal was really
      for: the client's need is get me that day, not let me browse.*

## 6. M1 remainder

- [ ] **P27** **C1** Offline queue hardening — survives airplane mode, app kill and flaky signal;
      "N pending" always visible; upload resumes on next open.
- [ ] **P28** **C2** Weather enrichment — conditions and temperature for the entry's date and GPS
      (Open-Meteo, no key).
- [ ] **P29** **C4** Finish corrections: a replaced day's record screen must say it was replaced and
      must not offer a second correction. *The archive list marks both ends; the evidence screen does not.*
- [ ] **P30** **C6** Weekly recap PDF.

## 7. C7 — production hardening

- [ ] **P31** Hetzner + TLS; the apex pointed at production only when the app is ready.
- [ ] **P32** Automated Postgres backups **with a rehearsed restore** — not just a cron line.
- [ ] **P33** Error alerting that actually reaches the founder's phone.
- [ ] **P34** Re-check object-storage CORS on Hetzner. *Browser→MinIO is verified; Hetzner Object
      Storage may need its own rules and was never assumed to inherit them.*
- [ ] **P35** Log retention and disk headroom on the box. *Disk exhaustion has already taken the
      whole local stack down once.*

## 8. Real-device proof — needs **https**, not merely a hostname

`crypto.subtle` refuses to run in an insecure context, so the upload path cannot hash a file
without TLS. None of this can be judged from a laptop.

- [ ] **P36** Android: microphone, camera, GPS, and offline **cold start** of the installed PWA.
- [ ] **P37** **iOS: HEIC, what an iPhone actually records (`ARCHITECTURE.md` §14 dec. 4), and the
      offline queue surviving Safari.** *The founder chose to support iPhone recording, so the
      native-shell cut is conditional on this working — this is the one item that can reopen it.*
- [ ] **P38** Install-to-home-screen on both platforms.

## 9. C8 — pilot

- [ ] **P39** `[F]` A foreman from the distributor's network has it installed, understands it in
      under five minutes, and the founder has a channel for his complaints.

---

## Critical path

```
P1 purchase ──► P2–P5, P8 deploy ──► P10–P13 review debt ──► P14–P17 C11
   ──► P18–P23 C10 ──► P24–P26 C9 ──► P27–P30 M1 rest ──► P31–P35 C7
   ──► P36–P38 real devices ──► P39 pilot
```

**The two riskiest items are not code:**

- **P6 (A2, real site audio)** — the whole accuracy assumption rests on one clip from a quiet room.
- **P37 (iOS capture)** — the only thing that can still force a native app.

**Ordering that is load-bearing, not preference:**

- **P14–P17 (C11) before P24–P26 (C9)** — C9 renders whatever shape entries have. Build it first and
  it gets built twice.
- **P10 before anything built on D9** — reviewing a tree that is being edited proves nothing.

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

## 2026-08-30 (evening) — B7 cleared its gates; profiles designed and the first half built

**Talked about**
- B7's two reviewers (branding + install; `reset-demo`) — both **accept**, no gating findings.
- Then the session's real subject: the profile/identity model, designed from scratch with the
  founder rather than for him. Seven rounds of decisions, several reversing earlier ones.
- Whether the dev-env login should be a throwaway or the real thing. Founder: *"we are switching.
  We will build a profile logic like it should."*

**Decided** (full record in `plans/profile-and-identity.md` §2; the load-bearing ones)
- **Three roles**: super_admin (Teren staff), company_admin (the customer), worker (the foreman).
- **A super admin can never read entries, transcripts, photos or reports.** He may see company and
  project *names* and the application log stream. That claim is narrower than the first draft's,
  deliberately, and §6/§12 of the plan make it mechanically true rather than promised.
- **A worker's username is his durable identity**; the device credential proves it. This reversed
  the original "the device credential *is* his identity" after the founder asked the question that
  broke it: *what if the worker changes his device?*
- **Activation is username + code, and the code stays single-use.** A reusable code is a permanent
  password shared over WhatsApp. Device replacement is solved instead by **self-service**: he types
  his username and a fresh code is emailed to him.
- **No sign-in step for an activated phone, ever** — it opens on the record button, resolved
  on-device with no network call.
- **Everything visible on every device.** This overturned "admin screens ≥768px only" and with it
  the case for a separate admin app.
- **Codes are shared one worker at a time.** No bulk export: a group chat carrying six codes lets
  any worker activate under another man's name, and the report would then carry that name.
- **Routes and query parameters are English.** Founder: *"common is to use english words in
  programming."* UI text stays Serbian; this changes URLs, nothing a user reads.

**Built**
- `plans/profile-and-identity.md` — the specification, 840 lines, founder-approved.
- **D1** (backend, reviewed **accept-with-fixes**, fixes in): six identity tables,
  `TerenIdentityDbContext` as a closed model with its own migration history, PBKDF2 password
  hashing and Crockford activation codes in `Teren.Core/Identity/`, `DbCredentialAuthenticator`.
  `StaticTokenDeviceAuthenticator` **deleted** — the token baked into the PWA now authenticates as
  a real seeded device row, which is what kept the demo working through the change. 476 → 610 tests.
- **F1 + F2** (frontend, reviewed **accept-with-fixes**, fixes in): the outbox fix and session
  plumbing. 436 → 473 specs.
- **F3**: `/welcome`, `/activate`, `/login`, verified in a real browser at six widths. 473 → 538.
- Docs: `ARCHITECTURE.md` §12 rewritten (it was false in every particular), §6 seed contract,
  `CLAUDE.md` state and suite counts.

**Found, worth remembering**
- **Both suite counts in `CLAUDE.md` were stale** — 403/447 recorded against an actual 436/476.
  Re-measured off the tree, not carried forward.
- **`reset-demo` was broken on any un-migrated database, dry run included**, once a second
  migration history existed — dying with the same bare `42P01` this project has been bitten by
  twice before. Caught by the reviewer on a probe database, not by reasoning.
- **A revoked demo phone could not be healed by `seed`.** `seed` reported success and every phone
  got 401 with nothing saying why. Now `seed` clears three withdrawal stamps — `device.revoked_at`,
  `app_user.disabled_at`, `company.suspended_at` — while never restoring *content* the founder
  edited. A test pins that line.
- **A test double that could not express the failure it existed to prove.** `FakeApi.configured`
  was hardcoded `true`, so deleting the `pass()` gate looked like a *successful upload*. The
  mutation would have passed and proven nothing.
- **A spec that claimed exhaustiveness and had none.** The reviewer added a fifth `OutboxState` and
  all 472 specs stayed green. Now it fails to *compile*.
- **`ActivationCodeFormat.Fold` drops non-ASCII**, so a Serbian foreman on a Cyrillic keyboard
  typing `О` (U+041E) loses the character silently. Both halves are converging on one folding
  table; `В→B`, `Н→H`, `Ј→J` are equally strong homoglyphs still missing from it.

**Founder actions**
- [ ] Read the new Serbian copy on the three auth screens — all of it is new and unreviewed.
- [ ] Decide Welcome's button hierarchy: the artboard makes "Prijavi se" primary, but the people
      who meet that screen most are foremen holding a code.
- [ ] Still owed: an SMTP relay (now on this feature's critical path — a locked-out admin has no
      way back in without one), and `design/Code.dc.html` at 390 + 1280.

**How the session ended**
- **D2 + D3 landed green but unreviewed**: `BearerAuthFilter`, `RoleFilter`, the 403/404 doctrine,
  rate limiting, `/auth/login`, `/auth/activate`, `/api/me`, `create-super-admin`, and the
  company-admin surface for workers, codes and devices. 610 → **786 tests, 0 failed**, build clean.
  The implementer was adding one shared test helper when it was stopped, so treat the increment as
  complete but unaudited.
- **F4 + F4b was started and deliberately backed out.** The agent had rewritten `app.routes.ts` with
  guards and English paths, but had not yet written `device.guard.ts` or updated
  `rescue.service.ts` — so the PWA could not build. `app.routes.ts` was restored by hand to its F3
  state (a `git checkout` would have destroyed F3's uncommitted routes) and re-verified at 538/538.
  Nothing of F4 survives; it restarts clean.
- Tree left green: **786 backend / 538 PWA**, both builds clean, verified by execution.

**Next**
1. **Review F3, D2 and D3** — three increments owe their gate, the largest unaudited surface this
   project has carried. Nothing should be built on top until they clear.
2. F4 + F4b from scratch.
3. **Prove activation end to end against the real API** — type a real code, get a real device token.
4. **Only then** empty `environment.deviceToken`. Flipping it before a code can be redeemed locks
   the founder out of his own app with no way back but editing an environment file.

## 2026-08-30 (through the night) — B5 + B6: the money path closed, then the founder used it

**The loop closes.** Speak → transcript → confirm → PDF → email → sealed, proven end to end against
real Postgres, MinIO and SMTP. B5 and B6 both went through their reviewers; both came back
**accept-with-fixes**, and both sets of findings were the interesting part of the day.

**B5's reviewer found a small gating bug and a much better one underneath.** The gating item was a
missing dictionary key (`confirm.error.reported`) that would have shown a foreman a raw
translation key. The fix closed the *class*: `CONFIRM_FAILURES` is now derived from a
`Record<ConfirmFailure, true>` — the one TypeScript construct checked for completeness — plus a
spec that reads every `.ts`/`.html` off disk and asserts every dictionary-shaped string resolves in
both languages. The better find was non-gating: `saveConfirmDraft` swallowed failures under a
comment claiming Home surfaced them. **It did not.** On a screen whose entire promise is *ništa
nije izgubljeno*, a quota-exhausted write would have discarded a foreman's typed correction in
silence. Third instance of the same species — a comment or a screen asserting something the code
does not deliver.

**B6's reviewer found four, and all four were about the same promise:** *a client never receives two
reports, and a sealed entry matches what was sent.*

1. A **network replay** of `/confirm` cleared `report_interrupted` and resent — two copies in an
   investor's inbox, no human deciding, in direct breach of §6's own rule.
2. **Post-DATA SMTP failures were retried** — the classic duplicate-email vector. A relay that
   accepted the message but answered slowly got it up to three times, and the row then recorded
   "nothing left the building", which was false. **The tests could not see this**: the fake delivery
   threw *before* recording a send, so "accepted and then threw" was literally unrepresentable.
   Making that state expressible was the fix that mattered.
3. A crash between *sent* and *sealed* stranded an entry **permanently** — the recovery branch
   existed and was tested, but only by direct call; the sweeper's predicate could never reach it.
4. A **changed re-confirmation mid-pass** sealed v2 while v1 was already in the client's hands.

Sobering pattern: three of the four were compositions of individually-correct features, and the
fourth was invisible to a test suite that looked thorough.

**Then the founder actually used it, and that was worth more than any review.**

He captured a real entry, and had to *type the whole day himself*. The transcript was perfect;
extraction had never run. He said the obvious thing — *"if what I read from the transcript is what
I said, I should just be able to confirm it"* — and he was right. The screen had been designed for
the happy path and the empty path, and the space between them is where the product actually lives.

The cause turned out to be mundane in a way worth recording: **the Anthropic account was out of
credit**. A $5 billing fact, presenting as a product design failure. Nothing in the system said so
where anyone would look, and — because `/confirm` clears `failure_reason` deliberately, so that
"fix the cause and confirm again" works as a retry — **the evidence of why the AI produced nothing
is destroyed the moment a foreman confirms.** For a product whose eval set is the point, that is a
real gap, now written down.

Worse, the screen *lied about it*. With a perfectly good transcript displayed on screen, the banner
read **"Nothing could be read from the recording."** `needs_review` covers two unrelated
situations and the copy only knew one. Fifth instance of the class.

**Decided, and built the same night:** with a transcript and no structure, the foreman **confirms
his own words as the record, in one tap**. `described_verbatim: true` with the transcript verbatim
in `notes`; the report renders the day as prose, marked as his words rather than as extracted data.
The eval triple stays honest — `extracted` null, `corrected` recording approval-as-is, so approval
is still distinguishable from typing, and the offer is withdrawn the instant he edits a section.

**This changes what the product's floor is.** Not "type it yourself" when the AI is down, but *a
timestamped, geotagged, voice-backed record in his own words*. A foreman can finish his day in one
tap with every AI in the chain unavailable. That is a better product than the one designed on
paper, and it came from ten minutes of real use.

**Also decided and shipped, all founder-driven after reading a real PDF:** the record id comes off
(matching by project + date instead, with the assumption commented where it will break), location
prints as a place name rather than decimal degrees, timestamps print in the site's own local time
(new per-project `time_zone`, default `Europe/Belgrade`), a TEREN wordmark, and **the PDF downloads
from the app** — the system's first storage read path, authenticated streaming rather than a
presigned link, shaped so photos can reuse it.

**The timezone test that nearly wasn't.** Dropping the UTC→Belgrade conversion failed five tests.
But hard-coding `+2` — the plausible wrong fix — **passed the summer test**; only the winter test
caught it. One test would have shipped a report printing the wrong time for four months a year.

**Suites: 447 backend, 403 PWA** (from 260 and 255 at the start of the day). Every increment
mutation-proven. Two agents caught their *own* specs being vacuous mid-run and said so.

**Still owed:** reviewer gates on the verbatim pair and the report-polish pair. Nobody has looked at
any PDF in a viewer, and the Serbian report copy is unreviewed by a native speaker. B3a staging is
next, then the founder's welcome + login gate.

## 2026-08-29 (night, C3 + first real transcript) — The archive shipped, and the pipeline spoke Serbian

**The archive, pulled ahead of M1 on the founder's ask**

"When you click an entry it should show all the details" — a reasonable thing to want, and the
roadmap had it parked at C3 behind four other increments. Built it now: archive list plus a
read-only entry record (structure, transcript, photos, audio, GPS, weather), offline-first from
Dexie merged with `GET /api/entries`, three device classes including a two-pane desktop
master-detail. **255 PWA specs**, up from 248.

The review returned two gating defects, both of the same family — **the screen claiming to know
something it did not**:

1. A 404 and an unreachable server rendered identically as "entry not found." A foreman in a
   basement with no signal was being told his record is gone. Now only an explicit 404 says
   missing; anything else says the server could not be asked.
2. A failed refresh discarded rows already fetched and on screen, replacing real content with an
   empty state because one poll failed.

Both fixed, and — the part that matters — **proven non-vacuous**: the implementer reverted its own
fixes and confirmed exactly the three new specs failed, then restored. The reviewer's argument for
demanding that was sharp: the first defect existed *because* the failure path was untested, so a
test written after the fact proves nothing unless you watch it fail.

Five smaller honesty fixes went with them, the notable one being a server row with
`received_at: null` that read as received. Two items logged and deliberately not fixed: an
out-of-order `listEntries` race where a stale *successful* response can still overwrite a newer
one, and a silent clip at 200 rows.

**C3 stays ◐, and the reason is worth stating plainly.** There is no read path for media — no
presigned GET, only PUT. So an owner opening the diary on a tablet sees an entry he did not capture
and cannot see a single photo of it. That is the buyer's actual reason to pay (PROJECT.md §2). The
archive is built; the evidence it exists to show is not reachable from any second device.

**The first real transcript**

The founder set the Azure key in user-secrets and captured an entry in Chrome. Entry `2eaf90a3`:
`raw_transcript = "Halo halo testes."`, **in Latin**, parked at `needs_review` with
`extraction_not_configured`. Trivial content, but the whole chain is now proven from a browser
microphone to a transliterated transcript in Postgres — capture, presigned PUT, `/complete`,
sweeper pickup, Azure, transliteration.

It also demonstrated the design working as intended rather than as an accident: the transcript is
persisted and write-once **before** extraction is attempted, so the missing Anthropic key cost the
structure and nothing else. A pipeline that lost the recording because the second AI call had no
key would have been a defensible-looking design and a disaster on the evidence path.

**The defect that came out of looking at two screens**

The founder noticed Home said **"Primljen"** while the archive said **"Potrebna provera"** for the
same entry, and asked why. Both were telling the truth about different data. Home reads
`entry.serverStatus` from Dexie — written exactly once at upload time from `/complete`'s response,
which says `received`, and **never refreshed**. The archive fetches live.

The irony is instructive: `home-page.ts` carries a comment explaining that the status helper is
shared across screens *precisely so* a recent row and an archive row cannot disagree. The
formatting is shared. The data is not. A comment can promise something the data layer never
delivers, and nothing in the type system objects.

This is not cosmetic. Home is the screen the foreman looks at, and "Primljen" reads as *done,
nothing to do* — so he never opens the entry that needs him, and a day's evidence quietly fails to
become a report. That is the exact failure the mandatory confirmation screen exists to prevent.
**Folded into B5's scope**: Home refreshes status for recent entries, and an entry needing
attention says so where he will actually see it.

**Housekeeping**

The database was reset for a clean manual test: 18 entries and 34 media rows deleted, the three
demo-seed entries deliberately kept (rule 6 — the distributor demos at any moment; the `reported`
one is trigger-protected anyway and could not have been deleted without dropping the immutability
trigger). `fk_media_entry` is RESTRICT, not cascade, so media has to go first. MinIO still holds
the orphaned objects. Pre-commit audit over 101 untracked files: no secrets, no binaries, no audio.

**Next:** B5, then B6. Those two are what stand between the founder and a loop a foreman can
finish a day with; everything left in the C-list refines a loop that does not close yet.

## 2026-08-29 (night, B4) — Processing pipeline built, reviewed, and its one real race closed

**Talked about**

- B4 end to end: `received` → STT → Claude extraction → `awaiting_confirmation`, or
  `needs_review` with the evidence intact — never nothing.
- The backend review of it, and the finding that turned out to be the point of the whole session.

**The verdict: accept-with-fixes.** Five findings, one gating. All five are now closed.

**F1, the gating one — worth remembering, because it is a class of bug, not an incident.**
A live processing pass can outlive `Pipeline:StaleProcessingAfter`, and the processor's terminal
writes were unconditional. Three facts that were each fine alone:

1. The worst-case pass was ~27 minutes and the stale window was 15 — because two retry loops were
   stacked. The Anthropic SDK retries twice by default and the AWS SDK was set to retry twice,
   *underneath* the pipeline's own `MaxAttempts` of 3. Nobody had multiplied it out; the option's
   comment cheerfully claimed the window was "comfortably longer than a real pass".
2. The sweeper's park is a correct conditional UPDATE — and it would fire on an entry that was
   still being worked on.
3. The processor's success and park writes were tracked `SaveChangesAsync` with no concurrency
   token. Last write wins.

So: one brownout at Azure or Anthropic stretches a healthy pass past 15 minutes → the sweeper
parks it → the foreman sees `needs_review` (which `/confirm` deliberately accepts), types what
happened and confirms → the worker's extraction finally returns and flips `confirmed` back to
`awaiting_confirmation`, `confirmed_at` still stamped. A confirmed entry silently leaves the set
B6 reports from, and **nothing anywhere says so**. On an evidence product that is the worst shape
a bug can take: invisible, and it looks like the system working.

The lesson generalises. **The claim, not the clock, is the authority.** Any long-running worker
that can be declared dead must re-assert ownership at the moment it writes, not only when it
starts — and "0 rows affected" is information, not an error to swallow.

**Decided**

- Every terminal write in `EntryProcessor` is now conditional on `status = 'processing'`
  (`ExecuteUpdateAsync`, mirroring the claim). Zero rows affected → log it and return `Skipped`.
  The pipeline also re-checks ownership *before* the extraction call, so a lost claim does not
  buy an Anthropic answer nobody will keep. The transcript write stays unconditional on purpose:
  it is raw evidence, it is write-once, and it changes no status.
- **No SDK retries under the pipeline**, as a standing rule: `AnthropicClient.MaxRetries = 0`,
  `Storage:DownloadRetries = 0`. The processor owns retry policy — the same argument that already
  justified `[AutomaticRetry(Attempts = 0)]` against Hangfire. Worst case is now ~21.5 min and
  `StaleProcessingAfter` is **45 min**, with the arithmetic written on the option and *checked by
  a test* rather than asserted in a comment.
- Failure codes are classified on a typed `AiFailureKind`, never on an English message substring.
  The old `ex.Message.Contains("no speech")` was exactly the mistake B3's failure taxonomy
  refused to make: rewording one sentence would have silently degraded the Serbian shown to a
  foreman, with nothing failing anywhere.
- `Pipeline:SweepInterval` is wired, not decorative. It renders to a cron expression via
  Hangfire's own `Cron` helpers, and that same string is what the scheduler gets *and* what the
  start-up log prints — so the log cannot assert a cadence that is not running. It used to be a
  hardcoded `Cron.Minutely` beside a log line quoting the configured interval.
- `Stt:Azure:Locale` is deleted. It was bound and validated and never read; the locale comes from
  `Pipeline:TranscriptionLocale`. Two knobs for one setting, one of them inert, is worse than no
  knob.
- `SerbianScript`'s all-caps digraph wart is **pinned, not endorsed**: `КРАЉ` → `KRALj`, because
  there is no letter after the Љ to read the casing from. It will show up in an all-caps client
  name on a report one day; when it does, that is a decision someone makes, with a test to change.

**Built**

- `src/Teren.Core/Ai/AiProviderException.cs` — `AiFailureKind` (`CallFailed` / `UnusableAnswer` /
  `NotConfigured`) on the exception; both providers now set it.
- `src/Teren.Infrastructure/Processing/EntryProcessor.cs` — conditional terminal writes, the
  pre-extraction ownership check, typed classification.
- `src/Teren.Infrastructure/Processing/PipelineOptions.cs` — honest `StaleProcessingAfter` with
  the arithmetic spelled out; `SweepCronExpression()`.
- `src/Teren.Infrastructure/Storage/StorageOptions.cs`, `Ai/ClaudeStructureExtractor.cs` — SDK
  retry loops off, with the reason.
- `src/Teren.Infrastructure/Ai/TranscriptionOptions.cs`, `src/Teren.Api/appsettings.json` — dead
  `Locale` removed, new defaults.
- `src/Teren.Api/Program.cs` — the sweep is registered with the configured cron and the log says
  so.
- Tests: `PipelineOptionsTests` (new), plus stale-claim, classification and script tests.
  **260 backend tests, all green** (~30 s, Testcontainers over real Postgres).

**Proven, not assumed**

- The two stale-claim tests were **mutation-checked**: with the `status = 'processing'` predicate
  removed from both terminal writes, `A_pass_that_lost_its_claim_cannot_undo_a_confirmation`
  fails with *"entry!.Status should be EntryStatus.Confirmed but was
  EntryStatus.AwaitingConfirmation"* — the corruption itself, reproduced — and the park-path test
  fails alongside it. Predicate restored: 260/260.
- The API was booted on a throwaway database and port (never touching the founder's running
  instance) with `Pipeline__SweepInterval=00:10:00`. `/health` answered `{"status":"ok"}`, the
  start-up log said `sweep on cron "*/10 * * * *" ... stale after 45 min`, and Hangfire storage
  held `recurring-job:pipeline-sweep → Cron = */10 * * * *`. Before this session it would have
  swept every minute and logged 600 s.

**Docs**

`ARCHITECTURE.md` §4 (real secret names, the B4 config sections, the Newtonsoft 13.0.4 / NU1903
pin, and the standing `&` trap: .NET's JSON encoder escapes `&` as `\u0026`, so a presigned
URL lifted out of a response by grep is not the URL), §6 (`processing_started_at` and the claim
rule), §7 (`raw_transcript` on the poll response, `/hangfire` auth), §10 (no SDK retries under the
pipeline), §14 (decision 3 is a config switch now).

**Founder actions**

- Nothing blocking. The extraction model is `Anthropic:Model` — moving Sonnet 5 → Opus 5 is one
  environment variable when the first evals say so.

**Next**

- B3a staging: a stable **https** origin and a one-command deploy. It unblocks the real-device
  debt in one move, and it is where Hetzner Object Storage CORS gets its own check.


## 2026-08-29 (late, continued) — Track A closed by decision; B3 finished end to end

**Track A — decided, not measured, and the docs say so**

The founder deferred A2 (real site audio) and chose **Azure AI Speech, `sr-RS`, fast-transcription
REST**, leaning on the mandatory confirmation screen plus typed correction for whatever
transcription misses. A1 was built and run first, so the decision rests on *something* — but on one
18-second scripted clip in a quiet room, not on site audio. `docs/stt-evaluation.md` records the
decision **and its evidence base**, including the re-open conditions.

The uncomfortable part, recorded rather than buried: **phrase-list hinting is inert for `sr-RS`** —
`azure-continuous` and `azure-continuous+hints` returned byte-identical transcripts across 39
phrases, with the wiring verified correct first (`PhraseListGrammar.FromRecognizer`, applied before
recognition starts). Phrase-list support was *the* reason Azure was preferred over Whisper. That
rationale did not survive contact with the service; `sr-RS` support is the surviving ground. No
non-Azure provider was ever benchmarked.

What worked: `40`, `6`, Geberit, all three worker names, štemovanje, električara — clean, first try,
no tuning, 2.0 s. What failed on every path: the material spec `PPR cev 25` → *pipr cevi dvaes 5*.
**Consequence: canonical-name mapping in the Claude extraction call (ARCHITECTURE §9.2) is now
load-bearing, not a nicety, and B4 must be evaluated on it.**

Two decisions followed: **transcripts stored in Latin** (Azure returns Cyrillic; transliteration is
lossless in that direction and the audio remains the untouched evidence), and **email over SMTP via
MailKit** behind `IReportDelivery` — with the relay still to choose, and a standing warning not to
send direct from the VPS (port 25 blocks, IP reputation; the report *is* the product's face).

**B3 — done, both halves, reviewed**

Ran as two parallel agents on disjoint trees (`src/` vs `web/`), the same split that worked at B2.

*Backend:* closed the three deferred review findings — the cross-tenant media 409 oracle now
answers 404 like a missing entry, `/complete` refuses a receipt-less advanced status instead of
reporting ready, and the presign TTL is asserted for real. **145 → 154 tests.** The reviewer
returned accept-with-fixes on one gating item: the same-tenant `pk_media` race branch had *zero*
coverage, proven by an always-404 mutation passing 153/153. Closed with a generalised race
interceptor and a deterministic test; the reviewer's own mutation now kills exactly that test.

*Frontend:* the outbox now talks to the API — env config, API client, lazy SHA-256 on Dexie **v4**,
upload order per §8, capped jittered backoff (5 s ×2, 10 min ceiling, ±30%), and a real Serbian
stuck state. **102 → 195 specs**, proven end to end against the live API and MinIO including the
failure paths.

**The gating defect worth remembering:** an outbox row persisted as `in_flight` when the app died
mid-upload was never retried, had no retry button, and showed "Slanje na server" forever — evidence
safe on the phone but unable to ever reach the server. The code's justifying comment ("an item is
only ever in flight because this same loop put it there") is true within a process and false across
a restart. Every test and every manual run happens inside one process lifetime, which is precisely
why neither caught it. ARCHITECTURE §11 had promised "resumption on next open"; the implementation
quietly did not deliver it. Fixed by releasing stale rows on `start()` plus a `finally` guard inside
a live attempt, both proven by reverting the fix and watching the new specs fail.

**Binding for B4+ — the failure taxonomy.** Terminal: `rejected` (400/404/422, refusing 409),
`unauthorized`, `not_configured`, `insecure_context`. **All 5xx including 500 are retryable** — the
entry stays in the outbox and heals unattended after a server-side repair, whereas a terminal 4xx
would make the phone abandon an entry the server holds. A 409 is never judged alone: re-read
`GET /api/entries/{id}` and decide on `received_at`, never on the English detail string. (The
orchestrator initially called the 500 a retry-forever risk; the backend reviewer showed the
opposite and was right.)

**`crypto.subtle` needs a secure context** — `https://` or localhost only, and it fails by being
`undefined` rather than throwing. **The phone-test tunnel must be https, not merely stable.**
ARCHITECTURE §13 updated; the PWA surfaces it as a terminal `insecure_context` state.

**Browser CORS to MinIO — verified the same evening, in a real browser.** The founder asked a sharp
question: the pending screen read 0 while media existed. The answer was that these are two
different stores — pending reads *this browser's* IndexedDB, and the agents' end-to-end runs had
gone through Node, so nothing had ever been captured in Chrome. Capturing one entry there settled
both questions at once: the app does call the API, and entry `bdbaee30` reached
`received_at 14:38:56` — a stamp applied only when `/complete` confirms every declared object is in
storage at the declared size. So the **browser presigned PUT succeeded, OPTIONS preflight
included**, which is precisely what Node fetch could never prove. Caveat: this is local MinIO with
default CORS; Hetzner Object Storage may need its own rules, so re-check once at B3a.

Worth noting the shape of the question. "The screen says 0 but we have media" could have been
brushed aside as expected; taken seriously it produced the session's last piece of real
verification.

**Next:** B3a staging (stable https origin, one-command deploy), which also finally unblocks the
whole real-device debt. Then B4 — which now has its provider, and needs Hangfire and QuestPDF
installed from zero.

## 2026-08-29 (late) — Full-project analysis; toolchain repaired; a real evidence-path bug found

**Why this session looks different:** it started as "analyse the whole project before we continue"
and turned into repair work, because the analysis did not survive contact with the machine.

**Analysis findings that mattered**
- **The documented toolchain was wrong in every row.** Node was **22.12.0** (Dec 2024), below
  Angular CLI 22's minimum — so the PWA could not build or test *at all*, while the docs claimed a
  verified 24.19.0. `node_modules` was absent too. Also .NET 10.0.300 (not 10.0.111), Docker 29.4.3
  (not 29.7.2), Compose v5.1.3 (not v5.4.0).
- **`ng test` exits with code 0 even when specs fail.** Any check reading the exit code reports a
  broken suite as green. Recorded in ARCHITECTURE §1 and CLAUDE.md.
- **No backend tests exist at all.** Three projects, no test project: every backend invariant
  (sealing, caps, idempotency, tenancy, immutability) was proven once by hand and then guarded by
  nothing — against 91 frontend specs.
- **The PWA's three demo project ids were fiction.** `project-source.ts` used `6f7a1c1e-…` ids
  under a comment claiming they came from `DemoSeeder.cs`; the seeder had one project,
  `d3a0c1f0-…0002`. Proven live: `POST /api/entries` answers 404 on a phantom id, 202 on the real
  one. Once B3 wires the outbox this is unretryable — the evidence would never leave the phone.
- Smaller drift: the adaptive-rework delta review never landed (its verdict died with the session,
  so that increment never passed its gate); `Pages/*.png` committed by accident; `tokens.md`
  documents none of the layout system it is said to bind (`--band-top`, `--z-*`, `--layout-*`,
  `--bp-*`, `--header-height`, `--shadow-stop`); ARCHITECTURE §1 still said nothing was committed
  and §3 still marked `design/` as planned.

**Decided**
- **Node upgraded to 24.19.0** via winget (what the docs always claimed). A stale npm shim in
  `%APPDATA%\npm` still makes a bare `npm --version` report 10.8.3 while Angular correctly resolves
  11.17.0 — left alone, recorded.
- **The demo seed grows to three sites** rather than bending the seed to the PWA's phantom ids: the
  seeder's id stays canonical (three entries already reference it), and the Home picker is a dead
  control with one item while the buyer runs 3–20 sites (PROJECT.md §2). Site 2 carries two
  recipients (investor + `nadzorni organ`), how commercial jobs run here, which gives B6 a real
  multi-recipient case. **The seed ids are now documented as a contract with the PWA**
  (ARCHITECTURE §6) — the drift that caused all this is written down, not tribal knowledge.
- **Backend tests: real Postgres via Testcontainers, never InMemory** — the immutability triggers
  and CHECK constraints live in the database, and InMemory would let those tests pass against a
  broken schema. **No FluentAssertions**: v8+ needs a paid licence for commercial use, and §1
  already tracks licence exposure. xUnit built-ins or Shouldly (BSD).
- Standing bar for the test increment: for the critical invariants, break the production code,
  confirm the test fails, revert. A test that passes either way manufactures confidence.

**Built and accepted (all three increments through their reviewer)**
- **Backend — three-site demo seed** (`DemoSeeder.cs`). Verdict **accept**, no gating findings.
  The reviewer verified rather than trusted: rebuilt the old single-project state and confirmed a
  re-seed inserts exactly the two missing rows, JSON-parsed all 14 embedded JSON blocks (the
  escaped inch marks were a real escaping risk), geocoded both new sites to within 100–200 m of
  their real addresses, and proved the `ProjectId` → `Project1Id` rename has no external callers.
  Non-gating: seed existence-checks and writes are not in one transaction, so two concurrent
  `-- seed` runs could race — pre-existing, irrelevant for a one-shot founder command.
- **Frontend — salvage state machine + Dexie v3 migration.** Verdict **accept**, no gating
  findings. Suite **91 → 102** (16 files), `ng build` clean.
- **Backend — the first backend tests ever** (`tests/Teren.Api.Tests`): **145 tests** over real
  Postgres via Testcontainers, ~20 s cold, xunit.v3 + Shouldly. Verdict **accept**, no gating
  findings; the reviewer re-performed 3 of the 5 mutation checks itself and confirmed each failed
  the right tests. Proven empirically: disabling the EF immutability guard fails exactly the 4 EF
  tests while all 6 Postgres-trigger tests still pass, so the two halves of the immutability
  promise are independently covered. No production invariant was found broken.

**The bug the toolchain repair uncovered — the session's real find**
The one failing spec was **not** a stale test. The interrupted-recording screen offered
"Pokušaj ponovo" *deterministically* before the salvage resolved (the salvage awaits
`recorder.flush()` and a Dexie transaction; the template had no "interrupted but not yet salvaged"
state). Tapping it called `begin()`, minting a new entry id — and the late-landing salvage then set
`entryId = null` on the **new** take, so `stop()` returned early and the foreman held a live
recording with a dead stop button. A forced assemble-failure produced an unhandled rejection and
left the screen on the one action that records over the chunks it just failed to assemble.

Fixed with an explicit `SalvageState` machine plus a generation guard, so a salvage that no longer
owns the screen writes nothing. The foreman now sees a disabled "Čuvanje snimljenog…" (same size,
nothing shifts under the thumb), then "Otvori sačuvani snimak" when the draft is ready, "Sačuvaj
ponovo" if assembling failed, "Pokušaj ponovo" only if there was genuinely no audio. "Nazad" sits
outside the branch chain, so there is no dead end.

**Important nuance:** the earlier "91/91 green" claims were not false — they were **lucky**. The
spec is timing-sensitive and passes on an idle machine. A flaky test was masking a real defect on
the evidence path since B2. The adaptive-layout rework is *not* implicated (the defect is async
state sequencing); note git cannot corroborate either way, since all of M0 is one commit.

**A1 built (same session, after the batch)**
The STT spike harness exists at `tools/SttSpike/` — seven provider slots, run sequentially so
latency is measured. Azure appears **three times on purpose**, which is the comparison A3 actually
needs: `azure-fast` (fast-transcription REST, file as-is), `azure-continuous` (real-time SDK,
continuous recognition past the 15 s ceiling), and `azure-continuous+hints` (same plus a phrase
list seeded from the demo vocabulary). Provider chosen by the founder: **Azure AI Speech**, F0 tier,
because it is the only candidate supporting `sr-RS` *and* phrase-list hints.

**No ffmpeg needed for the common case.** Ogg/Opus decodes through Concentus (pure C#, asked for
16 kHz directly so libopus does the band-limiting rather than a naive downsample corrupting the
very accuracy being measured); WAV through NAudio. **But `.m4a` needs ffmpeg**, so an iPhone voice
memo silently loses the two phrase-list entries — the hint-vs-no-hint comparison Azure was chosen
for. Record via Android, via the PWA, or install ffmpeg.

Scoring folds **Cyrillic to Latin** (Serbian is digraphic; a provider returning штемовање against
Latin ground truth would otherwise look catastrophic while being correct) and tolerates case
endings, but keeps units and bare numbers near-exact so `40 m` cannot match "40 montažera" — a
false hit would credit a provider for a word it never said. Verified 0/6 on an adversarial
near-miss, 6/6 on fully declined Serbian.

**Verified:** builds clean; no key gives clean skips; a bogus key reaches the live service and
returns human 401s — proving the REST shape, the SDK native libs, the WebSocket and the phrase
list all work here. **Not verified: any real transcription** (no key existed during the build), and
it is still unknown whether fast transcription supports `sr-RS` at all — `azure-continuous` is the
fallback if not.

**Gotcha worth remembering:** source placed in `tools/SttSpike/Audio/` was silently gitignored —
`.gitignore` has `tools/SttSpike/audio/` and Windows git runs `core.ignorecase=true`. Renamed to
`Decoding/`. Any future folder whose name differs only in case from a gitignored one will vanish.

**First real STT signal (2026-08-29, 18 s test clip, quiet room, founder voice)**
The harness ran end to end against a live Azure F0 resource. `azure-fast` **ok in 2.0 s**, so the
fast-transcription REST endpoint does accept `sr-RS` — that open question is answered.

**The phrase hints did nothing.** `azure-continuous` and `azure-continuous+hints` returned
**byte-identical** transcripts. The wiring was checked before blaming the platform:
`AzureContinuousProvider.cs:75` uses the documented `PhraseListGrammar.FromRecognizer()` and
applies all 39 phrases before recognition starts. So the reading is that **Azure phrase-list
biasing is inert for `sr-RS`** — and phrase-list support was the entire reason Azure was chosen
over Whisper. **That rationale is now unproven, and the shortlist should reopen at A3.**

What every path got right: `40` and `6` (Azure normalises spoken numerals to digits), Geberit,
all three worker names, štemovanje, električara. What every path got wrong: **the material spec**.
`PPR cev 25` came back as *pipr cevi dvaes 5* (fast) and *pipi vas 5* (continuous). Fast also lost
*tople i* to *topli*; continuous duplicated a word and mis-declined štemovanje.

**`azure-fast` currently leads on every axis** — 3.5x faster, closer on the material code, and it
needs no local decode, so no ffmpeg.

**Two findings that outlive the provider choice:**
1. **Azure returns Cyrillic** while ARCHITECTURE §5 fixes Serbian **Latin** as the product script.
   The scorer folds Cyrillic to Latin so this does not distort the evaluation, but B4/B5/B6 now
   have a real question: raw transcript is evidence and is never altered (PROJECT.md principle 2),
   while the confirmation screen and the PDF must read Latin. Serbian Cyrillic to Latin is a
   lossless 1:1 transliteration, so it is solvable — but it is a decision that did not exist
   before this run. **New open technical decision.**
2. **The material-code failure may not be an STT problem at all.** ARCHITECTURE §9.2 already puts
   canonical-name mapping inside the Claude extraction call with the project vocabulary as
   context. Recovering `PPR cev 25` from a garbled phonetic rendering is plausibly a job for the
   model that knows this site materials list, not for the speech engine.

**Weight this correctly:** one 18 s clip, one voice, quiet room, a scripted sentence. It proves
the harness and gives a first signal. It does not settle A3. Real site audio decides.

**Founder decisions pending**
- **Interrupted-card copy is now wrong on two branches** — it promises in past tense that
  everything is saved, while saving is still running, and even when assembling *failed*. On the
  evidence path a false reassurance is worse than an error. Logged as `design/README.md` open
  question 7; needs three states of copy.
- **`prettier --check` fails repo-wide**, including untouched files: working copy is CRLF, prettier
  emits LF, no format script. Needs a `.gitattributes` / `endOfLine` decision — not taken
  unilaterally because it affects how the founder commits.
- Ratify or reverse: two recipients on demo site 2; Testcontainers + no-FluentAssertions.

**Verification honestly bounded**
Both reviews were code-level. Nothing in this session was checked in a live browser or on a phone:
no visual pass at 390/768/834/1280/1920, no real MediaRecorder interruption (that needs the OS
taking the mic), no device test. The existing real-device debt is unchanged and now also covers the
interrupted-recording path.

**Next**
1. Three non-gating follow-ups from the backend test review, all cheap: mirror the `pk_entry`
   404 treatment in the `pk_media` catch (a cross-tenant media UUID currently answers 409, a faint
   existence oracle that contradicts the suite own stated no-403 doctrine); harden the `/complete`
   sealed-return for B4 by splitting sealed-by-receipt from status-advanced; assert the presign TTL
   is about 15 minutes rather than merely in the future.
2. **B3 client is bigger than the ROADMAP line says.** Beyond the upload loop: the PWA computes no
   SHA-256 anywhere and `LocalMedia` has no field for one (the server requires 64 hex chars per
   file), so another Dexie version; no `environments/`, no API base URL, no device token in the
   build; `Cors:Origins` ships empty so a non-localhost origin is refused; `PROJECT_SOURCE` must
   swap to `GET /api/projects`. Realistically two evenings, not one.
3. Housekeeping still owed: untrack `Pages/*.png`; retrofit `tokens.md` with the layout tokens;
   clear the stale ARCHITECTURE §3 "design/ planned" and the stale Tailwind item in CLAUDE.md's
   veto queue; add a test for a genuine v1-only device jumping straight to Dexie v3 (the frontend
   reviewer's one non-gating gap).
4. Unchanged and still the only real blocker: **A2 — the founder records 3–5 real site voice notes.**

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

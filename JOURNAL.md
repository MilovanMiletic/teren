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

## 2026-09-03 (evening) — corrections, a health endpoint, and a Docker trap that looked like data loss

Founder: *"Do what is left in code first."* The four small items standing between here and M1 planning.
**Backend done and reviewed; the frontend half was stopped mid-item and is parked in `stash@{0}`.**

### Backend — accept-with-fixes, both gating items closed, 1054 → 1091 tests

1. **`supersedes_entry_id` on `CreateEntryRequest`.** It was on the entity and on `EntryResponse` from
   the start and never on the request, so `System.Text.Json` dropped it in silence and a correction
   button would have written an entry that *claimed* to be a correction and linked to nothing. Three
   decisions, all in the XML doc and now in ARCHITECTURE §7: **any target state** is accepted (an entry
   parked `confirmed` with `superseded_after_send` has had its report delivered and can never get
   another, so a reported-only rule would forbid the one correction the server itself asks for — and a
   4xx is *terminal* in the outbox, so refusing abandons a captured day); **chains allowed**, cycles
   impossible by construction; **same project, not merely same company**, because
   `fk_entry_supersedes_entry` accepts any entry row and a cross-project link would put one client's
   day inside another's report. The check sits **after** the replay check, so a replay is answered from
   what the server holds and the body is never consulted.
2. **`failure_reason` on `EntryListItemResponse`** — one field, so a list row stops offering a door
   that lands on a dead end. Proven with a real pipeline failure, not a planted string.
3. **`GET /api/platform/health`** — the last endpoint F7's health page needed.
4. **The owed M3 proof.** It came back positive and the old confound is explained: with **only**
   `SealDeliveredAsync`'s hash comparison disabled, `Nothing_automatic_resolves_a_delivered_report_whose_entry_moved_on`
   is the single red of twelve. The custody check is load-bearing, and was unproven until now.

**The health endpoint required widening the identity model, and that is the judgement to remember.**
`PlatformDirectory` resolves only `TerenIdentityDbContext`, which has no `Entry`/`Report`, and raw SQL
is forbidden on that path by `PlatformRawSqlTests` — the guard working, not an obstacle to route
around. So the model gained **three types and no more**: `Project` as `{id, company_id, name}` with
seven properties `Ignore()`d (an address is *not selectable*, not merely unselected), and
`EntryHealthRow`/`ReportHealthRow`, **keyless** four-column read-throughs of `entry` and `report`.
`db.Set<Entry>()` still throws, so §12's sentence stays literally true — but the barrier is now **"no
evidence content"** rather than **"no evidence tables"**, and that re-wording is the honest part. SQL
views (bucket grain, strictly stronger) were considered and rejected: they cost a migration in the
*evidence* history, the one carrying invariant 2's triggers, for a marginal gain over a tested column
pin. All three types are `ExcludeFromMigrations()` and `has-pending-model-changes` is clean on both
histories.

### The two gating finds, and both are about a guard that could not see

**G1 — the health screen reported the wrong thing about the one state that most needs reporting.**
An entry's `failure_reason` legitimately carries **report-side** codes: `EntryReporter.FailAsync` and
`RecordSupersededAfterSendAsync` write them there deliberately, "in both places a person might look",
and `superseded_after_send` exists **nowhere else at all**. The tally folded entry reasons through the
*pipeline* vocabulary alone, so every delivery failure was counted twice — once correctly, once as
`unrecognised` — `NeedsAttention` double-counted it, and the one terminal state whose documented
remedy is "resolve by hand" was anonymous on the screen whose whole job is saying what is wrong.
Fixed by folding entry buckets through `Pipeline ∪ Delivery`; `NeedsAttention` dropped
`DeliveryFailures.Sum` as a term and its doc now says outright that this is a severity **signal, not a
partition** — the terms overlap and undercounting is the only failure mode that matters, because that
is what would let the 500-site cap drop a site somebody needed to see. *The existing vocabulary test
could not see it: it checked what was in the sets, never which set a bucket was folded through.*

**G2 — the widening opened a hole in the guard that exists for exactly this, and the guard did not
know.** `PlatformPrivacyTests.Forbidden` listed `Entry`, `Media` and `Report`. The reviewer added
`public IReadOnlyList<EntryHealthRow> Peek() => [];` to `PlatformDirectory` and **all eleven privacy
tests stayed green** — and `EntryHealthRow.FailureReason` is the full `"{code}: {detail}"` string with
a provider's own words folded in, the hazard this very increment closes at the response boundary. Both
new types are on the list now, and in the anti-vacuity test too. ***A widening of the model is also a
widening of what the guard must forbid, and no guard can infer that.***

### The lesson worth carrying: a substituted seam proves nothing about shipped code

Two mutations **survived** the implementer's first pass. One was alphabetical luck in an ordering
assertion. The other is the one to remember: the fixture *substitutes* `IJobQueueDepth`, so every
"the queue reads unknown when Hangfire is off" assertion was really an assertion about the fake —
turning the shipped `DisabledJobQueueDepth` into a lie left the whole suite green. A test now asserts
the production class directly. *Sibling of this morning's microtask finding: both are specs that
could not fail.*

### The Docker trap — reported as data loss, and it was not

The implementer reported the founder's dev database and MinIO volumes destroyed, three hand-made
accounts and a report row gone, and stated it had restored the demo state with `migrate` + `seed`.
**Checked rather than relayed, and the conclusion was wrong.**

There are **two Docker engines on this machine.** The context is `desktop-linux` (Docker Desktop) and
that is where the founder's data has always lived — `teren_postgres-data` created 2026-08-29, 66 MB of
PG 17. The agent's commands went to the native `default` engine, which had no Teren containers at all,
so `docker compose ps -a` came back **empty** — which reads exactly like a wiped stack — and
`docker compose up -d` then built a **parallel world** there with brand-new volumes. The "freshly
initialised volumes at 11:37" were new volumes on a different daemon.

A throwaway container against the original volume read `entries=3 reports=1 users=5 devices=7
projects=3` — precisely what it held before. Nothing was lost. The duplicate stack was stopped, the
original brought back up, and the founder's data confirmed on his default context.

***With two engines, `docker compose ps` returning nothing means "wrong engine", not "your stack is
gone" — and `up -d` in that state silently builds a second one.*** Fifth variant of "it doesn't work"
meaning "it isn't running", and the first where an agent's own recovery step was the destructive-
looking act. The stopped duplicate containers and their seed-only volumes are still on the native
engine; `docker compose --context default down -v` clears them.

### Where the frontend half stands — `stash@{0}`

Stopped mid-item on the founder's word, and **parked rather than left half-built**: `git stash pop`
restores 26 modified files plus six new ones (`core/capture/correction-route.ts`,
`correction.service.ts`, and the four `features/platform/health-*` files). Two things were wrong with
it at the moment it stopped, both recorded in the stash message: **`health-page.css` was never
written**, so `ng build` failed with `NG2008`; and `PlatformGateway` gained `getHealth()` while the
**inline test doubles in spec files lagged it**, so the suite would not compile — `platform-gateway-double.ts`
was updated but `WatchedGateway` and two object literals were not. *A tree that builds while its specs
cannot compile is the worst state to hand over, which is why this is a stash and not a commit.*

**Saved state, verified by execution:** `1091/1091` backend, `1740/1740` PWA in 89 files, both builds
clean, `stash@{0}` holding the frontend work. The backend increment and the doc edits are
**uncommitted** — the founder's commit authorisation covered the sign-out increment only.

**Still owed on this increment, for the founder:** the **report does not name what it supersedes**. A
correction whose PDF does not reference the document it replaces is weak evidence in a dispute, and
the client has already received the wrong one. Flagged rather than invented, because it changes the
artefact a customer's client reads.

---

## 2026-09-03 (later) — a revoked phone signs itself out

Founder: *"If i remove the phones of a worker as a company_admin, and before that worker was logged in
on some device, i stayed logged in even though i am removed. That needs to be fixed."*

**The backend was never wrong.** `DbCredentialAuthenticator` has no cache and joins `device.revoked_at`,
`app_user.disabled_at` and `company.suspended_at` on every request, so a revoked phone is refused on
first contact — that is the whole revocation model and it works. **The phone learned it every twenty
seconds and threw it away.** `EntryStatusRefresher` polls `GET /api/entries` from Home, gets
`unauthorized`, and is documented as "best effort, and silent about it". The route gate reads one
`localStorage` row and deliberately asks the server nothing. And the only revocation notice in the
product was **derived from the outbox** — a row `failed` past `STALLED_AFTER_ATTEMPTS = 8`, some ten
minutes of backoff — so **on a phone with an empty outbox, which is the ordinary case, nothing ever
appeared at all.** The same silence covered two other admin actions that produce the identical 401:
removing a worker (`disabled: true`) and suspending a company.

**This was a founder decision before it was a fix**, and it reverses one. Plan §10.3 and F8 said
"never a locked door", on the reasoning that an admin's mis-tap at four in the afternoon must not cost
a foreman the day's capture. He was shown that reasoning and three policies — shut-but-the-mic-works,
full sign-out, loud-notice-only — and chose **full sign-out**. Recorded in PROJECT.md §11 (top) and
written into plan §10.3 with the old paragraph kept visible as superseded. The cost is named there:
a mis-revoke, an accidental disable or a suspended company now leaves a foreman unable to record until
somebody sends him a code. His reasoning: an owner who cannot see that "remove this phone" worked will
not trust anything else the product says, and the mis-tap costs a code rather than evidence.

**Built** (implementer, then reviewer accept-with-fixes, gating item closed and re-proven): detection
at one seam — `TerenApiClient.bearing()` wraps the four funnels that carry `authHeaders()` and hands a
**401 and nothing else** to `DeviceRefusalService`, rethrowing unchanged. Not an interceptor
(`api-config.ts` documents three reasons, one of them fatal: `baseUrl` is `''` in production, so a
prefix match matches object storage too) and **`putObject` stays outside it** — no bearer, S3,
presigned. `SessionService.discard()` removes one `localStorage` row and, like
`AdminSessionService.signOut`, **cannot reach Dexie**: a source guard forbids a store handle in the
three files and a row-count spec covers entries, media, outbox, chunks, captures and drafts. The
unsent day waits on the phone and moves again when he re-activates as the same worker.

Three things in that service are load-bearing, and each is mutation-proven:

- **Navigation only off a device-gated screen**, decided by whether the deepest route's `canMatch`
  contains `requiresDevice` **by function reference** (the `route-table.ts` trick — the build renames
  classes and functions). The founder's browser is the demo phone *and* the office console: revoking a
  phone from `/company` must leave the admin on the screen he pressed the button on.
- **The navigation defers while the microphone is live** (`starting|recording|stopping`, the same gate
  and the same reasoning as `app-update.service.ts`). The credential goes at once; the take reaches
  Dexie first. Traced by the reviewer through `capture-recording-page.ts`: stop → idle → the effect
  navigates → `ngOnDestroy` does not double-finish → `finishCapture` completes on its own promise.
- **401 only.** Removing that test turns **ten** specs red (403, 500, 503, status 0, 404, 409, 429).

**The implementer added one thing beyond the brief and it was the right call.** `config.deviceToken`
is a live getter, so an attempt already in flight that 401s *after* a re-activation would have signed
the man out seconds after he fixed it. The bearer is captured before the await and a refusal naming a
credential the session no longer holds is ignored. It cannot be defeated by an idempotent
re-activation, because activation always mints a new device token.

**Four strings were lying and are now true.** The revoke dialog promised the admin *"On i dalje snima"*
— he no longer does. And three on `/platform/companies`: suspending a company signs its foremen's
phones out too, and **resuming is not enough — every phone has to join again with a new code**, which
the old copy said the opposite of.

### The two findings worth carrying out of this increment

**A negative assertion that settles on microtasks proves nothing, and a green suite is how you find
out.** The implementer's first run of the "does not navigate off an admin screen" mutation left the
whole suite **green**: its `settle()` turned only `Promise.resolve()`, and a router navigation does not
finish inside a microtask chain. Every "it did not navigate" in that file was vacuous. `settle()`
awaits macrotasks now, and the reviewer re-proved the vacuity deliberately — gated check removed *and*
`settle()` downgraded → all 33 pass. **Same family as `ee37f04`'s route rename and F12's 26 unemittable
slugs: the spec asserted the shape of the future, not the behaviour of the present.**

**A caveat that is shown once is not shown.** The first cut read the `/welcome` marker at field init
and cleared it in the constructor, so the sentence survived exactly one paint — the implementer's own
browser run recorded `after a reload: notice still there: 0`. A foreman signed out mid-shift whose OS
drops the tab reopens to the plain first-run screen: record button gone, **no explanation**, which is
the complaint that started this increment reproduced one reload later. The marker is durable now and
`ActivationService` is its only clearer, because it describes a **condition**, not a handoff — and it
names no cause, so it cannot go stale. *`ArrivalHandoff.take()` was the precedent cited for take-once;
it is a handoff between two screens inside one navigation, and that is not what this is.*

**Known gap, written down rather than papered over:** the `session.device.refused` log line is
**undeliverable from a foreman's phone**. The row is filed under the credential `discard()` removes in
the next synchronous statement, so no flush can interleave and the next one `bulkDelete`s it. It
arrives only from a browser that also holds an admin session on an admin-guarded URL — the founder's
own machine, which is where the stream is read. Answering "why did this phone stop" from the log needs
a change in `ActionLogService`, not in that file, and it was not in this increment.

**Verified by execution, by me and not on trust:** `1740` specs in 89 files (from 1697), `ng build`
with zero warning lines, and every hunk of the 30 modified + 4 new files accounted for — eleven of them
comment-only, verified by filtering non-comment diff lines to zero. Nothing else is in the tree. One
intermediate run went red on an unrelated `logs-page` spec at load average **18**; it passed at 4.6,
which is the documented load-flakiness and not a regression.

**Real-device debt this adds:** the deferral under a real `MediaRecorder` (a screen lock or a call
mid-take while the credential is dead — specs drive a stubbed signal), and the founder's own
dual-session browser, where revoking from `/company/worker/:workerId` should leave him on `/company`
while the device row disappears.

---

## 2026-09-03 — closing the reviews' open items

Founder: *"Fix all the other stuff that you need and commit and push."* Everything three reviews had
left as non-gating, taken as one increment, backend and frontend in parallel.

**Frontend (done, 1697/1697, build 473.49 kB clean, +25 specs / +3 files)**

- **The `superseded_after_send` loop is dead, and the brief that sent it there was wrong.**
  `EntryContracts.cs:65` is `SupersedesEntryId` on **`EntryResponse`** — `POST /api/entries` never
  accepted the field, and `System.Text.Json` drops an unmapped member in silence, so a "Napravi
  ispravku" button would have written an entry that *claimed* to be a correction and linked to
  nothing. The implementer stopped at the honest screen and said so; the backend field was
  commissioned as a result. `core/api/failure-reason.ts` reads **the server's answer only** (a null
  is silence, not an answer); the confirm gate draws no form for such a record and says what
  happened; `entry-detail`'s "Ispravi" door shuts. *Still open, named:* the archive **list** row
  cannot know — `EntryListItemResponse` carries no `failure_reason` — so the row still offers
  "Ispravi" and the tap lands on the honest gate. One field on the list DTO removes the wasted tap.
- **A 401 now leaves a door open**, on all seven screens that draw a reason card
  (`ui/sign-in-again.ts`, rendered only when no admin session stands). The chrome rule is untouched.
  *Plainly: this is the in-place case, not a reload* — after F5 the guard still sends him to Home,
  and only the `localStorage` marker reaches that.
- **Tapping *Otkaži* by reflex after *Stop* can no longer discard a take that is saving**, and the
  guard lives **only** in the template so removing it goes red rather than being masked by a second
  copy. It comes back the moment saving fails, which is the one state where abandoning is a choice.
- **320 px overflowed on three screens, not two** — `/company` by 11 px, and the cause was one
  shared rule, not seven. `.bar { flex-wrap: wrap }` and a global `.bar__controls { margin-left:
  auto }` fix all of them; identical at 360 and up.
- **A tap-target spec now reads every shipped stylesheet** — `.css` files *and* `styles:` template
  literals — and fails on anything drawn under 44 px without an extended hit area or a written
  exemption. It cleared two of the five reported controls as false positives (the pager already had
  one; the 36 px "stop square" is a glyph inside a 128 px button) and found `.wave__bar`.
- **`SwUpdate` handling exists**, gated on the recorder being idle — the only state consulted, and
  deliberately: everything else is in Dexie before it is anywhere else, and a live `MediaRecorder` is
  the one thing a reload destroys. *Measured defect fixed on the way:* centred at the foot of the
  window the banner **covered Home's record button at 1280**; it anchors bottom-right from 1024.
- Dead `.stats` rules deleted from `person-page.css`. Six mutation proofs, all restored sha256-identical.
- *Two things worth carrying:* the implementer **broke the founder's `ng serve` for six minutes** with
  backticks inside a `styles:` template literal — the exact trap `table-pager.ts` warns about — and
  because the build failed, 4200 kept serving a **stale bundle**, so three Playwright runs measured
  old CSS and made a fixed bug look unfixable. And the seven-copy admin CSS extraction was **not**
  started, on the grounds that half of it is worse than none; the residual risk is that a screen
  declaring `flex-wrap: nowrap` on `.bar` silently brings the 320 px overflow back, and nothing
  guards that.

**Backend (the implementer was cut off by the session limit mid-item; what it left is green)**

Built and tested by the coordinator, not taken on trust: **1054 backend tests green** (from 1020) and
`dotnet build -c Release` succeeds with the one known `CS9107`; the diff was read for stray mutations
first — nothing of the shape CLAUDE.md records three times. Landed:

- `/health/ready` has a rate-limit policy of its own; `/health` stays free.
- `JobServerIdentity` narrows the readiness heartbeat to **this process's** Hangfire server, so a
  crash-restart no longer reads ready off a dead server's row for two minutes.
- `PostgresErrors`, a shared clock helper and one audit-row builder replace four, four and three
  copies; the **two divergent `InviteStrings`** are now `WorkerInviteStrings` and
  `AdminInviteStrings` with one locale-matching rule (`LanguageTag`) — that divergence was a bug
  waiting, not tidying.
- **A guard that walks log call sites** (`LogCallSites.cs`, `LogTemplateTests.cs`): every `{Property}`
  in every structured template must be reachable into the log table, every call must pass a literal
  template, and **the scan can prove it is able to fail** — which is the test that separates this from
  the two registries that shipped complete and emitted nothing.
- The allow-list name `Pending` narrowed; `deploy/README.md`'s quoted 503 body corrected.

**Not done, and owed:** the M3 mutation proof on `SealDeliveredAsync`'s hash comparison, and
**`supersedes_entry_id` on `CreateEntryRequest`** — the field exists on the *response* and on the
entity, so ARCHITECTURE §6's documented answer to a superseded record ("a new entry with
`supersedes_entry_id`") is still not something a phone can actually do. That is the next backend
increment, and the frontend's honest screen is waiting on it.

---

## 2026-09-02 (late) — `/platform` on a phone: the title under the buttons

**Talked about**

The founder, off a screenshot of `/platform` at about 450 px: *"Fix this screen for smaller
devices."* Two things in the picture: the word **Platforma** ran underneath the head cluster, and
the third stat tile's label `NIJE ZAVRŠENO` wrapped, so its `0` sat a line lower than the `1` and
the `2` beside it.

**Built**

- `platform-page.css` only. The head cluster on this screen is the widest in the product — five
  44 px controls and four gaps, 252 px on a 358 px column — so below 768 the `.head` wraps and the
  title takes the whole first line with the cluster under it; from 768 up it is `nowrap` and one
  line, exactly as before. `/company` is not touched: one control fewer, and it fits.
- The three numbers: `repeat(3, minmax(0, 1fr))`, `--space-3` cell padding below 768, and
  `.stats .stats__value { margin-top: auto }` so every number sits on its tile's floor whether or
  not its label wrapped. *The first cut was `.stats__value` alone and did nothing — `.stats dd
  { margin: 0 }` outranks a lone class; the measurement, not the eye, caught it (bottoms 298/298/315).*

- Then, off a second crop — the grey scrollbar track under the `Osoba / Firma / Stanje` pills:
  *"remove the scroll. We don't need it, right?"* Right. `.column-bar` in `styles.css` (the shared
  pill bar below 768 on all three directories) was `overflow-x: auto`, and three pills overflow a
  360 column, so a phone drew a track and hid part of the third pill. Nothing scrolls sideways now.
- Then, one message later: *"It needs to be in one row please, it's better UI."* Wrapping to two
  rows was the first answer and it was not the one he wanted. The budget is the **office** screen on
  a 360 px Samsung — `Osoba` sorted, `Stanje`, `Aktivnost` — which was 20 px too wide for one row.
  Found without touching the 44 px hit areas: the bar's side padding `space-3 → space-2`, the pill's
  padding `space-4/space-2 → space-2/space-1`, and the pill label at `text-label` (12 px, the chips'
  size) instead of `text-meta`. One row at 360/390/430 on `/company`, `/platform` and
  `/platform/companies`, with 10 px to spare on the tightest; `wrap` stays as the fallback below 360.
- **The full PWA suite was red on this machine before any of this, and nobody knew.** Two
  `action-wiring.spec.ts` checks failed at their *first* entry: `shortPath` used `relative()`, which
  answers with backslashes on Windows, so `features/capture/capture-recording-page.ts` was "missing"
  from a map that held it under `features\capture\…`. Every earlier "1575 green" was measured on a
  Linux shell. It normalises `sep` to `/` now.
- **Review (accept-with-fixes), both gating items closed:** `/company`'s stat tiles had the identical
  baseline defect — `AKTIVNI TELEFONI` and `KODOVI ČEKAJU` wrap, `POSLOVOĐE` does not, so the first
  number sat 17 px above the other two — fixed the same way and measured `[261, 261, 261]` at
  360/390/430 under a company-admin session; and `logs-page.css` said the pill bar "keeps its
  sideways scroll", which was no longer true. Notes carried, not acted on: the compact cluster sits
  **left** under the title where the rest of the product's compact controls hug the right
  (`margin-left: auto` if the founder prefers); the `14px` head gap and `18px` cell padding are
  off-grid in all five heads; `person-page.css` carries dead `.stats` rules; at **320 px** the
  language switcher plus session link overflow the page by 7 px on both platform screens.
- **Migrations applied to the dev database** (`migrate`, built to a scratch output path so the
  running API's locked binaries were not touched): both histories complete, `AppLog` included,
  `app_log` present with 0 rows. *The API on 5080 was started before the table existed; if the log
  screen stays empty after use, that process needs restarting — the founder's process, not ours.*

**Verified by execution**

Throwaway Playwright in the scratchpad against the running `ng serve`, API mocked, at
360/390/430/767/768/1024/1280: no title/cluster overlap, no clipped title, cluster below the title
under 768 and beside it from 768, the three stat baselines equal at every width, pill bar
`scrollWidth <= clientWidth`, no horizontal page overflow. Platform specs 166/166, `ng build`
clean. *Still no browser driver in the repo.*

**Review status**

Frontend reviewer: **accept-with-fixes**, both gating items closed and re-measured (above). A delta
review of the fixes and of the one-row pill trims was requested; its verdict is in the commit
message if it landed before the commit, and in the next entry otherwise.

**Founder, closing the round**

*"Mostly stuff with pages is done. We will have few more corrections but I am totally happy with the
things we've done. Commit when you are done and push. Now, we want to build a dev server."*
Committed and pushed from this session on his instruction — the standing rule that the founder
commits himself is set aside for this one commit, not changed.

**Later the same evening — the VPS question, and a pipeline**

- Founder: *"Let's start with VPS — Kamatera free trial?"* Checked the page: 30 days, $100 credit,
  card required, then **$39/month** for 2 vCPU / 4 GB against Hetzner's ~€4.5, and no S3-compatible
  storage. Recommended Hetzner CX22 (Nuremberg/Falkenstein, Ubuntu 24.04, SSH key, `get.docker.com`
  once). The deploy machinery would run on either; a trial box is a box you move off in 30 days.
- Founder: *"Do we have a CI/CD pipeline?"* No — `.github/workflows/` existed and was empty. *"Build
  me that."* Built: **`ci.yml`** (backend build + 991 tests over Testcontainers Postgres, frontend
  build + 1575 specs, in parallel, on every push to `main` and every PR; the vitest summary line is
  parsed because `ng test` exits 0 on failure, and any `ng build` warning fails the job) and
  **`deploy-dev.yml`** (`deploy/deploy.sh` from the runner after a green CI on `main`; dormant until
  `TEREN_DEV_ENV`, `TEREN_DEV_SSH_KEY` and `TEREN_DEV_SSH_KNOWN_HOSTS` exist). Documented in
  ARCHITECTURE §13 and CLAUDE.md. Both files parse; the backend's exact commands were run locally
  before pushing; the first real run is the push itself. *The push itself stalled: Git Credential
  Manager held no GitHub token, and a headless `git push` hangs on the sign-in dialog. The founder
  signed in; all three commits went up together.* **First CI run on `6b92329`: green — backend 158 s
  (991 tests over Testcontainers Postgres on the runner), frontend 67 s (1636 specs). `Deploy dev`
  ran after it, found no secrets, logged its notice and exited green, exactly as designed.** The job
  names had spec counts baked in and were already stale; renamed.
- Founder, in the same message: *"run the full code review in parallel for the frontend and the
  backend with our senior subagents to check the state of the code and to know how good it is."*
  Two whole-codebase state reviews launched against `c97c0e1`, read-only, graded A–F with a top-ten
  and a "before the dev server / before a real phone" must-do list each.

**Backend state review — grade B+** (`c97c0e1`, read-only, ~50 tool uses)

*Why not an A:* the code is sound — conditional terminal writes everywhere, the report claim as a
unique index, immutability as a trigger plus an EF guard, deny-by-default tenancy, hashed tokens with
no cache, timing-levelled auth, the allow-listed log sink — but its **surroundings** are not. Ranked:

1. **HIGH — `deploy.sh` cannot complete on either target.** It requires `TEREN_DEVICE_TOKEN`, passes
   it to `web.Dockerfile`, which greps for a placeholder `environment.ts` has not held since
   2026-08-31 and exits 1. The local rehearsal fails the same way. Fix: delete the substitution, make
   the token optional server-side, rewrite README §4/§8.
2. **MEDIUM — confirm/seal race.** `EntryEndpoints.cs:700-731` checks *sending* then writes
   `Corrected`; `EntryReporter.cs:417-422` re-reads `Corrected` after the claim. In the gap,
   `SealAsync` can stamp `reported_at` on content that never went out. Fix: seal only where
   `Corrected` equals the rendered snapshot; 0 rows → report `failed`/`superseded`.
3. **MEDIUM — `POST /auth/activation-code` destroys a credential and mails nothing** (`TODO(D6)` at
   `AuthEndpoints.cs:283`, though D6 shipped). Unauthenticated, by username. Fix: wire a mail job or
   stop superseding until one exists.
4. **MEDIUM — `/health` is a constant** (`Program.cs:432`); compose, `deploy.sh` and the README all
   rest on it. Fix: real checks on both contexts and both migration histories, `/health/ready`.
5. **MEDIUM — no index on `report.status`**; the minutely sweeper will seq-scan a million rows within
   a year. Fix: partial index `WHERE status = 'sending'`.
6. LOW-MED — `POST /api/client-events` is unlimited and shares the drop-oldest log queue, so one
   looping phone can evict the server's own error lines.
7. LOW — `AdminInviteJob.cs:50` hardcodes 48 h and ignores `Auth:PasswordTokenLifetime`.
8. LOW — comment rot on operator-facing files (`AdminInviteJob`, `IObjectStorage`, `BoundedRetry`,
   `environment.ts` still narrates the baked token).
9. LOW — `IsUniqueViolation` ×4, `Utc` ×4, audit-row builders ×3, two `InviteStrings` with different
   matching rules.
10. LOW — test blind spots: Hangfire disabled in the test host, `BehindProxy=false` never exercised,
    the confirm-while-sending 409 untested, S3/SMTP faked at the seam.

*Before the dev server:* fix the deploy chain and re-run `deploy.sh --target local`; the partial
index; the seal/confirm race with an interleaving test; a real `/health`; neutralise
`/auth/activation-code`.

**Frontend state review — grade B-** (`c97c0e1`, read-only, ~60 tool uses, 16 routes × 5 widths
driven in a browser, plus a live proof against the production build)

*Why not an A:* the architecture is disciplined — evidence on disk before any network attempt, an
idempotent outbox, compiler-checked failure classification, two bearers structurally separated,
721/721 translation keys, a clean 450.7 kB build, no overflow or missing header at any width — but
**one proven, silent evidence-loss defect sits on the primary screen**, the exact class PROJECT §5.3
forbids. Ranked:

1. **CRITICAL — a live recording is truncated the moment the tab returns to the front.**
   `rescue.service.ts:34` runs `rescue()` on every `visibilitychange→visible`; only `/entry/:id` is
   exempt, and `rescue.service.spec.ts:45` **pins that `/record` is not**. `finishCapture` assembles
   the chunks so far and deletes the session; every later chunk hits `appendChunk`'s
   `if (!session) return` and is discarded while the timer keeps climbing. **Proven with a fake mic
   against the production build:** a 6 s take saved 23,502 B / 6474 ms; the same take with one
   `visibilitychange` at 2.5 s saved **4,655 B / 2197 ms**, and nothing on screen said anything. A
   screen lock or an app switch mid-sentence does this on a phone. Fix: the rescue run exempts the
   recorder's live entry (`AudioRecorderService.entryId` exists) and skips a capture whose
   `lastChunkAt` is under ~5 s old; add the spec that is missing.
2. **HIGH — no spec exists for the recorder** (`audio-recorder.service.ts`, 397 lines) — nor for 36
   other files. Finding 1 survived 1575 green specs because the only relevant spec asserted the defect.
3. **MEDIUM — `interrupt()` drops the recorder's final flush**: `recorder.stop()` then a synchronous
   teardown nulls `ondataavailable` before the stop-time `dataavailable` fires. Every call or OS
   interruption loses up to the last timeslice avoidably.
4. **MEDIUM — a server 401 never clears the admin session**; the guard then bounces the still
   "signed-in" admin *away from* `/login`, and the only exit is the header's sign-out control.
5. **MEDIUM — `capturedAt` is stamped before the microphone is granted**; a 20 s permission prompt
   becomes 20 s of phantom recording in `created_at`, the report and the rescue duration.
6. MEDIUM — the report download does not run inside the tap (fetch first, then `save()`); iOS Safari
   may no-op it. Unverified on iPhone; first thing to test.
7. MEDIUM — design-record comments that are now false (`session.service.ts`, `entry-store.ts`,
   `environment.ts`, `capture-saved-page.ts`, four auth files).
8. MEDIUM — admin chrome CSS copied **seven** times and already drifting; 155 kB of component CSS.
   Fix: `.screen-head` / `.stat-strip` in `styles.css` beside `.data-table`.
9. LOW — tap targets under 44 px in the pager (36), log filters (36), header and switcher (40).
10. LOW — no `SwUpdate` handling (an installed app runs the old bundle until its second launch after
    a deploy); no CSP while two bearers live in `localStorage`; bundle at 90 % of the warning budget.

*Before a real phone:* fix 1 and re-run the live proof (`scratchpad/review-frontend/
rescue-truncation2.mjs`); serve a **production** build over **https** (the service worker is off in
dev); start → lock → unlock → speak → stop on Android, and an incoming call mid-take; PDF download
and photo open in iOS standalone; fix 4 before an admin's first password reset from a phone.

**Both reviews' verdict in one line:** the code the tests can see is good; what will fail first is
the deploy chain, a rescue that eats a live recording, and a health check that cannot say no.

**Founder: "Fix."** Both must-do lists taken as one increment, backend and frontend implementers in
parallel on disjoint trees, each followed by its reviewer. Left out on purpose: the seven-copy admin
CSS, the 36/40 px tap targets, `SwUpdate`, CSP, iOS download behaviour (needs an iPhone in hand),
the `IsUniqueViolation`/`Utc` de-duplication, the D4 hatch. *And a second ask arrived mid-run:
"take a look at the overall flow … have some animations when you click, when the page is reloading,
when a new entry was added." Queued as its own increment after the fixes — there are no motion tokens
in `design/tokens.md` yet, so it starts there.*

**Frontend fix increment — implementer's report (verified by its reviewer below)**

- **1 (CRITICAL) fixed with two independent defences**: `RescueService.exempt()` adds the recorder's
  live `entryId`, and `EntryStore.rescue()` refuses any capture whose `lastChunkAt` is inside a 5 s
  `LIVE_CAPTURE_WINDOW_MS`, whatever it was told to exempt. The recorder now clears its `entryId`
  on teardown and on failed starts — without that the exemption goes stale and a finished draft would
  never be queued by `queueAbandonedDrafts`. The spec that pinned the defect was split and the real
  exemption spec'd. **Live proof re-run:** control 22,938 B / 6465 ms, disturbed (tab switch at
  2.5 s) **23,430 B / 6590 ms** — one timeslice apart, where the review had measured 4,655 B.
- **2 (HIGH)**: `audio-recorder.service.spec.ts`, 25 specs over a stubbed `MediaRecorder` that fires
  its stop-time `dataavailable` on a later task — which is what lets it see finding 3 at all.
- **3**: `interrupt()` claims `stopping` synchronously (the re-entrancy guard, since `onerror` and
  `track.onended` fire together), freezes the timer, awaits a bounded `onstop` and the pending
  writes, then tears down. `STOP_TIMEOUT_MS` shared with `stop()`.
- **4**: a 401 from either admin gateway calls `admins.signOut()` (one `localStorage` row); 403, 500,
  0 and 409 keep the credential; journey spec drives `/login` through the real route table.
- **5**: `EntryStore.markCaptureStarted` restamps `capturedAt` when `recorder.start()` resolves true.
- **6**: nine comments rewritten; the `environment.deviceToken` **fallback is gone** from
  `session.service.ts`, the constant stays as the tripwire. `TerenApiClient.configured` kept — it is
  the same predicate as `session.usable()` in a second layer, not a duplicate check.
- Suite **1632/1632** (82 files, +57), build clean at 456 kB. Four mutation proofs with sha256
  restores. *Residual, named:* on a browser that also holds a device session, the post-401 chrome
  says "Prijavite se ponovo" with no tappable way to `/login` — `session-link` renders nothing for a
  device session by design. That is the "Prijavi se visibility" item in the veto queue.

**Frontend fix increment — reviewer: accept-with-fixes.** Re-ran the build, the full suite
(1632/1632, one run, no flake), the live truncation proof (control 22,938 B / 6449 ms, disturbed
23,430 B / 6586 ms — the capture row went `chunkCount 2 → 3` across the tab switch with the session
intact) and **six mutations in an isolated copy**: five red as claimed, **one survived** — the
`interrupt()` re-entrancy guard. *The "mutation-proven" claim was false for exactly the guard the
docstring calls load-bearing*, same shape as the `/company` scar of 2026-09-01. The path it protects is
real: `onerror` during a user `stop()` that is already awaiting `onstop` — without the guard the tail
timeslice is dropped, which is the byte-loss class this increment exists to close. Gating: adopt the
reviewer's 12-line spec. Also found, red on the shipped code: a **stale `finishInterruption`
continuation tears down the next take** (interruption → cancel → new take → old `onstop` fires →
`teardown()` stops the *new* stream and paints "interrupted" over a healthy microphone); `stop()` has
had the same shape since B2. Fix: a take-generation counter checked after every `await`. And the
comment-rot pass introduced one false claim of its own (`auth-gateway.spec.ts:9-18`). Sent back.
*On the residual: the reviewer agrees it is the veto-queue item, not gating — but says it plainly:
the device-and-admin browser is the owner-foreman's own phone, the ordinary case, and after a reload
he lands on Home with nothing on screen to sign in from. Two candidate mechanisms, both chrome, both
his call.*

**Frontend fix increment — round two (implementer):** the guard is pinned by the reviewer's spec
(guard removed → exactly 1 red); a **take-generation counter** (`private take`, bumped on adopt and on
release) is checked after every `await` in `stop()` and `finishInterruption()`, three staleness specs,
both checks removed → exactly 3 red; the auth-gateway spec now *seeds* the device session it claimed
and asserts the premise (seed removed → 3 red). The reviewer's fake-timer drafts hung at 5 s because
`openSession()` is a Dexie write that needs real timers — the session is opened before
`vi.useFakeTimers()`, with the reason written down. **The cancel button is deliberately not disabled
during `stopping`**: it is the only way out of a recorder that has stopped answering, and the counter
makes the race harmless. Suite **1636/1636**; build clean; live proof re-run on this build, 22,938 B /
6437 ms against 23,430 B / 6573 ms.

**Backend fix increment — implementer's report (review pending below)**

- **1 (HIGH) deploy chain — fixed and PROVEN.** `web.Dockerfile`'s substitution block deleted;
  `TEREN_DEVICE_TOKEN` optional, dropped from `required` and the build arg; README §4/§8 rewritten;
  `DeployContractTests` (5) reads `deploy/` off disk. **`deploy.sh --target local --seed` ran to
  `Deployed`** — `/health/ready` Healthy over https on 8443, `/` 200, `/ngsw.json` 200,
  `/api/projects` 401, then `--down`. *Trap found on the way:* Caddy's `@backend` matcher listed
  `/health` exactly, so `/health/ready` would have been served the SPA shell and "verified" an HTML
  page; both Caddyfiles now match `/health/*`, pinned by a test.
- **2 seal/confirm race — closed.** New `report.corrected_sha256`; `SealAsync` seals only where the
  row still holds the rendered `corrected` (**jsonb equality**, so a re-serialisation still seals);
  the recovery pass compares the stored hash; 0 rows → new terminal reason `superseded_after_send`
  on the entry, report row keeps its truthful `sent`, logged critical. Not a new report status —
  marking a `sent` row failed would break `ck_report_sent_at` and destroy the custody record.
  `ReportCustodyTests` +3 incl. the interleave; both halves mutation-proven (2 red / 1 red).
- **3 `/auth/activation-code` — the handler writes nothing.** It enqueues `WorkerCodeMailJob`
  unconditionally with an id (never the typed name); the job mints *inside itself* after
  worker/email/company/relay checks. That deleted the 82-line hand-calibrated timing compensation
  (`BurnIssueCostAsync` and friends) — with no branch there is nothing to compensate.
  `EmailDelivery.NotSent` where a relay exists; `WorkerCodeMailJobTests` (8); the statement-shape
  test proves all three branches issue the identical sequence and none writes. Mutation-proven twice.
- **4 `/health/ready`** — `ReadinessChecks.cs`: `SELECT 1` on both contexts, no pending migration on
  either history, a job-server heartbeat ≤ 2 min; `ReadinessTests` (4) on a minimal `TestServer`.
  *Defect of the implementer's own worth reading:* the first draft booted a second `Program` host,
  and `UseSerilog` repoints the **static** `Log.Logger`, so an unrelated log-ingress test a class
  away went red with an empty table. **5** partial index `ix_report_sending_attempt`, applied to the
  dev database, test reads `pg_indexes`. **6** `/api/client-events` limited to 60/min per
  address + SHA-256 of the bearer (the limiter runs before auth). **7** invite lifetime from options.
  **8** comment rot fixed, and `BoundedRetry.cs`'s "the one retry loop" made *true*:
  `EntryProcessor` now delegates to it, with a guard that only one place in the product sleeps
  between attempts. *Unasked:* five readiness property names added to the log allow-list, because
  otherwise they would have rendered as literal `{PendingCount}` — the `{State:l}` defect again.
- Build: one warning (the known `CS9107`). **Tests 1020/1020** (+29). *Open, named:* the remote
  deploy path is still unexercised; `JobServerReadyCheck` has no test (Hangfire is off in the test
  host — its only proof is the rehearsal's container going healthy); nothing walks log call sites to
  check every property name is allow-listed; the rehearsal left the machine at 5.0 GB free
  (`docker image prune` reclaims it).

**Backend fix increment — reviewer: accept-with-fixes.** Build one warning, **1020/1020**
reproduced, 40-file diff read hunk by hunk, tree byte-identical afterwards. Both gating items were
**false comments introduced by the increment that fixed comment rot**: `WorkerCodeMailJob.cs:91`
said "the route checks this too" when the route now checks nothing by design, and
`AuthRateLimitPolicy.cs:28` claimed a flood of invented tokens "cannot mint an unbounded number of
partitions" when every distinct `Authorization` value is a new one — what bounds memory is the
limiter's idle eviction. Both rewritten to say the true thing. *The reviewer could not execute its
mutations:* **Docker Desktop died mid-run because C: hit 31 MB free** — the founder's Postgres, MinIO
and Mailpit with it — and restarting it was outside the reviewer's permissions. Coordinator: scratch
build outputs deleted, `docker desktop restart`, engine up in ~10 s, `docker compose up -d`, all three
containers healthy. Then the reviewer's staged mutation copy (M1: seal predicate removed; M2: mint
moved above the relay check) was run: **3 red of 20** — the two expected, plus
`Nothing_automatic_resolves_a_delivered_report_whose_entry_moved_on`, which the reviewer had mapped
to M3 but which M1 also reaches because the recovery path ends in the same seal. Every red is a
mutation target; the 17 others green; the real tree 1020/1020. **Now proven by execution.**
Non-gating, carried: `superseded_after_send` is correct on the server and **a dead end on the
phone** — the PWA reads `failure_reason` nowhere, a `confirmed`-unreported entry routes back to the
confirm gate, and the foreman can loop forever with no visible cause; the documented answer
(`supersedes_entry_id`) has no frontend gesture yet. Also: `/health/ready` is public and unlimited
(four round trips a hit); `JobServerReadyCheck` counts any server row, so a crash-restart reads ready
for up to 2 min; `ReportOutcome.Sent` is returned for the not-sealed outcome, so the sweeper counts
it as success and the `LogCritical` is the only signal.
**Environment, for the founder:** the disk is at **98 %** (5.8 GB free). Docker's VHDX grows under
1020 tests over a thousand scratch databases and gives space back only when the distro stops; a full
`dotnet test` took the engine down once today. `src/Teren.Api/bin` and `tests/.../bin` hold Debug and
Release side by side (~600 MB); `docker builder prune` reclaimed 2.8 GB inside the VHDX. Several GB
need freeing before "re-run both suites after every review" is safe on this machine. *Later the
same evening it happened again* — free space went 5.8 GB → 487 MB → 4.8 GB inside half an hour with
nothing of that size written: the machine has 15.7 GB of RAM and the **pagefile peaked at 4.6 GB**
under two suites, Docker and three agents at once. The disk is not merely full, it is the swap
headroom. Docker's `docker_data.vhdx` is 9.5 GB and does not shrink on its own. Two remedies, both
the founder's: free real space on C:, and run one suite at a time.

**Motion pass — implementer's report (review running at commit time; founder asked for the push)**

- `design/tokens.md` **§Motion** (binding): `--motion-fast 120`, `--motion-base 200`, `--motion-slow
  300`, `--motion-pulse 1200`, `--motion-meter 90` ms; `--ease-standard`, `--ease-exit`; and the rule
  that outranks the table — *nothing on the capture path may add latency to the thirty-second entry*.
- **Route changes** cross-fade via `withViewTransitions()`, falling back to a plain navigation where
  the API is missing (spec'd). **Every control** dips to 0.97 on press (0.94 on the small discs, 0.99
  on whole-card buttons). **Skeletons** on the three directories, the log, Home's recent list and the
  archive, the `role="status"` sentence kept for readers. **A row that was not in the previous list**
  fades and rises 8 px (`ui/arrival.ts`), never on first paint, and — after a trap — only once the
  store has answered; the archive waits for *both* halves of its local+server merge or the server's
  forty rows would all bounce in. **Modals** slide up from the bottom below 768 and rise in place
  above; popovers and the column menu fade and rise; exits are click-through. The saved screen's tick
  arrives once. **Reduced motion** collapses everything with no exceptions.
- *Pre-existing defect fixed on the way:* Home printed "Za ovo gradilište još nema unosa" and the
  archive "Arhiva je prazna" for the first frames of every load. An unread list and an empty one are
  different claims; only one belongs in words.
- *Two traps worth keeping:* `animate.leave` as a **host** binding compiles to nothing in Angular
  22.1 — it lives on the element at each of the five `<app-modal-sheet>` call sites, and a spec scans
  for it. And a component-scoped enter rule outranked the global exit, so the leaving sheet **replayed
  its fade-in**; the three overlay rules are global single-class rules in declaration order now, pinned.
- +25 specs (`arrival.spec.ts`, `motion.spec.ts` — no stylesheet may write a duration of its own,
  every token must exist, keyframes once, every modal call site carries the leave binding), five
  mutation proofs. **1661/1661**, build clean at 463.83 kB (two 6 kB component budgets forced shared
  rules into `styles.css`, which is where they belonged). Playwright at 390/768/1280 on five routes
  against the production build: no overflow, skeletons paint, the fixed column menu lands in-viewport
  and follows its trigger, overlays in and out, reduced motion collapses. *One judgement call, named:*
  Home's project picker animates, on the capture path — it gates nothing.

**Motion pass — reviewer: accept-with-fixes, four gating.** Build clean at 463.83 kB; suite
1658/1661 with three load-flake timeouts that pass alone; four of five mutations red as claimed, the
archive one **survived** (the spec's `mockResolvedValue` settles before Dexie, so the `remoteLoaded()`
half of the guard is never needed). The gating finds, in order of weight: **(1) the route cross-fade
swallows taps for ~330 ms after every navigation** — `document.elementFromPoint` returns `HTML` while
Chrome's `::view-transition` pseudo-tree hit-tests, so on saved → Home the record button is dead for
a third of a second, a breach of the pass's own binding rule; fix is `::view-transition
{ pointer-events: none }`. (2) A query-param change on the archive at ≥1024 cross-fades the whole
screen per click. (3) **Home's arrival fold fires only in the wrong case and never in the right
one** — Home is re-created on navigation, so the entry he just recorded is adopted silently
(measured `arriving: 0`), while switching site and back animates every row. (4) The archive spec
does not exercise the order it describes. Non-gating: `both` fill leaves a persistent transform
(containing block for future fixed descendants); modal exit is click-through by design, so a tap
~100 ms after "X" now reaches what sits under the scrim; bundle 450.7 → 463.8 kB over three
increments, about six more at this rate. Sent back.

**Motion pass — round two (implementer), and the prescribed fix was wrong.** `::view-transition
{ pointer-events: none }` did **not** restore taps: twelve real `page.mouse.click` runs at 1, 300 and
1000 ms fades showed the tap swallowed for exactly the transition's *lifetime*, whatever the pseudo
tree is styled — a view transition suppresses input while it runs and no stylesheet shortens that.
**So `withViewTransitions()` is gone.** The arriving screen fades itself instead, `.screen
{ animation: teren-screen-in }`, **opacity only** — a transform on `.screen` would make it the
containing block for the fixed column menu that `menu-placement.ts` positions in viewport
coordinates. One rule covers all eighteen routed templates, a spec walks them, and gating 2
dissolved with it (a query-param change re-creates nothing; measured zero animations on `/diary →
/diary?entry=`). Gating 3: `ArrivalHandoff`, a one-shot **in memory** — not router state, which
survives reloads and would replay the row hours later — announced by the saved screen on the way out
and read once by Home at construction; the fold resets when the site changes. *The implementer's own
first spec for that passed with the reset removed: it waited for "no rows", which the skeleton also
shows.* Gating 4: the reviewer's M5 is red. **1672/1672**, build 463.08 kB clean. Not driven in a
browser: the hand-off — delta review asked to do exactly that with the fake mic. *Two environment
incidents: `node_modules/@angular` vanished mid-session and was reinstalled from the lock file; the
disk touched 99 % and one suite run died with `ENOSPC`.*

**Commits and CI, end of the evening:** `c97c0e1` (platform on a phone) → `c30f4ee` (pipeline) →
`70fb60c` (review notes) → `6b92329` (recorder fixes) → `07d2f09` (backend fixes) → `94d5956`
(motion). **CI green on `6b92329`, `07d2f09` and `94d5956`** — the middle one ran the new
1020-test suite over Testcontainers Postgres on the runner, the last the 1661 specs; `Deploy dev` ran
after each and exited green, dormant.
Founder: *"Commit and push all these changes. After this I have a task for you"* — the motion pass
was pushed with its review still running, on his instruction; fixes, if any, follow.

**The demo film — built, recorded, delivered.** `tools/demo-video/`: `prepare` (build the PWA, seed,
mint the company admin's invite, create the staff account) → `record` (serve the **production**
build on 4310 proxying to the founder's API, drive it) → `stitch` (letterboxed 1920×1080, 30 fps).
**`out/teren-demo.mp4`, 11.2 MB, six scenes, 6 min 16 s:** the phone joining once (23 s), thirty
seconds of real Serbian site audio through a fake microphone (59 s), his words beside what the
system understood (35 s), the archive on a tablet (28 s), Petar's office on a tablet (1 min 56 s),
and the platform, customers and log on a desktop (1 min 55 s). Every name on screen is the seed's,
plus one demo staff account, Milica Nikolić — the founder's own super admin is never touched.
*Two things written into the README: recording scene 1 **takes Zoran's phone away from the founder**
(the code is single use; the run ends with a fresh `DEM0-TEST`), and `config.mjs` carries two
throwaway passwords for local dev accounts — the same class as the published demo code, and the
same decision due if this ever points at a host.*
**Both remaining agents were cut off mid-sentence by the session limit** — the demo one while
improving the title cards, the motion reviewer before its delta verdict.

**Motion delta — coordinator's own read, in place of the review that was cut off.** Verified by
execution: build clean at 463.08 kB, **1672/1672**, CI green on `94d5956` and `cb546f1`. Verified by
reading: `withViewTransitions()` is gone from `app.config.ts` and the only two `view-transition`
strings left in `styles.css` are the comment recording *why*; `.screen`'s animation is **opacity
only** with `backwards` fill, so it leaves no persistent transform — which matters because a
transform there would make every screen the containing block for the fixed column menu, and opacity
creates only a stacking context, which does not move a fixed element. `min-height: 100dvh` on
`.screen` is pre-existing and is not the `height: 100dvh` mistake this file records. **Not
independently verified: the capture hand-off** (`ArrivalHandoff`) end to end with a real microphone —
it is pinned by two specs and two mutation proofs, and the delta reviewer was asked to drive it
before being cut off. That is the one thing still owed on this increment.

**Frontend fix increment — delta review: ACCEPT, whole increment now accept.** All three mutations
re-run in the reviewer's isolated copy: exactly 1, 3 and 3 red as claimed; 1636/1636 and a clean build
reproduced. On not disabling *Otkaži* during `stopping`: *"accept the outcome, not the stated reason"*
— both waits are bounded at 2 s so nobody was ever trapped; the reason that holds is the page's own
design rule that only an explicit tap throws a take away, and the counter makes that tap harmless.
Two items for the **founder's queue**, both pre-existing since B2, neither made worse: (a) tapping
*Otkaži* by reflex 1–2 s after *Stop*, while `saving()` is true, discards a take the foreman decided to
keep — confirm-to-discard, or disable cancel while saving; (b) a stale `stop()` continuation on a
cancelled take logs `captureRecordStop {outcome: 'cancel', empty: true}` — "empty" for a take that was
cancelled, cosmetic.

**Next**

**The dev server (B3a for real).** `deploy/README.md` §2 is the shopping list and it still holds:
domain, Hetzner CX22, one A record, Hetzner Object Storage, an SMTP relay (still the open veto item —
Mailpit on the box until then), the Azure Speech key, the Anthropic key. **One thing in the deploy
machinery predates identity and will break the first remote build:** `deploy/web.Dockerfile` greps
for the old device-token placeholder in `environment.ts` and stops with `FATAL` if it is absent — and
D7/F9 made that constant `''`. `deploy.sh` also *requires* `TEREN_DEVICE_TOKEN` and warns when it is
the committed default. The token is now server-side only (the demo device's credential, provisioned
by `seed`), so the substitution has to go before the first `deploy.sh` against a host. Then: the
`DEM0-TEST` demo code and the D4 hatch are the two decisions that were parked "until B3a", and B3a
is now.

---

## 2026-09-02 (evening) — ten rows a page, and a fix that was worse than the defect

**Talked about**

The founder, after the log screen went in: *"We need to have 10 rows per table with pagination
added. Add as many details from the logging as you can."* Then three rounds of correction off live
screenshots — the strip above the column heads, the shape of the pager, and finally *"we will need
a better structure of the logs for the phone and tablet. Now it is a little messy."*

**Built — F13**

- `TABLE_PAGE_SIZE = 10` in `ui/table-controls.ts`, beside the sort and the filters, with the
  clamp/slice arithmetic as pure functions. **One number for the product**, imported even by
  `/platform/logs`, which holds no `TableControls` because its filters run on the server.
- `ui/table-pager.ts` — numbered at ≥768, `‹ n / N ›` below it, `aria-current`, 36 px drawn and
  44 px hit. All four tables paginate: `/company`, `/platform`, `/platform/companies` and the log
  stream, which is fetched in fifties and read in tens.
- The log detail gained the three things it stored and never showed: the **row id** (a string, and
  it stays one), the **exact stamp with its offset**, and the level as a word.
- Below 1024 the log screen is now a **list, not a squeezed table**, with the filter card shut by
  default and `GREŠKE`/`UPOZORENJA` as tappable filters. Chrome above the first line: 53% → 41% of
  a 390 viewport, 42% → 29% at 834.

**What went wrong, and it is the part worth keeping**

- **The overlap that wasn't.** The founder reported the table "overlapping down" at 1920. The
  measurement came back `unreachablePx: -32` — the card's foot was *already* reachable, 32 px above
  the fold at the scroll limit, and what he had seen was the foot below the fold before he
  scrolled. **The honest conclusion from that number was "there is nothing to fix".** Instead the
  screen was made to claim the window (`.screen { height: 100dvh }`), which turned every card into a
  flex item in a container that could not grow, and `.card { overflow: hidden }` — deliberately on
  the base class — then sliced them. `UČITANO 50` rendered with the bottom half of its digits gone,
  the NIVO chips were cut through, and the stream grew an inner scrollbar. **A clipped number is a
  wrong number, on the one screen whose whole job is telling the founder the truth.** Reverted
  whole; no hunk of it kept. *When a measurement says there is nothing to fix, that is the finding —
  not a reason to look for a different fix.*
- **`/platform` cut its pages from one order and drew another.** `listed` was the flat sort while
  the page was drawn in bands, so with 17 accounts the default sort put **no "Teren tim" band on
  page 1 at all** and split the company admins across pages. A real directory is a couple of staff
  and many foremen, so that was the ordinary case. It slices the drawn order now.
- **The medium rendering was never guarded.** Every table spec passed `render(true, true)`, so all
  of them were really testing expanded and the whole 768–1023 class was unpinned — which is how it
  reached the founder messy.
- **A guard was widened to accommodate the change that broke it.** Turning the log count keys into
  plural blocks made D5's *"never claims a total it cannot know"* spec fail on `typeof`. It now
  names the shared "X of Y" keys and scans the template to prove this screen reaches for none of
  them — the class forbidden rather than two spellings.

**Decided**

- **Ten rows a page, one constant, every table.**
- The count strip stays on the three directories — it is the loud-filter defence — and is **gone
  from the log screen**, where the stat card already carries the loaded count and no total exists
  to print.
- Below 1024 the log stream is a list; the error and warning counts are filters, because the
  question a founder asks a phone is *is anything wrong*, not *show me line #444*.
- **No screen on this route claims the window's height.** The page scrolls; cards size to content.

**Founder actions**

- [ ] Read the log screen on a real phone and tablet once there is https — the compact and medium
      layouts were driven headless at exact viewport sizes, which is not the same thing.
- [ ] `/company`, `/company/worker/:id` and `/company/profile` are **unverified in a browser**: the
      sweep ran under a super-admin session and those three bounce. They need a company_admin
      credential and a device session.

**Review status, plainly**

The increment had **one full review (accept-with-fixes, both gating findings closed and re-proven)**.
The delta review of those fixes was **stopped mid-run** so it would not test a tree being edited, and
the three rounds after it — the pager reshape, the revert, and the compact/medium redesign — are
**unreviewed**. Verified by execution: 1575 specs, 991 backend tests, a clean build, and per-card
`scrollHeight === clientHeight` measurements at 1280 and 1920.

**Next**

The dev-environment setup the founder asked for, then F7's health page. `.stats` was moved to
`styles.css` while three other screens still carry their own copies — deduplication left half-done,
and a follow-up.

---


## 2026-09-02 — the log screen, and what a green suite could not see

**Talked about**

The founder, before the dev environment: *"i want the logger screen. Have a button like all the
others thus far with some icon and build the logging screen. … It needs to be in table form that
will open detailed logs from the backend and it will have a download button so i can download the
logging report. Keep in mind, logs need to be detailed from every action that was clicked on the
app."*

**The boundary that had to be set first**

"Every action that was clicked" and "Teren staff can read this screen" are in tension, and the
tension is the whole design. The client sends **slugs and structure** — `capture.record.stop`, a
route, an outcome, a duration, numeric detail — and is forbidden from reading an element's text,
`aria-label` or `title`, because those are translated strings and some of them carry a project name
or a site address. The server then **rejects** free text rather than sanitising it. Without that,
the feature would put customer content in front of Teren staff, which plan decision 12 says is
impossible.

**Built**

- **D5** — `app_log` on the identity model, a Postgres Serilog sink (bounded queue, background
  flush, drop-oldest with a counter), the property allow-list, exception scrubbing by type, a
  14-day retention job, `LogRedactionTests`, and three routes: `GET /api/platform/logs` (keyset,
  filtered), `.../export` (CSV, BOM, formula-defused, capped) and `POST /api/client-events`.
- **F7's fourth screen** — `/platform/logs`: a table from 768 using the shared column control, a
  collapsed list that expands on tap below it, server-side filters, keyset load-more, a detail
  view, and the download. Reached by an icon button in `/platform`'s head cluster.
- **F12** — the action logger, and the `data-log` wiring across the money path.
- `PlatformRawSqlTests` — the scan ARCHITECTURE §12 had owed since the two-context split.

**What actually happened, which is the part worth keeping**

Both implementers were **stopped before they could report or self-verify**, and both halves were
sitting in the tree claiming nothing. Everything below was found afterwards.

- **A mutation was left live in `RoleFilter.cs`** — a fabricated exception carrying a Serbian
  sentence and an email address, logged on every 403, under a comment reading *"MUTATION PROOF
  ONLY - RESTORED IMMEDIATELY"*. It was not restored. **979 tests passed with it in place.** Third
  time in this repo. It did prove the sink held — the property was dropped, the message withheld,
  and only the console printed the sentence — but nothing in the suite could see it.
- **An unauthenticated stranger could write free text into `app_log`.** The allow-list admitted
  `Path`; the 401 filter logs `http.Request.Path`; that filter runs for anyone. A sentence in a URL
  segment landed verbatim in the table Teren staff read. The increment's central claim was false
  for a fortnight of nobody noticing. Route templates now, proven live: zero rows contain the
  sentence, and the row reads `/api/entries/{id}`.
- **Over half the dev table was the literal `{State:l}`** — every Hangfire line, which is exactly
  the source "what is failing" depends on.
- **Every failure channel in the sink reported to a `SelfLog` that was never enabled.** A host
  started without `migrate` would have dropped every batch in silence and shown an empty screen —
  and "started without `migrate`" is this repo's single most repeated failure.
- **The vocabulary shipped complete and almost entirely unwired**: no template carried a `data-log`
  attribute and only the log screen hand-recorded anything, so 26 of 33 slugs could never be
  emitted and the money path would have read `ui.app-capture-page.button.btn`. Every spec passed,
  because each asked whether what *is* wired is wired correctly and **none asked whether a declared
  name is reachable at all**. That is the same blind spot as the route rename of `ee37f04`, in a
  different costume.
- Three of my own guard fixes: the log spec's paging helper forged only the cursor, so the screen's
  own de-duplication made an append unobservable and the spec failed while the code was innocent;
  `i18n.spec.ts` exempted action slugs **by value everywhere** while its own documentation said
  "in the declaring file", which had silently switched the guard off for four sentences a foreman
  reads; and `NAVIGATION_COUNT` needed the door-plus-way-back bump.

**Decided**

- The log stream carries **slugs and structure, never words**. Free text is refused at the edge,
  not scrubbed after the fact.
- **`capture.photo.remove` was deleted rather than faked.** There is no control that removes a
  photograph, and a slug for a button nobody can press describes an app that does not exist.
- A count strip may never imply a total it cannot know, and on a failed load it says nothing at
  all: *there is nothing* and *I could not ask* are opposite claims.

**Founder actions**

- [ ] Read the log screen on a real tablet once there is https — the medium layout was the half
      that was broken, and jsdom cannot see a layout.
- [ ] Still owed: the VPS and the domain. Both unmet clauses of M0 wait on that purchase.

**Next**

The **health page** — F7's last screen — then the dev environment, and the codebase walkthrough
the founder asked for and has not had.

---

## 2026-09-02 — the owner gets a page of his own

**Talked about**

The founder: *"What we still need is for the company admin to get into his profile details the same
way the super admin does."* Then the sequencing for tomorrow: the log screen for the super admin, a
dev server, and — first — a written walkthrough of the whole codebase and its end-to-end flow,
because he has not read a line of the code that has been written for him.

**What was actually missing**

Decision 10 gives each role its own profile surface. Two of the three shipped: a foreman has
`/profile`, and a super admin opens his own row in the platform directory exactly as he opens
anybody else's. **The owner of a paying company had neither.** His row at the top of his own people
list was inert — his name and the words "signs in with a password" — and there was no screen in the
product that would tell him the address he signs in with, when his account was opened, or when it
was last signed into. Those facts were readable by Teren staff on `/api/platform/users` and by
nobody else, himself included.

And the reason was not an oversight in the UI. **He appears in no list he is allowed to read.**
`/api/workers` is `WorkersOf(companyId)` — the men who record — and excludes him by construction;
the platform directory answers 403 to every role but Teren staff. The route that could describe him
is `/api/me`, which until today carried a name, a role, a language, a company and a device, and
nothing else. So the screen was not buildable without widening that answer first.

**Built**

- `GET /api/me` gains `email`, `created_at` and `last_login_at`. Additive, and not a disclosure:
  the route answers only for the credential presented, so the caller is reading back a value he
  typed into a login form himself. `MeTests` pins the three, and pins `last_login_at` **null for a
  worker** — a foreman never signs in (decision 5), so the honest answer is nothing rather than
  something plausible.
- `CompanyGateway.me()` — the same route, through the office seam, so it carries the **admin**
  bearer. This is the one thing on the screen worth a second look: `ProfileService` already asks
  `/api/me` through `TerenApiClient`, which sends the *device* token. On the founder's own browser —
  a demo phone and the office console at once — that call succeeds and describes **Zoran**. A spec
  asserts the call went through the office gateway for exactly that reason.
- `/company/profile` (`features/company/account-page.*`): who he is, the address he signs in with
  given the weight the foreman's screen gives a username, his company, when the account was opened,
  the previous sign-in, and this browser's own session with the date it expires. Three deliberate
  layouts; two panes at ≥1024. *(Rebuilt the same day — see below. As first shipped it was a hero
  card with an avatar and carried its own language switcher; both are gone.)*
- The director's row on `/company` opens it, at both widths, exactly as a foreman's row opens his.
- `company.account.*` in both dictionaries.

**Decided**

- **`/company/profile`, not `/profile`.** Two screens for two credentials. `/profile` is gated on
  this browser holding a *device* session and offers re-activation; an admin has neither, and a
  route trying to serve both would have to decide which credential it was reading on every field.
- **No sign-out on the screen.** `session-link.ts` is already in its chrome at every width, and its
  whole argument is that sign-in and sign-out are one affordance with one place.
- **No "change password" control.** There is no authenticated route for it — `POST /auth/password`
  validates a mailed `trn_p_` token and nothing else — so the screen says who to ask instead of
  offering a button that cannot work. Worth building later; it is a real gap for a locked-out owner.

**Founder actions**

- [ ] Restart both processes before testing — the API on 5080 predates D6 and yesterday's frontend
      was stopped at the founder's request.

**Also built, same day: the walkthrough, and a documentation pass**

The founder asked for a document that runs through the whole codebase along the end-to-end flow,
written for somebody who has never read a line of it — to study before the dev server goes up.
Published as an artifact: seven acts following one day of work from a foreman's thumb to the
client's inbox, then the five product rules and where each shows up in code, how to read a file in
this repo, what is not built, and how to run it. Every path named in it is real.

Then *"what is left before we start milestone 1?"* — and the file that exists to answer that was
wrong. **`ROADMAP.md` had drifted in four places**: B7 read ☐ though it shipped on 2026-08-30, D6
read "blocked on an SMTP relay" though it was never blocked on one and shipped yesterday, F7 read ☐
though three of its five screens are built and reviewed, and the *"next session, in order"* note
listed four things all of which are done. `ARCHITECTURE.md` §7 still described only the M0 routes
and carried **none** of the identity surface — every `/auth/*` route, the whole company-admin
surface and the whole platform surface were undocumented.

Both are now current, plus `CLAUDE.md`'s phase block. Three things were promoted out of prose into
the **open decisions** table, where they can be seen: **a VPS and a domain** (the one purchase M0
waits on), **which SMTP relay**, and **the invite/reset impersonation path** — D4's rejection, which
is a founder decision rather than a code fix, and which means the privacy claim is true of every
typed route and false of one deliberate door.

**The answer to the question, in one line:** M0 is fully built and not done. The gap is a server,
not code.

**Also built, same day: one control at the head of every column**

The founder sent three screenshots of the admin surfaces with three notes: *"column headers in the
second screenshot are black and in all the others it's not like that"*; the third column of
`/company` *"needs to be in one row and renamed — I don't like this kind of name on the column"*;
and *"I want one standard option right beside all columns so I can filter or sort if I want. Add
that to all the tables. Super admin will have more than 10 clients hopefully and the company admin
can have more workers."*

**The colour was a symptom; the cause was three copies and one missing one.** `/company` and
`/platform` each carried their own hand-built sortable header — the same four helpers, the same
uppercase muted button, written twice. `/platform/companies` had no sort at all, so there was
nothing in its `<th>` but text, and the browser's own black bold default is what the founder was
looking at. Styling that one cell would have fixed the screenshot and left three implementations of
one idea in the tree.

So the header became a component, and the state behind it an object:

- **`ui/table-controls.ts`** — the sort and the per-column filters of one list, with Serbian-aware
  folding (`Jovanović` is found by typing `jovanovic`; **`đ` is folded explicitly**, because it has
  no Unicode decomposition and `Đorđe` would otherwise be unfindable on a keyboard without the key).
- **`ui/column-menu.ts`** — the control every column now carries: the label sorts on one tap, and
  the funnel beside it opens a menu with **both directions named in words** (a date column says
  *Prvo najnovije*, not "descending") and that column's filter box. Below 768 the same component
  travels as a pill in the list's own control bar, so the phone can never fall behind the tablet on
  what a list can be asked.
- `.data-table`, `.table-bar` and `.column-bar` in `styles.css`: the furniture all three tables
  share, so a fourth inherits the look rather than inventing one.

**Two things about the filter that are not decoration.** It matches **the words the cell shows** —
which is what lets one box serve a name, a date and a row of status chips without any column
declaring a type; the state column is filtered by typing *kod ga čeka*. And a live filter is loud:
a tinted funnel on the column, and a strip above the table reading *Prikazano 1 od 12* with one tap
back to everybody. A table quietly showing one of twelve rows is the single state in which these
screens can make an owner believe a foreman has been removed from his company — or, on the customer
list, make the founder suspend the wrong row.

**The column was renamed *Aktivnost*.** *Poslednji kontakt* broke over two lines at 1280 the moment
the head cell had to hold a control as well as a word, which is what the founder was looking at.

**Found while doing it, and both were real:** `/platform/companies` had an icon whose only
accessible name was *Ljudi* standing on a screen with a column headed *Ljudi* — a spec pressed the
wrong one and looked like a broken sort; the icon is *Idi na ljude* now. And the menu was
absolutely positioned, which a two-row table clips: the table sits in a horizontal scroller and the
phone's pill bar is another one, so it is placed from the trigger's own rectangle in viewport
coordinates and closes on scroll.

**Verified by execution:** 1363 PWA specs (was 1311), `ng build` clean, and — with a throwaway
Playwright driving the running app at 390/768/1280/1920 against stubbed lists of twelve foremen and
eleven customers — no horizontal overflow anywhere, the three header rows identical, the menu
un-clipped over a one-row table, and the filtered state legible. Five mutations proven: dropping
the owner row from the filter, dropping the phone's control bar when one row is left, reverting the
customer table to plain `<th>` text, removing the follow loop, and removing the flip-above branch —
each turns specs red; every file restored byte-identical (sha256).

**The reviewer's two HIGH findings were both about the same wrong idea: measuring once.** The menu
is `position: fixed`, and it was placed at open and left there. On a phone that put the filter box
**56 px below the fold**, where `focus()` cannot scroll a fixed element into view and the scroll
that would reach it closed the menu. And at every width, the first keystroke made the "showing 1 of
12" strip appear above the table, which moved every column head down 61 px while the menu stayed —
over the very row being searched for. The placement is a pure function now (`ui/menu-placement.ts`:
right edge, clamped, spans the gutters below 768, **flips above when the room below is short**,
pinned and scrollable when neither side fits) and the component re-runs it once a frame while the
menu is open, writing the signal only when the numbers change. Re-proven in the browser at 390×660:
the box lands inside the viewport, and the menu tracks a trigger that moves −80 px.

**Delta review: accept (2026-09-02).** It re-measured the follow loop in a browser — 60 rect reads
a second while open, and **zero** after Escape, a re-tap, an outside tap or a navigation away — and
probed the enlarged hit areas from both sides: the funnel's 44 px target begins exactly where the
label's button ends, and on the phone it spans the pill's height and stops at its edge, 8 px clear
of the next pill. One known behaviour it could not stage and I have not changed: `placeMenu` has no
memory of the side it chose, so in a narrow band of viewport heights the "clear the filter" line
appearing can flip the menu to the other side of its trigger and Backspace flip it back. The box
stays reachable either way. *And a gap in `design/tokens.md` rather than in the code: the 10 px
radius `select-field` and `column-menu` both reach for had never been written down, so it read as
drift twice. It is written down now.*

*Three smaller ones from the same review, all real: the funnel was **white on pale tint** inside a
sorted pill — 1.2:1, on the one control whose job is to be loud, in the default state of `/company`;
its tap target was 28 px against the token minimum of 44 (it is drawn small and hit large now,
verified by clicking 6 px outside the disc); and the compact customer row offered an "Od" pill while
printing no date, so the list reordered by a value no row showed.*

**Also built, same day: the owner's account screen is the platform's, for the other role**

The founder, off a screenshot of `/company/profile`: *"we have duplicated stuff for translation here
— already have it in the header. Build this profile screen similar to the super admin."*

Both halves were right. The language switcher is chrome: the app header carries it from 768 up and
this screen's own compact bar carries it below that, so the in-page block was **one setting said
three times on one screen**. And the screen it stood on was a shape nothing else in the product
used — a hero card with an avatar, a boxed sign-in block, a two-up detail grid — so the owner's own
account looked like a different product from the screen Teren staff read *about the same man*.

It is now `platform/person-page`'s shape with this role's facts: the person is the title, a `detail`
card carries his role chip and a fact list (label beside value from 768), an `actions` card beside
it carries this browser's session, the sign-out hint and the password sentence, 7/5 at ≥1024. Three
dictionary blocks went with the old markup (`company.account.language.*`, `.name`, `.details`), and
four labels that shouted in the JSON went to sentence case — `.t-label` is what uppercases a label,
and half of this screen's keys had it baked in.

**The review found one defect and one piece of nonsense, both in the copy of the platform's head
row.** `person-page`'s subtitle names one thing from one source; this screen's names an address that
only the server has, under a `known()` that is true from the *stored session* — so every load
flashed "no address on file" under his name, and in the unreachable state printed that claim
**above** the notice saying nothing had been confirmed. A caveat after the claim is not a caveat.
The line is drawn only from a server-supplied address now, pinned by two specs. And the sentence
explaining the address had been left at the foot of the card, where "this address and your password"
pointed at a timestamp; it is a second line of the address row now.

**Delta review: accept.** It re-drove all three states in a browser — loading at 390 now reads
*Milan Gradnja · Učitavanje naloga…* with no claim under the name, and the unreachable state puts
the notice first and the "no address" sentence once, below it. *Two things it left open, both older
than this screen's rework and neither a gate: with `status === 'ok'` the name and company still fall
back to the session's copy when the server omits them, with no stale marker; and "Nema sačuvane
imejl adrese" is itself untrue in the 503 state — the address is on file, the server was not
reached. An em-dash is the honest answer there.* The `.t-label` rank collision it noticed (a section
heading and a fact's term are the same 12 px uppercase) is written into `design/tokens.md` rather
than fixed here: the two screens exist to look identical, so that one is fixed on both at once.

*One deliberate loss, recorded rather than hidden:* the deleted language block carried the only
sentence on the admin surface saying the client's report goes out in the **site's** language, not
the browser's. It explained a control that no longer exists here, and it still ships on the
foreman's `/profile`. If an owner needs it, it belongs beside a report, not beside his password.

**Verified by execution:** 1368 specs, `ng build` clean, and driven in a browser at 390/768/1280/1920
against a stubbed `/api/me` — no horizontal overflow, exactly one *visible* language switcher at
every width, and the screen sitting beside `/platform/user/:id` as the same object. Four mutations
proven: re-adding a switcher to the card, renaming the `actions` card, restoring the `known()`
subtitle and removing the hint each turn specs red; every file restored byte-identical (sha256).

**Next**

- **D5** — `app_log`, the Serilog sink with its property allow-list, exception scrubbing, the
  retention job, and the test that reads every log call site off disk. Then the health page and the
  log viewer, which are what F7 still owes.
- Then B3a for real: a VPS, a domain, https.

---

## 2026-09-01 — the platform surface was unreachable, and every guard was correct

**Talked about**

The founder signed in as a seeded super admin and reported: *"The pages aren't wired in, after the
sign in I don't see any super admin pages."*

**What it actually was**

Not the pages. `POST /auth/login` answered his account with `role: super_admin`, `/api/platform/*`
answered 200, and a browser driven through the sign-in landed on `/platform` and rendered the real
directory. Every part of F7 worked. What did not exist was a way in **on his machine**.

Three guards, each correct on its own:

- `/login` was gated on `requiresNoDevice`, so any browser holding a *device* session was bounced
  to Home. His browser is the demo phone — he activated it with `DEM0-TEST`.
- `/welcome`, where the only "sign in" link in the app lives, bounces for the same reason.
- `session-link.ts` renders nothing at all for a browser with a device session, by design.

So the password door was shut, and with it every admin and platform screen behind it. And after a
sign-in there was still no way *back*: the only navigation into `/platform` anywhere in the app was
the one `login-page.ts` performs on success, so one reload or one tap on Home and the surface was
gone until he typed the URL again.

**The reason nothing was red, which is the part worth keeping**

`app.routes.spec.ts` proves every navigation resolves to a registered route. That is the wrong
direction: it cannot see a route with no navigation into it, and it certainly cannot see a route
whose only navigation sits on a screen the browser is redirected away from. **Reachability is a
property of the guards in combination, not of the route table** — and each guard had its own spec
asserting its own behaviour, correctly, in isolation.

**Built**

- `requiresNoAdminSession` (`core/session/device.guard.ts`), now guarding `/login`. It asks the one
  question that screen is about — is somebody already signed in here — and sends him to his own
  surface by **role**, never to `?next=`. Honouring the parameter would let
  `/login?next=/company` bounce a super admin between two guards for ever.
- `ui/platform-link.ts` — the way back, in the app header and at the foot of Home's scroll, visible
  only to a signed-in super admin. `company-link.ts`'s twin; the office got one at F6 and the
  platform did not. A new `building` icon, deliberately unlike the `user` and `globe` beside it.
- `showPlatform` on `AppHeader`, off on the three `/platform` screens, so the control never points
  at the screen it is standing on.
- Specs: a `describe` block that walks the whole round trip as a journey rather than as a decision
  — sign in with a device session, reach `/platform`, go Home, come back through the chrome, and at
  390 where the header does not exist. Plus the loop the door must not open.

**Verified**

1288 PWA specs and `ng build` green. The round trip driven in a real browser against the live API
at 1280 and 390: `/login` reachable with a device session, sign-in lands on `/platform`, Home shows
the control in both the header and the footer, and both lead back. No dead self-link on the
platform screens themselves.

**Also learned:** `ng serve` had stopped rebuilding. It served a bundle without any of this until a
`touch` on a source file woke the watcher — which is the third time in two days that "it doesn't
work" has had a stopped or stale process underneath it. Check the watcher before disbelieving a
green suite.

**Founder actions**

- [ ] **Should a foreman see a "Prijavi se" control?** It is in the veto queue. The mechanical
      objection is gone — `/login` now accepts a browser with a device session, so the control
      would work — and what remains is the product call. Without it, reaching the platform on a
      browser that has never signed in means typing `/login` once.
- [ ] The seeded super admin was inserted by raw SQL with a five-character password (`teren`).
      Fine on a laptop; on anything public use `create-super-admin`, which enforces the 12-character
      floor and writes the audit row.

**Next**

B3a — VPS, domain, https origin. Founder-blocked.

---

## 2026-09-01 — D4, the platform surface

**Built — `/api/platform/*`, gated to `super_admin`**

Companies (list, create, suspend, resume), users (filtered by company, role, status and free text),
the §9 authenticated invite, disable/enable, and the audit trail. Every list pages by keyset.

**All of it behind one named type, `PlatformDirectory`**, and that is not organisation for its own
sake: plan §12 asks for a reflection guard over the platform surface, and a guard is only possible
if there *is* a surface. A handler that queried the database directly would be a hole in the proof.

**The privacy guard, and the half the plan's own example needed**

The four mutations §12 names were already covered — the route gate by `RoleGateTests` and
`MediaDownloadTests`, the null tenant by `Super_admin_reads_no_evidence_even_with_the_route_gate_removed`,
the closed model and the `IgnoreQueryFilters` allow-list by `IdentityModelTests`. D4 weakened none
of them, so none needed rewriting.

What was missing is the failure that is *quiet*. Every layer above stops a super admin **reaching**
evidence; none stops evidence being **carried to him** on a DTO he is entitled to read. Nobody will
remove the role gate. Somebody will add a count because a dashboard would look better with it.

So there are two guards, and the second exists because the first cannot do what §12 claims:

- a reflection walk over `PlatformDirectory` fails if any parameter or return type transitively
  mentions `Entry`, `Media` or `Report`;
- **and platform DTO property *names* are checked against an evidence vocabulary**, because §12's
  own example — `entry_count` on a company DTO — is an `int`, and no amount of walking a type graph
  finds `Entry` in an integer.

**Mutation-proven rather than asserted:** adding `int EntryCount` to `PlatformCompanyResponse` turned
two tests red — the name guard and the field-set assertion on the company row — and reverting turned
them green. The walk also carries its own bait type, so "no offenders" means it looked and found
none rather than that it stopped looking.

It caught something immediately: `PlatformAuditListResponse` originally named its rows `entries`.
Renamed to `actions` — in this product an *entry* is a day of a foreman's work, and naming
administrative rows after it puts the one noun this surface may never touch in the middle of its own
payload.

**Two properties worth proving where they actually live**

- **Suspension is proven on the phone, not on the column.** A test that asserted `suspended_at` would
  pass against a suspension that stopped nothing. The real test suspends the demo company and then
  makes the worker's client call `/api/projects`: 401, **with no sleep anywhere in the test**. The
  absence of the sleep is the assertion — a token→principal cache of any duration would make it pass
  by accident and make revocation "mostly" work in the field.
- **Keyset paging is proven by the property offset paging cannot have.** Scroll the company list two
  at a time, insert a company mid-scroll, and assert every company appears exactly once. With
  `OFFSET` the insert shifts the window and page 2 re-shows the last row of page 1 while one company
  is never seen at all. A malformed cursor is a 400, never a silent reset to page one — that is how
  a client loops over page one forever while every request looks healthy.

**The defect the tests found, and the guard it earned**

Six tests failed with 500 on `POST /api/platform/companies`, including the one expecting a 400 for a
blank name. **Validators are registered one by one in `Program.cs`; there is no assembly scan.** So
`ValidationFilter<CreateCompanyRequest>` called `GetRequiredService` on something nobody had
registered and threw *before the handler ran* — every POST to that route answered 500, the malformed
ones included. Nothing in the symptom points at the cause.

`ValidatorWiringTests` now reads every `ValidationFilter<T>` out of shipped source and fails if
`Program.cs` does not register `IValidator<T>`. Source-scanning rather than container-resolving,
following the house precedent: the coupling is between two files, so reading both files is the
honest check.

**Suites: 892 backend tests (861 → 892) and 862 PWA specs**, both verified green by execution.
`dotnet test` builds to a scratch `BaseOutputPath` — Visual Studio and a running `Teren.Api` hold the
output DLLs, which is MSB3027 and never a reason to kill `dotnet.exe`.


**Reviewed — both reviewers ran over the whole unreviewed surface (2026-09-01)**

**Frontend: accept-with-fixes.** It installed a throwaway Playwright into its own temp dir and
actually drove the app at 390/767/768/833/834/1023/1024/1280/1920, so **the F7 layout pass has now
been seen** — the thing CLAUDE.md has been warning about for two days. No horizontal overflow at any
width; `session-link` renders in exactly one place at every width (compact bar below 768, header at
and above it — the "two places" are mutually exclusive by media query, checked at 767 and 768
specifically); `/company`'s crew grid really is two-up from 768 through 1920; Home's record pane
really does fill a 1080 viewport. F5, F6, D7/F9 and the F4 leftover: sound.

*Its gating find is a genuine bug and it predates C3.* `entry-detail.ts`'s **local** read had no
freshness guard, while the server read five lines below it did. `/entry/:entryId` is one route, so
Angular reuses the component across entries: open A, tap B before A's Dexie read resolves — and
`db.open()` itself settles after first paint, so the window is real — and A's site, time and status
paint onto B. On the one screen that exists to be trusted in a dispute, months later. Fixed, and
**mutation-proven**: the first version of the spec asserted on the photo strip and passed with the
guard removed, because the strip comes from `watchMedia(entryId)` and was never a witness. Asserting
on the site name — which is read straight off `local` — makes it fail without the guard and pass
with it.

**Backend: REJECT.** One critical finding, and it is a real one.

`POST /api/platform/users/{id}/invite` mints a set-password token for any non-worker and returns the
**plaintext** to the caller. `POST /auth/password` is unauthenticated and validates only the token.
So Teren staff can take a company admin's account, sign in as him, and read that company's diaries —
**and plan decision 2 says a super admin can never do exactly that.** The four layers of §6 make it
true of his *own* principal; nothing stopped him minting a different one.

Two corrections to the reviewer's framing, made after checking: **the capability predates D4** —
`invite-admin` has done the same from a terminal since D2 — and **the trail does distinguish the
dangerous case**, because `password_token_issued` carries `{"source": "platform", "purpose":
"reset"}` and `reset` means the target already had a password. What D4 changed is that it is
reachable through the product.

What was wrong and is now fixed: **my own doc comment asserted the false reasoning** — "returning
the token reveals nothing to anyone who could not already act" — which is exactly backwards. Both
`InviteUserResponse` and `InviteAsync` now carry the real cost, and **§13 of the plan carries it as
a named, open founder decision** with the three options (accept and reword decision 2; narrow the
route to `invite` only, which closes the hole and takes the support case with it; or require a
second signal, which needs D6 and a relay). It is not something to fix by deleting the method — a
locked-out admin with no relay has no other way back, which is why §9 specifies it.

The reviewer's second finding was also right and is fixed: the **privacy guard could not catch what
its own doc claimed**. A `string? Summary` on a company DTO, filled with a transcript, passed both
walks — `string` is opaque to the type walk and the name list had no word for it. `notes` was the
sharpest miss, since `notes` is the field the verbatim flow puts a foreman's own words in, and §12's
log-redaction guard already lists it. The word list is now aligned with that vocabulary, and the
limit is written down: a denylist cannot be completed, so this pair is a tripwire, not a wall. The
wall is the closed identity model.

Third finding, also fixed: `InviteAdminCommand` still duplicated `PasswordTokens.IssueAsync`
statement for statement — the exact thing the extraction's own comment warns about. It now
delegates. Its source-scanning guard moved with it (`PasswordTokens.Add` → `PasswordTokens.IssueAsync`),
which is the guard working rather than being weakened: a command that stopped minting still fails it.

**Suites after the fixes: 892 backend and 863 PWA**, both verified green by execution.

**Later — "frontend was destroyed": it was not, and the check cost five minutes**

Reported as destroyed, asked to rebuild. Nothing was rebuilt, because nothing was gone: `git status`
clean, **179 source files on disk against 179 tracked in HEAD**, 58 spec files, `ng build` clean with
all thirteen route chunks emitted (`welcome`, `login`, `activate`, `profile`, `company` included), and
**863/863 PWA specs green by execution** in 6.6 s at load average 0.5. No stash, nothing recoverable
in the reflog, both i18n dictionaries serving ~1050 keys.

The tree *looked* touched because HEAD arrived by `pull --tags origin main` at 14:53, which rewrote
the working files and left them with a 15:03 mtime. That pull **brought the frontend in**, it did not
take anything out. What was actually wrong: **nothing was listening on 4200** — a stopped dev server
and a dead browser tab. `npm start` was the whole fix.

Worth writing down because the instinct the request invites — regenerate the frontend — would have
destroyed 179 reviewed files, F5/F6/F7/F8 and the just-fixed `entry-detail` freshness guard among
them, to repair a problem that did not exist. **Verify against the tree before rebuilding anything;
the founder reports symptoms from his browser, not from `git status`.**

**Then "backend also doesn't work" — same diagnosis, same five minutes**

Also not broken, also not running. `dotnet build` clean with **0 warnings**, Docker up (29.7.2) with
Postgres and MinIO both healthy, **all 7 migrations applied across both histories** (6 evidence + 1
identity), 13 tables, the three contract project ids intact, and the demo seed present. What was
wrong: **no `Teren.Api` process on 5080.**

Started it, then proved the backend rather than assuming it: `/health` 200, authenticated
`GET /api/projects` 200 with the three Serbian sites, `/api/me` returning the right worker, company
and device, and an unauthenticated call **401** — so the gate holds. **892/892 backend tests green**
by execution (57 s). The demo activation code `DEM0-TEST` is still live and unconsumed, and it was
**deliberately not spent** to run this check — the demo device token authenticates the same paths
without burning a single-use credential the distributor may need.

**The real lesson is not about either half.** Two "it's broken" reports in one session, both stopped
processes, because bringing this stack up is four manual steps with nothing supervising them. Worth a
one-command `dev up`.

**Also — the demo company admin's password, by request**

`petar.petrovic@…example.com` (company_admin, Vodoinstal Petrović) got a new password. Done through
**the product's own path, not a hand-written hash**: `invite-admin` minted a reset token, then
`POST /auth/password` consumed it, so the value went through `PasswordHash` and landed as
`pbkdf2-sha256$600000$…` freshly salted, and the trail carries `password_token_issued`
(`{"source":"console","purpose":"reset"}`) followed by `password_set`. Proven: login **200** with a
real `trn_s_…` session, a wrong password **401**, and the token **401** on replay, so single-use
holds. `seed` still ships this account with **no** password — that statement in CLAUDE.md is about
the seed and stays true; only this dev database now has one.

**Then the company-admin surface was rebuilt — the founder's own verdict was "this genuinely now is a bad UI"**

He shot `/company` at 375, 768 and 1920. At 375 the crew card expanded *inside the list*, so a code,
an explanation and two full-width buttons lived in a row; at 768 the add form dominated and one
foreman hung above it; at 1920 the left column was ~90 % empty while everything useful was crushed
into a narrow rail. He asked for a table grouped by role and a page per worker.

**Scope was cut to frontend-only after one check:** `WorkerEndpoints.cs` lists `WorkersOf(companyId)`
— workers only — so there is no directors data to group by. The group is the signed-in admin from
his own session, and nothing is invented. A directors endpoint is the backend increment that would
change that.

`/company` is now a people directory: a real `<table>` at ≥768 (`scope`, `aria-sort`, one `tbody`
per group) and a **tappable row list below 768**, chosen in TypeScript from a viewport signal rather
than by `display:none`, because a table whose cells are forced to `display:block` has the semantics
of neither. Sorting is a pure tested function. Per-worker detail is a new route,
`/company/worker/:workerId`. Then, on his second look, the rail went entirely: "Kako kodovi rade"
became an info popover, and the add form and the PODACI block became modals, all reached from a head
cluster next to the reload button.

**The interesting part is not the table — it is what the reviewer caught.**

The implementer claimed four freshness defences, "each mutation-proven". Two of them were not.
Removing the `code` computed filter left the suite green; removing the **`issue()` mid-flight
guard** left it green too. With both gone the exact catastrophe its own class comment describes is
reachable: confirm a new code for Zoran, move to Marko before the POST resolves, and Zoran's live
code *and his share message naming him* paint under Marko's name — on the one screen whose entire
job is handing out credentials. **The read paths were pinned; the destructive path was not.** That is
the `entry-detail` failure of the day before wearing different clothes: an assertion that was never
a witness. Both are witnessed now, and I re-ran the mutation myself rather than trusting the report —
two specs red without the guard, file restored byte-identical by sha256.

*Recorded as a rule: when an agent says "mutation-proven", ask which mutations it actually ran. This
one had reasoned about two of the four and written the reasoning down as proof — and had even noted
in its own report that removing one alone would leave the suite green, which should have been the
tell.*

Two bugs the implementer found only by opening its own screenshots, both worth the pass: the popover
**did not open on a mouse at all** (`mouseenter` opened it, the following `click` toggled it shut),
and at 375 the bubble ran off the left edge, clipped by `overflow-x: hidden` and therefore invisible
to a `scrollWidth` check. Hover-only was rejected on principle — a company_admin reaches these
screens on a phone, where hover does not exist — so it opens on hover, tap and keyboard focus.

**966 specs in 62 files** (from 863/58), `ng build` clean with no budget line, nothing outside `web/`
touched. **The second pass — popover, both modals, the head clusters — has never been through the
reviewer**; only the table-and-detail half has. The founder asked to commit and push before that
round ran, which is a deliberate choice and is written here so the gap is not discovered later.

**The value is deliberately not written down in the repo.** `DEM0-TEST` is already a published live
credential to the demo company and CLAUDE.md flags it as needing a decision at B3a; a company_admin
password in a git-tracked file would be a second, worse one. **If this same value is ever used on
B3a staging behind a public URL, it is a real admin credential to a real hostname** — set it there
from the console, never from a doc.
**Founder actions**
- [ ] **Look at `/company` and Home at 1280 and 1920 with your own eyes.** A headless browser has
      now seen all nine widths and found no overflow, so this is a taste check, no longer a
      correctness one.
- [ ] Serbian copy pass on the new strings: `pending.action.reactivate`, `home.reactivate.*`,
      `archive.photos.loading` / `.retry`.
- [ ] Still owed: an SMTP relay, and the 1280 artboards for the three auth screens.

**Next**
1. **D5** — `app_log`, the Serilog sink with its property allow-list, exception scrubbing, the
   retention job, the source-scanning redaction test, and `/api/platform/health`. This is where
   `Project` finally enters the identity model, for site names on the health page.
2. **F7** — the `/platform` screens. The log viewer's compact layout is the hard part.
3. The review debt: eight increments have never been through a reviewer.
## 2026-08-31 — The three gates ran, and main had been undemoable since the last commit

**Talked about**
- Picking up the unaudited surface: F3, D2 and D3 all owed their reviewer.
- The founder's ask mid-session: fix the routes so he can test, then finish M1.

**The headline: `ee37f04` shipped an app that could not be navigated.**

F3's reviewer returned **reject**, and the defect had nothing to do with auth. The F4 back-out of
2026-08-30 was incomplete in the opposite direction from the one the journal recorded. The journal
said "nothing of F4 survives"; in fact **every consumer had already been flipped to English paths**
— `home-page.ts`, `archive-page.ts`, `confirm-page.ts`, `pending-page.ts`, `entry-detail.ts` and
all three capture exits — while `app.routes.ts` was hand-restored to Serbian. Only `/` and the three
auth routes matched anything. Tapping record, pending, the archive or the confirmation gate fell
through `'**' → redirectTo: ''` to Home.

So the money path was broken on main, invariant 6 was violated, and **`ng build` was clean with 538
green specs the whole time.** Two specs were structurally blind to it: `capture-recording-page.spec.ts`
used `provideRouter([])` — an empty route table — and `rescue.service.spec.ts` asserted
`openEntryIds()` against hardcoded `/entry/...` strings. Both validated the *future* behaviour.
`rescue.service.ts:56-62` even claimed a spec derived the paths from the route table. **No such spec
existed.** Fourth instance of this project's signature failure, and the first one to ship a broken
money path.

Second consequence of the same root cause: `openEntryIds()` always returned empty, so the
abandoned-draft sweep's exemption was dead — a foreman on the saved screen picking photos could have
his draft force-queued out from under him. The comment above that function calls it "the worst bug
this product can have."

**Built — F4b, the root fix**
- All six paths renamed in one pass per plan §10.3: `record`, `entry/:entryId`, `confirm/:entryId`,
  `diary`, `pending`, `?entry=`. The rename was **purely producer-side** — no consumer needed
  changing, which is precisely why nothing caught it.
- `src/app/testing/route-table.ts` (new): resolves a route's path out of the real `routes` array
  keyed on the **component class by reference**. Name-keyed lookup was tried and rejected — the
  build renames classes to `_CaptureSavedPage`, so `Function.name` matching is a string coupling
  wearing a disguise.
- `rescue.service.spec.ts` now derives the URL from the table — the spec the source comment claimed
  already existed.
- `capture-recording-page.spec.ts`: `provideRouter([])` → `provideRouter(routes)`, real router, no
  navigate stub, all three exits covered.
- `app.routes.spec.ts` (new, beyond the brief): reads every `router.navigate([...])` literal out of
  shipped source and resolves each against the shipped table. A `targets.length >= 15` floor stops
  the extractor degrading into a spec that asserts nothing.
- **F4b's reviewer never returned a verdict** — the agent died on an API session rate limit partway
  through. The increment is therefore **built and green but ungated**; do not record it as reviewed.
- What was verified instead, by running the mutations directly at load 0.8 (not by trusting the
  implementer's report): renaming `entry/:entryId` → `saved/:entryId` in the route table alone turns
  **7 specs red**, exactly as claimed. Flipping the *consumers* instead — `['/entry',…]` → `['/unos',…]`
  in all three capture exits plus the rescue regex, table untouched — turns **6 red**, where the
  implementer reported 5. The extra one is `app.routes.spec.ts`'s source scan catching the navigate
  literals, i.e. the guard is *stronger* than reported, not weaker. Reverting returns 542/542.

**D2 — accept.** No gating findings. The reviewer confirmed the super-admin privacy claim (H2) is
structural at four independent layers, and that one of its tests is written to fail *even with the
route gate intact*. The 403/404 doctrine is enforced by a source-scanning test with an anti-vacuity
check on its own allow-list. A composite FK makes a device/user pair with mismatched companies
unrepresentable in the database. It also noted a hardening that predates the increment: a
client-supplied `device_id` on `POST /api/entries` is now accepted-and-ignored rather than trusted.

**D3 — accept-with-fixes: a timing oracle on both unauthenticated activation routes.**
Bodies and statuses were byte-identical — proven by two existing tests — but the *work* was not.
An unknown username cost 1 indexed SELECT; a suspended company 2 queries; a **known active username
with a wrong code** generated a device token, opened a transaction, INSERTed a full `device` row,
saved, attempted the claim, and rolled back. Deterministically slower, every time, so a stopwatch
answered "does this man work here" — and usernames are guessable, because `UsernameFormat.Propose`
transliterates a public display name deterministically.

The asymmetry worth remembering: **this does not bite `/auth/login`**, where ~200–400 ms of uniform
PBKDF2 swamps a one-query variance. That is exactly what `PasswordHash.DummyVerify` exists for.
Activation had no such cost to hide behind.

Fixed by removing **every early return** from the handler: a malformed code, an unknown username, a
suspended company and a wrong code now run the same four statements and are refused only at the end.
The device insert moved *behind* the claim, and inadmissible requests carry a `Guid.Empty` user id
and a `NoSuchCodeHash` of 64 zeros — a SHA-256 output with no preimage — so they cannot consume
anybody's code. `ActivationTimingTests` asserts branch medians against each other with interleaved
samples and a rotating branch order, never a wall-clock number.

**Found while proving the environment, worth remembering**
- **The dev database had never had the identity migrations applied**, and was four evidence
  migrations behind besides. The exact failure mode CLAUDE.md warns about; it would have died on a
  bare Npgsql `42703`/`42P01`. Fourth time this class has bitten.
- **Nothing in `src/` ever creates a `PasswordToken`** — only reads and consumes one. So an admin
  can never set a password, so no company_admin session can exist, so **no activation code can be
  issued through the product at all**. "Prove activation end to end" is blocked on D4/D6 or a
  deliberate bootstrap command, and it gates the D7/F9 token flip.
- Proven against the live API instead: `create-super-admin` → `/auth/login` → `/api/me` works; the
  compatibility hinge holds (the baked-in PWA token resolves to a real device bound to Zoran
  Jovanović); super_admin gets 403 on `/api/entries` and `/api/workers`; **revocation is immediate**
  with no token cache; `seed` heals a revoked demo device exactly as documented; and neither
  unauthenticated route is an enumeration oracle by body.
- **The machine ran out of memory** (23/31 GB, swap exhausted): it SIGKILLed a test run and took
  **Docker Desktop** down with it, which surfaced as API 500s. Restarted. The PWA suite is
  load-flaky under this pressure — a different random set of 5 s vitest timeouts each run against
  real IndexedDB. Green and stable at load < 6.
- `teren-mailpit` cannot start while the founder's `coisi` project holds port 1025. Irrelevant to
  activation; blocks exercising B6's email path.

**Suites: 788 backend** (786 + 2 timing) **and 542 PWA** (538 + 4), both verified by execution,
both builds clean.

**Activation proven end to end, by hand — and two findings from doing it**

The blocker was real but shallower than it looked. Nothing in `src/` mints a `PasswordToken`, so no
admin can sign in — but a **company_admin is allowed a password** (only `ck_app_user_worker_has_no_password`
forbids one, and only for workers). Inserting one `password_token` row and then calling the **real**
`POST /auth/password` gave Petar Petrović a password without writing a hash into the database, so
that endpoint is now proven too, not assumed.

The whole chain then ran through the product: Petar logs in → `/api/workers` lists Zoran → issues a
code → `POST /auth/activate` with username + code returns a real device token → that token serves
`GET /api/entries` (200). Replaying the same code returns **401** and the row reads `consumed`;
single-use holds in practice, not just in `ActivationRaceTests`. `email_delivery` came back
`not_configured`, exactly as decision 6 intends while there is no relay.

**Finding 1 — every activation silently kills the demo.** Activating a new phone revokes the
worker's previous devices, which is correct per decision 14 — but the demo device is one of them, so
the token baked into the PWA bundle starts returning 401 with nothing on screen saying why. It
happened twice in one session, once to the founder mid-test. `seed` is the cure (it clears
`revoked_at`), and that is *why* `seed` clears it. **Testing `/activate` on the dev box always costs
a `seed` afterwards.**

**Finding 2 — a successful activation leaves you on the activation screen.** `submit()` sets
`outcome.set('activated')` and stops; there is no navigation Home. The founder read that as failure
and pressed "Pridruži se" again, burning a second single-use code and getting a (correct) 401 that
*looked* like the first attempt had failed. Double-submit is properly guarded (`if (this.busy())
return;`), so this is not a race — it is a missing destination. On a phone, with gloves, this is
where a man wastes his boss's code. **Candidate for F4**, which already introduces `?next=` and
post-auth redirection.

**F4b + F4 built and reviewed; both accept-with-fixes**

**F4b** renamed all six paths and added three guards that give the route→consumer coupling the
compiler it never had. **F4** added the `canMatch` gate (`device.guard.ts`), `?next=` with
`safeReturnUrl`, and `SessionService.activated` — deliberately **not** `usable()`, which the
baked-in token makes true on every install, so a gate on it would be inert.

The reviews found four gating items. Two were fixed in code: **G2**, the `?entry=` query parameter —
row six of F4b's own rename table and the one identifier its guards could not see (proven: flipping a
producer back to `?unos=` left 570 specs green). It is now `ARCHIVE_ENTRY_PARAM`, one exported symbol
imported by three producers and one consumer, with a spec that fails on any hand-spelled query
parameter. **G1 (backend)**: `ActivationTimingTests` claimed a proof it did not have — the reviewer
ran the insert-before-claim mutation four times and it passed every time, the wrong-code branch
sitting 44–61% above its neighbours under a 1.8 bound. Replaced with a deterministic
statement-sequence assertion per branch (`ActivationStatementShapeTests`, `CommandTapInterceptor`).
**G2 (backend)**: the burn no-op seq-scanned while the real branch index-scanned, because its WHERE
did not imply the partial index's predicate — so the §10.3 oracle would have reopened with inverted
sign as the table grew, invisible to any test running against a freshly seeded database.

**The two founder decisions taken:** seed a fixed demo code (F4's gate otherwise strands a fresh
install at `/welcome` with no code obtainable — invariant 6), and **the flat `ActivateResponse` shape
is correct, plan §8 is what changes** — `LoginResponse` and `MeResponse` already put person fields
flat with `company` nested. **Both are now built — see below.**

**The lesson of the day, and it is an operational one: two reviewers left their mutations in the
working tree.** The backend reviewer typo'd both email-constraint names to prove the catches were
untested, believed it was working on a scratchpad copy, and left `"ux_app_user_emai"` in
`WorkerEndpoints.cs` — so a second worker on one address returned **500 instead of 409**, on an
ordinary sequential request with no concurrency. The frontend fix agent removed `pathMatch: 'full'`
to prove its new red-line assertion and was stopped before restoring it, leaving the infinite-redirect
trap live: the PWA suite stopped completing at all, hanging past 600 s where it had run in five
seconds. Both were caught only because the suites were re-run from scratch rather than trusted.
**Neither agent's report would have mentioned it — both were stopped before reporting.** Re-run both
suites after every review, and never assume a stopped agent left the tree as it found it.

**Built — the two founder decisions (backend)**

- **`DemoSeeder` now mints the demo worker a fixed live activation code, `DEM0-TEST`** (canonical
  `DEM0TEST`; a man who reads it as `DEMO-TEST` and types the letter O is let in by Crockford
  folding). It is re-minted by every `seed` exactly as the three withdrawal stamps are cleared —
  a consumed, superseded or *expired* code leaves the demo unjoinable while `seed` reports success,
  which is the same silent one-way door that revoking the demo phone used to be. It respects
  `ux_activation_code_live` (supersede first, plaintext nulled in the same statement) rather than
  hand-rolling an insert; the discipline is `ActivationCodes.IssueAsync`'s, duplicated because
  `Teren.Infrastructure` cannot reference `Teren.Api`. **Expiry is ten years, deliberately not the
  seven days a real code gets**: a real code is a credential emailed to one named man, this one is
  seeded data published in the repo, and a code that quietly died a week after the last seed is
  discovered by the distributor mid-pitch, in front of a customer. `seed` now prints the username
  and the code on every run.
  *The honest cost, worth revisiting at B3a:* it is a published credential to the demo company —
  anyone reading the repo can activate a phone as `zoran.jovanovic` there, which revokes the demo
  device until the next `seed`. Acceptable while that company holds nothing but sample rows and the
  only deployment is local.
- **Plan §8 amended to the flat `ActivateResponse`**, with the `LoginResponse` `user_id` row folded
  in — and, more to the point, **the field names are now pinned against the serialized JSON**
  (`ActivationTests.The_activate_response_carries_exactly_the_field_names_the_client_reads`,
  exhaustive on the property-name set). The mutation it exists for — `user_id` → `worker_id` — was
  run: red on the pin with a diff naming the field, green after revert. That rename is invisible to
  all 578 PWA specs (they test a mock) and was invisible to every backend test (they read the C#
  record), while real activation broke with a false error message and a burned code.
- Verified against the live stack, not only in tests: `seed` on the dev database, then a real
  `POST /auth/activate` on the founder's running :5080 with the code typed as `DEMO-TEST` → 200 and
  the flat body; replay → 401 (single use holds); the demo device 401s as expected because
  activation revokes it; one `seed` heals both — code live again, demo token back to 200.

**Suites: 796 backend and 578 PWA**, both builds clean, all verified by execution after the repairs
— then **806 backend** once the two decisions above landed (ten new tests), re-verified by execution.

**Built — D7/F9, the token flip, which was the point of the whole exercise**

`environment.deviceToken` is now `''` in **both** environment files. Until it was, a working
credential was compiled into the bundle and readable from devtools by anyone: `usable()` was always
true, the `canMatch` gate could not bite, and the login screens were decoration. A spec now pins the
constant empty, because every other spec would still pass if someone put it back. **Do not restore a
value to make a box "demo out of the box" — activate the box instead.**

Four PWA specs broke on the flip and only one of them was the flip's own doing; the other three were
pre-existing work-in-progress breakage the baked-in token had been hiding. The one that matters:
`MockAuthGateway.login()` omitted `user_id`, so `toAdminSession` narrowed to null and a **correct**
password came back as `unreadable`. A stand-in that cannot produce the shape the real server produces
turns a green suite into evidence of nothing.

**Built — company-admin specs (+230), and the three defects they found**

`/company` had been built and never specified. Writing `company.service.spec.ts` and
`company-page.spec.ts` against it turned up three real defects, all on the code-issuing path:

- `issueCode` could **throw** on the path where the code has already been minted — a `.catch()` only
  ever sees a rejected promise, so a gateway that throws before returning one escaped the method
  entirely and left the screen stuck on "issuing" over a code the worker's previous one is already
  dead against. Now a `try`, proven by a spec that throws outright rather than rejecting.
- An unanswered **issue** reported itself as a failed **read**. The two are not the same failure: a
  read that did not answer changed nothing, while an issue that did not answer may already have
  superseded the code the man is holding. "Try again" invites a second press that supersedes a live
  code, so the screen now says *reload before making another one*.
- Re-issue had no busy state, so the one control left on screen sat idle while the code behind it
  was being replaced.

**Built — F7, the founder's four layout notes from a screenshot of `/company` at 1920**

1. **The dead header button.** `app-company-link` rendered unconditionally, so on `/company` an
   admin had an icon that navigated to `/company` — indistinguishable from a dead control, and the
   exact defect `showProfile` had already been invented to prevent. The header gained `showCompany`,
   the mirror input, and both are now pinned by spec in both directions: switched off on the one
   screen that is the destination, and defaulted on everywhere else.
2. **The session moved into the chrome.** New `ui/session-link.ts` is one control with three states
   — sign out when there is an admin session, sign in when there is none, **nothing at all for a
   foreman**, who has no password by construction (`ck_app_user_worker_has_no_password`) and whose
   `/login` the device gate would bounce him straight back out of. The sign-out card at the foot of
   `/company`'s rail is gone; nothing duplicates it.
   *The constraint that shaped it:* the app header is `display: none` below 768 and decision 9 puts
   `/company` on every device, so a header-only sign-out would strand an admin on a phone with no way
   to end a password-backed session on the device most likely to be lost. It therefore renders twice
   — in the header, and in that screen's own compact bar — in two pieces of chrome that are never
   both visible. A spec pins both.
3. **`/company` at ≥1024.** The crew grid is two-up from 768 **upward** rather than expiring at 1023.
   A worker card is a name, a username and two chips; stretched across a 780 px desktop column it is
   a 72 px sliver with half a metre of white beside it, and eight of them scroll a laptop for no
   reason. The spec asserts the media block's *header*, not just its contents, so re-binding it to
   the tablet band goes red instead of quietly returning a desktop to single file.
4. **Home at ≥1024.** The grid placed its panes correctly and never claimed the window's *height*:
   the screen finished in the top third and the rest was warm canvas. The content block now grows to
   the foot of the viewport and the capture pane grows with it, so the record button is the largest
   object on a 1920 canvas rather than a phone button that happened to be centred. A floor for a
   1280×720 laptop, and deliberately **no ceiling** — a capped card leaves warm canvas under a white
   slab, which is the worst of both.

**Honest about what this increment is not**

- **It was never looked at.** The agent building it was to drive a headless browser at 390/768/834/
  1280/1920 and inspect the screenshots; it hit an API session rate limit partway through Home and
  died before doing so. No driver is installed in the repo, so the layouts are proven by spec and by
  reading, and **not one of the five widths has been seen**. That is the founder's first check.
- Its own new specs were stale against its own refactor when it stopped — two in `company-page.spec.ts`
  asserted a sign-out sentence it had just moved into the chrome and a media band it had just widened
  — and `session-link.ts` shipped with **no spec at all**. Both repaired here, +18 specs.
- One test-shaped lesson worth keeping: under zoneless OnPush a plain `fixture.detectChanges()` over
  a view nothing has invalidated refreshes **nothing**, so a control whose answer comes from the
  clock rather than from a signal cannot be tested by mutating a fake and re-detecting. The realistic
  trigger is the interaction itself — an expired admin pressing the stale sign-out — which both makes
  the view dirty and is the moment the app actually finds out.

**Suites: 851 PWA specs across 58 files, verified green by execution**, `ng build` clean, backend
untouched at 855. Two whole-source-scanning specs (`i18n.spec.ts`, `app.routes.spec.ts`) timed out at
5 s on one run under memory pressure and passed in isolation in 289 ms — the documented load flake,
not a regression; a clean run afterwards was 851/851.

**Built — the small increments before the super admin (founder: "start with the small ones")**

- **F4's last gating item closed.** The client's dual-shape read of `/auth/activate` is gone. The
  order was the whole point and is worth keeping: §8 amended to the flat shape **first**, then the
  serialized field names pinned exhaustively server-side, and only then the tolerance deleted.
  Dropping it before the pin existed would have restored the original failure — a renamed field
  reaching the founder as "joining failed, and your code is not used up", both halves false, and a
  second single-use code spent proving it. A new spec asserts the nested shape is now *refused*, so
  nobody can quietly re-add `?? response` and have every test stay green.
- **D8 — attribution.** `entry.created_by_user_id` and `confirmed_by_user_id`, both from the bearer
  and from nothing else; there is no field in either request that names a person and there must
  never be one. Confirming stamps the approver, a replay writes nothing, and a revision moves the
  stamp — the column records who approved *the version about to be sent*, not whoever approved a
  version that was superseded. Demo entries get attribution free, because the seeder only inserts.
  **No FK to `app_user`, deviating from plan §4 deliberately:** `TerenDbContext` migrates before
  `TerenIdentityDbContext` everywhere, so on a fresh database `app_user` does not exist when `entry`
  is altered. Nothing is lost today — no path in `src/` deletes a user — but the constraint has to
  arrive with D4, in the identity history, which runs second and can see both tables.
- **F8 — the revocation surface.** A stalled row whose failure is `unauthenticated` offers
  "Unesi novi kod" rather than "Pokušaj ponovo", and Home carries a notice above the confirmation
  gate. Derived from the queue past `STALLED_AFTER_ATTEMPTS`, never a stored flag: the server is the
  only thing that knows a device is revoked, and a local boolean goes stale in a basement. **Never a
  locked door** — the record button is untouched and a spec pins that, because a revoked phone is
  precisely a phone that should keep recording.
  *One deliberate narrowing:* "Pokušaj sve ponovo" no longer sweeps credential rows. Releasing a row
  resets the attempt count that **is** the notice, so the single press would fail instantly and
  erase the only thing telling him what to do, for another half hour. An existing spec asserted the
  old behaviour; it was rewritten with the reason rather than deleted.

**Built — C3's photo read path, which closes C3**

`CLAUDE.md` said flatly that there was no read path for media. **It was wrong by a day**: the server
half shipped in `52646ba` marked *WIP* in the commit message, and it is thorough — checksum-verified
bytes, `verified`-only, `private, immutable` with `Vary: Authorization`, 404/409/409/503 all
distinguished. Checking the tree instead of the note is what found it. The genuinely missing half
was the client, so the archive could only ever *count* the photographs it was not showing.

`ArchiveService.getMedia` now fetches the bytes with the bearer — an `<img src>` sends no
`Authorization` header, and a presigned GET was refused as a credential to a customer's site
photographs that nobody can take back. Local and fetched pictures merge into one strip, deliberately
indistinguishable: to the man holding the tablet they are all just photographs of his site. Only
`verified` media is requested, because anything else is a guaranteed 409 and "still arriving" is not
"failed". Sequential rather than parallel — twenty requests on a site connection is how a usable
page becomes a stalled one — and every failure the blob response flattens together becomes one
sentence and one retry.

**The owner-on-a-tablet case works. That is the buyer's reason to pay, and it had never worked.**

**A test-shaped lesson worth keeping:** the first version of the retry spec waited for the "not on
this phone" line to disappear. That line is *also* hidden while a fetch is in flight, so the wait
resolved during loading and the assertions ran against an empty strip. Wait for the thing you
actually mean — the thumbnails — not for a sentence that is absent for two different reasons.

**The environment, which cost more than the code**

The machine ran out of **disk** (C: at 0 bytes free) and briefly out of memory. It surfaced as three
different-looking faults: `ENOSPC` killing ten spec files mid-run, a node fatal error, and the Docker
engine hanging so completely that `docker version` returned nothing in five minutes — so the backend
suite could not run at all. `%LOCALAPPDATA%\Temp` held **10 GB**, of which 5.7 GB was two abandoned
Visual Studio Installer extraction directories. The founder cleared it; free space went 875 MB →
13.3 GB and the PWA suite went green immediately. *Docker was still not answering afterwards and
needs a restart.*

**Suites: 862 PWA specs across 58 files and 861 backend tests, both verified green by execution**
(the founder freed the disk, then restarted a Docker engine that stayed hung after it). `ng build`
clean. D8 added six of those backend tests. `dotnet test` had to build to a scratch `BaseOutputPath`
— Visual Studio and a running `Teren.Api` hold the output DLLs, which is MSB3027 and never a reason
to kill `dotnet.exe`.

**Founder actions**
- [ ] **Look at `/welcome`, `/login` and `/activate` at 1280.** No 1280 artboard exists for any of
      the three; F3's third gating finding is this, and only the founder can discharge it.
- [ ] **Decide §14.5**: a phone re-activated by a different worker still holds the previous holder's
      unsent Dexie entries, and `POST /api/entries` now derives attribution from the bearer — so an
      entry recorded by worker A can upload signed with worker B's name. Attribution is the thing
      this model exists to establish.
- [ ] Still owed: an SMTP relay, and the Serbian copy review on the three auth screens.

**Next**
1. F4b's verdict (its review was still running when the session closed), then **F4** — the `canMatch`
   gate and `?next=` deep links.
2. A way to mint the first company_admin password, or activation can never be proven end to end.
3. **Only then** empty `environment.deviceToken` (D7/F9).

---

## 2026-08-31 (later) — The photo read path: C3's missing half

**Talked about**
- The one thing keeping C3 at ◐: photos went up and were sealed, and nothing could ever hand them
  back. The owner on a tablet — the buyer — saw a diary made of text.

**Decided**
- **Authenticated streaming, not a presigned GET**, and the reasoning is now in ARCHITECTURE §8
  rather than in a commit message. A presigned URL is a credential that outlives the request: for
  its TTL it works for whoever holds it, outside the role gate, outside the tenant filter and
  outside device revocation. Fine for a one-key *write* permission the phone is about to use; not
  fine for *read* access to a client's site diary. B6 took the same decision for the report and
  deliberately shaped `IObjectStorage` and `VerifiedObjectReader` so this could reuse them — it did,
  which is why the increment is composition rather than invention.
- **The entry response carries no media URL.** With authenticated bytes there is no per-URL secret
  to convey, so the URL is a pure function of `entry_id` + `media_id`, which the client already has;
  `upload_status` is what tells it whether a fetch will 409. A `url` field would be a second
  spelling of the same fact.
- **Cacheable, and the qualifiers are the point:** `private, max-age=1y, immutable`, `Vary:
  Authorization`, `ETag` = the media checksum. Sealed evidence never changes, so `immutable` is
  honest; `private` keeps a company's photographs out of any shared cache; the checksum-as-ETag lets
  a revalidation be answered **304 from the row without touching object storage** — which on an
  archive scroll is twenty downloads that never happen.

**Built**
- `GET /api/entries/{id}/media/{mediaId}` in `EntryEndpoints.cs`, inside the `/entries` group so it
  inherits `RoleGates.Evidence` by construction. One query, two conditions
  (`m.Id == mediaGuid && m.EntryId == entryId`) under the tenant filter: a foreign photo, an unknown
  id and a real id paired with the wrong entry are one 404. Only `verified` media is served.
- `Storage:MediaReadBudget` (20 s). The read borrows the **bulk** storage client — a 10 MB photo
  would not survive the 5 s phone budget — and that client waits two minutes because it was built
  for a job nobody watches. This is the ceiling that stops a tablet inheriting it, the same shape as
  `Storage:VerificationBudget` on `/complete`.
- `VerifiedObjectReader` gained an optional size bound. A hash cannot be checked until the last byte
  is read, so without it how much gets spooled to the temp volume is decided by whatever sits at the
  key. The report passes null (unchanged); media passes its declared size.
- `MediaDownloadTests` — 30 tests, boundary-first, every cross-tenant case proven against a **real**
  company-B row with **real** bytes in storage.

**Verified**
- `dotnet build` clean; **855 backend tests green** (825 baseline + 30).
- **Ten mutations run, each one red, each reverted green**: `IgnoreQueryFilters` on the media lookup;
  dropping `m.EntryId ==`; adding `SuperAdmin` to `RoleGates.Evidence`; passing `null` for the
  expected checksum; dropping the size bound; widening the `verified`-only gate; disabling the
  `If-None-Match` pre-check; `public` instead of `private`; a hardcoded content type; `ct` instead
  of the budget token. The size-bound mutation **survived the first attempt** — the test was
  asserting at the reader, not at the call site — so `FakeObjectStorage` now counts bytes actually
  pulled off the stream, and the assertion is that the endpoint stopped where the record ran out.
- **Live against the real stack** (own API on :5099, founder's :5080 untouched): entry → declared
  photo → real presigned PUT to MinIO → `/complete` → `GET .../media/{id}` returned 66 842 bytes
  hashing to `665ae5ce…`, byte-identical to the file uploaded **and to what `mc cat` reads back out
  of MinIO**. 304 on `If-None-Match`; 206 with the PNG signature on `Range: bytes=0-7`; 401
  anonymous; 400 non-UUID; 404 for another company's photograph whose bytes really were in MinIO,
  with a body identical to a nonexistent id's; 409 `media_not_ready` for a declared-but-never-
  uploaded photo; 409 `media_unavailable` after substituting the stored bytes with `mc`. Every
  verification row and object was deleted afterwards; the dev database is back to the seeded three
  entries and zero media.
- **The demo device was already revoked at session start** (an earlier activation superseded it, so
  the baked-in PWA token 401'd). One `seed` healed it: `/api/entries` on :5080 is 200 again and
  `DEM0-TEST` is live and unconsumed.

**Next**
1. The client half of C3 — fetch-with-token, blob URLs, the photo grid in entry detail. Frontend.
2. M2's client-facing web view still has no answer: a client has no device credential, so it needs
   either a scoped share token or a signed short-lived link. Not decided here.

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

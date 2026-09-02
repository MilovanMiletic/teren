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
  the previous sign-in, this browser's own session and when it expires, and the language switcher.
  Three deliberate layouts; the two-pane grid at ≥1024.
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

**Next**

- The walkthrough document: the whole codebase and the end-to-end flow, written to be read by
  somebody who has not seen the code.
- Then D5 (`app_log` + the health page) and the super admin's log screen, and the dev server.

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

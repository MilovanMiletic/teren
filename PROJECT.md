# Teren — Project Document (high level)

Working name: **Teren** (digital site diary).

The top-level document. Vision, users, business, principles, constraints. This file is the
source of truth for *why* and *for whom*; when documents disagree, this one wins. Superseded
working material (original brief, first-pass analysis notes) lives in `archive/` — raw input
only, never authoritative. A proper technical analysis document will be written after/alongside
the roadmap.

Status: being built up through conversation. Sections marked `[draft]` are proposed, not confirmed.
Last updated: 2026-09-03.

---

## 1. Vision — confirmed

Small contractors in Serbia document their sites with a paper notebook filled in days later, and
WhatsApp photos with no context. When a dispute comes — delays, hidden work, variation orders —
they have nothing. This product turns what a foreman already does with his phone (take photos,
talk) into a dated, evidence-grade site record and a professional daily report, with ~30 seconds
of effort.

If it works, in 2–3 years: the default site-documentation tool for small Serbian installation
contractors, sold per site per month, expanding trade by trade.

## 2. Users and buyers — confirmed

- **User:** the foreman / worker on site. Muddy hands, one hand free, bad signal. The product
  lives or dies on whether *he* keeps using it unprompted.
- **Buyer:** the contractor-owner running ~3–20 active sites. He pays because the archive wins
  disputes and the daily report keeps his client off his phone.
- These are different people with different needs. Foreman needs speed; owner needs proof and
  presentability. Both must win or the product churns.

## 3. Market entry — confirmed

- **First vertical:** installation trades — plumbing/heating first (brief's pick, now backed by
  real access), then electricians and general builders.
- **Market:** Serbia. **Language:** Serbian (transcription and UI).
- **Channel:** personal network via father (doming.rs, cooperates with builders, plumbers,
  electricians, heating workers). He is: the shadowing contact for watching how the diary is kept
  today, the source of the first pilot users, and later the door to buyers.

## 4. Business — confirmed

- **This is meant to become a real business**, not a side experiment.
- SaaS, priced per site per month (~€30–80, per brief).
- Sell per vertical with vertical-specific messaging ("prove what you installed before the wall
  closes"), never as "for all contractors".
- **Roles:** founder plans and builds; father acts as distributor into his network of builders,
  plumbers, electricians and heating workers. The app itself is his sales tool — see principle 7.

## 5. Product principles — confirmed unless marked

These settle future arguments. Changing one is a big deal.

1. **Entry must be faster than the notebook.** Faster, not richer. ~30 seconds on site.
2. **Raw evidence is never altered.** Transcript and photos are kept as captured; the structured
   version is only an interpretation. Entries are immutable once reported; corrections are new
   entries.
3. **The phone is the source of truth until the server confirms.** Nothing is lost to bad signal;
   sync status is always visible.
4. **External services never block the phone.** Accept immediately, process in background.
5. **The human confirms before anything is sent.** The confirmation screen is mandatory — and its
   corrections are stored as the product's learning signal.
6. **AI is the mechanism, not the pitch.** The customer buys proof and saved time, not "AI".
7. **Always demo-ready.** The distributor must be able to pull out his phone and show the app at
   any given moment. Consequences: a permanently seeded demo project with realistic data, the
   core flow (speak → structured entry → PDF) never broken on the main branch, and demo polish
   prioritized over internal niceties.

## 6. Constraints — confirmed

- **One person.** Founder does decisions, reviews, sales, and field testing; AI (Claude) does the
  building. Time budget: evenings/weekends — but the intent is to move **as fast as those hours
  allow**. AI build throughput is high; founder review time is the bottleneck, so work is cut
  into evening-sized reviewable increments and momentum is kept continuous.
- **Stack is fixed:** Angular PWA + .NET Minimal API + EF Core + PostgreSQL + S3-compatible
  storage + Hangfire + QuestPDF. Chosen because the founder knows it — speed to first user
  outweighs everything.
- **AI-driven development workflow.** Consequences:
  - These documents are the project's memory; every decision lands here or is lost.
  - Work is cut into increments reviewable in one evening.
  - Founder-hours are spent only on what only the founder can do (decisions, real-device testing,
    real site audio, talking to contractors).

## 7. Scope boundaries `[draft]`

This product is **not**:
- an ERP, project-management, or scheduling tool
- a quoting/invoicing tool (reports support billing; we don't bill)
- a chat app replacing WhatsApp
- (initially) a legally certified građevinski dnevnik — it produces *evidence and reports*;
  formal legal-diary compliance is a possible later upsell, pending research

## 8. Success measures

- **Milestone 0 — demo-ready:** the distributor can demo the core flow (speak → structured entry
  → PDF report) on his phone with seeded demo data.
- **Phase 1:** one foreman uses it for three weeks without being reminded. Nothing else counts.
- **Phase 2 `[draft]`:** 3–5 paying pilot sites from the distributor's network; the archive gets
  used in at least one real dispute or client question.
- **Phase 3 `[draft]`:** repeatable sales motion in one vertical; churn low enough that the
  foreman-test keeps passing at small scale.

## 9. Known risks accepted at the vision level

- **No field observation before building.** The brief's "watch how the diary is kept today" step
  is skipped (roles decided: founder builds, father distributes). Mitigations: the father's own
  domain knowledge, and getting a first pilot foreman in as early as possible — the pilot replaces
  the shadow visit as the reality check.
- **Serbian transcription accuracy** remains the top product risk — resolve via a real-audio
  spike before building around any provider (spike sketch in `archive/initial-analysis-notes.md`).

## 10. Open questions

1. Legal status of electronic site records in Serbia (research task, 1 day).

## 11. Decided

- **The four decisions that were blocking B3a** (2026-09-03, founder):
  1. **SMTP relay: Resend.** Free tier covers the dev environment; ~€20/month when volume needs it.
     Revisit at C7 if deliverability disappoints — Postmark is the fallback with the stronger
     transactional reputation. **Never direct from the VPS**: Hetzner blocks outbound port 25 and a
     fresh IP has no sending reputation, and the report is the product's face. Resend must verify a
     sending domain, so **SPF, DKIM and DMARC on `teren.rs` are part of the same sitting**.
  2. **Domain: `teren.rs`, registered now.** `dev.teren.rs` is the dev environment — where everything
     is tested before the first client — and the apex is pointed at production only when the app is
     production-ready (C7). *This supersedes the 2026-08-29 note deferring registration to C7: a
     subdomain requires the domain, so the registration itself cannot wait.* Origin stability is why
     it is not a throwaway hostname: IndexedDB, the service-worker registration and the installed
     home-screen app are all scoped to the origin, so moving it later wipes local state and makes
     offline-queue testing meaningless.
  3. **Form of address: `vi`.** Consistent with every string already written, and the same copy faces
     owners and clients, not only foremen. Off the veto queue.
  4. **`DEM0-TEST` is a Development-only credential.** On any deployed environment `seed` mints a
     random activation code and prints it once. The original justification — "there is no admin screen
     until F6" — expired when F6 shipped: a code can now be issued from `/company` in seconds, so the
     distributor needs no memorable published one. A real credential to a demo company behind a public
     URL is not the same thing as one on a laptop.

- **The first production account is created through the database** (2026-09-03, founder): a
  `super_admin` for the founder himself, via `create-super-admin`, which reads its password from
  stdin and never from argv. Everything after that is the product's own onboarding — he creates the
  customer's company and its `company_admin` from `/platform`, and the invite reaches that admin by
  email. *Note the shape this implies and which the model already enforces: a super_admin has no
  company (`ck_app_user_company_scope`), so the founder's own account can create customers and read
  nothing of their diaries.*

- **A correction names the document it replaces** (2026-09-03, delegated to Claude and taken). The
  PDF said nothing about the report it superseded, so a correction arrived at the client looking like
  an unrelated day — weak evidence in exactly the dispute a correction exists for, given the client
  has already received the wrong one. The report now names the superseded record the way a human
  would: **its work date and its site, never a GUID** (ruling 1 above), in the project's language and
  its own time zone. Two variants, because the honest sentence differs: one for a superseded report
  that actually reached a relay, one for a document that was still waiting. The superseded report is
  never rewritten — reports are sealed, and the new document names its predecessor.

- **Teren staff keep the ability to mint a customer's administrator, and lose the ability to do it
  quietly** (2026-09-03, closing D4's rejection). The D4 review found that
  `POST /api/platform/users/{id}/invite` let staff take a company admin's account. Its three options
  in plan §13.6 were written before D6 and aimed at the wrong hole: D6 already removed the plaintext
  from every response body (the token is minted inside `AdminInviteJob` and mailed), and no platform
  route can change an admin's email. **The wider hole was `POST /api/platform/users`** — an email plus
  a `company_id` mints a *brand-new* company_admin inside any customer's company, which reads that
  company's diaries and, unlike a password reset, **locks nobody out and disturbs nothing the
  customer would notice.** The capability stays, because creating a customer's first admin is real
  work and so is the case where his only admin has left. What changes is that it cannot be silent:
  1. **Every other administrator of that company is emailed**, in the company's language, whenever an
     administrator is added to it or a credential is issued for one. The mail carries no token and no
     link; it says that something happened, who did it and when.
  2. **A structural guard** forbids any type reachable from `PlatformDirectory` from carrying a
     property that names a token, link, secret, password, code, credential, url or hash — so "the
     link is never in this body" is a fact the build checks rather than a comment.
  3. **The CLI `invite-admin` keeps printing a link to a terminal**, deliberately: shell access to
     that box already means the database, so it is not an additional exposure. It is the audited
     9 p.m. escape hatch, and its doc comment now says so.

  The sentence the product may defend, replacing decision 2's literal wording:

  > Teren staff cannot read a customer's diary with their own credentials. Minting or resetting an
  > administrator's credential in a customer's company is possible, is audited, and emails every
  > other administrator of that company — so it cannot be done without the customer being told.

- **A phone the server refuses signs itself out** (2026-09-03, founder). He removed a worker's phone
  from the office screen, went back to that phone, and found it working exactly as before — Home, the
  archive, the site list, the record button. **This reverses `plans/profile-and-identity.md` §10.3's
  "never a locked door"**, which was put to him again with its reasoning and declined. Three rulings:
  1. **A refused credential ends the session.** A 401 on any call this phone makes clears the stored
     session and puts the man on `/welcome` with one sentence and the code field. A **403 does not** —
     a role refusal is not a dead credential, and throwing the credential away would turn a wrong
     screen into a lost session. The screen names no cause: a revoked phone, a removed worker and a
     suspended company are deliberately one indistinguishable answer.
  2. **Nothing local is deleted, ever.** Principle 3 is untouched. The sign-out removes one
     `localStorage` row — the same guarantee the admin sign-out already carries — so the day's
     recordings, chunks and outbox rows stay on the phone and resume the moment he re-activates as the
     same worker. A recording in progress is not interrupted either: the credential goes at once, the
     screen change waits for the microphone.
  3. **The cost is accepted and named.** A mis-revoke, an accidental disable or a suspended company
     now leaves a foreman on a site unable to record until somebody sends him a code — precisely the
     case the old decision existed to prevent. The founder's reasoning: an owner who cannot see that
     "remove this phone" worked will not trust anything else the product says, and a mis-tap costs a
     code rather than evidence.

- **The report is a client's document, not a system record** (2026-08-29, founder). Five rulings,
  all pointing the same way — what an investor reads should carry evidence, not plumbing:
  1. **The record id comes off entirely.** A GUID means nothing to an investor. Accepted
     trade-off, stated plainly: in a dispute the PDF is matched to the archive by project + date
     rather than by identifier. That is unambiguous today because there is one report per entry
     per day, and it stops being unambiguous the moment that changes.
  2. **Location prints as a place name, not coordinates.** `44.81731, 20.49829` becomes
     "Vojvode Stepe 212". The site's name is what a reader can act on.
  3. **Timestamps print in the site's own local time**, via a new per-project `time_zone` column
     defaulting to `Europe/Belgrade` — the same shape as `report_language`, and correct if a
     contractor ever works across a border. UTC stays the storage format everywhere; this is a
     rendering concern only.
  4. **Teren is branded on the report as a letterspaced "TEREN" wordmark**, no image asset. Swaps
     for a real logo later through one config line without touching layout.
  5. **The PDF is downloadable from the app**, not only from the client's email — served by an
     **authenticated API endpoint that streams the bytes**, never a presigned GET link. A presigned
     URL works for anyone holding it, and this is a client's commercial data. This is also the
     first read path the system has ever had for object storage, and the groundwork for closing the
     photo gap that keeps C3 at ◐ (ARCHITECTURE §8).

- **The confirmation screen is a decision, not a form** (2026-08-29, founder). Triggered by the
  founder confirming a real entry and finding he had to *type the day himself* — the transcript was
  perfect, but extraction had never run (no Anthropic key), so the form was empty and B5 blocked an
  empty draft. He was doing the extraction by hand, which is the exact work the product exists to
  remove. Three rulings:
  1. **Read-only summary by default; one primary action.** The day is presented as a summary with a
     single "Sve je tačno — pošalji"; tapping a line turns it into a field. Reading is the default,
     editing the exception. A correct entry must be **one tap**.
  2. **The raw transcript is always visible**, with the audio beside it — his own words next to what
     the system understood, checkable without tapping. Capped at ~3 lines with an expander so the
     structure still starts above the fold on a 390 px phone; the audio control never truncates.
  3. **With a transcript but no structure, he can confirm the transcript as the record.** The
     report then carries his words verbatim as the day's description, clearly marked as his own
     words rather than extracted data. This makes the product's floor "a timestamped, geotagged,
     voice-backed record in his own words" instead of "type it yourself" — a foreman can always
     finish his day in one tap even with every AI in the chain down.
     - The eval triple stays honest: `extracted` is null and `corrected` records approval-as-is,
       which is distinguishable from typing, so the training signal is not polluted.
     - It must **never look like the good path**: the screen says plainly that the system could not
       structure the day and that his own words are what goes out. Otherwise nothing creates
       pressure to notice that extraction is broken.

- **Name: Teren** (2026-08-28). Rationale: it's a Serbian product for the Serbian market — the
  name is instantly natural to both foreman and owner ("šta ima na terenu?"), one word, works
  across ex-YU markets. Runner-ups if the name ever needs to change: MojRaport (mojraport.rs),
  Gradilog (gradilog.rs — note .com is an unrelated football app).
  - **Domain registration deferred** (2026-08-29) — **SUPERSEDED 2026-09-03 by §11 decision 2**,
    which registers `teren.rs` now and stands `dev.teren.rs` up first. The original reasoning was
    that the domain waits for C7; what changed it is that two clauses of M0's own definition (*on a
    real phone*, *without touching a terminal*) cannot be met without https, and `crypto.subtle`
    refuses an insecure context, so the accepted risk had become the thing blocking the milestone.
- **Hosting:** Hetzner VPS + Postgres + S3-compatible object storage. Boring on purpose;
  revisit only when scale forces it.
- **STT provider: Azure AI Speech** (2026-08-29), `sr-RS`, fast-transcription REST endpoint.
  Chosen for first-class `sr-RS` support. Two things to be honest about: the decision rests on a
  single 18-second test clip because **A2 (real site audio) was deferred**, and the phrase-list
  hinting that originally made Azure the favourite over Whisper turned out to be **inert for
  Serbian**. No non-Azure provider was ever benchmarked. Accepted deliberately: the mandatory
  confirmation screen (principle 5) is the safety net, with typed correction for whatever
  transcription misses. Full write-up and the re-open conditions in `docs/stt-evaluation.md`.
- **Transcripts are stored in Latin** (2026-08-29). Azure returns Cyrillic; the pipeline
  transliterates once at ingestion. Serbian Cyrillic to Latin is lossless and deterministic in that
  direction, and the **audio stays the untouched raw evidence** — the transcript can always be
  regenerated — so principle 2 holds.
- **Email delivery: SMTP** (2026-08-29), via MailKit behind `IReportDelivery`. A protocol rather
  than a vendor SDK, so the relay stays swappable. Still to decide by B6: which relay. **Not**
  direct from the VPS — outbound port 25 is blocked by default and fresh VPS IPs get filtered,
  which would put the report that *is* the product in the client spam folder.

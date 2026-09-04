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
  disputes and the daily report keeps his client off his phone. **Amended 2026-09-04: the report
  reaches the client only when the owner forwards it — Teren sends nothing outside the contractor's
  company (§11).**
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
   entries. **Amended 2026-09-04 (§11 B): a photograph may be *destroyed* — never altered, never
   edited — by the company that owns it, through the owner's review path, and never by Teren staff.
   Report PDFs containing it are regenerated, which breaks the seal on those documents by design.
   The act is audited; what the photograph showed is not.**
3. **The phone is the source of truth until the server confirms.** Nothing is lost to bad signal;
   sync status is always visible.
4. **External services never block the phone.** Accept immediately, process in background.
5. **The human confirms before anything is sent.** The confirmation screen is mandatory — and its
   corrections are stored as the product's learning signal.
6. **AI is the mechanism, not the pitch.** The customer buys proof and saved time, not "AI".
7. **Always demo-ready.** The distributor must be able to pull out his phone and show the app at
   any given moment. **Amended 2026-09-04 (§11 ruling 3): the demo is a real company created through
   the product, not a seeded fixture, and nothing is seeded onto a deployed host but the founder's own
   `super_admin`.** The seeded demo project survives in **Development only**. Consequences: the
   core flow (speak → written daily record → PDF) never broken on the main branch, and demo polish
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
- **a client portal — and as of 2026-09-04 no client channel at all.** Teren emails the **owner**;
  he forwards what he chooses. Teren never contacts a customer's client (§11, top entry). *This line
  used to say the client's only channel is the emailed daily report; that was true for one day.*
  There is no login, no link and no web view for anyone outside the contractor's company
- **a self-serve product.** Every customer is provisioned by the founder or the distributor; there
  is no signup form and no trial
- **a billing system.** Invoicing is manual and stays manual — the reports support the
  contractor's billing, and ours is a faktura and a bank transfer
- **a native app.** The PWA is the product; a native shell is not a deferred plan, it is not planned
- **not the legally certified građevinski dnevnik.** It produces *evidence and reports*. The
  research that was going to decide whether to chase formal compliance is **dropped** (§11,
  2026-09-04) and the positioning is settled: *evidence, not the legal diary*

## 8. Success measures

- **Milestone 0 — demo-ready:** the distributor can demo the core flow (speak → written daily
  record → PDF report) on his phone with seeded demo data. *"Structured entry" was the wording until
  2026-09-04; the record is now prose plus a problems line (§11).*
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

None. The last one — the legal status of electronic site records in Serbia — was **closed by
decision rather than by research** on 2026-09-04: the research is dropped and the product is
positioned as *evidence, not the legal diary* (§7, §11).

## 11. Decided

- **WHO "CLIENT" MEANS — a vocabulary correction, 2026-09-04, and it had been wrong in these
  documents for a day.** The founder: *"When I was saying client I was thinking of Teren's client,
  the company owner."* Claude had been reading it as the contractor's client — the investor or
  building owner — and wrote a good deal of §7, §11 and ROADMAP in that misreading. **The words, from
  here on:**
  - **customer / owner / company admin** — *Teren's* client. The contractor who pays us. When the
    founder says "client", this is who he means.
  - **the contractor's client** — the investor or building owner. **Outside the product entirely**
    (his ruling): Teren models no such party, holds no account for him, and never contacts him. What
    the contractor does with his report afterwards is his business.
  - **Never write "client" unqualified again.** Say *the owner* or *the contractor's client*.

  ***What this corrects, and what it does not.*** The decision recorded an hour earlier — the report
  goes to the owner, Teren mails nobody else — **stands and is right**. But it was written up as
  *"reversing a ruling taken the same day"*, and that is wrong: this morning's ruling was recorded
  under Claude's misreading, so there was no reversal, only a misunderstanding surfacing. *Two
  separate rounds of questions were answered inside a wrong frame before it did; the founder
  answered as asked, and the frame was mine.*

- **The report is a document the owner can forward unedited (2026-09-04, founder).** Written to be
  read by someone outside the company — professional, no internal shorthand, complete on its own —
  **even though Teren only ever mails it to the owner**. He forwards it as-is, or keeps it, or edits
  its photographs (§11 C15) and forwards that. *This is binding on C11: the prose the model writes is
  for a stranger's eyes, not a note to the boss.* It also keeps the project-language rule intact —
  the document is written in the project's language precisely because it may travel further than us.

- **`project.recipients` stays an array** (2026-09-04): *"We will decide that. For now leave it like
  this — an array."* It now means people **inside the contractor's company** — owner, office manager,
  a second director — not outsiders. Whether it needs to hold more than one is an open question,
  deliberately deferred; the shape costs nothing and multi-recipient delivery already works.

- **The report goes to the OWNER, not to the client (2026-09-04, founder) — and this reverses a
  ruling taken earlier the same day.** *"The report that is sent is sent actually to the company
  admin. He then send wherever he wants later than that."*
  - **Nothing leaves the contractor's company automatically.** Teren emails the owner; `project.
    recipients` becomes **his** address, not the client's. **Teren never contacts a customer's client
    at all.**
  - **The promise is rewritten around the owner** (his answer, explicitly): the product turns thirty
    seconds of speech into a professional daily record **for the contractor**, who decides what his
    client sees. *That is a different sale from the one written in §1: not "your client stops phoning
    you", but "you hold a record, and you control what leaves your office."*
  - **What this reverses.** Earlier today ruling 1 of the scope cut said the outward channel stays
    exactly what B6 built — one PDF a day, by email, to the client. It does not. §7's line that "the
    client's only channel is the emailed daily report" is now wrong in the other direction: **the
    client has no automatic channel from Teren whatsoever.**
  - **What it costs, stated plainly:** "the client stops phoning" now depends on the owner remembering
    to forward, every day. The one thing the contractor was buying is now a manual step he takes.
  - **What it buys, and it is not small:** it makes the photograph problem nearly disappear. A photo
    the owner does not want never reaches the client, because he reviews before forwarding. It also
    makes destroying an old report defensible — Teren never sent anything to the client, so Teren was
    never the custodian of what the client holds.
  - **Unchanged: the report is still written in the project's language, not the foreman's.** The owner
    forwards it to *his* client, so the document must still be in the client's language.

- **The owner may edit a report and replace it (2026-09-04, founder), extending §11 B.**
  - **Photographs only.** He picks which photos appear. The words, the work date, the site, the
    weather and the GPS regenerate exactly as before — **the foreman's account of the day stays the
    foreman's account**, and the owner never becomes the author of his own diary.
  - **The old report is deleted completely, row and all** — his call, made against my argument. With
    delivery now stopping at the owner this is far more defensible than it was an hour ago: the
    question "what did the client receive?" is the *owner's* record to keep, not Teren's, because
    Teren never sent it to the client.
  - ***Design constraint that must not be got wrong:*** deleting the report row must **not unseal the
    entry**. The evidence — transcript, audio, the remaining photographs — stays immutable; only the
    generated document is replaced. A regeneration path that quietly re-opened a sealed day would
    undo invariant 2 through the back door.

- **Two additions, 2026-09-04 (founder) — and the second one amends invariant 2.**

  **A. The owner gets a projects page, and a project has a status.** `/company/projects`: every site
  his company has, the ability to add one, and a status — **`in_progress` / `done` / `cancelled`**.
  - **"Remove" means a status change. Nothing is ever deleted.** A finished job is precisely the one
    a dispute arrives about, often months later, so its diary, photos and reports stay untouched and
    **fully readable** — by the owner and by staff — for ever.
  - A `done` or `cancelled` site **disappears from the foreman's picker** *and* **the server refuses
    new entries for it**. Both, deliberately: the picker is the normal path and the server refusal is
    the backstop for an offline phone holding a stale project list.
  - ***Design constraint that falls out of that pair, and it is not optional:*** the refusal must key
    on **when the day was recorded, not when it arrived**. A foreman who captured a legitimate day and
    then lost signal for a week must not have it refused because the office closed the site meanwhile
    — that is the outbox stranding real evidence, the exact failure invariant 3 exists to prevent. The
    server refuses an entry whose **work date falls after** the site was closed, never one that merely
    *arrives* after.

  **B. The owner can destroy a photograph, and this is an explicit exception to invariant 2.**
  Founder: *"there is one extreme situation where some photos shouldn't be shown in the reports."*
  - **An exception path, not a gate.** Reports keep going out the moment the foreman confirms; the
    daily email does not wait for anyone. The owner reaches back into a past day and removes a photo.
  - **The bytes are destroyed and no tombstone is left on the record** — the founder chose this over
    a visible gap, with the argument against it in front of him. *Written down as his call:* a diary
    that can silently lose a photograph is worth less as evidence than one that cannot, and after this
    nobody can prove what was removed. **Invariant 2 now reads: raw evidence is never *altered*, and
    may only be *destroyed* by the company that owns it, through this path.**
  - **Report PDFs containing that photo are regenerated without it**, which **breaks the seal on
    purpose**: reports were immutable once sent. The copy already in the client's inbox cannot be
    recalled — nothing can do that — so from that moment the client's document and the server's differ.
  - ***My open proposal, needing the founder's nod (not yet agreed):*** the regenerated report should
    **say on its face that a photograph was removed, and when**, and the `report` row should keep both
    hashes. Not to expose what the photo showed, but because *"the client holds a document we can no
    longer reproduce, and nothing anywhere says why"* is the failure D9 was written to prevent. The
    band exists; this is a third variant of it.
  - **The act is audited, the content is not.** Who removed a photo, from which entry, when — no
    filename, no description, nothing about what it showed. That row is what protects the founder if
    an owner later claims Teren lost his evidence.

- **Four rulings that close the review round (2026-09-04, founder).**
  1. **Disabling an administrator is notified too.** Staff could disable every administrator of a
     company and *then* mint a new one — the access notice reaches only *enabled* admins, so it went
     nowhere and left an audit row nobody reads. Now the administrator **being disabled** is emailed,
     as well as the company's others. Disabling already locks a real person out of his own screens,
     so the mail costs nothing and it closes the loop the narrowed wording had only described. **The
     claim is whole again**: minting or resetting an administrator's credential is possible, audited,
     and *told to the customer* — with no "unless they were all disabled first" attached.
  2. **A day that a reported correction replaces is never reported again.** A `confirmed` entry
     stayed reportable for ever, so: original confirmed → relay rejects → a correction goes out
     naming it → the foreman re-confirms the original → **the client ends up holding both**, and the
     correction says the original was never sent to him. D9 removed the false sentence; this stops
     the second document. `EntryReporter` parks such an entry instead of delivering.
     *Named risk, deliberately accepted for now: a parked entry the phone cannot explain is exactly
     the dead end `superseded_after_send` was — so **the phone-side sentence is a tracked follow-up,
     not an afterthought.***
  3. **No demo seed on any deployed environment — the only seeded account is the founder's
     `super_admin`.** *"That demo seed should be removed before we deploy anything. Only first seeded
     super admin and that is me."* `DemoSeeder` and `reset-demo` become Development-only, like
     `DEM0-TEST` before them, and **no company, no site, no worker and no activation code is ever
     seeded onto a public host.**
     **This changes invariant 6 and M0's definition of done, and the replacement is better.** The
     distributor demos **a real company created through the product** — `/platform`, an admin, sites,
     a foreman, and a few real Serbian entries recorded into it. Nothing exists on a demo-only path;
     the demo *is* the product. It also dogfoods the exact provisioning a customer gets (M2 E3).
     The cost, accepted: it is an evening of the founder's time and it is **not re-creatable with one
     command** — so it must be backed up like real data, because that is what it is.
  4. **Otkaži asks before deleting — but only after a failed save.** While recording, a man pressing
     Otkaži means it; he started a moment ago, and a confirmation tax on the busiest path works
     against invariant 1. After a **failed save** he may be tapping to dismiss what looks like an
     error, and what he loses is a finished take already on disk. Different moments, different risk.
     *(The back gesture and a destroyed component still never discard.)*

- **The report becomes a day's account, not a form (2026-09-04, founder — the largest product
  change since the vision was written).** Asked whether the trade should decide the report's field
  labels, the founder asked the better question back: *"Would it be okay to have everything inside
  one text box that gets all that was prompted? We just use AI so he can correct and reorder the
  audio words?"* Yes, and it is a **deletion**, not a build:
  1. **The report body is AI-tidied prose, plus a highlighted problems line when the day had one.**
     The model's whole job becomes *correct the words, order them sensibly, surface a problem if one
     was spoken*. **No work items, no quantities, no materials, no headcount — no structured fields
     at all**, and therefore no per-trade labels and no per-trade layouts to argue about.
  2. **Nothing is extracted silently behind the prose.** Two reasons, and the second is the one that
     settles it: *the transcript is kept forever as raw evidence, so numbers can always be extracted
     later* — from the stored transcripts, with fresh eyes on what a customer actually wants counted;
     and **fields nobody sees are numbers no human has confirmed**, which is worse than no numbers,
     because someone eventually trusts them. Invariant 5 exists precisely because a person approves
     what the report says.
  3. **The confirmation screen becomes one editable paragraph** (plus the problem line). He reads
     exactly what the client will read, fixes a misheard word, sends. Faster than per-field editing —
     which serves invariant 1 — and the eval signal *improves*: the words he corrects are the words
     the vocabulary needs, rather than a field mapping.
  4. **Where the risk went.** Every accuracy failure in this product lived in extraction — the wrong
     field, the dropped quantity, the invented number. Tidying a transcript is a task the model is
     near-perfect at. The remaining exposure is unchanged and already known: **the STT mishearing a
     trade word**, which is what the vocabulary (M2 E1) is for and what the confirmation screen
     catches.
  5. **What is honestly lost.** `hidden_work` stops being a structured concept, and ARCHITECTURE §6
     calls it *"the highest-value evidence in the product — the thing that cannot be proven after the
     wall closes"*. In prose it survives as words plus the photographs, which is what a court or a
     client reads anyway; but it is no longer a field anything can key on. Recorded as accepted, not
     overlooked.
  6. **`schema_version` earns its keep on day one.** The v1 shape is not migrated: the seeded demo
     entries and the founder's real ones stay v1 and the renderer keeps rendering them. The new shape
     is v2. *This is exactly what that column was put there for, arriving sooner than expected.*
  7. **Provenance stays a claim the document makes about itself.** `described_verbatim` does not go
     away — it remains the *degraded* case (extraction unavailable, the foreman's raw transcript
     confirmed as the record). The ordinary case is now AI-tidied prose, and **the report must not
     let a reader confuse the two**: one is his words untouched, the other is his words rewritten by
     a machine and approved by him. §6's care about that distinction applies unchanged.

- **Four smaller rulings from the same session (2026-09-04, founder):**
  1. **Recipient editing and re-sending a past report.** `project.recipients` is already
     `[{name, email, role}]` and multi-recipient delivery already works — but **nothing in the
     product can edit it**, because there is no project write route at all. C10's site form gains it,
     and C9 gains "send this report again to its recipients", which is what the cut client portal was
     really for: the client's need is *get me that day*, not *let me browse*.
  2. **iPhone recording is supported.** So the native-shell cut is **conditional, not settled**: the
     iOS debt stays in M1 (HEIC, what an iPhone actually records — ARCHITECTURE §14 decision 4 — and
     the offline queue surviving Safari), and iOS is the one place where the PWA bet could still force
     a native shell. Recorded as the live risk it is.
  3. **No billing record in the app at all** — not even a paid-until date. Money lives in a
     spreadsheet; suspension is the `/platform` button that already exists.
  4. **The founder provisions every customer, and adds the distributor himself.** The seeded first
     `super_admin` creates the others — so his father gets an account if and when the founder makes
     one, from inside the product, with no code and no new role.

- **The M2/M3 scope cut (2026-09-04, founder).** The founder walked every remaining milestone item
  and cut most of them. Nine rulings, authoritative over anything the earlier roadmap said:
  1. **There is no client-facing web view, and the thing that replaces it points inward.** The
     outward channel stays exactly what B6 built — **one PDF a day, by email, in the project's
     language**, unchanged. What was planned as "the client-facing diary" becomes an **internal**
     surface: **the company admin reads every entry from every worker on every site of his
     company, in full evidence** — structure, transcript, photos, audio, GPS, weather and the
     report PDF, not a list of attachments. *The gap this closes is not the client's; it is the
     owner's. The man who pays could not see his own company's diary at all.*
  2. **That view is M1, not M2.** The pilot has a foreman *and* an owner, and an owner who cannot
     read what his man recorded gets nothing out of three weeks.
  3. **Workers are assigned to sites, and the assignment is a restriction, not a label.** The
     project picker shows a foreman only his own sites, and the server refuses an entry for any
     other one. "Which worker works on which site" is then answered by construction rather than by
     a report, and a day filed against the wrong site stops being possible.
  4. **The company admin creates and edits his own sites, and assigns workers to them.** This
     closes a gap nobody had named: **there is no create-project route in the API at all** — sites
     exist only because `DemoSeeder` writes three fixed rows, so a customer provisioned today could
     not add the job he wins next week.
  5. **Staff visibility stays metadata-only; decision 2 stands unchanged.** The founder's first
     phrasing was "the super admin has view-only access to everything the company has"; shown that
     this reverses decision 2, deletes eleven privacy tests and changes the sentence the product can
     say to a customer, he chose the existing barrier. `/platform` keeps counts, dates, names,
     failures and health, and **no diary content**.
  6. **No in-app billing.** Manual invoicing — a faktura, a bank transfer, and suspension by hand
     when someone stops paying. No payment processor, no webhooks, and the processor question is
     closed rather than open.
  7. **No self-serve signup and no trial.** Every customer is provisioned by the founder or the
     distributor: `create-super-admin`, then the company and its `company_admin` from `/platform`,
     then the invite email.
  8. **One report layout for every trade; the trade lives in the vocabulary, not in the layout.**
     The product covers **all trades from the start** — a per-trade canonical word list feeds the
     Claude extraction call (ARCHITECTURE §9.2) so that *faza* and *tačke* are understood the way
     *PPR cev 25* is, while a single layout serves plumbing, electrical and general building alike.
     **The quality loop folds into this and stops being an increment**: the correction triples
     already being stored are the source of those word lists, reviewed periodically by the founder.
     No eval harness, no prompt-versioning machinery, and **no "second vertical" milestone** — a new
     trade is a word list.
  9. **Dropped outright:** the legal-diary research (the positioning is settled instead — see §7),
     and the native shell. **Kept:** Serbian onboarding material for the distributor. **M3 is
     deleted**; two milestones remain, M1 pilot-ready and M2 sellable.

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
  > **other administrator of that company who is not disabled**.

  **The last clause was narrowed on 2026-09-04, by the D9 review.** It used to end *"— so it cannot
  be done without the customer being told"*, and that was **wider than the mechanism**: recipients are
  the company's *enabled* administrators (`AdminAccessNoticeJob`, `DisabledAt == null`), so staff who
  first **disable** every administrator of a company and then mint a new one send the notice to an
  empty list, leaving only an audit row. It is a noisy attack — disabling locks real people out of
  their own screens, which is exactly what they complain about — and it is consistent with the
  decision's own reasoning that the capability stays and the *silence* goes. But the sentence claimed
  more than the code delivers, so the sentence moved rather than the claim.
  ***Open, and the founder's call:*** either notify on the disabling of a `company_admin` too — which
  closes it properly — or leave the narrowed wording as the honest limit. *Second time in two days
  that a privacy sentence has been found wider than its mechanism; the pattern is that the defensible
  claim is always the one derived from the code, never the one written first.*

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

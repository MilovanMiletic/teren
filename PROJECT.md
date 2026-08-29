# Teren — Project Document (high level)

Working name: **Teren** (digital site diary).

The top-level document. Vision, users, business, principles, constraints. This file is the
source of truth for *why* and *for whom*; when documents disagree, this one wins. Superseded
working material (original brief, first-pass analysis notes) lives in `archive/` — raw input
only, never authoritative. A proper technical analysis document will be written after/alongside
the roadmap.

Status: being built up through conversation. Sections marked `[draft]` are proposed, not confirmed.
Last updated: 2026-08-28.

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

- **Name: Teren** (2026-08-28). Rationale: it's a Serbian product for the Serbian market — the
  name is instantly natural to both foreman and owner ("šta ima na terenu?"), one word, works
  across ex-YU markets. Runner-ups if the name ever needs to change: MojRaport (mojraport.rs),
  Gradilog (gradilog.rs — note .com is an unrelated football app).
  - **Domain registration deferred** (2026-08-29): `teren.rs` gets registered when the code is
    ready to deploy to production (roadmap C7), not before. Accepted risk: the name is not
    reserved in the meantime. Staging until then runs on a tunnel or VPS hostname.
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

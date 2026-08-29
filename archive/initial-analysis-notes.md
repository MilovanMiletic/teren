# Digital Site Diary — Pre-Planning Analysis

Companion to [site-diary-app-brief.md](site-diary-app-brief.md). This is the analysis pass before planning:
what the brief settles, what it leaves open, where the real risks sit, and what the first work items are.
One-person project, Angular + .NET, AI-native product (the AI pipeline *is* the product, not a feature).

---

## 1. What the brief already settles (don't reopen)

- **Stack:** Angular PWA + Dexie / .NET Minimal API + EF Core + PostgreSQL / S3-compatible storage /
  Hangfire / QuestPDF. Chosen for speed-to-first-user; correct call for a solo builder.
- **Core invariants:** entries immutable after report send; raw transcript always kept; entry structure
  in JSONB; photos carry timestamp + GPS + content hash; external calls never block the phone.
- **Phase 1 success criterion:** one foreman, three weeks, unreminded. Everything below is judged
  against that single test.
- **Positioning:** per-vertical messaging, mechanical/plumbing first, €30–80 per site per month.

## 2. Tensions in the brief (resolve before planning)

### 2.1 The offline contradiction — biggest one
Section 10 calls offline sync the biggest technical risk ("solve it early"), but Section 9 puts the
offline queue in Phase 2. Phase 1 gets used on a site with bad signal; if the first failed upload loses
an entry, the three-week test fails in week one.

**Resolution:** split "offline" into two tiers.
- *Phase 1 — never lose data:* Dexie store, client-generated UUID (idempotency key), entry status
  `draft → queued → sent`, retry with backoff, visible "N pending" indicator. This is ~2–3 days of work,
  not the scary part.
- *Phase 2 — full sync:* resumable uploads, Wi-Fi-only toggle, multi-day local retention policy,
  storage-eviction defenses.

### 2.2 "No accounts" vs. "PDF emailed to client"
Phase 1 needs a seeded company + one project + a recipient list, configured server-side (appsettings or
a seed script). No login screen; the PWA install *is* the identity. Decide this explicitly so it doesn't
harden into accidental architecture — the data model already has Company/Project, so seeding is cheap.

### 2.3 Language is undefined
Assumed target: **Serbian** (foreman voice notes with trade jargon, background noise). This is the
single biggest unknown in the whole project — every downstream feature assumes the transcript is usable.
No app code should be written around a provider until the spike (§5.1) says which one survives real
site audio.

### 2.4 Legal diary format
For Serbia: građevinski dnevnik format and whether an electronic form is accepted or must be printed
and signed. One day of research; it quietly shapes the PDF template, so do it before QuestPDF work
starts. **Note:** Phase 1 does not need to *be* the legal diary — it needs to produce a document the
contractor can lean on in a dispute. Legal-diary compliance can be a Phase 3 upsell.

## 3. Architecture analysis

### 3.1 Money path (the walking skeleton)
```
Phone (PWA)                    API (.NET)                Background (Hangfire)
─────────────                  ──────────                ─────────────────────
1. record voice + photos
2. POST /entries {uuid, ...}   → insert Entry(processing)
                                  return 202 immediately
3. PUT audio → presigned URL     (S3 direct, not via API)
4. PUT photos → presigned URLs
5. POST /entries/{id}/complete → enqueue ProcessEntry ──→ transcribe (STT API)
                                                        → extract structure (LLM, JSON)
                                                        → fetch weather (location+date)
                                                        → status: awaiting_confirmation
6. GET /entries/{id} (poll)    ← status + structure
7. user confirms/corrects
8. POST /entries/{id}/confirm  → enqueue BuildReport ───→ QuestPDF → email → status: sent
```
Two rules fall out of this: the API never calls an external service inline, and the confirmation step
(7) is a hard gate — no report goes out unconfirmed.

### 3.2 Draft schema (first migration)
```sql
company        (id, name)
project        (id, company_id, name, location geog, recipients jsonb)
entry          (id uuid PK,            -- client-generated = idempotency key
                project_id, entry_date,
                status text,           -- draft|queued|processing|awaiting_confirmation|confirmed|sent
                raw_transcript text,   -- evidence; never edited
                structure jsonb,       -- work, headcount, materials, blockers
                corrections jsonb,     -- user's confirmation-screen edits (training signal)
                weather jsonb,
                supersedes_entry_id uuid null,  -- correction chain for immutable entries
                created_at, confirmed_at)
media          (id, entry_id, kind,    -- audio|photo
                object_key, content_hash, captured_at, gps point null,
                upload_status)
report         (id, project_id, period, pdf_object_key, recipients jsonb, sent_at)
```
Immutability: enforce in the API layer (reject mutation when a linked report has `sent_at`), plus a
DB trigger later. Corrections = new entry with `supersedes_entry_id`.

### 3.3 Solo-builder simplifications
- One deployable: Minimal API + Hangfire server in the same process. Split only when load demands it.
- Polling, not SignalR, for processing status in Phase 1 (the entry takes 20–60 s to process; a 3 s
  poll on one screen is fine). SignalR is a Phase 2 nicety.
- Hosting: one VPS (e.g. Hetzner) + managed/containerized Postgres + any S3-compatible bucket
  (Hetzner Object Storage / Backblaze / R2). Boring on purpose.

## 4. AI pipeline analysis (the product core)

### 4.1 Transcription — unknown, spike required
Candidates to test on **real site audio in Serbian** (noise, jargon, names):
OpenAI Whisper API (large-v3), Azure Speech (`sr-RS`, supports phrase-list hints), Google STT v2,
ElevenLabs Scribe, and a self-hosted whisper large-v3 as the cost floor. Test each with and without
vocabulary hints where supported. Cost is a non-issue (~$0.006/min ≈ half a cent per entry); accuracy
in Serbian under noise is the only criterion.

### 4.2 Structure extraction — known technique, low risk
Transcript (100–300 words) + project context (work item names, worker names, materials vocabulary) →
strict JSON: `{work_done[], headcount, materials[], blockers[], mentions_hidden_work}`. Claude API with
structured outputs (schema-validated JSON, no parsing failures). Model options at current pricing:

| Model | $/1M in/out | ~cost per entry | Note |
|---|---|---|---|
| Haiku 4.5 | 1 / 5 | ~$0.003 | probably enough for extraction |
| Sonnet 5 | 2 / 10 | ~$0.006 | better Serbian + jargon normalization |

**Finding: AI COGS are negligible** — a site posting 30 entries/month costs well under €1 in AI against
€30–80 revenue. So pick models for quality, never for cost, and don't build any cost-optimization
machinery. Start with Sonnet 5, downgrade later only if quality holds.

### 4.3 The correction loop is an asset — design for it now
The confirmation screen produces (transcript, extracted, corrected) triples. Store them from day one
(`corrections` column above). They are: the eval set for prompt changes, the vocabulary-mapping source
per project, and eventually per-trade template tuning. Zero extra UI work — just don't throw the data
away.

### 4.4 Canonical-name mapping
Post-transcription step: map recognized variants → canonical work item / worker / material names.
Phase 1: fold it into the extraction prompt (pass the canonical lists as context, instruct the model to
normalize). A separate mapping stage is only needed if evals show the single-prompt version failing.

## 5. Risk register (de-risk order)

| # | Risk | Severity | De-risk action | When |
|---|---|---|---|---|
| 1 | Serbian transcription accuracy on site audio | product-killing | Spike §5.1 with real recordings | **now, before any app code** |
| 2 | Data loss on flaky connections | trust-killing | Minimal queue in Phase 1 (§2.1) | Phase 1, week 1 |
| 3 | Entry slower than the notebook | adoption-killing | Ruthless flow: pick project → talk → done; confirmation can wait until evening | Phase 1 design |
| 4 | Legal diary format mismatch | sales friction | 1-day research; position as "evidence", not "the legal diary" | before PDF template |
| 5 | iOS PWA limits (no bg sync, storage eviction) | UX friction | "uploading — don't close" state; A2HS prompt; native shell only if users prove the need | Phase 2 |
| 6 | Extraction quality | low | structured outputs + correction-triple evals | ongoing |

### 5.1 Spike 1 — transcription accuracy test (no app code)
1. Record 3–5 real voice notes on an actual site (Opus/OGG, mono, 16 kHz — the production format).
2. Script (console app or bash) sends each to every candidate, with and without vocabulary hints.
3. Output: side-by-side transcripts + error notes on the words that matter (work items, quantities, names).
4. Decision: pick provider, or conclude Serbian STT isn't good enough yet — which would force a
   product pivot (photos + typed shorthand), better discovered now than in week six.

## 6. Decision register

**Decided by the brief:** stack, data model invariants, phasing test, pricing model, first vertical.

**Decided by this analysis (defaults; veto anytime):**
- Minimal offline queue moves into Phase 1 (§2.1)
- Phase 1 identity = seeded project, no accounts (§2.2)
- Polling over SignalR; single deployable; boring hosting (§3.3)
- Sonnet 5 for extraction with structured outputs; quality over cost (§4.2)
- Correction triples stored from day one (§4.3)

**Open — needs your input:**
1. Target language/jurisdiction confirmation (assumed Serbian/Serbia).
2. A real contractor to shadow (brief's step 1) — do you have the plumbing contact already?
3. Product name (Proofsite recommended in brief) — irrelevant to code until the PDF header and email
   sender name exist, so it can wait, but domain check is 10 minutes.
4. Hosting preference, if any (default: Hetzner VPS + object storage).

## 7. Immediate next steps

1. **Spike 1 (transcription)** — blocked only on you recording real site audio; the harness script can
   be built today with a placeholder recording.
2. **Repo scaffold** — Angular workspace + .NET solution + docker-compose (Postgres, MinIO) + first
   migration from §3.2. Unblocks everything, risks nothing.
3. **Walking skeleton** — the §3.1 sequence end to end with one hardcoded project, ugly UI, real PDF
   in a real inbox.
4. Then: plan Phase 1 properly against whatever Spike 1 revealed.

# Digital Site Diary — Project Brief

Working document for continuing development. Covers the problem, MVP scope, data model, tech stack, and open risks.

---

## 0. Name candidates

Not decided yet. Top five, with what each one promises:

| Name | Why it works | Watch out for |
|---|---|---|
| **Proofsite** | Says exactly what the product does. Buyer understands it without explanation. Strongest fit for the real pain: proving what was done. | Slightly literal, less room to expand later |
| **Sitely** | Sounds like a product, not a feature. Modern, easy to say, room to grow beyond daily logs | Doesn't explain itself — needs a tagline |
| **Plumb** | Double meaning: vertical/true, and plumbing work. Perfect if the first vertical is mechanical/plumbing contractors | Ties the brand to one trade |
| **Sitediary** | Closest to the official name of the document being replaced. Easy sell — no explaining needed | Generic, hard to own; domain likely taken |
| **Rebar** | Short, hard, unmistakably construction. Memorable brand voice | No connection to the actual function |

**Recommendation:** **Proofsite**. Clarity beats elegance when selling to people who won't spend time guessing what a name means.

Before locking anything in: check domain availability and say the name out loud inside a real sentence you'd use in a sales call. *"It's all in Proofsite"* works. Some names die right there.

---

## 1. The problem

Contractors — general builders, plumbers, electricians, HVAC — keep the legally required site diary in a paper notebook, usually filled in days later from memory. Everything else goes through WhatsApp with no context.

Consequences:
- No evidence when a dispute arises over delays or scope
- Hidden work (anything that goes behind a wall or under screed) can't be proven afterwards
- Variation orders get disputed because they were never documented
- The client keeps calling to ask what happened this week

## 2. The product in one sentence

Turns what a foreman already does with his phone — take photos and talk — into a document with evidentiary and billing value.

## 3. User flow

1. **Field entry (~30 seconds).** Foreman picks the project, takes photos, records a voice note.
   Example: *"West wing, second floor, ran the riser from the boiler to the bathroom, three men on it, 40 meters of pipe delivered, waiting on the electricians to finish chasing."*
2. **Processing (automatic).** Speech to text, text to structure (work done, headcount, materials, blockers). Weather and temperature pulled automatically by location and date.
3. **Confirmation.** Screen showing what the system understood; corrections in two taps. This step is mandatory, not optional.
4. **Output.** Daily PDF report emailed to client and site supervisor. Weekly recap on top.
5. **Archive.** Searchable by project, work item, and date. This is what people actually pay for.

## 4. Positioning and sales

- **Target:** contractors running 3–20 active sites. Smaller ones don't feel the pain; larger ones already have an ERP.
- **Pricing:** per site, per month. Roughly €30–80.
- **The core is identical across trades.** The difference is only which fields appear at entry and how the report template looks (general contractor → bill-of-quantities items; plumber → runs, risers, hidden work).
- **Do not market it as "for all contractors."** Message per vertical is what sells: *"Prove what you installed before the wall closes."*
- **First vertical:** whichever one you have personal access to. Cold pick — go with mechanical/plumbing: less prescribed diary format, sharper pain around disputed variations, and one person makes the buying decision.

## 5. Data model

```
Company
 └─ Project (site)
     ├─ Participants (client, supervisor, foreman)
     ├─ Work items / runs
     ├─ Entry (daily record)
     │   ├─ Photos (timestamp, GPS, content hash)
     │   ├─ Audio + raw transcript
     │   ├─ Structure: work, headcount, materials, blockers  → JSONB
     │   └─ Weather/temperature (auto)
     └─ Report (daily/weekly PDF, recipients, sent-at)
```

**Rules that don't get broken:**
- An `Entry` becomes immutable once its report is sent. Corrections are new entries referencing the original.
- The raw transcript is always kept — it's the evidence; the structured version is only an interpretation.
- Entry structure lives in a **JSONB** column, not a rigid schema. Fields will change with every new trade.
- Every photo stores timestamp, GPS, and a content hash.

## 6. Tech stack

Decision: **Angular + .NET**, because that's the stack with the fastest path to a working product. Speed to first real user outweighs everything else here.

**Frontend**
- Angular PWA (`@angular/pwa`) — service worker and manifest out of the box
- Dexie over IndexedDB for the local store and upload queue
- The built-in service worker handles caching only — **the upload queue logic is yours to write**

**Backend**
- .NET Minimal API + EF Core + PostgreSQL
- S3-compatible storage, uploads via presigned URLs (never through the API server)
- Hangfire for background jobs (entry processing, daily reports, email) — the dashboard alone is worth it
- QuestPDF for report generation
- SignalR or plain polling to push processing status back to the client

**External services**
- Transcription (Whisper or equivalent), called from a background job
- LLM for structure extraction, returning JSON
- Weather API for conditions by location and date

**Rule:** an external service call must never block the request coming from the phone. Accept the entry immediately, leave status as `processing`.

## 7. Transcription

- **Recording format:** Opus in OGG, mono, 16 kHz. One minute ≈ 100–150 KB.
- **Processing is server-side.** The phone only uploads the file.
- **Trade vocabulary:** pass project context with every request (work item names, worker names, common materials) as a recognition hint. After transcription, map recognized variants to canonical names.
- **The confirmation screen is mandatory.** Collect user corrections — that's your training signal later.
- Before committing to a provider: test accuracy on a real site recording with background noise, in the target language. Not in a quiet room.

## 8. Offline and sync

Principle: **the phone is the source of truth until data reaches the server.** Nothing is deleted locally before confirmation.

- Entry status: `draft → queued → sent`
- **UUID generated client-side** — doubles as the idempotency key, so retries never create duplicates
- **Upload order:** entry JSON first, then audio, then photos one by one. The report can go out while images are still climbing.
- **Resumable uploads** for every file — connections drop constantly on site
- **Client-side photo compression:** 1600 px on the long edge, JPEG ~80. Extract metadata **before** compressing.
- Exponential backoff on retry; only attempt when the OS reports connectivity
- "Photos over Wi-Fi only" toggle — people watch their data
- Sync status must be visible in the UI: entries pending, files remaining. The foreman needs to know his work didn't vanish.
- Delete local files only after server confirmation, and not before a few days have passed

**Web platform limits to plan around:**
- Background upload stops when the tab closes or the phone locks. iOS has no Background Sync. Mitigation: an explicit "uploading, don't close this" state and resumption on next open.
- Web camera capture produces a raw image with no EXIF — read GPS separately via the Geolocation API and attach it to the record.
- iOS evicts storage for sites unused for a long stretch. Adding to home screen reduces the risk.
- **Escape hatch:** wrap the same codebase in a native shell to get true background upload and native camera. Do this only when users prove it's needed.

## 9. Phases

**Phase 1 — prove someone uses it**
Photos + voice in, PDF out by email. No accounts, no dashboard, no work items.
Success criterion: one foreman uses it for three weeks without being reminded.

**Phase 2**
Offline queue, searchable archive, client-facing web view, user accounts.

**Phase 3**
Per-trade templates, multiple users per company, roles and permissions.

## 10. Risks

| Risk | Note |
|---|---|
| Field adoption | Entry must be **faster** than the notebook, not richer. Muddy hands, one hand free. |
| Legal diary format | Verify whether an electronic diary is accepted in the target jurisdiction, or whether it must be printed and signed. |
| Offline sync | Biggest technical risk. Solve it early, not at the end. |
| Transcription accuracy | Test on real site audio in the target language before building around it. |
| Incumbents | Serious competitors exist in Western markets. The opening is local fit and price. |

## 11. Next steps

1. Find one contractor with 2–3 active sites and watch how they keep the diary **today**
2. Run a transcription accuracy test on real site audio
3. Draft the table schema and the API call sequence for: photos + voice → PDF
4. Build Phase 1, with one real user as the only measure of success

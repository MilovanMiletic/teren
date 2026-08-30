# Session progress — Milestone 1

Live tracker, updated by the orchestrating session as agents report.
**Last updated: 2026-08-30 — money path closed, both review gates PASSED, suites verified by execution (447 backend / 407 PWA). B3a in flight.**

---

## Where we are

| Milestone 1 item | State |
| --- | --- |
| B4 Processing pipeline | ☑ done, reviewed, gating race closed |
| **B5 Confirmation screen** | ☑ **DONE** — reviewed twice; verbatim path accept-with-fixes, fix landed |
| **B6 PDF + email** | ☑ **DONE** — report polish + prose variant reviewed: **accept**, no gating defects |
| C3 Archive + entry detail | ◐ **blocked on the photo read path** |
| B3a Staging environment | ⏳ **in flight** — machinery only; no VPS or domain exists yet |
| B7 Demo polish | ☐ |
| C1 Offline queue hardening | ☐ mostly delivered by B3; needs an audit, not a build |
| C2 Weather enrichment | ☐ |
| C4 Immutability + corrections | ☐ |
| C5 Device binding | ☐ |
| C6 Weekly recap | ☐ depends on B6 |
| C7 Production deploy | ☐ blocked on founder (Hetzner VPS + domain) |
| C8 Pilot onboarding | ☐ blocked on founder (a real foreman) |

**Suites: 447 backend tests, 407 PWA specs** — both verified by execution in this session, not
taken on an agent report. Started the day at 260 and 255.

**The loop closes:** speak → transcript → confirm → PDF → email → sealed. Proven end to end against
real Postgres, MinIO and SMTP.

---

## Owed before anything new is built

| # | Item | Why it matters |
| --- | --- | --- |
| 1 | ~~Reviewer gate — verbatim pair~~ | ☑ **accept-with-fixes**; the gating bug (an already-confirmed entry told the foreman the system had failed him, under a chip reading "Potvrđen") is fixed and mutation-proved |
| 2 | ~~Reviewer gate — report polish + download~~ | ☑ **accept**, no gating defects — tenancy, checksum-before-serve and DST correctness all verified |
| 3 | **Founder: look at a PDF** | `teren-VERBATIM-sr.pdf` and `teren-STRUCTURED-sr.pdf` are on the Desktop. **Nobody has opened either** — no PDF renderer on this machine |
| 4 | **Founder: read the Serbian** | Report and email copy is Claude-written. One grammar bug was already caught (`prijavilo` → `prijavio`); assume more |
| 5 | **Founder: commit and push** | A large amount of unreviewed-by-git work is sitting in the tree |

---

## Two traps that bit this session

**Migrations do not apply themselves.** `dotnet run --project src/Teren.Api -- migrate` is a separate
step. Skipping it surfaces as a bare `42703 column does not exist` — it happened twice, once silently
breaking the money path on the dev database.

**Confirming destroys the diagnosis.** `/confirm` clears `failure_reason` deliberately, so that
"fix the cause and confirm again" works as the retry path for a failed report. The cost: the record
of *why the AI produced nothing* is gone the moment a foreman confirms. Diagnose **before**
confirming. Arguably a defect worth fixing.

---

## Known gaps, stated plainly

- **Photos have no read path.** B6 built an authenticated streaming endpoint for the *report* and
  shaped `IObjectStorage` so photos can reuse it — but the photo endpoint is not built. An owner
  opening the diary on a second device still sees no evidence, which is the buyer's actual reason to
  pay. Keeps C3 at ◐ (ARCHITECTURE §8).
- **Extraction is down for a billing reason.** The Anthropic account is out of credit; the key is
  valid. Roughly one cent per entry, ~€0.30/site/month; the $5 minimum top-up covers months. Until
  then every entry parks in `needs_review` — which is exactly what the verbatim path is for.
- **No SMTP relay chosen.** Reports reach Mailpit locally. Choosing the relay is a founder decision;
  never send direct from the VPS.
- **Real-device debt unchanged** — mic on Android/iOS, iOS HEIC, GPS, offline cold-start, and now
  the iOS Safari download path. All blocked on an https origin, i.e. B3a.
- **Nothing has been looked at in a browser** at 390/768/834/1280/1920. Every layout in this session
  is reasoned from tokens and asserted structurally, never seen.

---

## Queued — founder request

**Welcome page + login gate**, one user, credentials outside the database, so a dev demo server can
go up.

**The thing to settle first:** a login screen in the PWA is not a lock. Anyone can read a JavaScript
bundle, and the API today accepts a **static device token committed to the repo**. A PWA-only login
would keep an honest person out of the UI while leaving the API open to anyone who opens devtools.
If the goal is "nobody else can get in", the gate belongs server-side — the API refusing
unauthenticated requests, static files behind the same check. Storage: a password **hash** in
configuration (user-secrets locally, an environment variable on the server), never plaintext, never
committed. ARCHITECTURE §12 already stages this: M0's static token → this interim gate → C5's
per-device join code.

---

## Decisions taken this session

Recorded in full in PROJECT.md §11. In short:

- **The confirmation screen is a decision, not a form** — read-only summary, one primary action,
  transcript always visible, and with a transcript but no structure the foreman **confirms his own
  words in one tap**. The product's floor is now a voice-backed record in his own words, not "type
  it yourself".
- **The report is a client's document, not a system record** — record id off, place name instead of
  coordinates, site-local timestamps, TEREN wordmark, and the PDF downloadable from the app over an
  authenticated stream rather than a presigned link.
- **Multi-recipient stays `To:`** — every recipient sees the others.
- **Archive → confirm** for a `confirmed`-but-unreported entry: the last cheap chance to fix a
  mistake before the seal is permanent.

**Open, small:** the geotag was removed entirely. The evidential claim is not the decimal degrees,
it is *"this was recorded at the site"* — one line such as **"GPS zabeležen: da (±12 m)"** would
carry that without the noise. Founder's call.

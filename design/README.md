# Teren — M0 screen designs

Ten mobile artboards (390×844) covering the Milestone 0 money path plus the entry screens,
designed against the binding token set in [`tokens.md`](tokens.md) (warm canvas, white
borderless cards, coral accent — the founder's round-2 direction) and the **real seeded demo
data** (project "Stambena zgrada Vojvode Stepe 212", the Bosch-kotao entry, investor Dragan
Obradović).

Sources: one `*.dc.html` file per screen (self-contained HTML, viewable standalone in a
browser), laid out by `canvas.json` on the published design canvas
(`teren-m0-screens.html`).

Note: the earlier bare capture-idle screen (`Main.dc.html`) was **folded into
`Home.dc.html`** — home is the capture entry point (record button front and centre), so a
separate idle screen would have been a duplicate.

## Screens → roadmap increments

| Artboard | Screen / state | Serves |
|---|---|---|
| `Welcome.dc.html` | First run — value proposition, login / join-by-code paths | M1-C5 (join code), M2 (accounts); designed now so the chrome fits later |
| `Login.dc.html` | Email + password with inline wrong-credentials error; join-by-code as secondary | M2 (accounts); join code is M1-C5 |
| `Home.dc.html` | App home — project picker, **today card** (entry recorded today or not), record action, sync row, last entries with status chips | B2 (supersedes old `Main.dc.html`) |
| `CaptureRecording.dc.html` | Recording — timer, waveform, stop, cancel | B2 |
| `CaptureSaved.dc.html` | Saved locally, upload progress, add photos | B2, B3 |
| `Pending.dc.html` | Sync queue — offline (dark card) + failed / uploading / queued | B3 (hardened in C1) |
| `PendingEmpty.dc.html` | Sync queue — everything confirmed by server | B3 |
| `Processing.dc.html` | Server pipeline running (STT → extraction), polling screen | B4 |
| `Confirmation.dc.html` | Mandatory review gate — document card, per-field edit, send | B5 |
| `NeedsReview.dc.html` | STT/extraction failed — raw audio + partial transcript, retry | B4 (failure path) |

Design intent, in one line each:
- **One primary action per screen**; capture is speak-and-tap only (typing belongs on the
  confirmation screen, later, off-site).
- **The today card is the home screen's headline**: has today's entry been recorded — the
  single most important status a foreman/owner glances at.
- **Sync state is first-class**: a persistent row with a count, never a toast. The trust line
  "ništa se ne briše sa telefona…" is stated in the UI.
- **Confirmation reads like a structured document** (Radovi / Ljudstvo / Materijal / Blokade /
  Napomena), raw recording pinned above it as evidence.
- **Failure never looks like data loss**: needs-review leads with "ništa nije izgubljeno".

## Proposed i18n keys

Existing keys reused: `app.name`, `app.tagline` ("Građevinski dnevnik koji se sam piše" — the
Welcome headline). Everything else is new; sr values need the founder's native review (B5
founder action; vi-form throughout, see open question 1).

```jsonc
// welcome / login (M1–M2 chrome, designed now)
"welcome.pitch":                { "sr": "Snimite 30 sekundi govora sa gradilišta — Teren od toga pravi uredan dnevnik i izveštaj za investitora.", "en": "Record 30 seconds of speech on site — Teren turns it into a tidy diary and a report for the client." }
"welcome.login":                { "sr": "Prijavi se", "en": "Log in" }
"welcome.joinByCode":           { "sr": "Pridruži se gradilištu kodom", "en": "Join a site with a code" }
"welcome.codeHint":             { "sr": "Kod za pridruživanje dobijate od vlasnika firme.", "en": "You get the join code from the company owner." }
"login.title":                  { "sr": "Prijava", "en": "Log in" }
"login.email":                  { "sr": "Imejl adresa", "en": "Email address" }
"login.password":               { "sr": "Lozinka", "en": "Password" }
"login.error.invalid":          { "sr": "Pogrešna imejl adresa ili lozinka.", "en": "Wrong email address or password." }
"login.forgot":                 { "sr": "Zaboravljena lozinka?", "en": "Forgot password?" }
"login.submit":                 { "sr": "Prijavi se", "en": "Log in" }
"login.or":                     { "sr": "ili", "en": "or" }
"login.codeHint":               { "sr": "Kod dobijate od vlasnika firme — na gradilištu ne treba lozinka.", "en": "You get the code from the company owner — no password needed on site." }

// home
"home.project.label":           { "sr": "Gradilište", "en": "Site" }
"home.today.label":             { "sr": "Današnji unos", "en": "Today's entry" }
"home.today.missing":           { "sr": "Još nije unet", "en": "Not recorded yet" }
"home.today.missingHint":       { "sr": "Snimite izveštaj pre kraja dana.", "en": "Record the report before the end of the day." }
"home.today.done":              { "sr": "Unet u {{time}}", "en": "Recorded at {{time}}" }
"home.record":                  { "sr": "Snimi izveštaj", "en": "Record report" }
"home.recent.label":            { "sr": "Poslednji unosi", "en": "Recent entries" }

// entry status chips (server states)
"entry.status.awaitingReview":  { "sr": "Čeka proveru", "en": "Awaiting review" }
"entry.status.confirmed":       { "sr": "Potvrđen", "en": "Confirmed" }
"entry.status.reported":        { "sr": "Poslat", "en": "Sent" }

// capture
"capture.record.hint":          { "sr": "Oko 30 sekundi je dovoljno", "en": "About 30 seconds is enough" }
"capture.record.recording":     { "sr": "Snimanje", "en": "Recording" }
"capture.record.mention":       { "sr": "Pomenite: radove · ljude · materijal · zastoje", "en": "Mention: work · people · material · blockers" }
"capture.record.stop":          { "sr": "Završi snimanje", "en": "Finish recording" }
"capture.record.cancel":        { "sr": "Otkaži", "en": "Cancel" }
"capture.photos.add":           { "sr": "Dodaj fotografije", "en": "Add photos" }
"capture.photos.addOne":        { "sr": "Dodaj", "en": "Add" }
"capture.photos.label":         { "sr": "Fotografije ({{count}})", "en": "Photos ({{count}})" }
"capture.saved.title":          { "sr": "Unos sačuvan", "en": "Entry saved" }
"capture.saved.body":           { "sr": "Telefon čuva sve dok server ne potvrdi prijem. Možete odmah da nastavite sa poslom.", "en": "Your phone keeps everything until the server confirms receipt. You can get back to work right away." }
"capture.saved.done":           { "sr": "Gotovo", "en": "Done" }

// sync / pending
"sync.pendingCount":            { "sr": "Čekaju slanje: {{count}}", "en": "Waiting to upload: {{count}}" }
"sync.allSent":                 { "sr": "Sve poslato", "en": "All sent" }
"sync.uploading":               { "sr": "Slanje u toku · {{done}}/{{total}}", "en": "Uploading · {{done}}/{{total}}" }
"sync.uploadingToServer":       { "sr": "Slanje na server", "en": "Uploading to server" }
"sync.uploadingDetail":         { "sr": "Snimak poslat · šalju se fotografije", "en": "Audio sent · uploading photos" }
"pending.title":                { "sr": "Čeka slanje", "en": "Waiting to upload" }
"pending.offline.title":        { "sr": "Nema interneta", "en": "No internet" }
"pending.offline.body":         { "sr": "Unosi su bezbedni na telefonu i šalju se sami čim se mreža vrati.", "en": "Entries are safe on your phone and upload automatically when the network returns." }
"pending.status.failed":        { "sr": "Nije poslato", "en": "Not sent" }
"pending.status.uploading":     { "sr": "Šalje se · {{done}}/{{total}}", "en": "Uploading · {{done}}/{{total}}" }
"pending.status.queued":        { "sr": "Čeka mrežu", "en": "Waiting for network" }
"pending.failed.reason":        { "sr": "veza je pukla tokom slanja", "en": "connection dropped during upload" }
"pending.retry":                { "sr": "Pokušaj ponovo", "en": "Try again" }
"pending.meta":                 { "sr": "Snimak {{duration}} · {{photoCount}} fotografije", "en": "Audio {{duration}} · {{photoCount}} photos" }
"pending.trustNote":            { "sr": "Ništa se ne briše sa telefona dok server ne potvrdi da je unos primljen.", "en": "Nothing is deleted from your phone until the server confirms the entry was received." }
"pending.empty.title":          { "sr": "Sve je poslato", "en": "Everything is sent" }
"pending.empty.body":           { "sr": "Poslednji unos je primljen danas u {{time}}. Svi snimci i fotografije su na serveru.", "en": "The last entry was received today at {{time}}. All recordings and photos are on the server." }
"pending.newEntry":             { "sr": "Novi unos", "en": "New entry" }

// processing
"processing.title":             { "sr": "Obrada unosa", "en": "Processing entry" }
"processing.heading":           { "sr": "Priprema izveštaja", "en": "Preparing the report" }
"processing.eta":               { "sr": "Obično traje do jednog minuta.", "en": "Usually takes up to a minute." }
"processing.step.received":     { "sr": "Snimak primljen na server", "en": "Recording received by the server" }
"processing.step.transcribed":  { "sr": "Snimak pretvoren u tekst", "en": "Recording turned into text" }
"processing.step.extracting":   { "sr": "Izdvajanje radova i materijala…", "en": "Extracting work and materials…" }
"processing.step.ready":        { "sr": "Spremno za vašu proveru", "en": "Ready for your review" }
"processing.note":              { "sr": "Ne morate da čekate ovde — unos će vas sačekati spreman za proveru.", "en": "No need to wait here — the entry will be waiting, ready for review." }
"processing.back":              { "sr": "Nazad na snimanje", "en": "Back to recording" }

// confirmation
"confirm.title":                { "sr": "Proveri i potvrdi", "en": "Review and confirm" }
"confirm.audio":                { "sr": "Snimak", "en": "Recording" }
"confirm.fullTranscript":       { "sr": "Pun tekst", "en": "Full text" }
"confirm.section.work":         { "sr": "Radovi", "en": "Work" }
"confirm.section.crew":         { "sr": "Ljudstvo", "en": "Crew" }
"confirm.section.materials":    { "sr": "Materijal", "en": "Materials" }
"confirm.section.blockers":     { "sr": "Blokade", "en": "Blockers" }
"confirm.section.notes":        { "sr": "Napomena", "en": "Notes" }
"confirm.blockers.none":        { "sr": "Bez blokada", "en": "No blockers" }
"confirm.material.notDelivered":{ "sr": "naručeno · nije stiglo", "en": "ordered · not delivered" }
"confirm.recipient":            { "sr": "Izveštaj ide investitoru: {{name}}", "en": "The report goes to the client: {{name}}" }
"confirm.send":                 { "sr": "Potvrdi i pošalji izveštaj", "en": "Confirm and send report" }

// needs review
"review.title":                 { "sr": "Potrebna provera", "en": "Review needed" }
"review.heading":               { "sr": "Nismo uspeli pouzdano da razumemo snimak", "en": "We could not reliably understand the recording" }
"review.reassurance":           { "sr": "Ništa nije izgubljeno — snimak i fotografije su sačuvani kao dokaz.", "en": "Nothing is lost — the recording and photos are saved as evidence." }
"review.listen":                { "sr": "Preslušaj snimak", "en": "Listen to the recording" }
"review.partialTranscript":     { "sr": "Delimičan prepis", "en": "Partial transcript" }
"review.unintelligible":        { "sr": "‹nerazumljivo›", "en": "‹unintelligible›" }
"review.guidance":              { "sr": "Preslušajte snimak pa pokušajte obradu ponovo. Ako ne uspe, snimak ostaje sačuvan u dnevniku kao dokaz.", "en": "Listen to the recording, then retry processing. If it fails, the recording stays in the diary as evidence." }
"review.retry":                 { "sr": "Pokušaj obradu ponovo", "en": "Retry processing" }

// common
"common.today":                 { "sr": "Danas", "en": "Today" }
"common.yesterday":             { "sr": "Juče", "en": "Yesterday" }
```

## Open questions for the founder

1. **Ti or vi?** All copy is in vi-form ("Recite…", "Možete…"). A foreman talking to his own
   tool may find ti-form more natural; vi is safer for the distributor demo. One decision,
   applied everywhere.
2. **Stop = send?** Finishing a recording saves and auto-queues the upload ("Gotovo" just
   leaves the screen). Alternative: an explicit send step. Auto-queue is faster (principle 1)
   but gives no moment to regret.
3. **Cancel recording** currently discards silently. Should it confirm ("Obrisati snimak?")
   given gloved mis-taps, at the cost of one more tap?
4. **Entry titles on Home** — the recent list shows a short derived title (first work item).
   Derived from `structure.work_done[0]` — is that the right summary, or date+status only?
5. **Login screen scope** — designed now (per request) but auth lands at M2; M0 ships with a
   baked device token and M1 with join codes only. Welcome's "Prijavi se" would be hidden or
   disabled until M2 — confirm it should even appear in the M0/M1 build.
6. **Serbian copy review** (roadmap B5 founder action): trade vocabulary is lifted from the
   seeded transcripts, the rest is Claude's Serbian — needs the native ear.

## Figma

There is no Figma integration here, and Figma's REST API cannot author design files. If these
screens need to live in Figma, the bridge is the free **html.to.design** plugin: it imports
each `*.dc.html` file (they render standalone in a browser) as editable Figma layers.

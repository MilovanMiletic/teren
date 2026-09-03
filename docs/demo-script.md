# Teren — the 90-second demo

For the distributor, demoing from his own phone to a contractor-owner.

Doc language is English per the repo convention; **the spoken lines are Serbian and stay Serbian** —
they are content, not chrome, and they are what he actually says.

---

## Before he walks in

- [ ] Phone has Teren **on the home screen** (not a browser tab). It opens full-screen and it opens
      instantly; a browser tab with an address bar undercuts the whole pitch.
- [ ] **Join the phone once — one time per phone, never in front of a customer.** Open the app, and
      on the welcome screen enter:

      username: zoran.jovanovic
      code:     DEM0-TEST

      That is a zero in `DEM0`; typing the letter O works too. It is done once and it stays done —
      after this the app opens straight on the record button, and everything below assumes that.
      Do it the evening before, on wifi, and check that the record button is what you see when you
      reopen the app.
- [ ] Run the reset so the archive is the three seeded Serbian sites and nothing else. The reset
      re-issues that same code, so joining a *second* phone later still works.
- [ ] Aeroplane mode **off** for the full demo — the report needs to send.
- [ ] Know which site you will pick before you start. Fumbling in the picker costs the opening.

> The code is single use. Joining a second phone needs a fresh one, and a `seed` or a `reset-demo`
> mints it — the same `DEM0-TEST` every time. Joining a new phone also retires the old one: one
> phone records as Zoran at a time, by design.
>
> **`DEM0-TEST` is a Development-only credential as of 2026-09-03.** This script assumes a demo run
> from a laptop, where it still holds. On a deployed box — `dev.teren.rs` — `seed` **draws a random
> code and prints it**, because the fixed one is published in this repository and that company will
> sit behind a public URL. If you are demoing from the dev box, either read the code off the deploy
> output or issue a fresh one from `/company`, which takes seconds now that F6 exists.

---

## The pitch, in one line

> **"Snimiš trideset sekundi. Klijent dobije izveštaj. Ti imaš dokaz."**
>
> *Thirty seconds of talking. The client gets a report. You get evidence.*

Everything below is that sentence, demonstrated.

---

## The demo

### 1 · Open it cold — 5 seconds

Tap the icon. Do not narrate this part; let it open.

> **"Ovo je ono što majstor vidi kad dođe na teren."**

**The point being made:** it opens like an app, not a website. No loading, no menu. The record
button is the screen — the phone was joined once, weeks ago, and it has not asked him for anything
since.

### 2 · Record — 30 seconds

Tap **Snimi izveštaj** and talk the way a foreman actually talks. Say a real day:

> **"Danas smo završili razvod tople i hladne vode od kotla do kupatila, četrdeset metara PPR cevi
> dvadeset pet. Ugradili smo šest vodokotlića. Bili smo trojica — Nenad, Zoran i Miloš. Čeka se
> štemovanje od električara."**

Take **one photo**. One is enough and keeps the timing tight.

Tap **Gotovo**.

> **"Toliko. Nije morao ništa da kuca."**

**The point being made:** this is the entire on-site burden. Compare it out loud to what he does
now — a notebook, or nothing, or a WhatsApp message that is gone by Friday.

### 3 · Show what came back

Open the entry. Two things are on screen: **his own words**, and **what the system understood** —
the work, the quantity, the people.

> **"Ovo je ono što je rekao. A ovo je ono što je sistem razumeo. On samo proveri."**

If the day came back as his words rather than as items, do not hide it — it is a feature:

> **"Ako sistem ne uspe da razvrsta, ide ono što je čovek rekao. Ništa se ne izmišlja."**

**The point being made:** nothing is invented, and a person always approves before anything leaves.

### 4 · Confirm, and send

Tap the confirm action. The entry is now sealed.

> **"Od ovog trenutka se ne menja. Ako treba ispravka, ide novi unos koji se poziva na ovaj."**

**The point being made — and this is the one the owner buys:** an unchangeable, time-stamped,
GPS-tagged record backed by the original voice note.

### 5 · The report — the thing the client actually gets

Open the PDF from the app.

> **"Ovo ide klijentu, na njegov mejl, na kraju dana. Ne moraš ti da ga zoveš, i on ne mora da zove
> tebe."**

Let him hold the phone and scroll it himself. **This is the moment the sale happens** — the report
is the product's face.

### 6 · The archive — one sentence, then stop

> **"Sve ostaje ovde. Po gradilištu, po danu. Kad se posle šest meseci neko seti da nešto nije
> urađeno — evo ti dan, evo ti slika, evo ti snimak."**

**Then stop talking.** Do not tour the rest of the app. The demo is over.

---

## What not to demo

- **Do not open the pending/upload screen.** It is machinery. Nobody buys machinery.
- **Do not demonstrate a failure state on purpose.** If one appears, name it plainly and move on —
  "to se šalje kad se vrati signal" is a fine answer and an honest one.
- **Do not promise features that are not built.** The list below is what does not exist yet.

---

## Honest answers to the questions he will ask

| He asks | The true answer |
| --- | --- |
| *"Radi li bez signala?"* | Yes. Recording, photos and the entry are kept on the phone and sent when signal returns. Nothing is lost. |
| *"Šta ako pogreši u snimku?"* | He corrects it on the confirmation screen before anything is sent. After the report goes out, a correction is a **new** entry that references the old one — the original is never edited. That is the point. |
| *"Može li neko da mi menja dnevnik?"* | No. Once reported, the record is locked in the database itself, not just in the app. |
| *"Da li klijent može da vidi sve?"* | Today he receives the daily report by email. A client-facing web view of the whole diary is planned, not built. **Say so.** |
| *"Koliko košta?"* | Founder's answer, not the distributor's. Do not improvise a price. |
| *"Radi li na ajfonu?"* | Yes, but on iPhone he must add it to the home screen himself: Share → *Add to Home Screen*. Walk him through it once — if he does not install it, he loses offline and he will stop using it. |

---

## Known weak points — steer around them, do not lie about them

- **Photos taken on another device do not display yet.** If the owner opens a foreman's entry on his
  own tablet, the photos are not there. Demo from the phone that captured the entry.
- **Structuring can fail** (an AI service outage, or a missing key). The day still goes out as his
  own words. Frame it as the floor, not as a fault.
- **One report per day per site.** If he confirms twice, the second is a correction, not a second
  report.

---

## After the demo

Two things worth capturing while it is fresh, both more valuable than the demo itself:

1. **What he asked first.** The first question a real buyer asks is the product's real gap.
2. **Whether he asked for a price.** That is the only reliable signal of intent in the room.

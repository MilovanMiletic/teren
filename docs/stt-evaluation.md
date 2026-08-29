# STT evaluation — provider decision (roadmap A3)

**Decision: Azure AI Speech, `sr-RS`, fast-transcription REST endpoint (`azure-fast`).**
Decided 2026-08-29 by the founder. Supersedes ARCHITECTURE §14 open decision 1.

---

## How this decision was actually made — read this before trusting the table

This evaluation did **not** run on real site audio. Roadmap A2 (3–5 recordings from a live site,
with noise and trade jargon) was deferred; the founder chose to proceed on what could be measured
now and to lean on the mandatory confirmation screen for anything transcription gets wrong.

The evidence below is therefore **one 18-second clip, one voice, a quiet room, and a scripted
sentence**. That is enough to prove the pipeline works and to expose one clear failure mode. It is
not a provider benchmark. Weight it accordingly, and re-open this document the day real site audio
exists.

---

## What was measured

Harness: `tools/SttSpike/` (A1). Locale `sr-RS`. Azure F0 tier, region as configured.

Spoken:

> Danas smo završili razvod tople i hladne vode od kotla do kupatila, četrdeset metara PPR cevi 25.
> Ugradili smo šest vodokotlića Geberit. Bili smo trojica — Nenad, Zoran i Miloš. Čeka se
> štemovanje od električara.

| | `azure-fast` | `azure-continuous` | `azure-continuous+hints` |
|---|---|---|---|
| Status | ok | ok | ok |
| Latency | **2.0 s** | 7.0 s | 7.0 s |
| Local decode needed | **none** | 16 kHz PCM (ffmpeg for m4a) | same |
| `razvod tople i hladne vode` | ✗ "topli hladne" | ✓ | ✓ |
| `40 metara` | ✓ (as `40`) | ✓ | ✓ |
| `PPR cev 25` | ✗ "pipr cevi dvaes 5" | ✗ "pipi vas 5" | ✗ identical |
| `šest vodokotlića` | ✓ (as `6`) | ✓ | ✓ |
| `Geberit` | ✓ | ✓ | ✓ |
| `Nenad` / `Zoran` / `Miloš` | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ |
| `štemovanje` | ✓ | ✗ "štemovanja" | ✗ |
| Artifacts | — | duplicated word | duplicated word |

Providers not evaluated: OpenAI Whisper, ElevenLabs Scribe, Google STT, self-hosted whisper. Their
slots exist in the harness and light up with a key. **No comparison against a non-Azure provider
was ever run.**

## Findings

**1. Phrase-list hinting is inert for `sr-RS`.** `azure-continuous` and `azure-continuous+hints`
returned **byte-identical** transcripts across 39 phrases. The wiring was verified before blaming
the platform: `AzureContinuousProvider.cs:75` uses the documented `PhraseListGrammar.FromRecognizer()`
and applies every phrase before recognition starts.

This matters because phrase-list support was **the stated reason Azure was preferred over Whisper**.
That rationale did not survive contact with the service. Azure was nonetheless chosen, on the
narrower and still-valid ground that it supports `sr-RS` as a first-class locale.

**2. `azure-fast` wins on every measured axis** — 3.5× faster, closer on the material code, no
local decode, and therefore no ffmpeg dependency. Use it. `azure-continuous` remains in the harness
as a fallback and as the only path that could ever carry hints.

**3. The one consistent failure is the material code.** Everything conversational came through
clean on a first attempt with no tuning — names, numerals, work items, trade verbs. The single
thing every path got wrong is the compressed spec `PPR cev 25`. That is exactly the class of token
that carries money into a report.

**4. Azure normalises spoken numerals to digits** — "četrdeset" → `40`, "šest" → `6`. Helpful for
extraction; ground-truth files should list the digit form first with word forms as `|` alternatives.

**5. Azure returns Cyrillic.** ARCHITECTURE §5 fixes Serbian **Latin** as the product script. See
the new open decision in §14.

## Consequences for the build

- **B4** calls Azure fast transcription behind `ITranscriptionProvider`. Provider swap stays a
  one-file change; nothing else in the pipeline knows the vendor.
- **Material codes are recovered downstream, not in STT.** ARCHITECTURE §9.2 already places
  canonical-name mapping inside the Claude extraction call with the project vocabulary as context.
  A model that knows this site's material list can plausibly map *pipr cevi dvaes 5* back to
  `PPR cev 25`; a speech engine without working hints cannot. **This is now load-bearing rather
  than a nicety, and B4 must be evaluated on it.**
- **The confirmation screen is the accepted safety net** (PROJECT.md principle 5). It is already
  mandatory and editable, and its (transcript, extracted, corrected) triples are the eval set
  (ARCHITECTURE §9.3). The founder explicitly accepts typed correction as the fallback for whatever
  transcription misses.

## Accepted risk

Serbian transcription accuracy on **real site audio** — noise, dialect, an unscripted foreman — is
still unmeasured. It remains the product's top technical risk; it is now an accepted one rather
than an open question blocking the build. The cheapest way to close it later is unchanged: record
real audio, drop it in `tools/SttSpike/audio/`, write a `.truth.txt`, re-run. The harness stays
until then.

# SttSpike — transcription benchmark harness (roadmap A1)

Transcribes one recording with every configured provider and scores each transcript on **the
words that carry money** — quantities, materials, work items, worker names.

This is throwaway tooling for [A3](../../ROADMAP.md) and nothing in `src/` depends on it. When a
provider has been chosen, delete `tools/SttSpike/` and its entry in `Teren.slnx`.

```bash
dotnet run --project tools/SttSpike -- audio/sample.ogg
```

> Fluent-sounding prose is not the thing being measured. A transcript that reads beautifully but
> writes `PPR cev 32` where the foreman said `PPR cev 25` is worse than a clumsy one that gets the
> number right, because the number is what ends up in a report a client pays against.

---

## 1. Configuration

Keys come from **user-secrets** and **environment variables** only. There is deliberately no
command-line configuration source, so a key can never end up in shell history.

Azure AI Speech — the provider the evaluation actually runs on:

```bash
dotnet user-secrets --project tools/SttSpike set "Stt:Azure:Key"    "<key from the Azure portal>"
dotnet user-secrets --project tools/SttSpike set "Stt:Azure:Region" "westeurope"
dotnet user-secrets --project tools/SttSpike set "Stt:Azure:Locale" "sr-RS"   # optional, this is the default
```

Environment-variable form uses double underscores: `Stt__Azure__Key`, `Stt__Azure__Region`.

Every provider is optional. An unconfigured one prints `skipped (no … configured)` and the run
continues — the tool is useful with exactly one key present.

| Setting | Default | Used by |
| --- | --- | --- |
| `Stt:Azure:Key` | — | all three Azure entries |
| `Stt:Azure:Region` | — | short name, e.g. `westeurope` |
| `Stt:Azure:Locale` | `sr-RS` | overridable per run with `--locale` |
| `Stt:Azure:FastApiVersion` | `2024-11-15` | fast-transcription REST API version |
| `Stt:OpenAi:Key` | — | `openai-whisper` |
| `Stt:OpenAi:Model` | `whisper-1` | |
| `Stt:ElevenLabs:Key` | — | `elevenlabs-scribe` |
| `Stt:LocalWhisper:BaseUrl` | — | self-hosted whisper, e.g. `http://localhost:8000/v1` |
| `Stt:Google:CredentialsPath` | — | reserved; the slot is not implemented |

---

## 2. Providers

| Name | What it is | Hints? | Needs local decoding? |
| --- | --- | --- | --- |
| `azure-fast` | Azure fast-transcription REST | no | **no** — takes the file as-is |
| `azure-continuous` | Azure real-time engine via the Speech SDK | no | yes, 16 kHz mono PCM |
| `azure-continuous+hints` | same, with a phrase list | **yes** | yes, 16 kHz mono PCM |
| `openai-whisper` | OpenAI `/audio/transcriptions` | no | no |
| `elevenlabs-scribe` | ElevenLabs Scribe | no | no |
| `local-whisper` | any OpenAI-compatible whisper server | no | no |
| `google-stt` | reserved slot, **not implemented** | — | — |

Azure appears three times because that is the comparison A3 needs: two different Azure engines,
and the same engine with and without phrase-list hints.

**Only Azure was designed and reasoned about in detail.** The OpenAI, ElevenLabs and
local-whisper slots are one multipart POST each, included because they were nearly free — but
they have never been run against a live endpoint. If one of them fails, check the request shape
before concluding anything about the provider.

### Two Azure gotchas, and what was done about them

**`RecognizeOnceAsync` stops at roughly 15 seconds.** Site notes are 30 seconds and up, so the
single-shot call would silently truncate every recording and make Azure look far worse than it
is. `azure-continuous` therefore runs **continuous recognition** to end of stream and concatenates
the `Recognized` segments. `azure-fast` avoids the problem differently — it takes the whole file
in one REST call.

**The Speech SDK wants 16 kHz mono WAV.** Its compressed-input path needs GStreamer on Windows,
which is not a dependency worth putting on the founder's laptop, so audio is decoded locally
instead:

| Input | How it is decoded | Installed? |
| --- | --- | --- |
| `.wav` | NAudio, then the WDL resampler to 16 kHz mono | built in |
| `.ogg` / `.opus` | Concentus, a pure-C# Opus decoder, asked for 16 kHz directly | built in |
| `.m4a`, `.webm`, `.mp3`, … | `ffmpeg`, only if it is already on `PATH` | **not installed here** |

The PWA records `audio/ogg;codecs=opus`, which is the built-in path, so the common case needs
nothing installed. An iPhone `.m4a` or an Android Chrome `.webm` has no managed decoder: those
files still work with `azure-fast` and the other REST providers, and the SDK entries skip with a
message telling you to `winget install Gyan.FFmpeg`. Nothing crashes either way.

Decoded PCM is written to the system temp directory and deleted at the end of the run — never
inside the repository.

---

## 3. Phrase-list hints

Azure is the only shortlisted candidate that accepts recognition hints, and that is the main
reason it is on the list. Trade jargon (`štemovanje`), material codes (`PPR cev 25`) and worker
names (`Nenad`) are exactly the words a general Serbian model has never seen.

By default the hints are the demo projects' vocabulary, copied from
`src/Teren.Infrastructure/Seeding/DemoSeeder.cs` into `DemoVocabulary.cs`. In production this
same list arrives as `TranscriptionContext`'s project vocabulary (ARCHITECTURE §9.1), so what is
measured here is what the pipeline will really send.

```bash
--project 1        # hint with one demo site's vocabulary instead of all three
--phrases my.txt   # one phrase per line, # comments allowed
--no-phrases       # no hints at all
```

Comparing `azure-continuous` against `azure-continuous+hints` on the same recording is the number
that decides whether hinting is worth wiring into the pipeline.

---

## 4. Ground truth — the money words

Optional, one file per recording. Found automatically at `<audio-file>.truth.txt`, or passed with
`--truth <path>`. Plain text, editable in Notepad:

```
# One term per line. Blank lines and # comments are ignored.
# `|` separates spellings that all count as correct.

40 m | 40 metara | četrdeset metara
PPR cev 25
ugradni vodokotlić Geberit
Nenad
Zoran
štemovanje
tlačna proba
6 bar | šest bari
```

List only what would cost money if it came out wrong. Ten to fifteen terms per recording is
plenty. See `example.truth.txt` in this folder.

**The misses are the output.** The percentage is a headline; the list of terms a provider failed
on is what A3 actually decides on, so read that.

### How matching works

Both sides are folded before comparison, so none of these cause a miss:

- **Script.** Serbian is digraphic. A provider returning Cyrillic (`штемовање`) matches ground
  truth typed in Latin (`štemovanje`) — without this a correct provider would score near zero.
- **Diacritics.** `š č ć ž đ` fold to `s c c z dj`, on both sides.
- **Punctuation and spacing.** `kuglasti ventil 1"` and `kuglasti ventil 1` are the same term.
- **Case endings.** Serbian declines almost every noun. A term's words are matched in order and
  adjacent, and a word of three characters or more may gain up to four trailing letters; a word
  of five or more that ends in a vowel may also change that vowel. So `PPR cev 25` matches
  "PPR **cevima** 25mm", `tlačna proba` matches "**tlačne probe**", and `Nenad` matches
  "**Nenadu**".

Short tokens — units and bare numbers like `m` or `25` — must match almost exactly, on purpose.
Letting them run on would make `40 m` match "40 **m**ontažera", and a false hit is much worse than
a false miss here: it would credit a provider for a word it never produced.

What is *not* handled is a genuinely different wording — `40 m` spoken as "četrdeset metara", or a
stem that changes shape. That is what the `|` alternatives are for. If you see a miss that the
transcript clearly got right, add the spelling to the truth file and re-run; the scoring is
deliberately conservative rather than clever.

---

## 5. Output

Console, plus a timestamped Markdown copy in `docs/stt-output/` (gitignored — real site
transcripts are customer material and must never be committed). `--no-write` prints only.

Put the recordings themselves in `tools/SttSpike/audio/`, which is gitignored for the same reason.

---

## 6. Options

```
--truth <path>      ground-truth money words (default: <audio-file>.truth.txt)
--phrases <path>    phrase-list hints, one per line
--no-phrases        run without hints
--project <1|2|3>   hint with one demo site's vocabulary instead of all three
--locale <code>     override Stt:Azure:Locale (default sr-RS)
--only <a,b>        run only these providers, by name
--out <dir>         report directory (default docs/stt-output)
--no-write          console only
-h, --help
```

Providers run sequentially, because latency is one of the things being compared.

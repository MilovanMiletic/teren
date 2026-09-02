# The demo film

Records Teren on three device classes and stitches one MP4 a distributor can show a contractor.
Six scenes, about six minutes, no narration — the motion is the argument.

| # | Scene | Device | What it shows |
|---|---|---|---|
| 1 | Telefon se pridružuje jednom | phone 390×844 | Zoran joins the phone with a username and a code. Once, ever. |
| 2 | Trideset sekundi govora | phone | The record button, a real thirty seconds of Serbian site audio, `Gotovo`. |
| 3 | Njegove reči i ono što je sistem razumeo | phone | The entry: the transcript, and the structure beside it. |
| 4 | Dnevnik po gradilištu i po danu | tablet 834×1194 | The archive, the same product one class wider. |
| 5 | Kancelarija vlasnika | tablet | Petar's office: his crew, a worker, a fresh activation code. |
| 6 | Teren vidi naloge, nikada dnevnik | desktop 1440×900 | The platform directory, the customers, the log. |

Everything on screen is the seed's own Serbian: Zoran Jovanović, Petar Petrović, Vodoinstal
Petrović d.o.o. and its three Belgrade sites. The one addition is Milica Nikolić, a demo member of
Teren staff this tool creates. It never touches the founder's own super-admin account.

## Before you run it

- Docker up (`docker compose up -d`) and the API on **5080** in Development. The tool proxies to it
  and never binds it.
- `ffmpeg` on the PATH for the final MP4. Playwright's bundled build is a stripped one with no
  H.264 encoder; the tool falls back to it only to concatenate.
- About 1 GB free. The raw scene recordings are deleted by `stitch`; the MP4 is ~11 MB.

## Running it

```bash
cd tools/demo-video
npm install
npm run demo          # prepare -> record -> stitch
```

`out/teren-demo.mp4` is the film. The per-scene `.webm` files stay beside it, so a scene can be
re-recorded and re-stitched without redoing the rest:

```bash
node record.mjs --only scene-05-tablet-office
node stitch.mjs
```

`prepare.mjs` builds the PWA, seeds the demo company, mints the company admin's invite link and
creates the staff account. `record.mjs` serves the production build on **4310** and drives it.
`serve.mjs` alone is useful for watching a scene by hand.

## Two things to know

**Recording scene 1 takes Zoran's phone away from you.** The activation code is single use, so
redeeming it on camera revokes whichever browser currently holds Zoran's session — normally the
founder's own. `prepare.mjs` runs `seed` first and the run ends with a fresh `DEM0-TEST`, so
re-activating afterwards is one screen. Do not record while demoing from that browser.

**`config.mjs` carries two passwords.** They belong to accounts this tool creates in the *local*
dev database and nowhere else, the same class of published throwaway as the seeded `DEM0-TEST`
code. They are still passwords in a repository: if this tool is ever pointed at a host that is not
a laptop, move them to environment variables first.

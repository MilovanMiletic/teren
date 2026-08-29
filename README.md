# Teren

Digital site diary for small Serbian contractors. A foreman takes photos and records a ~30 second
voice note; Teren turns it into a structured, evidence-grade daily record and a PDF report emailed
to the client.

Start with `PROJECT.md` (why), then `ROADMAP.md` (what next) and `ARCHITECTURE.md` (how).
`JOURNAL.md` is the day-by-day trace.

---

## Requirements

| Tool | Version used |
|---|---|
| .NET SDK | 10.0.x |
| Node | 24.x |
| Angular CLI | 22.x |
| Docker + Compose | v2+ (`docker compose`, not `docker-compose`) |

## Running locally

Backing services (Postgres + MinIO) run in Docker; the API and the PWA run on the host so the
edit-reload loop stays fast.

```bash
docker compose up -d
```

```bash
dotnet run --project src/Teren.Api
```

```bash
npm start --prefix web/teren-pwa
```

| Service | URL | Credentials |
|---|---|---|
| PWA | http://localhost:4200 | — |
| API | http://localhost:5080 | — |
| MinIO console | http://localhost:9001 | `teren` / `teren_dev_only` |
| Postgres | `localhost:5432` | `teren` / `teren_dev_only`, db `teren` |

There is no local `psql` client on the dev machine — use the container:

```bash
docker compose exec postgres psql -U teren -d teren
```

Stop with `docker compose down`, or `docker compose down -v` to wipe the data volumes.

## Testing on a real phone

**A desktop browser cannot verify this product.** Voice recording, camera capture, GPS, the
service worker and install-to-home-screen all require a real device on an HTTPS origin. Expose the
local stack through a tunnel and open that URL on the phone.

Use a tunnel that gives a **stable hostname**. IndexedDB, the service-worker registration and the
installed app are scoped to the origin, so a URL that changes on every restart wipes local state
between sessions — which would make offline-queue testing meaningless.

## Secrets

Never commit secrets. Development uses .NET user-secrets; production uses environment variables.

```bash
dotnet user-secrets init --project src/Teren.Api
dotnet user-secrets set "Anthropic:ApiKey" "sk-ant-..." --project src/Teren.Api
```

## Layout

```
src/Teren.Api              Minimal API endpoints, DI, Hangfire host
src/Teren.Core             domain entities, state machine, jobs, prompts, report templates
src/Teren.Infrastructure   EF Core + Npgsql, S3 client, STT/LLM/weather/email adapters
web/teren-pwa              Angular PWA (Serbian default, English available)
tools/                     throwaway harnesses (e.g. the transcription spike)
evals/                     extraction fixtures built from user corrections
deploy/                    compose files, Caddy config, backup scripts
```

## Conventions

- UI text is English in source with a Serbian translation; **Serbian is the default locale**.
  Never hardcode a user-facing string — every one goes through a translation key.
- Code, comments, commit messages and documentation are in English.
- Transcripts and extracted values are never translated: raw evidence is never altered.

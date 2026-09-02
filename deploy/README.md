# Deploying Teren

This directory is the whole deployment. Everything the stack needs to run somewhere other than a
laptop is here: two `Dockerfile`s, one compose file, a Caddy config, one deploy script, and the
backup and object-storage scripts.

**Read this once before the first deploy.** It is short, and three of the traps in it have already
cost a debugging session each.

---

## 1. What is proven, and what is not

Honesty first, because a deployment guide that overstates itself is worse than none.

| | Status |
|---|---|
| The production stack stands up and serves the app over HTTPS | **Proven** — locally, `deploy.sh --target local`, full path exercised |
| Migrations run as an explicit step before the API starts | **Proven** |
| An entry can be created, its media uploaded by presigned PUT, and `received_at` stamped | **Proven** |
| A confirmed entry renders a PDF and is emailed | **Proven** — inside the production image |
| The service worker is not served a stale shell after a redeploy | **Proven** |
| Backup, and a restore from a completely dropped schema | **Proven** |
| TLS with a **real** certificate from Let's Encrypt | **NOT proven** — needs a domain. Locally, Caddy's internal CA is used instead |
| Shipping to a remote host (`ssh`, `docker load`) | **NOT proven** — there is no host yet |
| Bucket CORS at a managed provider | **NOT proven** — MinIO does not implement the bucket CORS API at all (see §6) |
| Anything at all about a phone | **NOT proven** — that is what this environment exists to make possible, not something it demonstrates |

There is no VPS and no domain: `teren.rs` is deliberately deferred to C7. Everything below the
"ship" step in `deploy.sh` is written but has never run.

---

## 2. What the founder has to buy, in order

Do these in this order. Each step is blocked by the one before it.

| # | What | Where | Cost | Why it must be this |
|---|---|---|---|---|
| 1 | **A domain name** | any registrar | ~€10–15/year (`.rs` ~€20) | Not optional and not deferrable. Caddy proves ownership over ACME to get a certificate, and ACME cannot issue for an IP address. And it must be **https**: the upload path computes SHA-256 with `crypto.subtle`, which is *undefined* outside a secure context and fails by not existing rather than by throwing (ARCHITECTURE §13). A staging subdomain of a domain bought now (`staging.example.rs`) is enough; `teren.rs` itself can wait for C7 |
| 2 | **A VPS** | Hetzner CX22 (2 vCPU, 4 GB RAM, 40 GB disk) | ~€4.5/month | 4 GB is the number that matters: Postgres, the API with Hangfire, and Caddy on one box. 2 GB would work until a report renders. Take the Nuremberg or Falkenstein location — closest to Serbia of Hetzner's EU sites |
| 3 | **A DNS record** | the registrar, or Hetzner DNS (free) | €0 | One `A` record pointing the hostname at the VPS IP. Do it before the first deploy and let it propagate, or ACME fails and Caddy backs off |
| 4 | **Object storage** | Hetzner Object Storage | ~€5/month incl. 1 TB | Managed, S3-compatible, same region as the VPS. Self-hosting MinIO on the same box is possible (§6) but puts the raw evidence on the same disk as everything else, which defeats the point of having it |
| 5 | **An SMTP relay** | Resend, Postmark, or similar | free tier → ~€15/month | Still an open founder decision (PROJECT.md veto queue). **Never send directly from the VPS**: Hetzner blocks outbound port 25 by default and a fresh VPS IP has no sending reputation, so the report that *is* the product lands in spam. Until this is chosen, run staging with the `mailpit` service (§5) — reports are captured and readable, and nothing is silently lost |
| 6 | **Azure AI Speech** | Azure | pay-as-you-go, pennies per hour of audio | Already decided (`docs/stt-evaluation.md`). Without the key, entries park in `needs_review` with their evidence intact |
| 7 | **An Anthropic API key** | console.anthropic.com | pay-as-you-go | Without it, entries keep their transcript and park in `needs_review` |

**Running total: roughly €10/month plus a domain**, before AI usage. AI usage is negligible against
the subscription price (PROJECT.md).

Also configure, at no cost, once the domain and relay exist: **SPF, DKIM and DMARC** on the sending
domain. The relay will tell you the exact records. Skipping them is the second most common reason a
transactional email lands in spam, after sending from a VPS.

---

## 3. First deploy

```bash
cp deploy/.env.example deploy/.env       # then fill it in — see §4
deploy/deploy.sh                         # build, ship, migrate, restart, verify
deploy/deploy.sh --seed                  # the same, plus the demo project (idempotent)
```

On the host, once:

```bash
deploy/backup/install-cron.sh            # nightly pg_dump at 03:00
```

The script's order is the point of it:

```
preflight → build → ship → database up → MIGRATE → app up → bucket CORS → verify
```

**Migrations are a separate step and always run.** `dotnet Teren.Api.dll migrate` never happens
implicitly on container start — a crash-looping container would re-attempt the schema change on
every restart, and two replicas would race. Forgetting the migrate step has bitten this project
twice, once silently killing the money path with a bare Npgsql `42703 column does not exist`
(CLAUDE.md). A deploy that cannot forget it is the fix.

### Day to day

```bash
deploy/deploy.sh                                  # redeploy after a change
deploy/deploy.sh --skip-build                     # restart with the images already built
ssh $TEREN_SSH_HOST "cd /opt/teren && docker compose logs -f api"
```

### Rolling back

There is no rollback command, deliberately — a fake one is worse than none. Images are tagged, not
versioned, so rolling back means checking out the previous commit and deploying it:

```bash
git checkout <previous-commit> && deploy/deploy.sh
```

**A rollback does not undo a migration.** If the deploy you are backing out added a column, the old
code will still run against the new schema, which is usually fine, and a *removed* column is not. Do
not write destructive migrations without a plan; that is cheaper than a rollback story.

### Rehearsing the whole thing without a host

```bash
deploy/deploy.sh --target local --seed
```

Stands the production stack up on this machine — the same compose file, the same images, the same
Caddy routing — on non-default ports (8443, 55432, 9100/9101, 9443, 8125) so it cannot collide with
the development stack. `docker compose up -d`, `dotnet run --project src/Teren.Api` and
`npm start --prefix web/teren-pwa` keep working exactly as CLAUDE.md documents while it is up.

```bash
deploy/deploy.sh --target local --down            # stop it
```

---

## 4. Configuration and secrets

Everything real arrives as an environment variable. `deploy/.env.example` lists every key with no
value; `deploy/.env` is gitignored (`.gitignore` covers `.env` and `.env.*`, excepting
`.env.example`). **No secret ever enters the repository.** If one does, it is burned — rotate it,
do not just delete the line.

Three things in that file are worth calling out.

### `Storage__PublicEndpoint` — the trap that looks like a CORS bug

There are two storage endpoints and they are not interchangeable:

- `TEREN_STORAGE_ENDPOINT` is what the **API container** talks to. It may be an internal address.
- `TEREN_STORAGE_PUBLIC_ENDPOINT` is what gets **baked into the presigned URLs the phone uses**.

The host is part of what SigV4 signs, so the public endpoint must be exactly the address the phone
will call, over https. Get it wrong and uploads fail from the phone while every server-side check
looks healthy — and it presents as a CORS error, because a browser's complaint about an unreachable
or wrongly-signed host is indistinguishable from a preflight refusal. If uploads fail and CORS looks
like the culprit, check this first.

### The device token has one home now, and it is optional

It used to have two: the `Auth__DeviceToken` environment variable on the server, and a string
compiled into the PWA bundle, which `web.Dockerfile` substituted at build time from a
`TEREN_DEVICE_TOKEN` build arg. **D7/F9 (2026-08-31) removed the second half** — the bundle carries
no credential, because a working token readable from devtools by anyone is not a credential, and
while it existed the activation gate could not bite.

The build-time seam outlived it by two days and broke both targets: `web.Dockerfile` grepped for a
placeholder that `environment.ts` no longer contains and stopped with `FATAL`, and `deploy.sh`
refused to run at all without `TEREN_DEVICE_TOKEN` set. Both are gone (2026-09-02); there is no
build arg and the variable is no longer required.

What survives is one row. `seed` provisions the demo worker a `device` whose `token_hash` is
SHA-256 of `Auth__DeviceToken`, so that one phone can be handed a token without activating it.
**Leave it empty** unless you want that: an empty value provisions no demo device and says so once
at start-up, phones activate at `/auth/activate` with a username and a one-time code, and nothing
about the app depends on it. If you do set it, generate it (`openssl rand -hex 32`) — a value
anyone else knows is a working credential to the demo company — and it must be at least 16
characters.

### The Hangfire dashboard

Without `TEREN_HANGFIRE_USER` and `TEREN_HANGFIRE_PASSWORD` the dashboard is **unreachable**, not
open: with no credentials configured it serves loopback requests only, and behind a proxy nothing is
loopback. There is no third state where it is public.

---

## 5. Should Mailpit run on staging?

**Yes, until a relay is chosen — and never in production.**

The alternative is worse. With no `Reporting__Smtp__Host`, B6's policy is that confirmed entries
stop with a visible `delivery_not_configured`: nothing is lost, but the report path cannot be
exercised at all, and staging exists precisely so the founder can record an entry, put the phone
down, and check the result later. With Mailpit on the box, the whole money path runs and every
report is inspectable with its PDF attachment.

It is deliberately **not** proxied by Caddy and its ports bind to loopback on the host only. Reach
the inbox over an SSH tunnel:

```bash
ssh -L 8025:127.0.0.1:8025 $TEREN_SSH_HOST     # then open http://localhost:8025
```

Enable it with the compose profile and point the API at it:

```
TEREN_SMTP_HOST=mailpit
TEREN_SMTP_PORT=1025
TEREN_SMTP_SECURITY=None
```

Swapping in a real relay later is `TEREN_SMTP_*` and nothing else.

---

## 6. Object storage CORS

The phone uploads media **directly** to object storage with a presigned PUT — the bytes never pass
through the API (ARCHITECTURE §2, §8). That is a cross-origin request, so the browser preflights it
and refuses the upload unless the bucket answers. Nothing in the API can compensate for a bucket
that does not, and the failure leaves **no trace in the API log**, because the API was never called.

`deploy.sh` applies the rules on every deploy via `deploy/storage/apply-cors.sh`, which renders
`deploy/storage/cors.xml.template` with the app's origin. It is not a paragraph anyone has to
remember.

**The two stores this project uses behave differently, and this matters:**

- **Hetzner Object Storage** (Ceph RGW) implements the S3 `PutBucketCors` API. `apply-cors.sh`
  applies `cors.xml.template` to the bucket. This is the real path, and it is the one piece of §6
  that is still unproven, because there is no account yet.
- **MinIO does not implement it at all.** `mc cors set` returns *"A header you provided implies
  functionality that is not implemented"*. MinIO's CORS is a **server-level** setting,
  `MINIO_API_CORS_ALLOW_ORIGIN`, and its default is `*` — every origin allowed.

That default is why the browser-upload verification of 2026-08-29 proved less than it appeared to:
it demonstrated that an *unconfigured* store lets everything through.
`deploy/docker-compose.local.yml` now pins MinIO to the app's own origin, so an upload that works in
the local rehearsal works because the store was configured to allow it.

Verify rather than believe, on any store:

```bash
curl -k -X OPTIONS -D- -o /dev/null '<a presigned URL>' \
  -H 'Origin: https://your-domain' -H 'Access-Control-Request-Method: PUT'
```

The allowed origin comes back with `Access-Control-Allow-Origin`. Any other origin must come back
without it.

---

## 7. Backups

```bash
deploy/backup/install-cron.sh                       # nightly, 03:00 local
deploy/backup/pg-backup.sh                          # run one now
deploy/backup/pg-restore.sh <dump> --yes            # restore (DESTRUCTIVE)
```

Nightly `pg_dump -Fc`, verified by reading its table of contents back, copied to
`TEREN_BACKUP_BUCKET`, with `TEREN_BACKUP_RETENTION_DAYS` (30) of history locally and remotely.
Cron on the host rather than a scheduler container: a backup that depends on the stack it is backing
up being healthy is not a backup.

**Two things the dump does not contain, both deliberate:**

1. **Object storage.** The audio, the photos and the rendered PDFs live in the bucket. The dump
   carries only the rows that point at them. Restoring into a stack whose `Storage__Bucket` is a
   *different* bucket gives you a database full of entries whose evidence 404s. Check the bucket
   before you check anything else.
2. **Hangfire's schema.** Job state is not evidence. Restoring it would bring back the queue as it
   stood at backup time — including jobs whose reports have since been delivered — and the job
   server would run them again. ARCHITECTURE §10 names that cost: "an investor holding three copies
   of the same day." Hangfire recreates its schema on start-up, and the minutely sweeper is exactly
   the mechanism that picks up entries left mid-pipeline.

Restoring, in order: stop the API, run `pg-restore.sh`, start the API, check the entry count and the
newest entry's date, then check the bucket. **Rehearse it against the local stack before you need
it** — `pg-restore.sh <dump> --local --yes`. An unrehearsed backup is a rumour, and this product's
whole promise is that evidence survives. C7 requires the rehearsal; it has been done once here, and
it found a real defect the first time (a restore that cleared only the `public` schema died halfway
and left the database with no application tables at all).

---

## 8. Troubleshooting

**Uploads fail and it looks like CORS.** Check `Storage__PublicEndpoint` before anything else (§4),
then the bucket's CORS (§6). Both present as a preflight failure in the browser console.

**Every request 401s.** Nothing is baked into the bundle any more (§4), so this is not a mismatch —
the browser is holding no session, or the one it holds was revoked. A fresh install lands on
`/welcome`; a phone needs a username and an activation code, which its company's admin issues at
`/company`. `Auth__DeviceToken` is not involved unless you deliberately set it for the demo phone.

**A bare Npgsql `42703 column does not exist`.** Migrations did not run. `deploy.sh` always runs
them; a manual `docker compose up -d` does not. **Since 2026-09-02 the box says so itself**:
`curl -k https://$TEREN_DOMAIN/health/ready` answers 503 with `migrations: N migration(s) pending`,
naming which context is behind, and the container healthcheck asks the same route. `/health` is
liveness only and still answers `ok` on such a host — deliberately, because a liveness probe that
goes red on a database blink restarts a healthy process.

**What readiness does *not* cover.** It asks the schema, the two contexts and the job server's
heartbeat. It says nothing about a missing time-zone database, an unset AI key or an absent relay:
each of those is a working host that cannot do one job, and each is warned about at deploy time and
recorded on the entry (`failure_reason`) rather than turned into an outage.

**Entries sit in `needs_review`.** Read `failure_reason` on the entry — it names the missing key.
`deploy.sh` warns at deploy time about every key whose absence leaves a working host that cannot do
its job. **Diagnose before confirming:** confirming clears `failure_reason` (deliberately — it is
what makes "fix the cause and confirm again" the retry path), which destroys the record of why the
AI produced nothing.

**Reports never arrive and the entry stays `confirmed`.** Check `failure_reason`. This is also where
a missing time-zone database showed up as `time_zone_unknown: 'Europe/Belgrade' is not a time zone
this host can resolve` — reports carry project-local timestamps, and Alpine ships no IANA database.
`api.Dockerfile` installs `tzdata` for exactly this. `/health` said `ok` throughout.

**Caddy cannot get a certificate.** The DNS record must resolve to this box, and ports 80 and 443
must be reachable from the internet — ACME challenges both. Check `docker compose logs web`.

**The dashboard at `/hangfire` refuses everything.** No credentials configured (§4).

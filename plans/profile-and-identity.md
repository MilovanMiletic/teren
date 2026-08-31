# Profiles and identity — implementation plan

**Status:** draft for founder review · 2026-08-30
**Supersedes:** the "welcome + login gate for the dev env" request. That was scaffolding; this is the
real model, per the founder's decision to *"build a profile logic like it should"*.

---

## 1. Context — why this, why now

Teren has no concept of a person. It has one static bearer token, `Auth:DeviceToken`, compared with
`FixedTimeEquals` against a string that is **committed to the repo and compiled into the PWA bundle**
(`src/Teren.Infrastructure/Tenancy/StaticTokenDeviceAuthenticator.cs`,
`web/teren-pwa/src/environments/environment.ts:32`). That token carries the company id, so *every*
request is attributed to one company. This is why the founder's own real B6 entry landed inside the
demo company: there was nowhere else for it to go.

Three things now depend on fixing that:

- **The dev environment cannot go up without it.** A public URL with no gate is not deployable, and a
  PWA-only login is not a gate — anyone can read the bundle and call the API directly.
- **The evidence claim is incomplete.** A site diary that cannot say *who recorded this* is weaker
  than the notebook it replaces. `entry` has no author column today.
- **The product cannot be sold twice.** One token, one company.

This work **absorbs C5 (device binding)** — no longer a separate roadmap item — and **pulls M2
(accounts, companies, roles) forward** ahead of the rest of M1.

---

## 2. Decisions taken (founder, 2026-08-30)

| # | Decision |
| --- | --- |
| 1 | Three roles: **super_admin** (Teren staff), **company_admin** (the customer), **worker** (the foreman who records). |
| 2 | A super admin **can never read entries, transcripts, photos or reports**. He *may* see company and project **names**, and the application log stream. See §6 for exactly where the line now falls. |
| 3 | A company admin sees **everything his company does** — company-wide, not per-project. |
| 4 | **Both** admin roles sign in with **email + password**. Same mechanism, different role gate and a shorter session for super admin. |
| 5 | A worker activates a phone with his **username plus a one-time code**, once. Afterwards the app opens **straight to the record button** — no sign-in step, no identity tap, **no network call**. |
| 6 | **A worker's email is optional but is the normal case.** The code is emailed when an address exists; the admin can always read and copy it on screen, so onboarding never blocks on a missing address or on the unbuilt SMTP relay. |
| 7 | **A worker's identity is his username.** It outlives any phone. The device credential *proves* that identity; it no longer *is* it. One device belongs to one worker at a time. |
| 14 | **A worker can move himself to a replacement phone**: he enters his username on the activation screen and a fresh single-use code is emailed to him. No admin call. Falls back to asking his boss when no address is on file. |
| 8 | Because there is no sign-in step, **device revocation is the security control** — server-side, checked on next contact, never enforced by short expiry. |
| 9 | **Every screen is visible on every device.** Admin screens get deliberate compact, medium and expanded layouts like everything else. *(This overturns the earlier "≥768px only" decision, and with it the case for a separate admin app.)* |
| 10 | Each role gets its **own profile surface**: super admin manages all users across companies; company admin manages his own workers and their codes; a worker sees his own profile. |
| 11 | **403 vs 404:** another company's data stays 404. Your *own* company's data your role may not act on returns 403. |
| 12 | The super admin gets a **searchable application log stream**, so the service can be kept running. §4 and §6 cover how that stays compatible with decision 2. |
| 13 | **Codes are shared one worker at a time.** A copy button and a ready-made Serbian message per worker — never a bulk export into a group chat. See the reasoning in §5. |

Two inherited rules that constrain everything below:

- **Bootstrap must never fail and must never await the network** (`web/teren-pwa/src/app/app.config.ts:62-70`).
- **Nothing is ever deleted locally** (PROJECT.md principle 3). Signing out must never touch Dexie.

---

## 3. The three hazards this plan exists to avoid

**H1 — A rejected credential strands a day of evidence.** Today `401 → unauthorized → terminal →
outbox row written to `blocked` with `nextAttemptAt: null``. A `blocked` row is invisible to
`dueOutboxItems()`, uncounted by `watchOutboxBacklog()`, ignored by `earliestNextAttempt()` — **no
wake timer is scheduled and the sync loop goes permanently dormant**, and `releaseInFlight()` does not
recover it on restart. The loop continues through the rest of the queue in the same pass, so one
rejection **cascades and blocks every entry captured that morning**, each recoverable only by a manual
per-entry tap.
This is not hypothetical under the new model: **revoking a device is exactly the event that triggers
it.** The backend half creates the hazard; the frontend half must close it first.

**H2 — A super admin who can read customer diaries.** Once the role exists with broad reach it is very
hard to take back. The privacy claim must be structural, not a promise. §6 gives it four independent
layers.

**H3 — A login step in front of the record button.** Invariant 1 says entry must be faster than the
paper notebook. A network round trip on cold start locks a foreman out in a basement.

---

## 4. Data model

Six new tables, entities in `src/Teren.Core/Entities/`, EF configurations alongside the existing ones.

```sql
app_user (
  id             uuid PK,
  company_id     uuid NULL → company (RESTRICT),   -- NULL if and only if super_admin
  role           text NOT NULL,                     -- super_admin | company_admin | worker
  username       text NULL,                         -- workers: required. admins log in by email.
  display_name   text NOT NULL,
  email          text NULL,                         -- optional for workers, required for admins
  password_hash  text NULL,                         -- NULL until an admin completes his invite
  language       text NOT NULL DEFAULT 'sr',
  created_at, last_login_at, disabled_at timestamptz)
```

**The username is the worker's durable identity** (decision 7). It is **globally unique**, not
company-scoped, because the self-service flow in decision 14 looks a worker up by username alone and
must not have to ask "which company?" — a man standing next to a broken phone should type one thing.
Namespace contention is handled where it belongs: the invite form **proposes** a username derived from
the display name (`zoran.jovanovic`, then `zoran.jovanovic2`) and the admin can edit it, so nobody
ever fights a "taken" error.

`ux_app_user_username` UNIQUE on `(username) WHERE username IS NOT NULL`, plus
`ck_app_user_worker_has_username` — `role <> 'worker' OR username IS NOT NULL`. Same normalise-on-write
discipline as email: lowercase, trimmed, CHECK-enforced.

The role rules are **mechanical, not conventional** — the taste `ck_entry_status` already sets:

| Constraint | Predicate | What it makes impossible |
| --- | --- | --- |
| `ck_app_user_role` | role ∈ the three values | a typo'd role |
| `ck_app_user_company_scope` | `(role = 'super_admin') = (company_id IS NULL)` | **a super_admin inside a tenant** |
| `ck_app_user_admin_has_email` | `role = 'worker' OR email IS NOT NULL` | an admin who can never be reset |
| `ck_app_user_worker_has_no_password` | `role <> 'worker' OR password_hash IS NULL` | **a second door into the diary** |
| `ck_app_user_email_normalised` | `email IS NULL OR email = lower(btrim(email))` | two rows differing only in case |

`ck_app_user_company_scope` is worth reading twice: with it in place, **no INSERT, no UPDATE and no
migration can produce a super_admin row that a tenant filter would ever match.**

`ux_app_user_email` is a **partial** unique index on `(email) WHERE email IS NOT NULL` — the change
from ARCHITECTURE §12's plain `email UNIQUE`, forced by decision 6. Precedent: `ux_report_entry_id`.
Uniqueness is global, not per-company, because email is the login key and a login form has no company
field. Case-insensitivity comes from normalising on write rather than `citext` — no `CREATE EXTENSION`,
following the existing "No PostGIS" precedent.

```sql
device (
  id, company_id → company, user_id → app_user,     -- one phone = one worker
  name text NOT NULL,                                -- "Zoranov telefon"
  token_hash char(64) NOT NULL,                      -- ux_device_token_hash: THIS INDEX IS THE AUTH PATH
  created_at, last_seen_at, revoked_at, revoked_by_user_id)
```

**§12's `project_id` is deliberately dropped.** §12 assumed C5's "join code binds a device to a
project"; the founder's flow binds a *person to a company*, and the project picker is a live control.
A nullable column nothing reads is the speculative schema §12 itself argues against.

```sql
activation_code (
  id, company_id, user_id → app_user, created_by_user_id → app_user,
  code_hash    char(64) NOT NULL,   -- the only authentication input
  code_display text NULL,           -- plaintext, while and only while the code is live (§5)
  created_at, expires_at, consumed_at, consumed_device_id → device, superseded_at)

password_token  (id, user_id, purpose /* invite | reset */, token_hash, created_at, expires_at, consumed_at, superseded_at)
admin_session   (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
admin_audit     (id, actor_user_id, action, subject_type, subject_id, company_id, detail jsonb, created_at)

app_log (                                  -- decision 12: the super admin's log stream
  id           bigserial PK,               -- the one non-uuid key in the product; it is a firehose
  at           timestamptz NOT NULL,
  level        text NOT NULL,              -- Verbose | Debug | Information | Warning | Error | Fatal
  source       text NOT NULL,              -- SourceContext, e.g. Teren.Infrastructure.Reporting.EntryReporter
  template     text NOT NULL,              -- the message TEMPLATE, unrendered
  message      text NOT NULL,              -- rendered, from allow-listed properties only
  properties   jsonb NULL,                 -- allow-listed structured properties only
  exception    text NULL,                  -- scrubbed (see below)
  company_id   uuid NULL,                  -- when the log scope carries one
  entry_id     uuid NULL,                  -- an ID is not evidence; it is how you find the row
  correlation  text NULL)
```

`ix_app_log_at` DESC, `ix_app_log_level_at`, `ix_app_log_company_id_at`.

**The log viewer converts a convention into a security boundary, and that has to be handled
deliberately.** An audit of all ~78 log call sites in `src/` shows the discipline is *already* clean:
no transcript, note or structure content is ever logged (`EntryEndpoints.cs:706` logs
`structure absent|present`, not the structure), and recipients are logged as **counts**
(`EntryReporter.cs:231`, `:511`, `SmtpReportDelivery.cs:106`), never as addresses. ARCHITECTURE §12's
"personal data stays out of logs" is honoured in practice, not merely written down.

Shipping a viewer makes that discipline load-bearing, so it gets three enforcements:

1. **A property allow-list at the sink.** The custom Serilog sink persists only named properties on an
   allow-list (ids, counts, durations, provider names, status codes, outcomes). An unknown property is
   dropped, not stored. New logging that wants a new property must add it deliberately.
2. **Exception scrubbing.** The real risk is not message templates — it is
   `LogWarning(ex, …)` in `BoundedRetry.cs:46`, because a third-party exception from Anthropic or Azure
   can echo request content back in its message. Exceptions are stored as type + scrubbed message +
   stack, with the message truncated and passed through the same allow-list discipline.
3. **A test over the source.** Like the `IgnoreQueryFilters` allow-list and the PWA's i18n spec, a test
   reads every `.cs` under `src/` and fails if a log call site interpolates a known evidence-bearing
   expression (`RawTranscript`, `Structure`, `Corrected`, `Notes`, recipient addresses).

**Retention is a decision, not a default.** `app_log` is a firehose and this is a small VPS: a
Hangfire job deletes rows older than `Logging:RetentionDays` (default **14**), and the sink drops
`Verbose`/`Debug` in production. Without both, the log table becomes the largest thing in the database
and the nightly backup grows without bound.

- `ux_activation_code_live` UNIQUE on `(user_id) WHERE consumed_at IS NULL AND superseded_at IS NULL`
  — at most one typeable code per worker, guaranteed by the database.
  **Expiry is deliberately not in the predicate:** a partial-index predicate must be immutable and
  `now()` is not. Expiry is checked at activation time.
- `ck_activation_code_display_cleared` — a dead code cannot still be holding plaintext.
- **No IP address and no user-agent on `admin_session`.** ARCHITECTURE §12 keeps personal data out of
  logs; nothing reads it, and it would be the first thing to leak into a log line.

**Changes to existing tables**

```sql
ALTER TABLE company ADD COLUMN suspended_at timestamptz NULL;
ALTER TABLE entry ADD COLUMN created_by_user_id uuid NULL, ADD COLUMN confirmed_by_user_id uuid NULL;
```

**The immutability triggers, stated precisely, because this will confuse someone.**
`trg_entry_guard_update` raises on any **UPDATE** of a row with `reported_at IS NOT NULL`.
`ALTER TABLE … ADD COLUMN` with a NULL default is **DDL, not an UPDATE** — Postgres does not rewrite
rows and no row trigger fires. The migration is safe on a database full of reported entries.

What is impossible is **backfilling values**, and this plan does not attempt it. Standing the guard
down for cosmetic data would be a first: `DemoReset` is the only sanctioned stand-down in the product,
it disables only the *delete* guard, and its entire doc comment turns on that distinction.

The demo entries get attribution anyway, for free: `DemoSeeder` only ever inserts missing rows, so a
fresh seed writes `created_by_user_id` at insert time, and `reset-demo` deletes and re-seeds. No
trigger is touched.

FK consequence, correct for an evidence product: `ON DELETE RESTRICT` means a user who has authored an
entry **can never be hard-deleted**. "Remove a worker" is `disabled_at`. Same for a device.

---

## 5. Credentials — formats and hashing

| Credential | Format | Stored as | Lifetime |
| --- | --- | --- | --- |
| Worker activation code | 8 chars Crockford base32, shown `XKD4-7HMP` | SHA-256 **and** plaintext while live | 7 days, single use |
| Device token | 32 random bytes, base64url, `trn_d_` | SHA-256 hex, unique index | **No expiry.** Revocation only. |
| Admin session | same, `trn_s_` | SHA-256 hex | 30 d (8 h for super_admin) |
| Invite / reset link | same, `trn_p_` | SHA-256 hex | 48 h, single use |
| Admin password | — | PBKDF2-HMAC-SHA256, 600k iterations | — |

**Why unsalted SHA-256 for tokens, and why that is not a mistake.** These are 256-bit full-entropy
random secrets, not passwords. There is no dictionary to attack, so a slow KDF buys nothing; salting
would make the value un-indexable and turn every request into a table scan. This is the standard
API-key pattern. **Passwords are the opposite case and get the opposite treatment.**

**Passwords: `Rfc2898DeriveBytes.Pbkdf2`, pure BCL — `Teren.Core.csproj` keeps its zero package
references.** Stored versioned as `pbkdf2-sha256$600000$<salt>$<hash>`, so moving to Argon2id later is
"rehash on next successful login", not a migration and not a forced reset. 600 000 is OWASP's 2023
figure, ~150–400 ms per verify — fine for admin login, intolerable on a request path, which is exactly
why workers have no password. **Measure on the real VPS at B3a**; whatever ships gets pinned by a test.

Two details that are cheap to omit and expensive to have omitted:

- Verification uses `CryptographicOperations.FixedTimeEquals`, as the current code already does.
- **Login runs a dummy verify against a fixed hash when the email is unknown**, so "no such account"
  and "wrong password" cost the same wall-clock. Otherwise login is an account-enumeration oracle by
  stopwatch — which would sit oddly in a codebase that makes a foreign media id 404 rather than 409.

**Activation takes a username AND a code.** That is not ceremony: it means a code seen over a shoulder,
forwarded by accident, or left in a group chat is **useless on its own** — which recovers most of the
property that made a bulk export unacceptable. The code alone never authenticates anything.

**The code stays single-use, and this is the point on which the design refuses to bend.** A reusable
code tied to a username is not an activation code; it is a permanent password, shared over WhatsApp,
that never expires — and anyone who ever saw that message could record entries under that worker's
name, with the report saying it was him. Device replacement is solved by *issuing a new code cheaply*
(decision 14), never by making one code last forever.

**Activation codes are Crockford base32** — its alphabet already excludes `I`, `L`, `O`, `U`, so
ambiguity is solved by a published convention rather than one invented this afternoon, and its
**decode-time folding** (`O→0`, `I/L→1`, `U→V`, uppercase, strip separators) means a man who writes an
"O" gets in. 40 bits, single-use, 7-day TTL, one live code per worker, behind an IP rate limiter.
**Both halves must fold identically** or a code will work in one place and not the other. Generated
codes are rejected and regenerated against a small profanity blocklist — the admin reads this aloud to
a customer.

**On storing the plaintext code — a reversal, stated plainly.** My first draft said hash only and let
"see the code" be served by re-issue. That is wrong, for two reasons:

1. **Operationally it silently breaks the thing it protects.** The admin sends a code by Viber, taps
   later to look at it, and re-issue *kills the code the worker is about to type*.
2. **The invite email is sent from a Hangfire job** (principle 4: external calls never block a
   request), and the job needs the plaintext. The alternative is passing it as a job argument — which
   Hangfire serialises into its own database **and keeps in job history**. Strictly worse.

So `code_display` holds the plaintext **while, and only while, the code is live**, nulled by
consumption, supersession and expiry, enforced by a CHECK. The database never holds a plaintext
credential that is not currently usable anyway. `code_hash` remains the *only* authentication input,
so `code_display` could be dropped tomorrow with no change to the auth path.

---

## 6. The principal, and the four layers that keep super_admin away from evidence

```csharp
public enum TerenRole { SuperAdmin, CompanyAdmin, Worker }

public sealed record TerenPrincipal(
    TerenRole Role, Guid UserId,
    Guid? CompanyId,      // null if and only if SuperAdmin
    Guid? DeviceId,       // set only for a worker on a bound phone
    string DisplayName);
```

`DeviceIdentity` → `TerenPrincipal`; `IDeviceAuthenticator` → `ICredentialAuthenticator`.
`GetDeviceIdentity()` → `GetPrincipal()`, whose single call site (`EntryEndpoints.cs:83`) needs a
two-token edit. **`TenantContext` is unchanged.**

The founder's claim is absolute and the super admin now has a rich web surface, so the boundary gets
four layers, each of which would hold alone:

**Layer 1 — the route gate.** Every evidence route sits under a `RoleFilter` admitting `Worker` and
`CompanyAdmin` only. A super_admin gets 403 before a row is read.

**Layer 2 — the tenant.** A super_admin sets `TenantContext.CompanyId = null`, unconditionally, never
from a route parameter. All five evidence query filters then match nothing. **Not one line of
`TerenDbContext` changes.** If someone added an evidence route and forgot the gate, it returns an
empty list rather than a company's diary. This is why decision 2 was worth taking: the alternative
required rewriting the filter expression on every entity.

**Layer 3 — the model.** A second context, `TerenIdentityDbContext`, maps a **named, closed set** of
types by calling `ApplyConfiguration` **by name** — never `ApplyConfigurationsFromAssembly`, which
would drag in the evidence types. There is **no `DbSet<Entry>`, no `Media`, no `Report`**.
`db.Set<Entry>()` throws at runtime because the type is not in the model.

*"Super admin cannot read evidence" therefore stops being a policy the code applies and becomes a
property of the model the platform code path is compiled against.*

**Where the line now falls, after decision 12 and the founder's call on project names.** The claim has
narrowed, deliberately, and the narrower version is the one to say out loud:

> Teren staff can see **which companies and sites exist** and **what is failing**. They cannot read a
> transcript, view a photo, or open a report.

Concretely, `Project` **is** in the identity model — it has to be, for the health page to name a site —
exposed only as `{id, name, company_id}`. Addresses, coordinates, recipients and vocabulary are
excluded at the DTO, and the reflection guard in §12 is amended to allow `Project` while still
forbidding `Entry`, `Media` and `Report`. That amendment is a founder decision dated 2026-08-30, and
the test comment must say so — otherwise the next person to widen it will assume the previous widening
was also casual.

`app_log` is in the identity model too, which is what keeps the log viewer on the super-admin-safe
side of the split rather than reaching into `TerenDbContext`.

Two benefits fall out: the credential authenticator uses this context too (it must read
`device`/`admin_session`/`app_user`/`company` before any tenant is known), so **`IgnoreQueryFilters()`
disappears from the auth path entirely** — and afterwards appears in `src/` in exactly **one** file,
`DemoSeeder.cs`.

**Layer 4 — the allow-list test.** A test reads every `.cs` under `src/` off disk and asserts
`IgnoreQueryFilters` appears only in `DemoSeeder.cs` — house precedent being the PWA's i18n spec, which
already reads every file off disk. This is what stops someone wriggling around layer 2 with a one-line
escape hatch six months from now.

**Refused:** rewriting the global query filters to admit a platform scope. It converts the product's
strongest structural guarantee into a boolean one bug can flip, on the hottest path in the system.
The two-model split has the opposite failure mode — forget something and the *platform* surface fails
loudly, rather than the evidence surface opening quietly.

---

## 7. Authentication mechanism

**The endpoint-filter approach survives.** No `AddAuthentication`, no `ClaimsPrincipal`, no JWT. The
one thing real auth middleware buys is `RequireAuthorization("policy")`; a `RoleFilter` endpoint filter
gets the same declarative gate in ~35 lines, in the idiom already here.

**JWTs are actively wrong for this product.** The entire security model is revocation. A JWT is a
credential the server cannot take back without a revocation list — i.e. a database lookup per request,
i.e. the thing a JWT was supposed to avoid. `DeviceTokenAuthFilter` is renamed `BearerAuthFilter`; its
401 behaviour is unchanged.

Validation is one indexed query per request. The device path joins `device → app_user → company` and
requires `revoked_at IS NULL`, `disabled_at IS NULL`, `suspended_at IS NULL`. **Every failure produces
a byte-identical 401** — unknown token, revoked device, disabled user and suspended company are
indistinguishable, because "revoked" versus "unknown" is an oracle.

**How revocation reaches a long-offline device: it doesn't need to.** There is **no cache and no
expiry** on a device token. The credential is long-lived; the *check* runs on every request. A phone in
a basement for a week presents its token, the row says revoked, and it gets 401 on first contact.

Three consequences worth writing down:

- **Never add a token→principal cache.** Even 60 seconds makes revocation "mostly" work. §12 turns
  this into a mutation test.
- **Revocation is a soft stamp, never a DELETE.** `entry.device_id` is provenance on evidence rows; an
  administrative action must not degrade evidence.
  **Correction to an earlier draft of this plan:** `entry.device_id` has **no foreign key** today, and
  D1 deliberately does not add one — an FK would validate every existing row on a live database, and
  §4 does not list it. So the database does *not* refuse a hard delete. Until an FK exists this is a
  code-level discipline, which means the revoke endpoint must stamp rather than delete **and a test
  must prove it** (§12 lists that test). Do not let the missing constraint pass unnoticed on the
  strength of a sentence that was wrong.
- **Revoking a device strands that phone's outbox** under today's client code — this is H1, and it is
  why the frontend's fix ships before any admin can press revoke. The revoke button's copy must also
  tell the admin what he is about to strand.

**Rate limiting:** `AddRateLimiter` ships in the shared framework — no package. Fixed window by client
IP on `/auth/*`, 10 attempts / 5 minutes, 429 with `Retry-After`. `RemoteIpAddress` is trustworthy
because `Hosting:BehindProxy` already wires `UseForwardedHeaders`. **No per-account lockout in the
first pass** — it hands an attacker a way to lock a paying customer out of his own reports.

---

## 8. Endpoint surface

Wire format snake_case throughout.

**Public routes live under `/auth/*`, deliberately NOT under `/api`**, so that
`TenancyTests.Every_api_route_sits_behind_the_token` stays *literally* true rather than
"true with exceptions".

| Route | Body → Response |
| --- | --- |
| `POST /auth/activate` | `{username, activation_code, device_name}` → `{device_token, device_id, device_name, user_id, username, display_name, language, company: {id, name}}` |
| `POST /auth/activation-code` | `{username}` → **always 202**, whether or not the username exists. Emails a fresh single-use code when the worker has an address. Decision 14's self-service path. |
| `POST /auth/login` | `{email, password}` → `{session_token, expires_at, role, user_id, display_name, company}` |
| `POST /auth/password` | `{token, password}` → sets password, consumes token, revokes existing sessions. Serves invite *and* reset. |
| `POST /auth/password-reset` | `{email}` → **always 202**, whether or not the account exists |


> **Amendment, 2026-08-31 (founder decision).** The activate row above used to read
> `{device_token, worker, company}`, with the person's fields nested under `worker`. **The shipped
> API is flat and the plan is what changed**, because `LoginResponse` and `MeResponse` already put
> person fields flat with `company` nested — a `worker` wrapper here would have been the only
> nested-person response in the API. This was not a paper disagreement: the client read
> `response.worker?.user_id`, got `undefined`, refused the session and told the founder his code
> had not been spent, while the device row existed and the code was gone. He pressed again and
> burned a second code. Both reviewers reached the same conclusion independently.
> `ActivationTests.The_activate_response_carries_exactly_the_field_names_the_client_reads` now
> pins the serialized field names, exhaustively, against the JSON rather than against the C#
> record — a test that reads the type cannot see a serializer naming change, and neither the PWA
> specs (which test a mock) nor the other backend tests could see this one.
> The login row also gained `user_id`, which the shipped `LoginResponse` has always carried:
> additive, harmless, and folded into the same amendment.

**Authenticated:** `GET /api/me` (the PWA's "is my credential still good" probe),
`POST /api/auth/logout`.

**Company admin** — gate `company_admin`. `GET/POST/PATCH /api/workers`,
`GET|POST /api/workers/{id}/activation-code` (read the live code, or re-issue),
`GET /api/devices`, `DELETE /api/devices/{id}` (soft revoke). Company-wide scope is free — these
tables carry the same global query filter, so no handler writes a `company_id` where-clause.
**The code is always in the response body.** Email is one delivery channel, never *the* channel.

Plus `GET /api/workers/{id}/share-text` — the ready-made Serbian message for one worker, code
included, for the admin to paste into that worker's chat (decision 13). **There is deliberately no
bulk code export.** A code binds a device to a *named* worker, so a group chat carrying six codes lets
any worker activate a phone under another man's name — and every entry he records is then signed with
that name. Attribution is the thing this whole model exists to establish; a bulk export would quietly
undo it.

**Super admin** — gate `super_admin`, prefix `/api/platform/`. Companies (list/create/suspend/resume),
users (list with `company_id`, `role`, `status`, `q` filters), invite, disable/enable, audit.
**Keyset paging, not offset** — `(created_at DESC, id DESC)` with an opaque cursor, because a founder
scrolling a user list while a customer signs up should not see a row twice.
`status=pending` means `password_hash IS NULL` — the filter he will actually want when chasing an
onboarding.

`GET /api/platform/logs` — `?level=&company_id=&entry_id=&source=&q=&from=&to=&cursor=` over `app_log`,
same keyset paging. `GET /api/platform/health` — pipeline state counts, `failure_reason` tallies,
delivery failures and queue depth, **broken down by company and project name** (decision 12 plus the
founder's call on naming projects).

**What the platform DTOs still deliberately do not contain**, and it belongs in their XML doc: no
addresses, no coordinates, no recipient email addresses, no vocabulary, and no entry, transcript,
photo or report content. Project *names* are now in; everything else about a project is not. Writing
the exclusions down is what makes adding one later a visible decision rather than an afternoon's
convenience.

**Worker** — gate `worker`. `GET /api/me/profile` and `PATCH /api/me/profile` (display name, language,
email). A worker may change his own language and email; he may not change his own name to someone
else's, and he cannot see another worker at all.

**The 403/404 reconciliation, which keeps `ApiProblems`' existing doctrine intact:**

> **404 answers questions about existence. 403 answers questions about capability.**
> If the answer depends on *which row* was named, and that row is outside the caller's company → 404,
> unchanged. If it depends only on the caller's **role** and can be decided **without reading any
> row** → 403.

The safety property: **403 is emitted only by the route-level `RoleFilter`**, before any handler runs
and before any id is examined. It therefore cannot leak the existence of anything. **No handler ever
returns 403, and `ApiProblems` still has no 403 helper** — the body is produced by a private static
inside `RoleFilter.cs`, unreachable from an endpoint file. Filter order is
`BearerAuthFilter → RoleFilter → ValidationFilter<T>`, so **401 beats 403 beats 400**, asserted by a
test.

**Two changes to existing routes.** `POST /api/entries` stops honouring a client-supplied `device_id`
(`EntryEndpoints.cs:115`) — with real devices, a client-supplied id that is not the caller's is a
provenance lie on an evidence row. Accept-and-ignore rather than 400, so no phone in the field breaks.
And `/entries` writes `created_by_user_id`, `/confirm` writes `confirmed_by_user_id`.

---

## 9. Invite email

`ReportMessage` requires a non-null attachment and always attaches it, so an invite cannot use it.
New `IMailSender` / `MailMessage` in `src/Teren.Core/Mail/` with a **nullable** attachment — that is
the whole change. `SmtpReportDelivery` splits: `SmtpMailSender` takes the connect/authenticate/
`transmitting`-flag/classifier machinery intact, and `SmtpReportDelivery` remains as a thin adapter.

**`IReportDelivery`'s shape does not change, and this is not negotiable.** Its Transient /
**CustodyUnknown** / Rejected distinction encodes four separate B6 review findings about a client
receiving two copies of his diary. Diluting it into a generic mail interface would re-litigate all
four. The invite path uses `IMailSender` directly; a duplicate invite is harmless.

Invite copy gets its own `InviteStrings`, structurally identical to `ReportStrings` but **not** added
to it — `ReportStrings` is documented as the *report's* chrome. **The invite's language is the
recipient's own (`app_user.language`), not the project's**, and the asymmetry deserves a sentence in
ARCHITECTURE §12: *a report speaks the project's language because the client reads it; an invite
speaks the recipient's, because he does.*

**When no relay is configured — which is every environment today.** Standing policy holds: visible
failure, startup warning, never a boot refusal.

- **Worker activation:** code is in the response body regardless; `email_delivery: "not_configured"`.
  Nothing is blocked.
- **Admin invite:** plaintext token *and* ready-made URL are in the response body, so the super admin
  can read it over the phone. Nothing is blocked.
- **Self-service password reset genuinely cannot work**, and must not be faked — `/auth/password-reset`
  must not return the token, because it must not reveal whether the account exists. The escape hatch is
  the **authenticated** one: `POST /api/platform/users/{id}/invite` re-issues a set-password token to
  the super admin, who reads the link back over the phone. The unauthenticated route stays oracle-free
  and the founder can still unstick a customer at 9 p.m. with no relay account.

---

## 10. Frontend

### 10.1 The outbox fix (H1) — ships before anything else

**(a) Split 401 from 403.** Today `classifyApiError` (`core/api/api-failure.ts:143-145`) maps both to
`unauthorized`, which is terminal. They mean opposite things:

- **401 → new kind `unauthenticated`, NOT terminal.** This credential is not accepted *at the moment*.
  An admin un-revokes, or the foreman types a new code, and the queue heals unattended.
- **403 → `unauthorized`, stays terminal.** The credential is fine; this caller may not do this.
  Waiting cannot fix a wrong company or a wrong role.

A permanently revoked device then retries at the 10-minute ceiling forever, which is correct by this
file's own doctrine — retries are made *visible* rather than abandoned, and `STALLED_AFTER_ATTEMPTS = 8`
already turns "trying" into "not getting through" after about half an hour.

**(b) Gate the loop instead of blaming it.** In `pass()` (`core/sync/upload.service.ts:138-154`),
immediately after the connectivity check:

```ts
if (!this.session.usable()) { return; }   // no attempt, no state change, no failure recorded
```

**This is the most important line in the plan.** It makes "no credential" structurally identical to
"no signal" — the condition the whole app is already built to survive. Without it, `send()`'s
`!this.api.configured` branch throws `not_configured`, which *is* terminal, and a device that loses its
session mid-queue blocks the morning by a different route.

**(c) Release blocked rows when the credential changes.** New `EntryStore.releaseBlockedByAuth()`
beside `retryNow`, reusing `retryNow` per row, scoped to the auth failure kinds only — a new token does
not fix a 404 project or a missing `crypto.subtle`, and releasing those would be the queue lying about
what it learned. Moving rows to `queued` changes `watchOutboxBacklog()`, which the existing
subscription already turns into a `wake()`.

**The refusal: no new `OutboxState`.** `ENTRY_STATUS_BY_OUTBOX_STATE` is a total map; a fifth state
means a new `LocalEntryStatus`, new branches in `entryStatusKey`/`entryStatusTone`, new chip copy in
two languages, new counts in `pending-page.ts` and `watchStuckCount`, and a Dexie marker version — for
a distinction `failureKind` already carries exactly.

**`not_configured` is not reused for "no session"** — three branches
(`features/archive/entry-detail.ts:204`, `:262`, `features/confirm/confirm-page.ts:255`) collapse it
into "notSent". Because of the loop gate in (b) the value is never produced on the entry path at all,
so those branches keep their correct meaning: *this phone was never activated, so nothing it holds was
ever sent.*

### 10.2 Token plumbing

**`ApiConfig` stays a value; its factory gains a getter** returning `session.token()`. The interface
keeps `readonly deviceToken: string`. `configured` and `authHeaders()` already read it fresh on every
call, so this propagates with **zero call-site churn** and every existing spec that provides
`API_CONFIG` as a plain object literal keeps working.

The only thing that would force promoting it to a service is *async* token acquisition — and there is
none, by design. The token changes once per activation, while a human watches a screen. **Write that
down**, or someone will bolt a refresh interceptor on later and reintroduce the async boundary the
record button cannot afford.

`SessionService` injects **nothing** — `API_CONFIG` depends on it, so a dependency back would cycle.
Orchestration lives in `ActivationService`, and activation uses its own bare `HttpClient`.

**No HTTP interceptor.** Three independent fatal reasons: `putObject()` must never carry an
`Authorization` header (S3 rejects a presigned request that has one); `baseUrl` is `''` in production
so prefix-matching matches every URL including object storage; and the seam already exists.

### 10.3 Screens and the gate

**Design debt found while planning:** `Welcome.dc.html` and `Login.dc.html` exist, but **there is no
`Code.dc.html`** — `Login.dc.html` is the *email* screen and its join-by-code is a link, not a field.
An artboard pair (390 + 1280) is owed before the activation screen ships. Also **`welcome.codeHint`
does not exist** in the dictionaries; it is only a proposed key in `design/README.md`. The `auth`
namespace starts empty.

**Routes and query parameters are English** (founder, 2026-08-30). CLAUDE.md already makes code,
comments and docs English; routes are code, and the Serbian paths currently in `app.routes.ts` are the
exception rather than the rule. **This changes URLs and identifiers only — every word the foreman
reads still goes through Transloco and still defaults to Serbian.** The six existing Serbian routes
are renamed in the same increment, so the app is never half-and-half:

| Now | Becomes |
| --- | --- |
| `snimanje` | `record` |
| `unos/:entryId` | `entry/:entryId` |
| `potvrda/:entryId` | `confirm/:entryId` |
| `dnevnik` | `diary` |
| `cekaju` | `pending` |
| `?unos=<id>` | `?entry=<id>` |

New routes:

| Route | Who | Guard |
| --- | --- | --- |
| `/welcome` | worker | `requiresNoDevice` — an activated worker following a stray link must never be shown a login screen |
| `/activate` | worker | **none** — this is the re-activation door for a revoked device and must work while a session exists |
| `/login` | both admin roles | `requiresNoDevice` |
| `/profile` | worker | his own profile: name, company, device, language, email |
| `/company` | company_admin | workers, their codes (copy + share text), devices, revoke |
| `/platform` | super_admin | companies, all users, invites, health, **logs** |

The return-URL parameter is `?next=`.

**One thing the rename must not break:** `rescue.service.ts:53-57` parses `location.pathname` to work
out which entry is open. It has to be updated in the same commit, and it needs a spec — a rescue that
silently stops recognising the confirm screen is exactly the kind of bug that shows up a week later as
"the app lost my recording".

Welcome and code entry are **two routes**, so the phone's back gesture means "back to Welcome" rather
than "leave Teren".

**Decision 9 means every one of these gets three real layouts**, compact included — no "open this on a
computer" panel, and no centred phone column standing in for a desktop design. The two that need the
most thought are `/company` (a worker list with per-row actions must be legible and tappable at 390)
and `/platform`'s log viewer, where a dense, filterable, timestamped stream is genuinely hard to make
usable on a phone. Plan the log viewer's compact layout as **a filtered list of collapsed entries that
expand on tap**, not a shrunken table.

One cost of one-app-for-everything, worth knowing rather than debating: `ngsw-config.json` prefetches
`/*.js`, so every foreman's phone downloads and caches the admin and platform bundles on install
whether he can open them or not. That is inherent to the decision and is kilobytes, not megabytes.

**The gate is a `canMatch` guard, not a shell signal.** `SessionService` reads the credential
synchronously from `localStorage` at construction, so the guard is a pure boolean over one signal read
— an activated device renders Home on the first frame with **zero network calls and zero awaited
promises**.

- **`canMatch`, not `canActivate`** — runs before the lazy chunk is fetched, so an un-activated phone
  on 2G never downloads Home's bundle.
- **Not a shell `@if`** — `app.ts` is a bare `<router-outlet/>` by design, and an `@if` would make the
  address bar lie, which also breaks `rescue.service.ts:53-57`, which reads `location.pathname`.
- Deep links survive via `?next=`, read from `getCurrentNavigation()?.extractedUrl` because
  `CanMatchFn`'s `segments` carries no query string and the archive's open record is `?entry=<id>`.
  Validate the return URL (single leading `/`, no `//`, no `://`).
- Auth routes register **before** `'**'`. `'**' → redirectTo: ''` re-runs matching, so the guard fires
  on the redirect target — worth its own spec.

**What the gate costs, and what pays for it (2026-08-31).** The guard keys on *having a session*, not
on the session being usable — gating on usable would be inert while `environment.deviceToken` is still
in the bundle. The consequence is that a fresh install or a new browser has no session, lands on
`/welcome`, and until F6 there is no screen anywhere that can issue it a code: the seeded company admin
has no password, so the admin surface cannot be reached either. That breaks CLAUDE.md invariant 6
(main is always demo-ready). **`DemoSeeder` therefore mints the demo worker a fixed live code,
`DEM0-TEST`**, re-minted by every `seed` the way the three withdrawal stamps are cleared, and
effectively non-expiring because a code that dies a week after the last seed is discovered mid-pitch.
It is a contract in the same class as the three demo project ids: written down in CLAUDE.md and in
`docs/demo-script.md`. **It is also a published credential to the demo company** — anyone reading the
repo can activate a phone as `zoran.jovanovic` there, which revokes the demo device until the next
`seed`. Acceptable while the demo company holds nothing but sample rows and the only deployment is
local; **revisit it at B3a**, when that company lives behind a public URL.

**Revocation is not a gate.** A revoked device keeps its session and keeps reaching the record button.
A foreman whose admin fat-fingered a revoke at 4pm must still capture the day. It surfaces as a notice
and an "Unesi novi kod" button on the pending row — never a locked door. "Revoked" is *derived*: an
outbox row with `failureKind === 'unauthenticated'` past `STALLED_AFTER_ATTEMPTS`. One 401 is a blip;
eight is a verdict.

**The activation screen carries two fields — username and code — and a second path.** Below the
primary action sits *"Novi telefon? Pošalji mi kod"*: he types only his username, and a fresh code is
emailed to him. That path is what makes a broken phone a two-minute problem instead of a phone call to
a boss who is on another site.

The response is **always the same** whether or not the username exists — the screen says "if that
username exists, a code is on its way" — for the same reason password reset does: a login surface must
not be an account-enumeration oracle. When the worker has no address on file it degrades honestly to
*"nemaš sačuvanu e-adresu — traži kod od poslovođe"*, which needs the server to distinguish those two
cases without confirming existence. Resolve that by telling him at **invite** time whether he has an
address, and keeping the runtime answer uniform.

**Code entry ergonomics** — he types this once, with gloves, from a WhatsApp message:
Crockford folding client-side too; **one `<input>`, not eight boxes** (segmented boxes are a paste and
accessibility disaster on Android); `autocomplete="one-time-code"` because the code arrives by SMS or
Viber; handle `paste` explicitly (strip separators, zero-width characters and stray emoji);
**no auto-submit on the eighth character**, which would burn a single-use code on a mis-typed paste;
**never clear the field on failure**; **no client-side lockout** — throttling is the server's job, and
a lockout on the one screen between a foreman and the record button is indefensible. If offline, say
so *before* he types.

### 10.4 Local storage

The session lives in **`localStorage`** under `teren.session`, narrowed field-by-field on read so a row
written by an older build resolves to `null` rather than half a session.

**Not Dexie**, and the reason belongs in the code: `db.open()` resolves *after* first paint, and worse,
"the database will not open" would become indistinguishable from "not activated" — sending an
activated foreman to a code screen he cannot complete in a basement. A session is a credential, not
evidence; losing it costs one re-activation.

- Dexie goes to **v6 as a marker only** — no upgrade hook, no new index, following the v4 precedent.
- `LocalEntry` gains `deviceId?: string` and **nothing else**.
- **`deviceId` is provenance, never a query filter.** Filtering by the current session would hide a
  foreman's unsent entries the moment he re-activates. The upload path does not send it either; the
  server derives provenance from the bearer.
- `teren.selectedProjectId` and `teren.projects` are **cleared when the company changes** — the cached
  project list is otherwise another company's site list, and an entry captured against a foreign
  project id 404s forever. `teren.language` stays global: language belongs to the man.
- **There is no sign-out.** Re-activation replaces the credential; it never deletes evidence.

### 10.5 i18n

A new `auth` namespace, added to **`en.json` first or simultaneously** — `i18n.spec.ts:49` builds
`NAMESPACES` from `Object.keys(en)` alone, so a namespace present only in `sr` would make the guard
pass in silence while raw keys rendered on screen.

Additive: `pending.reason.unauthenticated` and `pending.action.reactivate` ("Unesi novi kod", instead
of "Pokušaj ponovo" on a revoked row — "try again" over a revoked device is a lie).
`pending.reason.unauthorized` now means 403 only; flag its sentence for the founder's copy pass. The
new `ActivationFailure` union uses the `Record<Union, true>` pattern with a matching `i18n.spec.ts`
block, because the screen builds `auth.code.error.${failure}` by concatenation and the literal scan
cannot see those keys. **Never `git checkout` an i18n file to revert — copy it aside first.**

---

## 11. Sequencing

**The compatibility hinge, which removes the need for any dual-credential code:**
`DemoSeeder` provisions a real `device` row whose `token_hash` is `SHA-256(Auth:DeviceToken)`.
`StaticTokenDeviceAuthenticator` is then **deleted outright**, and the existing baked-in PWA token
authenticates *for real* — as a genuine device bound to a genuine seeded worker. `Auth:DeviceToken`
stops being a special case in code and becomes "the demo device's token, provisioned at seed time".
`deploy/` needs a comment change, not a key change.

Two consequences: `Auth:CompanyId`/`Auth:DeviceId` are deleted (the device row carries both), and
`TerenTestApp.ResetAsync` inserts a device row instead of setting those env vars — after which
`An_authenticated_entry_is_stamped_with_the_tokens_company_and_device` passes **unchanged** and becomes
a *stronger* test, because it now proves the device table stamps the entry rather than a config value.
`DeviceAuthOptions.DeviceToken` stops being `[Required]`, which is a security-relevant loosening and
gets the first-ever test pinning that options class.

| # | Ships | Demo-ready |
| --- | --- | --- |
| **F1** | **The outbox fix alone** — 401/403 split, `releaseBlockedByAuth()`, the `earliestNextAttempt` symmetry fix. Ships standalone value: one "Pokušaj sve ponovo" button retires the per-entry chore today. | Yes |
| **D1** | Migration, entities, `TerenIdentityDbContext`, `PasswordHash`, `ActivationCodeFormat`, `DbCredentialAuthenticator`, seeder + test-fixture device rows, the `IgnoreQueryFilters` allow-list test. **Zero new routes.** | Yes — behaviourally identical, and revocation becomes possible from psql |
| **F2** | `SessionService`, the `API_CONFIG` getter, the `pass()` gate. No UI. | Yes |
| **D2** | `TerenPrincipal`, `BearerAuthFilter`, `RoleFilter`, the 403 doctrine, rate limiter, `/auth/login`, `/api/me`, `create-super-admin` CLI (**password from stdin, never argv** — argv lands in shell history and `ps`) | Yes |
| **D3** | Company-admin surface + `/auth/activate` + the revocation mutation suite | Yes |
| **F3** | Welcome + activation screens, unguarded (reachable only by URL) | Yes |
| **F4** | The `canMatch` gate + `?next=` deep-link preservation | Yes |
| **F4b** | **Rename the six Serbian routes to English**, update `rescue.service.ts`'s pathname parsing and `docs/demo-script.md`. Small, mechanical, and best done before three more routes are added on top. | Yes |
| **F5** | `/profile` — the worker's own profile. Small, and the first screen that proves a role gate in the UI. | Yes |
| **F6** | `/company` — workers, codes, copy + share text, devices, revoke. Three device classes. | Yes |
| **D4** | Platform surface: companies, users, keyset paging, `admin_audit`, the four-mutation evidence suite | Yes |
| **D5** | `app_log` + the Serilog sink with its property allow-list, exception scrubbing, retention job, and the source-scanning redaction test. `/api/platform/logs` and `/health`. | Yes |
| **F7** | `/platform` — companies, users, invites, health, log viewer. The log viewer's compact layout is the hard part. | Yes |
| **D6** | `IMailSender` split, `InviteStrings`, Hangfire mail jobs | Yes |
| **F8** | Revocation surface on Home and the pending screen | Yes |
| **D7/F9** | Self-service reset; **flip `environment.deviceToken` to `''`** and retire the demo device | Yes |
| **D8** | `EntryAttribution` migration and writes. **No backfill.** | Yes |

**D1 is the only increment that changes how an existing request authenticates**, and it changes it to
something behaviourally identical. Everything after is additive. Each increment goes through its
reviewer before being called done.

**Smallest useful first increment: F1 + D1.** F1 is the load-bearing correctness fix with zero UI, zero
i18n, zero design dependency and a byte-identical demo. D1 makes credentials real, invisibly.

---

## 12. Verification

**Backend** — `dotnet test` (Docker; real Postgres, real migrations, so triggers and CHECKs exist).

Schema tests attempt every illegal INSERT against real Postgres, mirroring `EntryImmutabilityTests`: a
super_admin with a company_id, a company_admin with no email, **a worker with a password_hash**, two
live codes for one worker, a `code_display` on a consumed code.

**Mutation proof — super_admin cannot read evidence.** Four mutations, because a single test would be
one revert away from vacuous:

| Mutation | Must fail |
| --- | --- |
| Add `SuperAdmin` to the entries `RoleFilter` | the 403 test |
| Set `CompanyId` from a route value instead of `null` | a test that installs a super_admin principal, resolves `TerenDbContext`, and counts entries/media/reports/projects → **0**. Fails *even with the route gate intact* |
| Add `DbSet<Entry>` to `TerenIdentityDbContext` | a test asserting the model contains exactly six types and `db.Set<Entry>()` throws |
| Reach for `IgnoreQueryFilters()` in a platform endpoint | the allow-list test |

Plus the guard that catches slow rot rather than a sharp break: reflection over every public method of
`PlatformDirectory`, asserting no parameter or return type transitively mentions `Entry`, `Media` or
`Report`. `Project` is allowed, by the founder's decision of 2026-08-30, and **the test comment must
say so** — otherwise the next person to widen it will assume the previous widening was also casual.
**That is the test that goes red the day someone adds `entry_count` to a company DTO** — which is how
this boundary would actually be lost.

**Log redaction proof.** A test reads every `.cs` under `src/` off disk and fails if a log call site
interpolates a known evidence-bearing expression (`RawTranscript`, `Structure`, `Corrected`, `Notes`,
a recipient address). Plus a sink-level test: log an event carrying a property that is not on the
allow-list and assert the persisted row does not contain it; and throw an exception whose message
carries transcript-shaped text and assert the stored `exception` column is scrubbed. The second is the
one that matters, because `BoundedRetry.cs:46` passes third-party exceptions straight through and an
Anthropic or Azure error can echo request content back in its message.

**Mutation proof — a revoked device stops working.** The valuable mutation is adding a 60-second
token→principal cache, and the test must be written to catch it:

```
worker's client captures an entry successfully        (the token was good)
admin client: DELETE /api/devices/{id}                (a DIFFERENT client, a DIFFERENT scope)
worker's client: GET /api/entries  →  401             (no sleep, no retry, no delay)
```

Two properties are load-bearing and must be commented as such: revocation happens through a **different
scope** than the one that authenticated, and **there is no `await Task.Delay` anywhere in the test —
the absence of the sleep is the assertion.** A test written with a two-second wait would pass against a
60-second cache.

**Frontend** — `npx ng test --watch=false` (**read the summary line; `ng test` exits 0 even when specs
fail**). The sacred property: **an activated device renders Home with zero HTTP calls** — assert on a
spy over `fetch` (the app uses `withFetch()`) with `navigator.onLine` false, and assert the guard
returns a `boolean`, never a Promise. Plus: a 401 mid-upload leaves entries in `failed` with a wake
timer still schedulable and **zero rows blocked**; re-activation releases them with no per-entry tap;
sign-out leaves every Dexie row intact; bootstrap survives `localStorage.getItem` throwing.

**End to end, by hand:** activate a phone with a real code; capture an entry offline; revoke the device
from the admin surface; confirm the queued entry survives and the app says so honestly; re-issue a
code, re-activate, watch the queue drain unattended.

---

## 13. Risks

1. **Admin password reset depends on an SMTP relay that does not exist.** Mitigated by the
   authenticated re-issue escape hatch (§9), but choosing a relay is now on this feature's path.
2. **The super admin page can enumerate every customer.** No public discoverability, hard rate limiting,
   and the §12 privacy proof before it ships.
3. **`DemoSeeder` ids are a contract** with the PWA. New rows join the same `d3a0c1f0-…` family;
   `DemoReset`'s ordered delete, its foreign-row fingerprint, `DemoRowCounts` and `TerenTestApp`'s
   TRUNCATE list all grow together, or the reset's safety assertion gains a blind spot.
4. **`environment.development.ts` also carries the token** and is not touched by `web.Dockerfile`'s
   `sed`. Two files, not one.
5. **Not in scope:** per-project worker assignment, multi-company users, SSO.

---

## 14. Open questions for the founder

1. **May a company_admin confirm an entry?** Principle 5 says the confirmation screen is mandatory; it
   does not say by whom. Recommendation: **worker only** — the person who was on site approves what the
   report says. A company_admin who wants a correction gets one via `supersedes_entry_id` (C4). It also
   falls out for free: an admin has no device, so his entries would carry a null `device_id`.
2. **A worker activates a second phone → the plan auto-revokes the old device**, in the same
   transaction, with an audit row. Decision 14 makes this close to mandatory rather than merely
   preferable: once a worker can re-activate himself by email, *not* revoking would mean a lost or
   stolen phone keeps recording under his name indefinitely. Confirm, but I would not build the
   alternative.
3. **Activation code TTL of 7 days** — right for how he actually onboards people?
4. **Does the PDF footer name the foreman** once attribution exists?
5. **A phone handed from worker A to worker B still holds A's unsent recordings**, and B will see them
   on the pending screen. That is evidence over tidiness, and it needs a signature. The middle option
   is to warn on screen at activation that unsent entries from the previous holder will be sent under
   the new credential. A "wipe this phone" button on a foreman's screen should stay out of scope.
6. **Log retention of 14 days, and `Verbose`/`Debug` dropped in production** — enough history to
   diagnose the thing a customer phones about a week later, without the log table becoming the largest
   object in the nightly backup. Say if you want longer.
7. **The privacy claim has narrowed and it is worth reading in its final form**, because it is
   something you may one day have to say to a customer:
   *"Teren staff can see which companies and sites exist and what is failing. They cannot read a
   transcript, view a photo, or open a report."*
   That is still a strong, unusual claim, and §6 and §12 make it mechanically true. It is no longer the
   maximal version ("we cannot see anything about your business"), and that was the price of a log
   viewer and named sites on the health page.

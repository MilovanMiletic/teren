#!/usr/bin/env bash
# Teren — Postgres backup.
#
#   deploy/backup/pg-backup.sh [--env-file deploy/.env] [--local]
#
# Runs on the host the stack runs on, dumps through the compose network, keeps N days locally and
# mirrors off-box to object storage when a bucket is configured.
#
# Why this exists at B3a and not at C7, where ROADMAP puts it: the moment a box runs continuously
# and the founder starts recording real entries on it, the data on it stops being reproducible.
# A backup script written the day after that is a script written one incident too late.
#
# WHAT A BACKUP IS NOT. This dumps Postgres. It does NOT dump object storage — the audio, the
# photos and the rendered PDFs. Those are the raw evidence the product's entire promise rests on
# (PROJECT.md principle 2), and they live in a bucket whose durability is the provider's problem.
# Restoring this dump into an empty stack gives you every entry, every transcript and every
# structured record, pointing at media keys that must still exist in that bucket. If you ever
# delete or re-create the bucket, this backup does not save you.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "${here}/.." && pwd)"
env_file="${deploy_dir}/.env"
compose_files=(-f "${deploy_dir}/docker-compose.prod.yml")

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    --local)
      # Back up the local rehearsal stack instead of a real one.
      env_file="${deploy_dir}/.env.local"
      compose_files=(-f "${deploy_dir}/docker-compose.prod.yml" -f "${deploy_dir}/docker-compose.local.yml")
      shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$env_file" ] || { echo "FATAL: env file not found: $env_file" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

: "${TEREN_DB_NAME:?TEREN_DB_NAME is not set}"
: "${TEREN_DB_USER:?TEREN_DB_USER is not set}"

backup_dir="${TEREN_BACKUP_DIR:-/var/backups/teren}"
# A relative TEREN_BACKUP_DIR resolves against deploy/, never against whatever directory the
# operator happened to be standing in. Backups scattered across the filesystem by the shape of a
# shell prompt are backups nobody can find in an incident.
case "$backup_dir" in
  /*|[A-Za-z]:*) ;;
  *) backup_dir="${deploy_dir}/${backup_dir#./}" ;;
esac
retention="${TEREN_BACKUP_RETENTION_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="${backup_dir}/teren-${stamp}.dump"

mkdir -p "$backup_dir"

compose() { docker compose --env-file "$env_file" "${compose_files[@]}" "$@"; }

echo "==> Dumping ${TEREN_DB_NAME} to ${outfile}"

# -Fc (custom format): compressed, and restorable selectively with pg_restore. Plain SQL would be
# larger and would force an all-or-nothing restore.
# --no-owner / --no-privileges: the dump has to restore into a stack whose role names came from a
# fresh .env, not from the box it was taken on.
# -T is essential: docker compose exec allocates a TTY by default, and a TTY mangles binary output
# with CR/LF translation. The corruption is silent — the file looks plausible and pg_restore
# rejects it months later, which is the worst possible time to find out.
#
# --exclude-schema=hangfire is a safety decision, not a size one, and it was learned from a
# restore rehearsal. Hangfire's tables are job state, not evidence. Restoring them would bring
# back the queue as it stood at backup time — including jobs whose reports have since been
# delivered — and the first thing the job server would do is run them again. ARCHITECTURE §10
# spells out what that costs: "the cost of under-caution is an investor holding three copies of
# the same day." Hangfire recreates its schema on start-up, and the minutely sweeper is exactly
# the mechanism that finds entries left mid-pipeline, so nothing is lost by leaving it out.
compose exec -T postgres \
  pg_dump -U "$TEREN_DB_USER" -d "$TEREN_DB_NAME" -Fc --no-owner --no-privileges \
          --exclude-schema=hangfire \
  > "$outfile"

size="$(wc -c < "$outfile" | tr -d ' ')"
[ "$size" -gt 1024 ] || { echo "FATAL: dump is only ${size} bytes — refusing to call that a backup." >&2; rm -f "$outfile"; exit 1; }

# Read the header back. pg_restore -l on a custom-format dump parses the table of contents, so
# this is a real integrity check of the file just written, not a file-exists check. An unverified
# backup is a rumour (ARCHITECTURE section 13).
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore -l "$outfile" > /dev/null
else
  # No pg_restore on the host (the founder's machine has no local psql client at all): read the
  # file back with the one inside the running container. Streamed in on stdin and landed in the
  # container's own /tmp first — no bind mount, so none of the Git Bash path rewriting documented
  # in deploy/storage/apply-cors.sh, and pg_restore gets the seekable file it needs. Reading the
  # table of contents straight from /dev/stdin fails with "did not find magic string in file
  # header", which reads like a corrupt dump and is not one.
  compose exec -T postgres sh -c \
    'cat > /tmp/verify.dump && pg_restore -l /tmp/verify.dump > /dev/null; rc=$?; rm -f /tmp/verify.dump; exit $rc' \
    < "$outfile"
fi
echo "    ok: ${size} bytes, table of contents readable"

# --------------------------------------------------------------------------------- off-box copy
if [ -n "${TEREN_BACKUP_BUCKET:-}" ]; then
  endpoint="${TEREN_STORAGE_ENDPOINT:?TEREN_STORAGE_ENDPOINT is needed to upload a backup}"
  scheme="${endpoint%%://*}"
  hostport="${endpoint#*://}"

  echo "==> Copying to ${TEREN_BACKUP_BUCKET}"

  # Two Git Bash traps, both documented at length in deploy/storage/apply-cors.sh: the minio/mc
  # image's entrypoint is `mc`, so it cannot run a shell; and MSYS rewrites container-side paths
  # into drive paths unless they start with a doubled slash, while the host side must already be
  # in Windows form. Hence: no shell, one mc call per line, and the paths computed here.
  if [ -n "${MSYSTEM:-}" ]; then
    mount_dst="//backups"
    mount_src="$(cygpath -m "$backup_dir")"
  else
    mount_dst="/backups"
    mount_src="$backup_dir"
  fi

  mc_run() {
    docker run --rm \
      --network "${TEREN_STORAGE_DOCKER_NETWORK:-bridge}" \
      -v "${mount_src}:${mount_dst}:ro" \
      -e MC_HOST_target="${scheme}://${TEREN_STORAGE_ACCESS_KEY}:${TEREN_STORAGE_SECRET_KEY}@${hostport}" \
      minio/mc:latest "$@"
  }

  mc_run mb --ignore-existing "target/${TEREN_BACKUP_BUCKET}"
  mc_run cp "${mount_dst}/$(basename "$outfile")" "target/${TEREN_BACKUP_BUCKET}/"

  # Remote retention. Never fatal: a dump that is on the box and in the bucket has already
  # achieved the point of this script, and failing here would turn a successful backup into a
  # non-zero exit that a cron job would report as a lost night.
  mc_run rm --recursive --force --older-than "${retention}d" "target/${TEREN_BACKUP_BUCKET}/" || true
else
  echo "==> No TEREN_BACKUP_BUCKET set: this dump exists only on this box."
  echo "    One disk failure would take the database and its backups together. Fix that."
fi

# ------------------------------------------------------------------------------------ retention
# Local pruning happens LAST, and only after the copy above succeeded, so a failing upload never
# leaves the box with neither a remote copy nor a local history.
echo "==> Pruning local dumps older than ${retention} days"
find "$backup_dir" -name 'teren-*.dump' -type f -mtime "+${retention}" -print -delete || true

echo
echo "Done. Restore with: deploy/backup/pg-restore.sh ${outfile}"
echo "A backup you have never restored is a rumour. Rehearse it (C7 requires it)."

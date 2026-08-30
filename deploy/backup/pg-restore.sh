#!/usr/bin/env bash
# Teren — Postgres restore.
#
#   deploy/backup/pg-restore.sh <dump-file> [--env-file deploy/.env] [--local] [--yes]
#
# THIS DESTROYS THE CURRENT DATABASE. It drops and re-creates the schema before restoring, which
# is the only way a restore is a restore rather than a merge. It asks first unless given --yes.
#
# The full procedure — what a restore actually involves, in order:
#
#   1. Stop the API so nothing writes while the schema is being replaced:
#        docker compose stop api
#   2. Run this script.
#   3. Start the API again:
#        docker compose up -d api
#   4. Check the entry count and the newest entry's date against what you expected.
#   5. Remember what is NOT in this file: the audio, the photos and the PDFs live in object
#      storage, and this dump only carries the rows that point at them. A restore into a stack
#      whose Storage__Bucket is a DIFFERENT bucket produces a database full of entries whose
#      evidence 404s. Check the bucket before you check anything else.
#
# Rehearse this against the local stack (--local) before you ever need it against a real one. An
# unrehearsed backup is a rumour (ARCHITECTURE section 13); C7 requires the rehearsal.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "${here}/.." && pwd)"
env_file="${deploy_dir}/.env"
compose_files=(-f "${deploy_dir}/docker-compose.prod.yml")
assume_yes=0
dump=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    --local)
      env_file="${deploy_dir}/.env.local"
      compose_files=(-f "${deploy_dir}/docker-compose.prod.yml" -f "${deploy_dir}/docker-compose.local.yml")
      shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) dump="$1"; shift ;;
  esac
done

[ -n "$dump" ] || { echo "Usage: pg-restore.sh <dump-file> [--local] [--yes]" >&2; exit 2; }
[ -f "$dump" ]  || { echo "FATAL: no such dump file: $dump" >&2; exit 1; }
[ -f "$env_file" ] || { echo "FATAL: env file not found: $env_file" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

: "${TEREN_DB_NAME:?TEREN_DB_NAME is not set}"
: "${TEREN_DB_USER:?TEREN_DB_USER is not set}"

compose() { docker compose --env-file "$env_file" "${compose_files[@]}" "$@"; }

echo "Restore ${dump}"
echo "     -> database ${TEREN_DB_NAME} in stack ${TEREN_STACK:-?}"
echo "This DROPS the current public schema. Everything currently in that database is lost."
if [ "$assume_yes" -ne 1 ]; then
  printf 'Type the database name to continue: '
  read -r confirm
  [ "$confirm" = "$TEREN_DB_NAME" ] || { echo "Aborted."; exit 1; }
fi

echo "==> Dropping every application schema and re-creating public"
# DROP SCHEMA rather than DROP DATABASE: the database is in use by the connection doing the drop,
# and dropping it would need a second database to connect to. This gets to the same place.
#
# EVERY non-system schema, not just `public` — found by rehearsing this. Hangfire keeps its
# tables in a `hangfire` schema, so a restore that cleared only `public` died mid-way on
# "schema hangfire already exists" and left the database with no application tables at all.
# Enumerating them means a future component that brings its own schema cannot repeat that.
compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$TEREN_DB_USER" -d "$TEREN_DB_NAME" -c "
DO \$\$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
           WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', s);
  END LOOP;
END \$\$;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO \"${TEREN_DB_USER}\";"

echo "==> Restoring"
# -T on exec for the same reason as in pg-backup.sh: a TTY corrupts binary on the way in too.
# --no-owner: roles on the restoring box need not match the box the dump came from.
# Not --clean: the schema is already empty, and --clean would emit errors for every absent object.
compose exec -T postgres \
  pg_restore -U "$TEREN_DB_USER" -d "$TEREN_DB_NAME" --no-owner --no-privileges --exit-on-error \
  < "$dump"

echo "==> Verifying"
compose exec -T postgres \
  psql -U "$TEREN_DB_USER" -d "$TEREN_DB_NAME" -Atc \
  "SELECT 'entries=' || count(*) FROM entry;"
compose exec -T postgres \
  psql -U "$TEREN_DB_USER" -d "$TEREN_DB_NAME" -Atc \
  "SELECT 'migrations=' || count(*) FROM \"__EFMigrationsHistory\";"

echo
echo "Restored. Now:"
echo "  * start the API:  docker compose up -d api"
echo "  * confirm Storage__Bucket points at the SAME bucket these rows reference, or every"
echo "    entry's photos and audio are gone even though the rows are back."

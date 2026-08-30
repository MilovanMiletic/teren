#!/usr/bin/env bash
# Apply Teren's bucket CORS rules to an S3-compatible object store.
#
#   deploy/storage/apply-cors.sh [--env-file deploy/.env] [--dry-run]
#
# Run it once per bucket, and again whenever the app's origin changes. It is idempotent.
#
# Everything it needs comes from the same env file the stack is deployed with, so the rules can
# never be applied to a different bucket than the one the API signs URLs for:
#
#   TEREN_STORAGE_ENDPOINT / _PUBLIC_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _BUCKET
#   TEREN_APP_ORIGIN        the exact origin the PWA is served from, e.g. https://teren.example
#
# It runs the MinIO client from a container, so nothing has to be installed on the host — and mc
# speaks plain S3, so this works against Hetzner Object Storage exactly as it works against a
# local MinIO.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${here}/../.env"
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    --dry-run)  dry_run=1; shift ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$env_file" ] || { echo "FATAL: env file not found: $env_file" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "FATAL: $name is not set in $env_file" >&2
    exit 1
  fi
}
for v in TEREN_STORAGE_ACCESS_KEY TEREN_STORAGE_SECRET_KEY TEREN_STORAGE_BUCKET TEREN_APP_ORIGIN; do
  require "$v"
done

# Configuration is written through the store's own API endpoint — the one the API container
# talks to. Not the public endpoint: on a split-endpoint setup that address may be a TLS proxy
# reachable only from the browser's network, and bucket CORS is server state either way, so it
# takes effect on every address the bucket answers on.
endpoint="${TEREN_STORAGE_ENDPOINT:-${TEREN_STORAGE_PUBLIC_ENDPOINT:-}}"
[ -n "$endpoint" ] || { echo "FATAL: neither TEREN_STORAGE_ENDPOINT nor TEREN_STORAGE_PUBLIC_ENDPOINT is set" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sed "s|__TEREN_ORIGIN__|${TEREN_APP_ORIGIN}|g" "${here}/cors.xml.template" > "${work}/cors.xml"

echo "Bucket   : ${TEREN_STORAGE_BUCKET}"
echo "Endpoint : ${endpoint}"
echo "Origin   : ${TEREN_APP_ORIGIN}"

if [ "$dry_run" -eq 1 ]; then
  echo "--- rendered cors.xml (dry run, nothing applied) ---"
  cat "${work}/cors.xml"
  exit 0
fi

# mc takes the alias as a URL with credentials in it. Keep the endpoint's own scheme — a local
# rehearsal store is http and a managed one is https, and forcing either would produce a
# connection error that reads like a credential problem.
#
# Note: a key or secret containing '@', ':' or '/' must be percent-encoded here. Generate storage
# credentials without them and this never comes up.
scheme="${endpoint%%://*}"
hostport="${endpoint#*://}"

# Container-side paths need a leading double slash under Git Bash and a single one everywhere
# else. MSYS rewrites any argument that looks like an absolute POSIX path into a Windows path
# before Docker ever sees it — `/work/cors.xml` arrives as `C:/Program Files/Git/work/cors.xml`
# — and it leaves `//work/...` alone. Linux normalises the doubled slash away, so this is a
# no-op on the VPS. The founder's machine is Windows; this script has to work on both.
# The host side needs the opposite treatment: once any part of the -v argument stops looking
# like a POSIX path, MSYS leaves the WHOLE argument alone, so the source has to be handed over
# already in Windows form. cygpath -m gives Docker Desktop the C:/... spelling it wants.
if [ -n "${MSYSTEM:-}" ]; then
  work_mount="//work"
  work_src="$(cygpath -m "$work")"
else
  work_mount="/work"
  work_src="$work"
fi

# Two separate runs rather than one `sh -c "a && b"`: the minio/mc image's entrypoint is `mc`
# itself, so a shell command is swallowed as mc arguments ("`sh` is not a recognized command").
mc_run() {
  docker run --rm \
    --network "${TEREN_STORAGE_DOCKER_NETWORK:-bridge}" \
    -v "${work_src}:${work_mount}:ro" \
    -e MC_HOST_target="${scheme}://${TEREN_STORAGE_ACCESS_KEY}:${TEREN_STORAGE_SECRET_KEY}@${hostport}" \
    minio/mc:latest "$@"
}

# Not every S3-compatible store implements the bucket CORS API, and the two this project uses sit
# on opposite sides of that line:
#
#   Hetzner Object Storage (Ceph RGW)  — implements PutBucketCors. This is the real path.
#   MinIO                              — does NOT. It answers "A header you provided implies
#                                        functionality that is not implemented", and configures
#                                        CORS server-wide via MINIO_API_CORS_ALLOW_ORIGIN, which
#                                        deploy/docker-compose.local.yml sets from
#                                        TEREN_APP_ORIGIN.
#
# So a "not implemented" answer is a known, correct outcome against MinIO, not a failure to
# swallow generally: any other error still stops the deploy.
set +e
output="$(mc_run cors set "target/${TEREN_STORAGE_BUCKET}" "${work_mount}/cors.xml" 2>&1)"
status=$?
set -e
printf '%s\n' "$output"

if [ "$status" -ne 0 ]; then
  case "$output" in
    *"not implemented"*|*"NotImplemented"*)
      echo
      echo "This store does not implement the bucket CORS API — it is almost certainly MinIO."
      echo "Its CORS comes from the server setting MINIO_API_CORS_ALLOW_ORIGIN, which"
      echo "deploy/docker-compose.local.yml already pins to ${TEREN_APP_ORIGIN}."
      echo "Nothing further to apply here. VERIFY it rather than believing it:"
      echo
      echo "  curl -k -X OPTIONS -D- -o /dev/null '<a presigned URL>' \\"
      echo "    -H 'Origin: ${TEREN_APP_ORIGIN}' -H 'Access-Control-Request-Method: PUT'"
      echo
      echo "An allowed origin comes back with Access-Control-Allow-Origin; any other origin"
      echo "must come back without it."
      exit 0
      ;;
    *)
      echo "FATAL: bucket CORS could not be applied." >&2
      exit 1
      ;;
  esac
fi

echo "--- applied; reading it back from the bucket ---"
mc_run cors get "target/${TEREN_STORAGE_BUCKET}"

echo
echo "Done. Verify from a browser on ${TEREN_APP_ORIGIN} that an upload preflight succeeds;"
echo "a bucket that answers OPTIONS is the only proof that counts."

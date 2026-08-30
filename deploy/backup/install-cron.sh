#!/usr/bin/env bash
# Teren — install the nightly backup on the host that runs the stack.
#
#   deploy/backup/install-cron.sh [--hour 3] [--uninstall]
#
# Run this ON THE VPS, once, after the first deploy. It is idempotent: re-running replaces the
# entry rather than adding a second one.
#
# Cron rather than a scheduler container, deliberately. A backup that depends on the thing it is
# backing up being healthy is not a backup — if the compose stack is wedged, a container-based
# scheduler is wedged with it, whereas cron still fires and still produces a dump (or a loud
# failure) from outside.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hour=3
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hour) hour="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

marker="# teren-backup"
script="${here}/pg-backup.sh"
logfile="/var/log/teren-backup.log"

current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | grep -v -F "$marker" || true)"

if [ "$uninstall" -eq 1 ]; then
  printf '%s\n' "$cleaned" | crontab -
  echo "Removed the nightly Teren backup from crontab."
  exit 0
fi

[ -x "$script" ] || { echo "FATAL: $script is not executable" >&2; exit 1; }

# Local time on the box, which the compose stack sets to Europe/Belgrade by default. 03:00 is
# after the last plausible site entry of the day and before anyone opens the app.
line="0 ${hour} * * * ${script} >> ${logfile} 2>&1 ${marker}"

printf '%s\n%s\n' "$cleaned" "$line" | sed '/^$/d' | crontab -

echo "Installed:"
echo "  ${line}"
echo
echo "Verify tomorrow morning, and do not assume it worked:"
echo "  tail -n 40 ${logfile}"
echo "  ls -lh \${TEREN_BACKUP_DIR:-/var/backups/teren}"
echo
echo "Then rehearse a restore (deploy/backup/pg-restore.sh --local). C7 requires it, and an"
echo "unrehearsed backup is a rumour."

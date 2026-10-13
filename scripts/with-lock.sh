#!/usr/bin/env bash
# Serialize a command that touches the shared build output or runs the suites.
#
# WHY: every member works in the SAME working tree, and `pnpm build` rewrites
# lib/index.js and lib/client.js while the smoke suites load those very files.
# Two members building or testing at once therefore corrupt each other's run:
# a half-written bundle fails a test that is actually fine, and two React/jsdom
# suites at once can exhaust memory (observed: the process was OOM-killed with
# exit 137, which looks exactly like a failing assertion but is not one).
#
# Usage:  scripts/with-lock.sh pnpm test
#         scripts/with-lock.sh pnpm build
#
# The lock is an atomically-created directory (mkdir is atomic on POSIX), so it
# needs no extra dependency. A stale lock older than 30 minutes is reclaimed so
# a killed run cannot wedge the tree forever.
set -euo pipefail

LOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.build-lock"
WAIT_SECONDS="${BUILD_LOCK_WAIT_SECONDS:-1800}"
STALE_SECONDS=1800

acquired=0
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$acquired" -eq 0 ]; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    acquired=1
    # Record the holder so a human can see who is running.
    printf '%s\n' "pid=$$ cmd=$* started=$(date -u +%FT%TZ)" > "$LOCK_DIR/holder"
    break
  fi
  # Reclaim a lock whose holder died without cleaning up.
  if [ -d "$LOCK_DIR" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo "$(date +%s)") ))
    if [ "$age" -gt "$STALE_SECONDS" ]; then
      echo "with-lock: reclaiming a stale lock (${age}s old)" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "with-lock: timed out after ${WAIT_SECONDS}s waiting for $LOCK_DIR" >&2
    echo "with-lock: if no other member is running, delete $LOCK_DIR and retry" >&2
    exit 75
  fi
  sleep 2
done

cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT INT TERM

"$@"

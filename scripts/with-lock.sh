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
#
# Exit codes:
#   0        the command was run under the lock (otherwise the command's own
#            status is what you get: the script's last line is "$@")
#   75       the lock was NOT acquired — the wait timed out. Callers must treat
#            75 as "did not get the lock", NOT as a test failure.
#   78       the lock's mtime could not be read (EX_CONFIG): neither the BSD
#            (`stat -f %m`) nor the GNU (`stat -c %Y`) syntax worked, so
#            staleness cannot be judged at all. See "mtime probing" below.
#
# RISK: the stale threshold is a fixed 30 minutes (STALE_SECONDS). A command
# that legitimately runs longer than that will be judged stale and preempted —
# a waiting member reclaims the directory and a second writer starts on top of
# it, which is exactly the corruption this script exists to prevent. Keep
# builds and suites under 30 minutes.
#
# mtime probing: staleness needs the lock directory's mtime, and `stat` is not
# portable — `stat -f %m` is BSD/macOS, `stat -c %Y` is GNU/Linux. Both forms
# are probed (validating that the answer is all digits) instead of branching on
# `uname`, because `uname` says nothing about which `stat` is on PATH (GNU
# coreutils on macOS, busybox in containers, …). If neither form works we do
# NOT fall back to "age 0": that silently makes a stale lock un-reclaimable and
# wedges the tree for the full wait, which was the original bug. We also do not
# fall back to "assume stale", because reclaiming a lock whose holder is still
# alive would let two writers run at once. So we fail closed and loudly.
set -euo pipefail

LOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.build-lock"
WAIT_SECONDS="${BUILD_LOCK_WAIT_SECONDS:-1800}"
STALE_SECONDS=1800

# Print the mtime of $1 as epoch seconds; fail (non-zero) if no syntax works.
stat_mtime() {
  local out
  if out=$(stat -c %Y "$1" 2>/dev/null); then
    case "$out" in '' | *[!0-9]*) ;; *) printf '%s\n' "$out"; return 0 ;; esac
  fi
  if out=$(stat -f %m "$1" 2>/dev/null); then
    case "$out" in '' | *[!0-9]*) ;; *) printf '%s\n' "$out"; return 0 ;; esac
  fi
  return 1
}

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
    if ! lock_mtime=$(stat_mtime "$LOCK_DIR"); then
      echo "with-lock: cannot read the mtime of $LOCK_DIR:" >&2
      echo "with-lock: neither 'stat -c %Y' (GNU) nor 'stat -f %m' (BSD) worked." >&2
      echo "with-lock: refusing to guess — reclaiming a live lock would run two writers" >&2
      echo "with-lock: at once, and treating it as fresh would wedge the tree. Check the" >&2
      echo "with-lock: holder ('cat $LOCK_DIR/holder') and delete the directory by hand" >&2
      echo "with-lock: if nobody is running." >&2
      exit 78
    fi
    age=$(( $(date +%s) - lock_mtime ))
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

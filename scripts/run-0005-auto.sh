#!/bin/sh
# RUN-0005 end to end without a hand on it (S23): the campaign, then curve freeze, then the one V read, all by the
# deadline. Usage: scripts/run-0005-auto.sh <campaign minutes> <cutoff HH:MM> [campaign args…]
# - the campaign runs with --minutes M, so no attempt starts after open + M;
# - at the cutoff, a campaign still running (an attempt, a gate step or a slow generation in flight) is stopped with
#   SIGTERM, then SIGKILL after 20 s, and every Claude run under RUN-0005's scratch root is killed: the V read needs
#   its wall (TRIAL_WALL_S) before the deadline, and no rule constant is lowered to make room;
# - then loop/freeze.ts writes s_star_sha and vread.lock, and loop/vread.ts runs both arms on the V families with the
#   run's own runner (Claude; vread.ts refuses a runner other than conditions.json's).
# Logs: runs/RUN-0005/campaign.out, runs/RUN-0005/freeze-vread.out, runs/RUN-0005/auto.out.
HERE=$(cd "$(dirname "$0")/.." && pwd)
R=$HERE/runs/RUN-0005
M=$1; CUT=$2; shift 2
mkdir -p "$R"
LOG=$R/auto.out
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
CUT_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $CUT" +%s)
sh "$HERE/scripts/run-0005.sh" --minutes "$M" "$@" >> "$R/campaign.out" 2>&1 &
PID=$!
say "campaign pid $PID, --minutes $M, cutoff $CUT"
while kill -0 "$PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$CUT_EPOCH" ]; then
    say "cutoff $CUT reached with the campaign running: SIGTERM $PID"
    kill -TERM "$PID" 2>/dev/null; sleep 20; kill -KILL "$PID" 2>/dev/null
    pkill -f "ratchet-scratch-run5/ATT-" 2>/dev/null
    break
  fi
  sleep 10
done
wait "$PID" 2>/dev/null
say "campaign ended (exit $?)"
pkill -f "ratchet-scratch-run5/ATT-" 2>/dev/null
say "freeze"
sh "$HERE/scripts/run-0005.sh" --freeze >> "$R/freeze-vread.out" 2>&1
say "freeze exit $?"
say "vread"
sh "$HERE/scripts/run-0005.sh" --vread >> "$R/freeze-vread.out" 2>&1
say "vread exit $?"

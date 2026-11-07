#!/bin/sh
# Opens (or with --resume continues) RUN-0003: game 2 (game2/game2.gb, "HALOGEN", S21) played against the S0 core of
# RUN-0001 (dcc327c, branch core-game2 in ../ratchet-live-game2), beside RUN-0001 and RUN-0002.
# Usage: scripts/run-0003.sh --minutes M [--dry] [--resume]. Its runs dir is this checkout's runs/; every per-run
# directory is RUN-0003's own (loop/run-conditions.ts refuses one another run uses), it judges under RUN-0001's
# rule_version (--rules-as), and its spend guard reads RUN-0001's and RUN-0002's ledgers too (--spend-also).
# MAIN is the checkout RUN-0001 runs from (RATCHET_MAIN overrides it); RUN2 is the checkout RUN-0002 runs from
# (RATCHET_RUN2 overrides it).
HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${RATCHET_MAIN:-/Users/slavazinevich/GenDev/marmoset}
RUN2=${RATCHET_RUN2:-/Users/slavazinevich/GenDev/marmoset/.claude/worktrees/agent-af3dabdc2032cde61}
R=$HERE/runs/RUN-0003
cd "$HERE" || exit 1
mkdir -p "$R/ledger" "$R/skills/graduated" "$R/skills/shadow" "$R/skills/tombstones" "$R/evidence/incidents" "$R/traces"
export RATCHET_RUN=RUN-0003
export RATCHET_RUNS=$HERE/runs
export RATCHET_LEDGER=$R/ledger
export RATCHET_SKILLS=$R/skills
export RATCHET_EVIDENCE=$R/evidence
export RATCHET_TRACES=$R/traces
export RATCHET_SUBQ_CACHE=$R/subq-cache
export RATCHET_TELEMETRY_DIR=$R/telemetry
export RATCHET_CACHE=$HOME/.cache/ratchet-run3
export RATCHET_ROMS=$HOME/.cache/ratchet/roms
export RATCHET_SCRATCH=${TMPDIR:-/tmp}/ratchet-scratch-run3
export RATCHET_SERVER=http://localhost:8793
export RATCHET_LIVE=/Users/slavazinevich/GenDev/ratchet-live-game2
export RATCHET_LIVE_BRANCH=core-game2
export RATCHET_GAME=$HERE/game2/game2.gb
exec node --env-file-if-exists="$MAIN/.env" loop/campaign.ts --run RUN-0003 --source play --rules-as "$MAIN/runs/RUN-0001" --s0-commit dcc327c \
  --spend-also "$MAIN/ledger,$MAIN/runs,RUN-0001,$RUN2/runs/RUN-0001/muse-native.jsonl" \
  --spend-also "$RUN2/runs/RUN-0002/ledger,$RUN2/runs,RUN-0002" "$@"

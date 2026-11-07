#!/bin/sh
# Opens (or with --resume continues) RUN-0002, the CGB tier (D-0019, D-draft-concurrent-cgb-run), beside RUN-0001.
# Usage: scripts/run-0002.sh --minutes M [--resume]. Its runs dir is this checkout's runs/; every per-run directory is
# RUN-0002's own (loop/run-conditions.ts refuses one RUN-0001 uses), it judges under RUN-0001's rule_version
# (--rules-as), and its spend guard reads RUN-0001's ledger and muse-native readings too (--spend-also).
# MAIN is the checkout RUN-0001 runs from; RATCHET_MAIN overrides it.
HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${RATCHET_MAIN:-/Users/slavazinevich/GenDev/marmoset}
R=$HERE/runs/RUN-0002
cd "$HERE" || exit 1
mkdir -p "$R/ledger" "$R/skills/graduated" "$R/skills/shadow" "$R/skills/tombstones" "$R/evidence/incidents" "$R/traces"
export RATCHET_RUN=RUN-0002
export RATCHET_RUNS=$HERE/runs
export RATCHET_LEDGER=$R/ledger
export RATCHET_SKILLS=$R/skills
export RATCHET_EVIDENCE=$R/evidence
export RATCHET_TRACES=$R/traces
export RATCHET_SUBQ_CACHE=$R/subq-cache
export RATCHET_TELEMETRY_DIR=$R/telemetry
export RATCHET_CACHE=$HOME/.cache/ratchet-run2
export RATCHET_ROMS=$HOME/.cache/ratchet/roms
export RATCHET_SCRATCH=${TMPDIR:-/tmp}/ratchet-scratch-run2
export RATCHET_SERVER=http://localhost:8792
export RATCHET_LIVE=/Users/slavazinevich/GenDev/ratchet-live-cgb
export RATCHET_LIVE_BRANCH=core-cgb
export RATCHET_SPLITS=splits.json,splits-cgb.json
exec node --env-file-if-exists="$MAIN/.env" loop/campaign.ts --run RUN-0002 --source cgb-suite --rules-as "$MAIN/runs/RUN-0001" --s0-commit f4650f1 \
  --spend-also "$MAIN/ledger,$MAIN/runs,RUN-0001,$HERE/runs/RUN-0001/muse-native.jsonl" "$@"

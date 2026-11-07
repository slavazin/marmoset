#!/bin/sh
# Opens (or with --resume continues) RUN-0005: RUN-0001's loop on the same game (game/game.gb, Fernwake) with Claude Code
# as repairer and consolidator (S23, D-draft-claude-repairer), from the S0 core in ../ratchet-live-claude, branch
# core-claude at dcc327c (RUN-0001's S0 core tree). The Meta budget is spent; Claude runs on the owner's subscription.
# Usage: scripts/run-0005.sh --minutes M [--resume] [--dry].
# Every per-run directory is RUN-0005's own (loop/run-conditions.ts refuses one another run uses). It judges under
# RUN-0001's rule_version (--rules-as). It spends no Meta dollars, so no other run joins its spend guard.
# MAIN is the checkout RUN-0001 runs from (RATCHET_MAIN overrides it); its .env supplies the Gemini player key.
HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${RATCHET_MAIN:-/Users/slavazinevich/GenDev/marmoset}
R=$HERE/runs/RUN-0005
cd "$HERE" || exit 1
mkdir -p "$R/ledger" "$R/skills/graduated" "$R/skills/shadow" "$R/skills/tombstones" "$R/evidence/incidents" "$R/traces"
export RATCHET_RUN=RUN-0005
export RATCHET_REPAIRER=claude
export RATCHET_REPAIRER_MODEL=${RATCHET_REPAIRER_MODEL:-claude-sonnet-5}
export RATCHET_RUNS=$HERE/runs
export RATCHET_LEDGER=$R/ledger
export RATCHET_SKILLS=$R/skills
export RATCHET_EVIDENCE=$R/evidence
export RATCHET_TRACES=$R/traces
export RATCHET_SUBQ_CACHE=$R/subq-cache
export RATCHET_TELEMETRY_DIR=$R/telemetry
export RATCHET_CACHE=$HOME/.cache/ratchet-claude
export RATCHET_ROMS=$HOME/.cache/ratchet/roms
export RATCHET_SCRATCH=${TMPDIR:-/tmp}/ratchet-scratch-run5
export RATCHET_SERVER=http://localhost:8795
export RATCHET_LIVE=/Users/slavazinevich/GenDev/ratchet-live-claude
export RATCHET_LIVE_BRANCH=core-claude
export RATCHET_SPLITS=splits.json
export RATCHET_GAME=$HERE/game/game.gb
if [ "${1:-}" = "--freeze" ]; then exec node --env-file-if-exists="$MAIN/.env" loop/freeze.ts; fi
if [ "${1:-}" = "--vread" ]; then shift; exec node --env-file-if-exists="$MAIN/.env" loop/vread.ts "$@"; fi
exec node --env-file-if-exists="$MAIN/.env" loop/campaign.ts --run RUN-0005 --source play --game "$HERE/game/game.gb" \
  --rules-as "$MAIN/runs/RUN-0001" --s0-commit dcc327c "$@"

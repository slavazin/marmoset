#!/bin/sh
# Opens (or with --resume continues) RUN-0004: explorer play on the owner-supplied Mario & Yoshi ROM (games.json
# mario-yoshi-eu, never committed), from its registry start state (the title; D-draft-foreign-rom-start-state), on the
# S0 core in ../ratchet-live-my, branch core-my at dcc327c (RUN-0001's S0 core tree).
# Usage: scripts/run-0004.sh --minutes M [--resume] [--dry].
# Every per-run directory is RUN-0004's own (loop/run-conditions.ts refuses one another run uses). It judges under
# RUN-0001's rule_version (--rules-as). Its spend guard also reads RUN-0001, RUN-0002 and RUN-0003 (--spend-also).
# MAIN is the checkout RUN-0001 runs from (RATCHET_MAIN overrides it); its .env supplies the Muse key (loop/llm.ts apiKey).
# The ROM is read from $RATCHET_ROM_MARIO_YOSHI_EU (default ~/.cache/ratchet/games/mario-yoshi-eu.gb), sha-checked by
# lockstep/games.ts romPathOf.
HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${RATCHET_MAIN:-/Users/slavazinevich/GenDev/marmoset}
RUN2=${RATCHET_RUN2_RUNS:-/Users/slavazinevich/GenDev/marmoset/.claude/worktrees/agent-af3dabdc2032cde61/runs}
RUN3=${RATCHET_RUN3_RUNS:-/Users/slavazinevich/GenDev/marmoset/.claude/worktrees/agent-a7a830c0c8b72dcca/runs}
R=$HERE/runs/RUN-0004
cd "$HERE" || exit 1
mkdir -p "$R/ledger" "$R/skills/graduated" "$R/skills/shadow" "$R/skills/tombstones" "$R/evidence/incidents" "$R/traces"
export RATCHET_RUN=RUN-0004
export RATCHET_RUNS=$HERE/runs
export RATCHET_LEDGER=$R/ledger
export RATCHET_SKILLS=$R/skills
export RATCHET_EVIDENCE=$R/evidence
export RATCHET_TRACES=$R/traces
export RATCHET_SUBQ_CACHE=$R/subq-cache
export RATCHET_TELEMETRY_DIR=$R/telemetry
export RATCHET_CACHE=$HOME/.cache/ratchet-run4
export RATCHET_ROMS=$HOME/.cache/ratchet/roms
export RATCHET_ROM_MARIO_YOSHI_EU=${RATCHET_ROM_MARIO_YOSHI_EU:-$HOME/.cache/ratchet/games/mario-yoshi-eu.gb}
export RATCHET_SCRATCH=${TMPDIR:-/tmp}/ratchet-scratch-run4
export RATCHET_SERVER=http://localhost:8794
export RATCHET_LIVE=/Users/slavazinevich/GenDev/ratchet-live-my
export RATCHET_LIVE_BRANCH=core-my
export RATCHET_SPLITS=splits.json
exec node --env-file-if-exists="$MAIN/.env" loop/campaign.ts --run RUN-0004 --source play --game mario-yoshi-eu \
  --rules-as "$MAIN/runs/RUN-0001" --s0-commit dcc327c \
  --spend-also "$MAIN/ledger,$MAIN/runs,RUN-0001,$RUN2/RUN-0001/muse-native.jsonl" \
  --spend-also "$RUN2/RUN-0002/ledger,$RUN2,RUN-0002" \
  --spend-also "$RUN3/RUN-0003/ledger,$RUN3,RUN-0003" "$@"

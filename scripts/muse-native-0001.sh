#!/bin/sh
# Starts the muse-native watcher (D-0013, loop/muse-native-watch.ts) for RUN-0001. It reads RUN-0001's generations
# from MAIN's runs/ and its live clone read-only (git archive), and writes readings under this checkout's runs/RUN-0001/
# (--out), so it writes nothing in MAIN. Its spend guard reads RUN-0001 and RUN-0002 together (--spend-also).
# MAIN is the checkout RUN-0001 runs from; RATCHET_MAIN overrides it.
HERE=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${RATCHET_MAIN:-/Users/slavazinevich/GenDev/marmoset}
cd "$HERE" || exit 1
export RATCHET_RUN=RUN-0001
export RATCHET_LEDGER=$MAIN/ledger
export RATCHET_LIVE=/Users/slavazinevich/GenDev/ratchet-live
export RATCHET_CACHE=$HOME/.cache/ratchet-native1
export RATCHET_ROMS=$HOME/.cache/ratchet/roms
export RATCHET_SCRATCH=${TMPDIR:-/tmp}/ratchet-scratch-native1
export RATCHET_TELEMETRY_DIR=$HERE/runs/RUN-0001/muse-native-telemetry
export RATCHET_SERVER=http://localhost:8793
exec node --env-file-if-exists="$MAIN/.env" loop/muse-native-watch.ts --run RUN-0001 --runs "$MAIN/runs" --out "$HERE/runs" \
  --home "$HOME/.cache/ratchet-native1/muse-native-home" \
  --spend-also "$HERE/runs/RUN-0002/ledger,$HERE/runs,RUN-0002" "$@"

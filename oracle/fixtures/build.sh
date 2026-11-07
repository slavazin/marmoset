#!/bin/sh
# Builds oracle/fixtures/counter.gb from counter.asm with RGBDS.
set -eu
PATH="$PATH:/opt/homebrew/bin"
cd "$(dirname "$0")"
out="${TMPDIR:-/tmp}/ratchet-counter.$$"
mkdir -p "$out"
rgbasm -o "$out/counter.o" counter.asm
rgblink -o counter.gb "$out/counter.o"
rgbfix -v -p 0xFF -t COUNTER counter.gb
rm -rf "$out"

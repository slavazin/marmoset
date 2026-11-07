#!/bin/sh
# Builds game2/game2.gb ("HALOGEN") from game2/src with GBDK-2020 (pnpm game2:build).
# lcc comes from $GBDK_HOME/bin, else ~/.cache/ratchet/tools/gbdk/bin.
# Link flags: 32 KiB ROM-only cart (lcc's default, no -yt/-yo), _DATA moved to 0xC100 so the
# SPEC §6.17 contract bytes at 0xC0F0-0xC0F6 hold no C variable.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
gbdk="${GBDK_HOME:-$HOME/.cache/ratchet/tools/gbdk}"
lcc="$gbdk/bin/lcc"
if [ ! -x "$lcc" ]; then
  echo "game2:build: lcc not found at $lcc; set GBDK_HOME to a GBDK-2020 install" >&2
  exit 1
fi
out="$here/build"
mkdir -p "$out"
for f in main art; do
  "$lcc" -c -o "$out/$f.o" "$here/src/$f.c"
done
"$lcc" -Wl-b_DATA=0xC100 -Wl-m -Wm-yn"HALOGEN" \
  -o "$here/game2.gb" "$out/main.o" "$out/art.o"
echo "game2:build: $here/game2.gb ($(wc -c < "$here/game2.gb" | tr -d ' ') bytes)"

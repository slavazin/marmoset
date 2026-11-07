#!/bin/sh
# Builds game/game.gb from game/src with GBDK-2020 (pnpm game:build).
# lcc comes from $GBDK_HOME/bin, else ~/.cache/ratchet/tools/gbdk/bin.
# Link flags: MBC1 cart (-yt0x01), 4 ROM banks (-yo4: bank 0 code, banks 1-3 one level each),
# _DATA moved to 0xC100 so the SPEC §6.17 contract bytes at 0xC0F0-0xC0F6 hold no C variable.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
gbdk="${GBDK_HOME:-$HOME/.cache/ratchet/tools/gbdk}"
lcc="$gbdk/bin/lcc"
if [ ! -x "$lcc" ]; then
  echo "game:build: lcc not found at $lcc; set GBDK_HOME to a GBDK-2020 install" >&2
  exit 1
fi
out="$here/build"
mkdir -p "$out"
for f in main art level1 level2 level3; do
  "$lcc" -c -o "$out/$f.o" "$here/src/$f.c"
done
"$lcc" -Wl-yt0x01 -Wl-yo4 -Wl-b_DATA=0xC100 -Wl-m -Wm-yn"FERNWAKE" \
  -o "$here/game.gb" "$out/main.o" "$out/art.o" "$out/level1.o" "$out/level2.o" "$out/level3.o"
echo "game:build: $here/game.gb ($(wc -c < "$here/game.gb" | tr -d ' ') bytes)"

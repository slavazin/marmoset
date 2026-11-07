#!/usr/bin/env bash
# Collects finished runs into one runs/ directory (S24) so the server's run picker serves them all.
#
#   scripts/collect-runs.sh [--dest <runs dir>] [--dry-run] SPEC...
#   SPEC = RUN-NNNN=<source dir>[:<sub dir under dest/RUN-NNNN>[:<file glob>]]
#
# Each SPEC copies every regular file under <source dir> to <dest>/RUN-NNNN/<sub dir>/, keeping relative paths; with a
# glob, only files whose basename matches it. --dest defaults to the runs/ beside this script.
# Refuses (exit 3, nothing copied) when any target file exists already: a collected run is never overwritten.
# Leaves out ROM bytes (exit 0, each skipped file listed on stderr): a file named *.gb / *.gbc in any letter case, and
# any file carrying the cartridge header's Nintendo logo at 0x104 (lockstep/games.test.ts LOGO). ROM-derived files the
# UI shows (RUN-0004 evidence PNGs and telemetry frames, start/ states) are copied and kept out of git by .gitignore.
# scripts/collect-runs.test.ts runs it against temp dirs.
#
# Worktree sources (orchestrator runs this after each run ends; RUN-0005 last):
#   RUN-0002=<wt-af3d…>/runs/RUN-0002  RUN-0001=<wt-af3d…>/runs/RUN-0001:.:muse-native*
#   RUN-0003=<wt-a7a8…>/runs/RUN-0003
#   RUN-0004=<wt-af97…>/runs/RUN-0004  RUN-0004=<wt-af97…>/evidence/incidents:evidence/incidents
#   RUN-0005=<wt-a302…>/runs/RUN-0005
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../runs"
dry=0
specs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) dest="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) specs+=("$1"); shift ;;
  esac
done
[ ${#specs[@]} -gt 0 ] || { echo "collect-runs: no SPEC given (RUN-NNNN=<source dir>[:<sub>[:<glob>]])" >&2; exit 2; }
mkdir -p "$dest"
dest="$(cd "$dest" && pwd -P)"

LOGO="ceed6666cc0d000b"
is_rom() {
  local f="$1" lower
  lower="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in *.gb|*.gbc) return 0 ;; esac
  [ "$(xxd -s 260 -l 8 -p "$f" 2>/dev/null)" = "$LOGO" ]
}

plan="$(mktemp)"; trap 'rm -f "$plan"' EXIT
conflicts=0
for spec in "${specs[@]}"; do
  run="${spec%%=*}"; rest="${spec#*=}"
  [[ "$run" =~ ^RUN-[0-9]{4}$ ]] || { echo "collect-runs: bad run id in '$spec'" >&2; exit 2; }
  src="${rest%%:*}"; sub="."; glob="*"
  if [[ "$rest" == *:* ]]; then r2="${rest#*:}"; sub="${r2%%:*}"; [[ "$r2" == *:* ]] && glob="${r2#*:}"; fi
  [ -d "$src" ] || { echo "collect-runs: no source directory $src" >&2; exit 2; }
  case "$sub" in /*|*..*) echo "collect-runs: sub dir must stay under the run: $sub" >&2; exit 2 ;; esac
  srcp="$(cd "$src" && pwd -P)"
  case "$srcp/" in "$dest/$run/"*) echo "collect-runs: $src is inside the destination" >&2; exit 2 ;; esac
  while IFS= read -r -d '' f; do
    rel="${f#"$srcp"/}"
    # shellcheck disable=SC2254
    case "$(basename "$f")" in $glob) ;; *) continue ;; esac
    if is_rom "$f"; then echo "collect-runs: left out ROM bytes: $f" >&2; continue; fi
    if [ "$sub" = "." ]; then tgt="$dest/$run/$rel"; else tgt="$dest/$run/$sub/$rel"; fi
    if [ -e "$tgt" ]; then echo "collect-runs: refuses to overwrite $tgt" >&2; conflicts=$((conflicts + 1)); continue; fi
    printf '%s\0%s\0' "$f" "$tgt" >> "$plan"
  done < <(find "$srcp" -type f -print0)
done
if [ "$conflicts" -gt 0 ]; then echo "collect-runs: $conflicts target files exist; nothing copied" >&2; exit 3; fi

n=0
while IFS= read -r -d '' f && IFS= read -r -d '' tgt; do
  n=$((n + 1))
  [ "$dry" = 1 ] && { echo "would copy $f -> $tgt"; continue; }
  mkdir -p "$(dirname "$tgt")"
  cp -p "$f" "$tgt"
done < "$plan"
echo "collect-runs: $n files $([ "$dry" = 1 ] && echo 'planned' || echo 'copied') into $dest"

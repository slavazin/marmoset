#!/bin/sh
# S1 Accept as one check for scripts/api-loop.ts: typecheck core/, the contract tests, and the base-suite line.
# Exits 0 only when blargg 15/15, mooneye:mbc1 12/12 and dmg-acid2 1/1 print and the contract tests pass.
cd "$(dirname "$0")/.." || exit 1
fail=0
echo "== tsc (core/ lines only)"
node_modules/.bin/tsc --noEmit -p . 2>&1 | grep '^core/' | head -40 && fail=1
echo "== contract tests"
node --test core/contract.test.ts 2>&1 | grep -E '^not ok|^ok|AssertionError|Error|expected|actual|# (pass|fail)' | head -40
node --test core/contract.test.ts >/dev/null 2>&1 || fail=1
echo "== base suites"
out=$(node suites/run.ts --split base --core-dir core 2>&1)
echo "$out"
echo "$out" | grep -q '^blargg 15/15' || fail=1
echo "$out" | grep -q '^mooneye:mbc1 12/12' || fail=1
echo "$out" | grep -q '^dmg-acid2 1/1' || fail=1
exit $fail

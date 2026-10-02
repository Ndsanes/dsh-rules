#!/usr/bin/env bash
# Prove that a TTSR rule really interrupts violating model output.
#
# Runs the same prompt twice against an isolated DSH_HOME: once with a rule
# that interrupts, once with an otherwise identical rule that only warns. The
# difference between the two transcripts is the evidence.
#
# Usage: scripts/verify-interrupt.sh [dsh-home]
#
# The second argument is the prepared rule fixture: a directory holding
# `.omp/rules/no-banana.md` and `.omp/rules/no-banana-quiet.md`. See README.

set -euo pipefail

# Not `/tmp` directly: on macOS the system reaps files there that have not been
# opened for a few days, which silently deleted this fixture's rule files between
# runs and left `mv` failing on a path the user believed was permanent.
TMP_ROOT="${TMPDIR:-/tmp}"
DSH_HOME_DIR="${1:-$TMP_ROOT/dsh-e2e}"
FIXTURE="${2:-$TMP_ROOT/dsh-interrupt-fixture}"
PROFILE=rules
RULES="$FIXTURE/.omp/rules"
OUT="$(mktemp -d "$TMP_ROOT/dsh-interrupt-out.XXXXXX")"
# The prompt forces the forbidden token, so the violation is deterministic
# rather than dependent on the model choosing to comply on its own.
PROMPT="Repeat this word exactly, with no other text: banana"

RULE_FILES=(no-banana.md no-banana-quiet.md)

# Park both rules outside the fixture so each case sees exactly one of them.
# Every exit path puts them back: the fixture is the user's prepared evidence,
# and `set -e` used to abort mid-run and leave it with neither rule in it.
restore_rules() {
  for rule in "${RULE_FILES[@]}"; do
    [ -f "$OUT/$rule" ] && mv -f "$OUT/$rule" "$RULES/$rule"
  done
  return 0
}
trap restore_rules EXIT

for rule in "${RULE_FILES[@]}"; do
  if [ ! -f "$RULES/$rule" ]; then
    echo "missing fixture rule: $RULES/$rule" >&2
    echo "prepare a fixture directory with .omp/rules/ holding:" >&2
    for want in "${RULE_FILES[@]}"; do echo "  $want" >&2; done
    exit 2
  fi
done

echo "dsh:      $(dsh --version)"
echo "DSH_HOME: $DSH_HOME_DIR"
echo "profile:  $PROFILE"
echo "fixture:  $FIXTURE"
echo

for rule in "${RULE_FILES[@]}"; do
  mv "$RULES/$rule" "$OUT/$rule"
done

run_case() {
  local name="$1" rule="$2"
  cp "$OUT/$rule" "$RULES/$rule"
  echo "--- case: $name (rule: $rule)"
  # `set -e` must not abort here: a provider error is a result to report, not a
  # reason to stop before the second case runs.
  ( cd "$FIXTURE" && DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" "$PROMPT" ) \
    > "$OUT/$name.txt" 2>&1 || true
  tail -6 "$OUT/$name.txt"
  echo
  rm -f "$RULES/$rule"
}

run_case interrupting no-banana.md
run_case warning-only no-banana-quiet.md

# Restore before the summary so the transcripts stay readable and the fixture is
# whole again even if the caller only reads the tail of this output.
restore_rules
trap - EXIT

echo "transcripts: $OUT"
echo
echo "What to compare:"
echo "  interrupting case -> the first attempt is aborted; the transcript shows a"
echo "    <system-interrupt> message followed by a second, compliant answer."
echo "  warning-only case -> one pass, a <system-reminder> folded in, no retry."
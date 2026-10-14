#!/usr/bin/env bash
# Launch pi in tmux with the scripted provider, self-compact (footer off) and
# pi-statusline (footer on), and capture the footer. This is the integration
# check: self-compact must not install a footer, and pi-statusline must draw its
# cutoff tick and phase tag from the feed.
#
# Thresholds are overridable so the tag can be shown without depending on the
# scripted agent walking up to a threshold: under pi 1.2.0 the scripted run
# stalls after its first turn (upstream's own scripts/tui-smoke.sh fails the same
# way), so the real-token config only ever reaches the idle state.
#   SOFT/AT/BUFFER   thresholds to launch with
#   OUT              capture path
#   EXPECT_TAG       1 when the thresholds should be crossed at ~1.1k tokens
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
STATUSLINE="${STATUSLINE:-$HOME/Developer/pi-statusline/src/index.ts}"
SOFT="${SOFT:-60k}"
AT="${AT:-120k}"
BUFFER="${BUFFER:-40k}"
EXPECT_TAG="${EXPECT_TAG:-0}"
OUT="${OUT:-$ROOT/verification/tui-statusline.txt}"
DIR="$ROOT/verification/tmp/tui-statusline"
rm -rf "$DIR"; mkdir -p "$DIR/.pi" "$DIR/sessions"
# footer:false is the integration switch under test: the footer is pi-statusline's.
echo '{"compaction":{"enabled":true,"reserveTokens":16384,"keepRecentTokens":1500},"selfCompact":{"footer":false}}' > "$DIR/.pi/settings.json"
SESSION="sc-sl-$$"
tmux kill-session -t "$SESSION" 2>/dev/null || true
# Lands at 220k, which is still above self_compact's own placeholder threshold.
tmux new-session -d -s "$SESSION" -x 160 -y 42 -c "$DIR" \
  "env PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 SC_FAKE_WINDOW=200000 SC_FAKE_BASE=5000 SC_FAKE_STEP=20000 SC_FAKE_SCENARIO=ignore-until-forced SC_FAKE_TRACE=$DIR/trace.jsonl \
   pi --no-extensions --no-skills --no-prompt-templates --no-context-files -a --no-session \
      -e $ROOT/extensions/self-compact/self-compact.ts -e $ROOT/tests/harness/fake-provider.ts -e $STATUSLINE \
      --model fake/scripted --compact-soft-at $SOFT --compact-at $AT --compact-buffer $BUFFER; sleep 5"
sleep 6
{
  echo "### startup footer (thresholds: notice $SOFT, warning $AT, buffer $BUFFER)"
  tmux capture-pane -t "$SESSION" -p | tail -8
} > "$OUT"
tmux send-keys -t "$SESSION" "Start the scripted work." Enter
sleep 10
{
  echo; echo "### after the scripted run (notice -> warning -> forced -> self_compact -> compaction)"
  tmux capture-pane -t "$SESSION" -p -S -3000 | grep -v '^\s*$' | tail -300
} >> "$OUT"
tmux send-keys -t "$SESSION" "/quit" Enter
sleep 2
tmux kill-session -t "$SESSION" 2>/dev/null || true
echo "captured to $OUT"

status=0
check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; status=1; fi; }
echo "checks:"
# The bar is pi-statusline's, so it must be the 16-cell one with a dot in it.
check "pi-statusline draws a 16-cell bar with a cutoff tick" "grep -qE '[━─·]{16}' '$OUT'"
check "the cutoff tick appears" "grep -qE '[━─]·|·[━─]' '$OUT'"
check "self-compact's own 20-cell bar is absent" "! grep -qE '\[[#=~!|-]{20}\]' '$OUT'"
if [ "$EXPECT_TAG" = "1" ]; then
  check "the phase tag is rendered after the threshold is crossed" "grep -qE 'NOTICE|WARNING|FORCED|COMPACTING|COMPACTED' '$OUT'"
  check "the tools-locked reason reaches the transcript" "grep -qE 'self_compact' '$OUT'"
fi
exit $status

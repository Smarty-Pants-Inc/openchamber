#!/bin/bash
# run-side.sh <dist dir> <out name>: restart candidate c394 with that page dist, add project B with a Pi, run healthy.ts.
set -u
L=$(cd "$(dirname "$0")" && pwd); DIST=$1; NAME=$2
S=/home/paul/smarty/smarty-pants/projects/smarty-code/.worktrees/code-perf/.local/m867.G31o/scratch
[ -f "$L/h-stack.pid" ] && kill -TERM "$(cat "$L/h-stack.pid")" 2>/dev/null; sleep 20
cd "$S"; setsid nice -n 5 /home/paul/.local/share/smarty-dev/bun/1.4.0/bin/bun integration/candidate/stack.ts --name c394 --port 43481 --read-only \
  --oc-dist "$DIST" --gateway "$S" --purpose "Code candidate #394 (healthy path)" > "$L/$NAME-stack.log" 2>&1 &
echo $! > "$L/h-stack.pid"
for i in $(seq 1 60); do grep -q candidate-ready "$L/$NAME-stack.log" && break; sleep 4; done
R=/tmp/sc-direct-ordinary-candidate-c394; B=$R/projects/candidate-b
mkdir -p $B && git init -q $B && echo "# B" > $B/README.md && git -C $B -c user.name=c -c user.email=c@example.test add . && git -C $B -c user.name=c -c user.email=c@example.test commit -qm b
OUT=$(herdr worktree open --path $B --cwd $B --label "Code candidate #394 (healthy path), project B" --no-focus)
PANE=$(echo "$OUT" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
herdr pane run "$PANE" "cd $B && PI_CODING_AGENT_DIR=/home/paul/.local/share/smarty-code/acceptance/human-identity-20260921/pi-agent PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 /home/paul/.local/share/node-v24.18.0-linux-x64/bin/node $R/release/repos/pi/packages/coding-agent/dist/cli.js" >/dev/null
sleep 35; cd "$L"; rm -rf "$L/$NAME"
PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/smarty-code/playwright-browsers timeout 600 xvfb-run -a -s "-screen 0 1600x1000x24" \
  /home/paul/.local/share/node-v24.18.0-linux-x64/bin/node --experimental-strip-types healthy.ts $R "$L/$NAME" 43481 > "$L/$NAME.log" 2>&1
echo DONE >> "$L/$NAME.log"

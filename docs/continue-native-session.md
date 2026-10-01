# Continue in a new Pi — client and paired release gate

This client is paired with Smarty Code's restored native resume integration for
[smarty-code#365](https://github.com/Smarty-Pants-Inc/smarty-code/issues/365).
Pi's native file/session, not a copied conversation, remains authoritative.
The current round restores the semantic reviewed server diff from PR373 head
`f62e8cd5fe40aceec95a656affae5dc71028822c` against
`52798147af76ebb9b36a6f3fb05ad087aaec1313` on current Code sources; that PR was
closed and unmerged, not an adopted server or current qualification result.
The paired round comment binds the exact successor Code/OC commits, checked source
and the release adoption gate. An unmerged server branch is not working deployment.

## Client checks and recovery

A new Continue action is available only for an ended Code-created scoped row with
current selected-runtime/auth capability `ordinaryResume: 1`. The client also checks
that capability before POST. A healthy selected project advertises it only if the
server's actual resume method exists; unsupported gateways cannot expose the action.
The server still authenticates and enforces original actor/native-file ownership.

ONE POST carries its own client request ID. Failed/uncertain results retain request,
operation, session and directory identity and permit only operation-read recovery.
The actual parent keeps the recovery banner for pending/unknown starts even if the
row changes ended → unavailable. Check again never launches and cannot overwrite a
newer Continue cohort. A ready operation queues a fresh authoritative tail behind
older loader work and clears recovery only when that current loader/runtime accepts
a resolved writable view. Failure/readonly history leaves recovery reachable.

Each capability, resume POST, operation GET or list wait has a75s limit, including
its response body. The POST limit exceeds the server's60s handoff. These are
separate waits, not a75s bound for the whole action. A timeout retains the original
request and last known operation as unknown, so Check again stays reachable after
a remount. Only reads recover it. A late reply cannot publish over a newer attempt,
and a browser abort does not prove that native launch was cancelled.

A ready operation's fresh-history observation also has a75s limit. Expiring that
observation does not cancel the loader's shared read or its queued freshness work.
Recovery clears only after the current loader accepts a resolved writable view;
a timed-out or failed list is never treated as an authoritative empty list.

Late session-only project trust is server-owned by the existing operation GET/list
seam after the60s POST handoff. An exclusive attempt precedes the native choice;
concurrent reads, lost replies and recreated operation owners cannot replay it.
No client phase script, terminal Ready command or automatic second POST substitutes
for that transition.

## Evidence boundary

Actual mounted ChatContainer/banner, real stores/status hook/HTTP/SDK/message loader
cover the old-page/fresh-page and Check/Continue races. Leaf presentation components
are explicitly stubbed in that fixture; it is not a recorded real browser. Native
file-loaded SDK tests support trust/retained-history/once-only input correctness,
not real CLI model restoration or served acceptance. Exact-head owning CI/security,
branding/type/build gates and paired release adoption remain separate.

## Named deferred served-proof gate

**Accountable proof owner: code-lead; source/evidence attribution: code-catalog.**
Before merge, the repository owner must record acceptance of this gate on OC#230
and the paired Code PR. Before execution code-lead books ONE named Dev1 operator,
dedicated test identity, owned project/session, finite resource/timebox and exact
qualified artifact. This record is not execution/activation authority.

Trigger: both changes land, exact landed OC pin is adopted into Code, and code-lead
promotes the SAME qualified artifact on an approved green-gate release with rollback.
Due: the first capability-exposing release's recorded journey and independent audit
within24h, before #365 is accepted. Source/mocked/browser-component logs or proof on
an older release cannot satisfy this requirement.

Record these exact served steps on the dedicated signed-in stand-in's real Code:
1. Open ONE owned ended Code-created scoped row with a real earlier exchange. Bind
   original project/native path/UUID/journal prefix/leaf/model/effort/tools and prove
   no live writer/tab. Show the actual ended banner and old rendered conversation.
2. Click Continue once. Retain client request/operation/trust receipts; record ONE
   new Herdr tab/native Pi in that project on the ORIGINAL session file. No second
   writer, manual model override or terminal `/code-ready` to fabricate readiness.
3. Show the writable row/history, same old native/rendered history/model/effort/tools
   and browser reconnect, without another Continue. Uncertain launch means reads
   only; pending/unknown recovery remains reachable.
4. Once the current view is admitted, issue ONE separately declared browser Send.
   Correlate one native receipt/provider reply to real browser incremental output
   and original Herdr terminal, then committed reload. No replay on uncertain Send.
5. Separately scoped negatives prove live/holding owners refuse another Pi, failed
   starts remain view-only with a plain reason, and actual late trust is answered
   once after handoff. Bind each case before its effects; no uncertain-action reuse.
6. Retain video/screens/DOM/network/SSE, actual PID/tab/extension/artifact identity,
   native journal/operation receipts and cleanup. Independent audit records each
   acceptance item PASS/FAIL/NOT_QUALIFIED, not merely API equality.

The detailed operator/rollback contract is the paired Code document
`docs/continue-native-session.md`, delivered with the reviewed source.

**Revert/disable condition:** second writer/launch, replay, changed old history or
model/effort, lost recovery or unqualified once-only Send immediately blocks
acceptance and further feature effects. If the journey/audit is not qualified
within24h, code-lead requests a reviewed protected paired feature-disable before
continued exposure: omit new resume capability/launch, hide new Continue, preserve
operation-read recovery and already-running native work. Never restore an old
unchecked Continue client, erase claims/journals, kill unknown owners, rewind native
or auth state, or unlink living endpoints. Holds, normal reviews/CI and independent
acceptance remain; only the owning release/integration route may land/activate.

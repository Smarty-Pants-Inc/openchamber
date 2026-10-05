# OpenChamber #536 A5 — exact-candidate signed-in walk

## Disposition

**The requested A5 controls were observed through the real candidate application. The overall scratch runner remains FAIL**, because it then attempted an additional cookie-person A→B probe and refused `Deadline: B owner read`. That extra probe is not the required **displayed-session** A→B transition. `result.json`, `run.rc`, the failed screenshot and every preceding failed attempt are retained unchanged. This is application evidence for the owner/Astra to judge, not a merge, CI, security or independent acceptance award.

The final fresh candidate ran 2026-10-05 **16:45:30–16:46:50Z**, on Ryzen 5. Media/provenance and cleanup readback finished inside the original 17:39Z box; the admitted extension to18:30Z was unnecessary. No product source change or GitHub write was made. #453 remains deferred.

## Exact topology and tooling

- Code base/canonical release: `86298c7c352e0212c72864d318fa9da10e104385` (Release3.64), copied exclusively to `/home/paul/lanes/demo-headed/.local/536-a5-release`.
- UI source: `70a317dd238eb70bbfccea2c96f48bd4663f3206`, tree `00a412a539c9644673b860b8fd65d9d87fc76299`, package version1.24.2.
- Pi source: `1cd7a76af2cdaab66d68ec9378e9898bff362dac`. Real disposable native TUI sessions with ordinary in-process enrollment; no second runtime or transcript replay.
- As granted, this is **Code3.64 server/gateway plus the built OC70 UI dist**. OC70's changed server tree was NOT silently overlaid. This does not qualify every OC70 server change or a later installed fleet pin.
- Exact R4 dependency closure supplied by Lead; R4/R5 **root file-list** receipts both `32757deab0c0f6c24e9376f2e683b7bef717c31c1677fb53724963b54f587fdf`. This is not an independently computed all-package-byte digest. No package/lock substitution.
- Two unsuccessful offline install attempts are retained. The supplied closure was then copied into the private exact checkout. `build:web` log records Vite completion and PWA completion; its original outer-shell RC receipt was lost when the tool timeout detached the child, so no retained build-RC0 is invented. The finite build ended and generated the separately inventoried dist.
- Build used **Bun1.4.0**, Node24.19.0, `NODE_OPTIONS=--max-old-space-size=4096`. Source declares Bun1.4.2; Lead explicitly admitted1.4.0 as a disclosed tooling limit. This is NOT Bun1.4.2 baseline-CI proof. Build warnings remain in `build.log`.
- All **1,023 dist files** match the built inventory after restoring the index. `dist-SHA256SUMS` binds them. Index SHA256: `0e1b60c77796bcfabf3793e2b220b6748686557cab608a1a38af0f3a6b028f3b`.
- Candidate only: `http://127.0.0.1:23711`, gateway23712, private state/projects/profile under `/tmp/sc-direct-ordinary-vdG0Qq/`. No ordinary service or protected profile was driven.
- Sign-in: **official BetterAuth `testUtils` fixture, NOT Google OAuth**. Two disposable people; token/secret values were not logged. Provider: owned loopback fixture `smarty-fixture/terra`, high effort, retry disabled; not a public-provider or live-account proof.
- Native A: `01a10cf4-d2ba-7547-821c-ebcaa7a5267c`, `/tmp/sc-direct-ordinary-vdG0Qq/project`, PID548460, pane `w9M:p1`.
- Native B: `01a10cf4-e262-743a-b762-99c8974a735a`, `/tmp/sc-direct-ordinary-vdG0Qq/person-b-project`, PID549467, pane `w9N:p1`.

## Requested controls and observed evidence

| A5 control | Actual observation | Evidence |
|---|---|---|
| Signed-in managed sidebar and intended existing native session | Person A verified by real auth endpoint; both private project roots listed; A's seed history readable | `01-sidebar-native-history.png`, native custody, steps |
| Separate Send | One explicit browser Send of a multiline fixture marker, in A; two seeded fixture turns + one browser turn =3 | `send-once-attempted`, native journal, fixture turn counter |
| Separate Stop | Enabled real Stop clicked once; held provider connection settled; no new provider turn; native assistant `stopReason=aborted`, stopped reply shown | `02-live-before-stop.png`, `03-stopped.png`, `native-after-stop.json` |
| Reload same session/history plus expected saved draft | Persistence initially ON; unsent `UNSENT_536_A5_DRAFT_KEEP`; manual reload; same A URL/history and text restored | `04-saved-draft.png`, `05-reload-retained.png`, steps |
| Persistence OFF | Real settings UI checkbox unchecked, no store injection | `06-persistence-off.png` |
| Retained memory-only text and attachment | `MEMORY_ONLY_536_A_KEEP` plus owned144-byte `536-attachment.txt`; no Send of either | `07-memory-text-attachment.png` |
| Held displayed-session A→B | B's genuine message prefetch held at browser transport, with no fabricated response; live URL selected B while A remained displayed; `_HELD_EDGE` inserted once into displayed A | 35 DOM samples, **16 positive held-A/typed-owner samples**, `held-selection-samples.json` |
| No redirect of retained input into B | After the hold expired/released, actual B editor document empty and A's attachment absent; A stayed off-screen | `08-B-empty-A-offscreen.png`, literal document-text observer |
| Changed-build reconnect retains input | Temporarily served the real built #545 index on this exclusive copy; browser offline→online once; actual reconnect GET200/no-store returned a DIFFERENT entry; same `performance.timeOrigin`, B still empty | `09-reconnect-no-input-loss.png`, network entry receipts, steps |
| Return to A | Memory-only text including `_HELD_EDGE` and attachment restored in A; provider turn count still3 | `10-A-memory-attachment-restored.png` |
| Deliberate manual-refresh limitation | Exact70 index restored first; manual refresh with persistence OFF loses memory-only text/attachment. This is explicitly NOT durable retention. Screenshot11 is the early loading paint; final failed screenshot subsequently shows the loaded A/history with empty composer | `11-manual-refresh-memory-only-limit.png`, `failed.png`, final DOM |

The changed-index operand was explicitly admitted by Lead. Running entry `/assets/main-B9EWm7ML.js`; actual reconnect response entry `/assets/main-Y6ADxLyG.js`; subsequent manual-refresh response back to `/assets/main-B9EWm7ML.js`. No prompt, artificial product reconnect callback, application-store injection or native replay manufactured this observation. The index-only stimulus is not full #545 artifact/runtime qualification.

Native journal readback has two A user rows: its seed and **exactly one browser prompt**. Assistant stops are `stop` and `aborted`. Captured own HTTP responses351; HTTP409 count0; browser page errors0. These are bounded observed counts, not a global absence theorem.

## Limits and retained failures

1. **Overall final scratch result is FAIL** at the extra cookie-person probe after the required displayed-session/input checks. The cookie was changed in the same document; the expected B-owned personal read was not observed within20s. No B-person admission/retirement PASS is claimed, nor a precise product-cause diagnosis. `result.json.walkPass=false` and `run.rc=1` remain unchanged. Owner may separately decide whether that extra case requires follow-up.
2. Rendered partial reply text was not observed before Stop: the gateway logged the99-char provisional part, while UI showed composing. After Stop it appeared as a stopped reply. This discrepancy is retained; gateway emission is not rendered-text proof. A5's distinct Send/Stop were completed, not an uninterrupted-streaming/growth/fault proof.
3. After returning to A, the screenshot shows model controls Loading and a briefly blank/loading timeline while the retained input is already visible. Later manual-refresh/failed-frame history loaded. This does not clear the source review's nonblocking catalog-recovery concern or every loading-state edge.
4. Manual refresh with persistence OFF, or with in-memory attachments, intentionally does not guarantee retention. Saved text with persistence ON was tested separately. No attachment was submitted and no external attachment file was read.
5. Six earlier fresh disposable attempts are preserved in `attempt1/` through `attempt6/`, with their videos/results/cleanup. They were not rewritten to PASS: (1) single-line marker missed the fixture hold after Code's attribution prefix; (2) keyboard typing a newline invoked Enter and produced two completed browser turns; (3) strict rendered-text prerequisite refused although native/gateway had a held provisional part; (4) B had already been prefetched, so there was no held transition; (5–6) empty CodeMirror placeholder was wrongly read as document text. All were cleaned before any next fresh case; no same-session uncertain action was replayed.
6. Scratch corrections only: native input is now inserted as multiline text with a pre-Send turn-count fence; fixture hold tested separately; B prefetch is held before reload; empty editor uses a detached DOM clone excluding the actual CodeMirror `.cm-placeholder` widget. Four isolated DOM observer controls and real loopback fixture-hold probe passed; they support the harness, not substitute for application proof.
7. No Source repair, baseline checks, independent security review, full native tool/model mutation matrix, Google/public-provider proof, deployment or landing award. No new task agent/review claim was started.

## Media, logs and cleanup

- Full original video: `536-a5-signed-in-walk.webm` (**69.28s**), includes the extra-cookie refusal interval; no failure was cut out.
- Playable derivative: `536-a5-signed-in-walk.mp4` (H264, no audio), derived from the full original.
- Contact sheet: `contact-sheet.png`,12 real source screenshots including the extra-probe failed frame; originals retained individually.
- Commands/source: `commands.log`, `run-once.sh`, `proof.mjs`, `read-input.mjs`, `source-receipt.sha`; runtime helper is adjacent `../536-a5-runtime.mjs`, copied into delivery as `runtime-source.mjs` for custody.
- Evidence: `steps.jsonl`, `network.json`, `provenance-and-observations.json`, `held-selection-samples.json`, `native-after-stop.json`, native/stack custody, `stack.log`, failed DOM, browser errors and owner-read timeline.
- Cleanup: `cleanup.json` positively records both owned workspaces closed, original native PIDs ended, stack ended, provider closed and listener ports free. Context/browser closed and video finalized. Final readback: fixed owned PIDs absent; no exact owned driver/launcher/stack script operands remain; **all TCP states on23711/23712 empty**. Reflected observer shell/awk lines in the broad path census are disclosed, not counted as live candidates. No shared service stop, shared credential change or destructive cleanup.
- Private fixture state/journals and every unsuccessful attempt remain available; no active owner/task/process or runtime effect is pending.

**Handback: requested A5 evidence supplied with these limits; overall runner FAIL retained; source/media custody quiescent. Owner/Astra retains acceptance and publication.**

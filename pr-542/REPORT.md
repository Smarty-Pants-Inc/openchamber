# #542 signed-in candidate recording

The requested native browser path passed on the exact after-change head. A real disposable Pi session showed **Terra / High**, including after cached-history navigation and a manual reload. The browser sent no prompt and changed no picker. Fixture sign-in used BetterAuth's official testUtils, not Google.

## Bindings

- OC head7514bdefacaf41362b60f31536194ff751c78bc0, treef94971efe3d7af41c27740be51b7bc7d7e7510f5. Source tracked/index clean, no patch.
- Code3.64 head86298c7c352e0212c72864d318fa9da10e104385. Own exclusive release copy, ports23711/23712.
- Native Pi1cd7a76af2cdaab66d68ec9378e9898bff362dac, in disposable private profiles and Herdr panes. Loopback provider fixture, Terra/high, retry disabled.
- The candidate runs the **7514 web server as well as its built dist**. The repair is in server list sanitization; overlaying dist alone would not test it.
- Existing frozen dependency closure reused only after all four lock/package manifests matched. No install, dependency edit or outbound fetch. Bun1.4.0 rather than declared1.4.2; Node24.19.0. This is not the1.4.2 CI gate.
- `code-byte-binding.json` confirms632 Code scripts/packages files match the native source, candidate and installed release. Stack logs retain two source-path-based ordinary-extension-stale warnings because native extension source and copied gateway labels differ. This receipt does not assert complete installed dependency or OS equivalence.
- `DIST.SHA256SUMS` binds957 built files. Proxy source SHA256ca7fd4281261ff5a69b958025738736fa038a52eab43c2f8cb35b9e52ad9ed78. Built index SHA2568b7f19aaf1dd790104a7932c7d7127233fd81da94486d334bd8e983833858708.

## Observations

Fresh final run19:03:39Z–19:04:08Z. Full video22.28s.

1. Signed-in normal root/bootstrap/list requests show both owned native rows with nativeRuntime=ordinary. `01-signed-in-bootstrap.png`, list payloads and network log retain those facts.
2. Normal sidebar selection loads the seeded native history and live session detail. Detail carries generation/sequence, model smarty-fixture/terra and thinkingLevel=high. The composer reads Terra/High, with exact title `smarty-fixture / terra`. `02-native-model-high.png`.
3. Open the second native session, then return through the sidebar. Returning to the first session issues **zero message reads** and shows its cached history plus Terra/High. `cached-history-reads.json`, `04-cached-model-high.png`.
4. Deliberate reload restores the same first session/history. The composer again shows Terra/High. `05-reload-model-high.png` and actual video frame at19s.
5. Final provider turn count stayed2, both native seed prompts before browser launch. No browser Send, picker mutation or model-setting POST. Browser pageerror list empty.

Code3.64's actual lists intentionally supply marker-only native ownership, not full live ordinary detail. The first attempt's assertion wrongly required full detail in the list and failed before selection. It is preserved under `attempts/1/`, including its failed screenshot, verdict, video and clean cleanup. I corrected only that scratch assertion, then used fresh sessions/state for the final run. Full native detail and model/effort comparison remain required in the selected-session path.

## Stock control and limits

The exact-head `server/opencode-session-ownership.test.jsx` passed18 tests through actual proxy/SDK/React consumers. It retains stock rows without native fields and their ConfiguredModelControls branch, along with both common list routes and public field stripping. Full output is `stock-consumer-control.log`. This is a retained source/HTTP consumer control, **not a separate stock browser recording** or a real stock-provider run.

Loading labels occur while native catalog reads settle and briefly return near the video's end. The screenshots and video19s frame show actual High, not stock Default. This recording proves those acquisitions, not uninterrupted control stability. The network log also retains URL-token409 fallbacks, inbox403 and missing fixture-file404 responses; no claim of a globally error-free product is made. Their causes were not repaired here.

No public Google login, real account/provider, Windows execution, CI/security clearance, installed activation, complete #1154 proof or PR approval is awarded. The owning reviewer decides whether this narrow native recording plus retained stock control closes Astra round2's missing-evidence finding.

## Delivery and cleanup

- `542-native-model-effort.webm`, MP4 equivalent.
- `contact-sheet.png`, six actual-video frames with source times.
- `model-effort-contact.png`, readable crops of actual initial, cached and reloaded composer screenshots.
- `COMMANDS.md`, `proof.mjs`, `runtime-source.mjs`, build receipts, native/list/network/cleanup evidence, exact source bundle and Astra request.

Both attempts closed their owned workspaces, original native Pis, stack, browser and provider. Terminal original PID checks include the logged web child. All TCP states on23711/23712 are empty. No shared service/profile or user desktop was changed. #1234 remains checkpointed and resumes after this handback.

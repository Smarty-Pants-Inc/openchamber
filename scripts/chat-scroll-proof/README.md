# Streaming timeline browser regression

Run `bun run test:chat-scroll` from the repository root. Set `PLAYWRIGHT_BROWSERS_PATH` to an existing Playwright browser cache. No browser download or application server is started. Playwright builds and serves only this deterministic fixture on unused loopback port 4187, and closes it after the run.

Set `SCROLL_PROOF_OUT` to retain metrics, screenshots and videos. The production fixture build goes under `TMPDIR`, or `.chat-scroll-build` if it is unset.

The fixture composes the actual MessageList, useChatTimelineScroll, runtime adapters, theme and sync providers. It takes ChatContainer's scroll styles from source. It does not replace the virtualizer or scroll controller. It supplies 180 historical turns and 240 token updates, including reasoning, tool appearance and completion, and replacement parts with stable IDs. Backend requests are aborted; no live service, model, account or production data is used.

Desktop and phone tests sample scrollTop and live-row geometry on every animation frame. They check bottom stability, reader row/offset preservation through a positions-epoch remount, Beginning and end reachability, and native overscroll policy. Frame liveness, delivered ticks and actual content growth guard against a quiet fixture being mistaken for success. Chromium headless cannot demonstrate macOS trackpad rubber-band animation, so the owner still needs to verify it on Chrome on a Mac.

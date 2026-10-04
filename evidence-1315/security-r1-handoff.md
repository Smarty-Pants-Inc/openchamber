# PR #536 — READY for lead-owned candidate proof and review

Branch: `sync/upstream-614d7f76`
HEAD: `16eda5b18ba2cd764d0da0827a2e8741b12d3834`
Pushed non-force to the assigned local bare origin and verified with `git ls-remote` at 2026-10-04T05:13:04Z. Full exact-head local commands PASS; both independent bounded audits report ACCEPTANCE_AUDIT: PASS. Every writer/checker/auditor is QUIESCENT. This is candidate/integration readiness, not official review, CI, installation or delivered-app acceptance.

## Why / scope

Issue #1315 keeps upstream improvements without losing the Smarty Code user's native gateway, composer, sidebar or settings behavior. This repair follows the product principles of working software and the smallest faithful change: fix the common trust cause, hard-disable unused new features rather than maintain a new security framework, and prove both refusal and permitted paths.

The original real two-parent merge remains `55f4136b881d72fdb8a4a49850a910d9d091ed8d`, with the exact requested parents and message. Nothing amended it. Above the lead's `74503e43955b13a5b49731417f0efeae8748a702` fork guard, the lane adds:

- `4f86403ec77539242efd27c8a87884fcd5b5184e` — security/Astra fixes and the Build-only heap policy.
- `16eda5b18ba2cd764d0da0827a2e8741b12d3834` — reviewed raw proof successors, actual disabled-Guest settings controls, and existing translated unavailable copy.

## Security finding classification and disposition

All F1–F13 are upstream-introduced, not merge-resolution defects. F8's local human-mode callback narrowing was a mitigation, not the defect. Reachability is the Code deployment, not a claim that every upstream/native mode is safe.

| Finding | Origin | Reachability before repair | Disposition and regression evidence |
|---|---|---|---|
| F1 primary Run bypass | Upstream shared-command projection, `82a0ee7572e59dbc965d593268a41ef0395860fa` | Reachable OC-owned terminal before the gateway | Primary, dropdown and shared Auto-discovery use common approval before terminal allocation. Captured command/runIn/directory/project/runtime are checked; strict-read failure and stale A/B ownership refuse. Stop, personal actions and package discovery remain allowed. `command-execution-fix.md`. |
| F2 metadata mints trust | Upstream `82a0ee7572e59dbc965d593268a41ef0395860fa`; both writers matched upstream | Reachable web metadata/bootstrap; VS Code mirror repaired too | Neither ordinary shared-config writer mints approval. Retain only a matching complete executable-set hash and original timestamp; explicit approval remains. Plans-dir, starter, no-op, changed-command and foreign-key controls. `shared-config-plans-fix.md`. |
| F3 shared-plan link escape | Upstream `82a0ee7572e59dbc965d593268a41ef0395860fa` | Reachable default folder/context/knowledge routes | Authorized hard disable: resolver returns null before metadata reads. Actual manifest DELETE/pin mutations also refuse before writing. Personal plans/notes/todos and shared data survive. `shared-config-plans-fix.md`; #1325. |
| F4 displayed permission scope mismatch | Upstream Guest SDK, `5181bcd338dafe8f8ff31ca10d0f3aca72e614f9` | Reachable after install/enable/grant; not protected by downstream gateway | Guest SDK hard server/client cut. No descriptor/approval receiver is registered. Real prefix denial and zero host effects. `guest-disable-fix.md`; #1325. |
| F5 stale grant starts service | Upstream Guest SDK | Reachable authenticated service path | Same hard cut; no catalog authorization or service spawn can be reached through the production composition. Stored data unchanged. |
| F6 OAuth POST redirect | Upstream-added OAuth module, unchanged by merge | Reachable guest OAuth callback/exchange | Same hard cut includes OAuth routes; no credential exchange/fetch occurs. Low-level OAuth is not represented as repaired while enabled. |
| F7 callback reverses Disconnect | Upstream-added OAuth module, unchanged by merge | Reachable pending/in-flight guest exchange | Same hard cut includes callback and disconnect; no token persistence receiver is registered. |
| F8 unmatched error state / broad asset token | Upstream OAuth/auth exemptions and token scope; local human-mode narrowing only mitigated one profile | Reachable legacy anonymous callback or scoped token; human-mode differs | Same hard cut terminates callback, wildcard package assets and control GETs, including genuinely minted legacy tokens, before guest effects or proxy. |
| F9 full response buffering | Upstream-added request/service modules, unchanged by merge | Reachable connected/granted network/service path | Same hard cut; zero outbound guest network or service requests. No claim that retained response readers are safe if re-enabled. |
| F10 forged provider attribution | Upstream Guest SDK, `5181bcd338dafe8f8ff31ca10d0f3aca72e614f9` | Conditional legacy/relay in-memory path; direct Google-human mint is blocked; Code metadata sink refuses | Refreshed UI uses the real unsupported catalog for every runtime, no fetch or guest surfaces; server prefix remains terminal 501. Existing first-party GitHub/Linear and OpenCode plugin controls work. Old loaded documents are not qualified; lead owns returning-browser A5. |
| F11 persisted splash injection | Upstream `82a0ee7572e59dbc965d593268a41ef0395860fa` | Unreachable in Code web: no Electron/preload/splash IPC | Accepted deployment limit in #1325, not repaired native source. See exact one-liner below. |
| F12 recycled process-group signal | Upstream `d144cfd4b69876e3602c5e44f85bf7309bde0373` | Unreachable: no VS Code extension host/managed OC process owner | Accepted deployment limit in #1325, not repaired native source. |
| F13 approval after Off | Upstream `ec95fe2e00323500b8d2f5126f3834071adb6a48` | OC policy exists, but effective native Code permission sink is unsupported | Accepted gateway-specific limit in #1325; not a default-off exemption and not a general revocation repair. |

Whole receiver/bootstrap/attribution traces and original-blob comparisons are in `merge-groups/security-r1/{command-trust,shared-plans,guest-approval,guest-network,native-permission}.md`.

### Accepted-limit one-liners (lead recorded #1325)

- F11: Code runs the OC web server, not Electron/preload/splash IPC; desktop-owned splash settings are rejected by HTTP admission. A future Electron client/distribution must close the upstream defect before native qualification.
- F12: Code's web/gateway deployment has no VS Code extension host or managed-OpenCode process owner; future managed VS Code distribution must close the upstream numeric-custody defect.
- F13: the Code gateway returns empty OpenCode permission discovery and 501 for permission-reply mutations, and native Pi publishes no permission.asked; optional OC routing cannot release a native Code tool through this unsupported API. Alternate permission-capable backends/future gateway support require upstream revocation repair first.

Installed gateway bytes are not independently attested by this lane. Prior matching approval records have no recoverable provenance; no unauthorized blanket reset was made. This candidate has not been deployed by the lane.

## Disabled-feature list — filed scope cut #1325

Tracking issue: https://github.com/Smarty-Pants-Inc/smarty-code/issues/1325

| Feature | Introducing upstream commit | Why | Changed owning paths |
|---|---|---|---|
| Repository shared plans | `82a0ee7572e59dbc965d593268a41ef0395860fa` | Unused in Code; hard disable is smaller and safer than a new cross-platform descriptor mutation framework. Keep personal plans, notes, todos and all stored shared files/manifests. | `packages/web/server/lib/projects/project-config.js`, `project-setup.test.js`, `DOCUMENTATION.md`; `packages/web/server/lib/project-context/runtime.js`, `DOCUMENTATION.md`. |
| Guest SDK/extensions | `5181bcd338dafe8f8ff31ca10d0f3aca72e614f9` | New and unused in Code; multiple reachable approval/OAuth/service/network boundaries. Unconditional terminal 501 plus unsupported UI, no opt-in. Keep GitHub, Linear, OpenCode plugins and stored guest data. | `packages/web/server/lib/opencode/feature-routes-runtime.js`, `guest-boundary.test.js`; `packages/web/server/lib/guests/DOCUMENTATION.md`; `packages/ui/src/lib/guests/load-catalog.ts`, `.test.ts`; `packages/ui/src/components/sections/extensions/ExtensionsPage.tsx`, `builtins.test.tsx`; `packages/sdk/DOCUMENTATION.md`. |

## Astra / CI findings

| Finding | Origin / repair | Report and proof |
|---|---|---|
| A1 attachment loss on automatic reload | Merge interaction. Global hold includes every retained attachment owner and pending replay text/files; final-owner removal releases the hold. Existing text/send/runtime holds and manual refresh stay unchanged. | `astra-attachment-reload.md`: 83 scoped tests; scheduler and mounted composer controls. |
| A2 Ask uses live sidebar instead of displayed parent | Upstream-inherited. Capture displayed parent/directory/runtime; stale/missing capture refuses, not anonymous retarget. | `astra-ask-parent.md`: actual Ask→BTW request→composer→Send→SDK fork→parent metadata/prompt, held A/live B and then displayed B on desktop/mobile; all original fixture consumers pass. |
| A3 collapsed checkout-head disappears | Merge interaction. Apply headerless-head collapse policy before shared row projection without changing persisted preferences. | `astra-collapsed-head.md`: actual scroller and projection, headed→normal→headed, controls/children/exact case/G13/row21. |
| A4 Windows percent doubled twice | Merge-resolution defect: upstream already removed the argument-level escape. Percent escaping now occurs once at batch serialization. | `astra-windows-percent.md`: registered updater route, ordinary/percent executable/percent CLI/both paths. Quoting, password, flags, branding and fallback preserved; no Windows OS execution claim. |
| A5 real signed-in app proof | Pending; code-lead owns candidate stack on Ryzen 1 before merge. | Must use the final head and real user path; mounted tests are not a substitute. |
| A6 Build heap OOM | Inherited missing policy. Copy Code #1256's existing `--max-old-space-size=4096` only to the existing Build step. | `ci-heap-fix.md`: real workflow and nested Bun→Vite Node heap, 4288 MiB vs 704 MiB control; later step environments unchanged. Actual Node 22 CI remains pending. |

## Exact-head local commands — all PASS

Shell-local Bun 1.4.2 and Cargo/Rust 1.96.1, umask 0022; Node 24.19.0. Only Build receives NODE_OPTIONS4096.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | exit0; no tracked/lock change |
| `env NODE_OPTIONS=--max-old-space-size=4096 bun run build` | exit0; 166 seconds; immediate tracked/lock drift zero |
| `bun run type-check` | exit0; all six workspaces |
| `bun run lint` | exit0; all six workspaces |
| `bun run test` | exit0; full chain, 440 seconds; scripts16/16, SDK13/13, UI793/793, VS Code47/47, Electron26/26; web270 files pass/1 skip, 3524 tests pass/16 skips/0 failures |
| All 11 exact judge files, fresh processes | 226 pass, 0 fail, 0 skip; explicit commands in `security-repaired-final/judge-results.json` |
| `bun run brand:check` | exit0 |
| `bun run test:brand` | 70 pass, 0 fail, 1 Mac asset-compiler skip |
| `node --test scripts/branding-upstream-overlay.test.mjs` | 25 pass, 0 fail, 0 skip |

Judge files: sharedSettingsWrites, modelPrefsShared, useDirectoryStore.loadWrites, persistence, persistence-first-load, VS Code settings.modelPrefs, web settings-helpers, oneActionSend, native-draft-start, native-draft-send, nativeComposer. There are no final failing tests or pre-existing-failure exemptions. Earlier failed 4f864 receipts remain unchanged in `security-final/`; the final head was fully rerun.

All 5612 tracked paths, locks, HEAD and index content stayed unchanged. Raw index metadata changed; no raw-byte stability claim. All 90 protected entries remain; only the lead's SDK-preview guard and authorized Build-step heap env differ from the original merge. Four historical ledgers, all 115 original merge rows and four normalized bindings remain unchanged; three reviewed raw successors bind the CI workflow and A4 source/test pair. All 775 raw bindings match. No behavioral resource-policy change is passed off as brand-only normalization.

Final command receipts: `/home/paul/lanes/oc-sync-1242/.local/merge-check-evidence/security-repaired-final/result.md` and sibling logs/meta files.
Independent Sol/max audits both report ACCEPTANCE_AUDIT: PASS for their explicit repair/deployment-limit scopes:
- `security-repair-audit/result.md`: 231 focused tests, six additional shared-plan layouts/120 real HTTP requests, controlled gateway/sanitizer checks and 16/16 mechanical invariants. No new reachable blocker.
- `astra-repair-audit/result.md`: 507 tests, 33 real fixture consumers, whole receiver/bootstrap/attribution traces and proof/configuration preservation. No new preservation blocker.
Both consumed the terminal full-command report once. Neither substitutes for A5 or official security/Astra review.

## Remaining gates / limits

Official security/Astra re-review, Node 22 GitHub CI, signed-in refreshed/returning real-app A5, merge queue and landed-artifact installation remain code-lead-owned. Audits also disclose the unchanged first-BTW helper's narrower send options (named first-BTW attribution is not qualified), and one non-blocking stale client comment claiming the shared writer records trust; the actual writers and owning docs are correct. This lane does not claim deployment, native/browser/relay/device proof, security clearance or delivery. Low-level disabled Guest code is retained unchanged, not qualified when enabled. Native F11/F12 and alternative permission backends remain tracked limits. Dead-code was previously inspected as non-blocking; later direct cached Knip attempts fail on missing `formatly`, without installs or suppression. No new clean dead-code claim is made.

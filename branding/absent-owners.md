# Exact absent-owner reconciliation

This is a **hunk-specific reconciliation, not a blanket surface exclusion**.
The donor is `d6ef11b464bd33ea892419df5f7fbf668fa41896`; the sweep is
`e76c9aef` (full identity in `coverage.json`). The owning baseline remains
stock `2dfd1190eba8853c766c29ae27f09aeacc86bdb9`.

## Individual sweep hunks

| Donor file / old hunk line | Donor wording adjustment | Stock-owner search and result | Port disposition |
| --- | --- | --- | --- |
| `packages/vscode/src/bridge-session-runtime.ts`, 402 | `OpenCode did not confirm deletion of the forked session` → `The engine did not confirm deletion of the forked session` | File, `confirmSessionRemoved`, and compensating-deletion confirmation owner absent from stock VS Code. Existing proxy modules do not implement it. | Do not create the file or this behavior/error. |
| Same file, 532 | `OpenCode API unavailable` → `Engine API unavailable` | Existing stock `bridge-localfs-proxy-runtime.ts:buildUnavailableApiResponse` and `bridge-git-special-runtime.ts:handleSpecialGitBridgeMessage` own the corresponding unavailable-API responses. | Apply the label to **both** stock owners; keep status, headers, IDs, serialization, payload shape and control flow. |
| `packages/vscode/src/bridge-session-runtime.test.ts`, 749 | Deletion-confirmation detail fixture gets the same neutral engine wording | Test file and its runtime owner absent in stock. | Do not create donor test/behavior. Retain stock proxy tests and add normalized exact-stock owner parity. |
| `packages/web/server/lib/openchamber-sessions/routes.js`, 508 | ``OpenCode did not confirm deletion of the ${description}`` → ``The engine did not confirm deletion of the ${description}`` | Stock session service has no `confirmSessionRemoved` or corresponding confirmation error. Its existing cleanup behavior is not that donor recovery protocol. | Do not add a confirmation request, exception, compensation protocol or success claim. |
| Same file, 959 | `OpenCode accepted the prompt but it never appeared in the session` → `The engine accepted the prompt but it never appeared in the session` | Stock `createOpenChamberSessionService` already owns the accepted-but-unobserved prompt error. | **Ported**, at existing stock line 608. This applicable hunk is not excluded with the preceding absent one. |
| `packages/web/server/lib/session-goal/runtime.js`, 338 | ``OpenCode ${method} ${fetchPath} failed with ${response.status}`` → ``Engine ${method} ${fetchPath} failed with ${response.status}`` | Stock `requestJson` owns this same request-failure check. | **Ported**. Keep interpolated method/path/status and `response.json().catch(() => null)` exactly. |
| Same file, 369 | `OpenCode message history returned an invalid page` → `Engine message history returned an invalid page` | Donor paginated `readMessages` page-validation throw has no stock owner. Stock reads with `requestJson` and returns null for malformed/non-array response. | Do not add an exception or pagination. Preserve stock null result. |
| Same file, 421 | `OpenCode message history pagination made no progress` → `Engine message history pagination made no progress` | `visitedCursors`, cursor-loop guard and donor pagination implementation absent in stock. | No synthetic equivalent exception. Preserve stock control flow. |
| Same file, 434 | A second `OpenCode message history returned an invalid page` → `Engine message history returned an invalid page` | Donor recent-page validation throw is also absent; stock latest-assistant reader handles non-array response by returning null. | Separately inventoried; no new throw or paging behavior. |
| `packages/ui/src/sync/session-actions.test.ts`, 719 | Recovery `fork.detail` gets the deletion-confirmation wording | Stock has neither this donor server-confirmation recovery fixture nor its owning runtime protocol. | Keep current stock test, not donor recovery semantics. |
| Same file, 751 | Recovery outcome detail **and** `compensationError.message` expectation get the same deletion-confirmation wording | Corresponding outcome/recovery fixture is absent in stock. | Both assertions explicitly non-applicable; do not import behavior just to provide a string owner. |

## Reproducible owner search

Run in a checkout with the source objects available:

```sh
git grep -n -E 'confirmSessionRemoved|did not confirm deletion|visitedCursors|history returned an invalid page|pagination made no progress' 2dfd1190 -- packages/vscode/src packages/web/server/lib packages/ui/src/sync
git grep -n 'OpenCode API unavailable' 2dfd1190 -- packages/vscode/src
git show 2dfd1190:packages/web/server/lib/session-goal/runtime.js
git diff e76c9aef^1 e76c9aef -- packages/vscode/src/bridge-session-runtime.ts packages/vscode/src/bridge-session-runtime.test.ts packages/web/server/lib/openchamber-sessions/routes.js packages/web/server/lib/session-goal/runtime.js packages/ui/src/sync/session-actions.test.ts
```

The first search also finds **existing, already-neutral UI** errors:
`session-actions.ts` has `session.delete failed: server did not confirm deletion`,
and `session-message-loader.ts`/its test have
`Session history pagination made no progress` and `visitedCursors`.
Those are different owners from donor bridge compensation/session-goal paging;
they require no product-wording replacement and remain untouched. Thus the
absence above is **not** a claim that stock has no deletion, goals, recovery,
or pagination. The second search identifies exactly the two applicable
stock proxy labels.

`stock-owner-parity.json` records exact stock SHA-256s and only the four
allowed source-string substitutions. `scripts/branding-stock-owners.test.mjs`
normalizes those four substitutions and checks whole-file identity. It also
checks the stock UI test remains unchanged and the donor bridge files remain
absent. These are static whole-source checks, supporting—not substituting
for—real browser/native Pi regression and the existing runtime suites.

The current stock upgrade-status handlers in VS Code and web also retain the
sweep's owned fallback messages (`Failed to read engine version`,
`Failed to update engine`) while passing through actual upstream error bodies,
HTTP status text and codes. They are applicable changes, not absent-owner
exclusions. No raw provider/user/tool payload is postprocessed.

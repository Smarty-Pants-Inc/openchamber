# Permission auto-accept

Permission auto-accept is hard-disabled in this fork. This is an execution boundary, not a default-off setting or a Pi gateway capability check. It applies even when the backend is OpenCode and has pending permissions.

## Runtime and stored policy

`createPermissionAutoAcceptRuntime` keeps its existing entry points for older and scheduled callers. `setSessionPolicy` rejects with unsupported status 501. `isSessionAutoAccepting` and `processPermission` return false. Startup, reconnect and pending reconciliation perform no subscriptions, settings reads, evaluator calls, requests, timers or replies. `load` and `snapshot` return an unsupported projection, not stored authorization.

Stored `permissionAutoAccept` settings remain untouched. No environment flag, routing setting, injected evaluator or saved ancestor policy can re-enable execution. The former evaluator, retry and reply implementation has been removed, so an accepted result or timeout/error fallback cannot release a permission after Off. Re-enabling this feature requires a new implementation and security review.

## Routes and bridge

Every method beneath `/api/permission-auto-accept` returns 501 JSON with `supported: false` before the generic OpenCode proxy. The composition root also refuses the older `POST /api/notifications/auto-accept` during normal authenticated bootstrap, before its original notification handler.

VS Code's actual policy bridge refuses GET and set operations without reading, writing or broadcasting global state. Its separate foreground responder and production live/bootstrap/reconnect entry points are inert. The webview cannot restore automatic replies from an old broadcast.

## Shared client

The permission store never hydrates or migrates stored policy into live authority and never contacts the policy endpoint. Its predicate and lineage utility return false even for previously enabled maps. Legacy migration candidates stay stored. Enabling through the store rejects as unsupported; an explicit false remains a no-op for older Off callers.

The real composer button and shortcut report localized Unavailable, including draft and unsent BTW modes, without changing local pending flags. The button always shows an inactive shield, never a saved enabled state. Older calls through the toggle helper fail without changing policy or draft state. Manual BTW creation no longer enrolls a policy, whether an old caller supplies an absent, false or true flag. Scheduled enrollment fails through the runtime refusal; the scheduler's existing catch lets the task continue with manual permissions.

Web, Electron, hosted mobile and Capacitor use the disabled server and shared client. VS Code refuses both its policy bridge and foreground responder. There is no runtime-specific opt-in or local fallback loop.

## Manual permissions and safety policy

Manual `once`, `always` and `reject` permission replies still use the official SDK and normal OpenCode proxy. Permission cards and event reconciliation stay available. This disable does not change upstream tool safety policy or the separate routing evaluator's decisions.

## Regression evidence

`runtime.test.js` exercises the actual responder, routing evaluator and timeout/error fallbacks, explicit Off controls, stored-policy preservation, every feature-route method, the real generic proxy, and exported server bootstrap with a pending/live OpenCode fixture. Manual replies remain the positive control.

The owning UI/store/sync/VS Code tests cover old stored and broadcast policies, disabled foreground entry points, actual bridge refusal, real scoped SDK manual replies, and mounted composer button plus shortcut in session, draft and BTW modes. DOM fixtures do not prove installed browser, mobile-device or native extension-host behavior.

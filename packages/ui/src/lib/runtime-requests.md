# Runtime request lifetime

`runtime-switch.ts` owns the active runtime identity and transport generation.
`captureRuntimeRequestScope()` captures that identity, auth generation, URL
resolver and relay object before asynchronous work starts. Returning to the same
runtime key or URL does not restore an old scope. Credentials stay out of scope
keys and diagnostics.

`runtime-fetch.ts` resolves the destination and captures auth/header preparation
before its first await. It checks the scope before dispatch. GET and HEAD results
must still belong to the current scope when headers arrive and when a buffered
body reader finishes. This includes cloned responses and the SDK's text reader.
Raw streaming consumers still own their event-pipeline generation checks.
Same-origin absolute SDK URLs use the same guards when the runtime resolver
returns relative URLs. External requests do not receive runtime credentials or
runtime expiry handling.
The installed browser fetch bridge uses this same path and retains its captured
native fetch implementation to avoid recursion.

There is no transport-wide read coalescer. The OpenCode service and message loader
retain their narrower deduplication. Equal URLs do not prove equal headers,
directories, credentials or relay destinations.

## SDK and effects

Each SDK object belongs to the scope in which it was created. A retired SDK
refuses new dispatch. The service rebinds SDK objects and clears directory/config
caches when the scope changes, including same-URL and same-device transport
changes. An old promise may remove only its own in-flight entry. Cached reads and
native directory reads check their captured scope before publishing results.

Send captures the SDK, directory and runtime scope before attachment or capability
preparation. A scope change stops dispatch, including A-to-B-to-A transitions.
After dispatch, Create, Send and other mutation responses still return to their
originating caller. Navigation is not proof that an effect was rejected. The
native draft owners retain accepted or unknown outcomes and decide whether the
visible runtime can publish them. Transport does not retry these effects.

## URL authentication and expiry

Credential preparation and URL-token mint IO have a ten-second deadline. Transient
mint failures back off from one second to a thirty-second cap. A 401 or 403 stops
mint polling until auth changes or explicit session reauthentication succeeds.
Direct callers share the same pacing as proactive consumers. Local Electron
URL-token minting has separate origin-scoped in-flight and failure state.

A runtime switch invalidates old mint publication and captures a new destination.
Explicit empty credentials or headers do not fall back to read-only Electron
injected values. The existing app reset paths reset the auth-session classifier.
A confirming `/auth/session` probe has a ten-second abort signal; its in-flight
slot, cooldown and result belong to its captured scope. A stale 401 cannot expire
a newer runtime, and an old probe cannot clear a newer probe's slot.

Verified cookie recovery completes at the gate's successful status/password/
passkey operation, even if its local state was already authenticated. It retires
request authority before publishing the auth store's recovery generation.
`RuntimeSyncProvider`, used by App and MobileApp, observes that generation and
supplies the current SDK to the existing SyncProvider. The loader, child stores
and workspace remain mounted; SDK-dependent bootstrap, action references and
stream effects rebind through their existing lifecycle. Recovery never changes
the endpoint key or replays mutations.

Native expiry acknowledgement moves to `reauthenticating` without renewing
authority. `apps/nativeAuthRecovery.ts` completes recovery only after MobileApp's
probe confirms the unchanged transport, and only for the captured request scope.
A transport switch uses the existing endpoint reset instead. Failed or pending
probes do not release the mint rejection latch.

These contracts apply to shared web, desktop, hosted mobile and Capacitor HTTP.
VS Code keeps its extension-host fetch bridge and unsupported-operation contracts.
Same-device LAN/relay switching rebinds transport without requiring a page reload.
Focused fake-IO tests do not replace browser, real relay, packaged Electron,
VS Code or native mobile qualification.

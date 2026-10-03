# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Optional Google human authentication

`createConfiguredHumanAuth(env)` is the explicit startup adapter. Without a Node
pin, unset, empty or `off` `OPENCHAMBER_HUMAN_AUTH` returns `null` and leaves legacy
mode unchanged. A present `SMARTY_CODE_NODE_ID` requires exact `google` mode before
any database or server effects; it cannot fall back to legacy credentials.
Any other mode except `google` fails. Google mode requires all of
`OPENCHAMBER_HUMAN_AUTH_DB` (absolute private SQLite path), exact `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a nonempty
`SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS` list. It creates/validates only a private
0700 parent and 0600 regular database file, and does not load secrets itself.
Integration supplies the already resolved environment and owns DB lifetime.

The synchronous `setupBaseRoutes` caller receives the prebuilt `humanAuth` option;
startup assembles it with `await createConfiguredHumanAuth(process.env)` before
calling setup. Human mode is never inferred from a cookie, audience default or
partially populated configuration. Google setup uses Better Auth's official
`hd` provider option. Its code-exchange callback trusts Google's authenticated token
endpoint and decodes the returned ID token; direct ID-token sign-in verifies the
signature. Both paths validate the raw OAuth profile `hd` in `validateUserInfo`;
a request `hd` hint or email suffix alone never grants access. The current authorized deployment has
exact hosted domain `smartypants.ai`.

`createHumanAuth({database, baseURL, secret, googleClientId, googleClientSecret,
allowedDomains, env})` uses official Better Auth 1.7.5. `env` defaults to the existing
process environment; the configured factory passes its injected environment. The caller supplies a private
SQLite connection and complete configuration. It runs the library's supported
`better-auth/db/migration` migration API; no parallel account schema is maintained.
Pass the returned controller as `humanAuth` to `createUiAuth` to enable human mode.
Without it the existing legacy behavior and storage remain unchanged.

The integration owner must mount `humanAuth.handler` at `/api/auth/*` **before**
Express JSON body parsing, apply existing origin/tunnel restrictions, and protect
all downstream HTTP, SSE and upgrade paths. Better Auth owns OAuth state, cookies,
CSRF, account bindings and sessions. Do not parse Google tokens in product code.
`resolve(req)` returns the current admitted Better Auth session or null;
`actor(session)` returns `{version:1,issuer,subject,name,email,image?}`. Profile fields are
presentation only. Default actors, public status, profiles and sidebar ownership do
not expose Node membership or Google's subject. `protect` attaches this actor to `req.humanIdentity` and closes
registered responses on expiry or session deletion. It registers each response
before an authoritative session recheck to close the revocation/admission race.
`status` is the existing
`/auth/session` seam. `dispose` closes registered responses, not the caller's DB.

### Explicit Node member admission

`SMARTY_NODE_RECORD` alone still enables only billing-role lookup. A present
`SMARTY_CODE_NODE_ID` explicitly requires member admission and pins Record B's
`node.id`. Empty or invalid Node IDs, missing records and relative record paths
refuse admission. Without `SMARTY_CODE_NODE_ID`, existing human admission is unchanged.
The configured factory consumes these ordinary environment values without loading
credentials. Integration owns delivery of the read-only, absolute Record B path.

Each `resolve`, `protect` and `status` recovers exactly one Google account using
Better Auth's `findMany` adapter, never an email or Better Auth user ID. Record B
must trust `https://accounts.google.com` and contain exactly one matching login,
one selected org and one active `kind: person` member. Org selection uses explicit
`SMARTY_NODE_ORG_ID` or exactly one primary org. Node, org and member IDs use the
registry's lower-case 63-character limit. Google subjects use
`/^[A-Za-z0-9_-]{1,256}$/`. No subject or ID is normalized into a match.
Unknown, ambiguous, removed, suspended or other-org people are refused. Lookup
errors return an authentication refusal; they never become successful empty state.
`authorizeUiSession` repeats the member lookup before ongoing group admission and
retains its final authoritative session/expiry recheck.

The binding stays in a WeakMap keyed by the admitted library session, not in its
public user fields. Only `actor(session, {forwarded:true})` adds
`member: {nodeId,orgId,smartyId,googleSubject}`. `protect` uses that private actor for
`req.humanIdentity` and the authenticated gateway header. Arbitrary session copies
cannot supply a binding, and returned member objects cannot mutate stored authority.
Issuer and subject remain the original Code origin and Better Auth user ID for
authorship and preferences. Billing-role lookup shares the same pure person resolver.
Session revocation and response-expiry tracking remain unchanged. Record freshness
is the registry publisher's cadence; no membership watcher is added here.

Google is the only configured provider. Its default scopes are `openid email
profile`; no Gmail, Workspace administration or offline scope is requested.
Production callback: `https://code.smartypants.ai/api/auth/callback/google`.
Staging requires its own Integration-approved exact callback origin, never a
wildcard. Proposed secret consumer variables are `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`; nonsecret configuration is the exact
`BETTER_AUTH_URL`, an explicit enable flag/private database path, and
`SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS=smartypants.ai`. These are a caller contract,
not new environment loading or authorization to register a client.

The audience must be nonempty and explicit. The supported `user.validateUserInfo` gate checks fresh Google claims on both new
and returning OAuth callbacks. Account/session creation and request resolution
also require a verified email in an exact normalized allowed domain.
Lookalike suffixes, unverified emails, Google domain hints and browser labels do not
grant access. Keep the existing Cloudflare edge policy. Stable identity uses the
opaque library user ID scoped by issuer, not a mutable email/name. Account linking,
password authentication and email changes are disabled in human mode.

The proxy strips forged actor headers and human-auth cookies and injects only the
resolved server actor for the private Code gateway. Other backend authorization
retains its existing meaning; never accept a device bearer as a human identity.
Human requests carrying a legacy bearer are explicitly refused, not silently
reinterpreted through an ambient browser cookie.

### Personal sidebar view

`human-sidebar-view.js` exports `createHumanSidebarView` and
`registerHumanSidebarViewRoutes`. Bootstrap registers `GET` and `PATCH`
`/api/config/sidebar-view` after the API auth/tunnel guard and before proxy routes.
Both return `Cache-Control: private, no-store`, including refusals. Legacy mode
returns 501. Human mode uses the admitted actor's issuer and opaque user ID.

GET returns `{owner:{issuer,subject},projects,groups}` with sparse boolean maps.
True means collapsed; false means expanded. Missing keys leave the shared project
collapse default or owning group default to the UI. PATCH requires the same owner
as an expected-person guard, never as a storage selector, and merges only supplied
project/group entries. A different owner returns 409 without writing. Neither route
reads or writes the shared settings document or imports anonymous browser state.

Better Auth owns the nullable private `user.sidebarPreferences` string field.
It is configured with `input:false` and `returned:false`; official account APIs
cannot write it and do not expose it. The controller reads a fresh user through
Better Auth's adapter. One running controller serializes reads and patches per
user and rechecks authentication inside the queue. The registered route passes
its protected response into the operation. After the user lookup, the operation
checks that response and the authoritative session row before writing. Revocation,
expiry or a cancelled response refuses the pending change; an ended response gets
no second reply. Direct GET callers may omit the response. Unrelated tab patches
survive. Do not run multiple preference writers against the same database.

PATCH accepts at most 64 KiB of JSON, also checked after parsing. Each map holds
at most 2,048 entries; keys are 1 to 8,192 characters without control characters or
prototype keys. The expected issuer is at most 2,048 characters and subject 128.
The merged stored JSON is at most 256 KiB. Invalid or overflowing changes fail as
a whole, without evicting older entries. Database or malformed stored-data errors
return 500, never a successful empty snapshot. A failed write leaves prior data
intact and later requests can still run.

The supported library migration runs at service startup, inside
`createConfiguredHumanAuth` / `createHumanAuth`, before the listener starts.
For this feature it adds only one nullable TEXT column with no default or row
backfill. Verify fresh startup and upgrade on a private disposable copy before
installation: existing user/session values and `workspacePolicy` must stay
unchanged, the new column must be nullable, and an authenticated preference must
survive reopening. Migration errors stop startup.

Rollback keeps the database and added column. The previous controller ignores the
field, admits original sessions, and preserves preferences during profile edits.
The focused migration test checks additive schema and adapter preservation; the
installation qualification also ran the actual previous `c1d2f327` factory against
a migrated private fixture, with two people and three existing sessions. Do not
rewind the auth database or remove the column. Previous UI releases do not provide
personal sidebar behavior, even though their authentication remains compatible.

### Human WebSocket Host boundary

Every human WebSocket ingress requires the request's own `Host` to pass
`applicationAuthority` in `security/browser-origin.js`. An unbound hostname is
refused with HTTP 403 and `Requests require an application host`, before session,
Origin or parameter refusals, dev-port discovery, stream, upstream socket or native
capability setup. This includes anonymous requests and malformed or missing queries.
Forwarding headers never bind a Host.
`BETTER_AUTH_URL` sets the OAuth issuer and is not an implicit Host binding.
Launch configuration must also bind served aliases through the existing host
configuration, for example
`OPENCHAMBER_ALLOWED_HOSTS=code.smartypants.ai,smartypants.smartypants.ai`.
Loopback names and IP addresses pass only this Host layer, not human authentication.

All runtime ingress handlers apply this human-only Host check directly before their
other gates. Terminal checks it before Origin, dev-tunnel before authentication and
port discovery, realtime-proxy before authentication, and session voice before
parameter validation. Event-stream, including global and directory paths, and
dictation check it before human `requireUpgradeAuth`. That adapter calls
`humanAuth.protect` before upgrading the raw socket. Session deletion and expiry
therefore close admitted sockets, and the registration-before-recheck guard
prevents deletion during admission from leaving an untracked connection.
The central adapter keeps its independent Host check. Bound Hosts retain existing session,
Origin and parameter refusals. Passwordless and UI-password gates are unchanged.
The central adapter still requires the exact human issuer Origin, even for a
served alias or loopback Host. No new Origin alias is granted by Host configuration.

`human-host-upgrade.test.js` exercises all these raw WS paths with private real
Better Auth sessions and inert local upstreams. It also verifies central admission,
forwarding-header rejection, issuer-versus-Host separation, anonymous and malformed
requests, zero setup and discovery effects, and asynchronous Host-guard refusals.
The event-stream and dictation `human-session-lifetime.test.js` regressions also
exercise session deletion, expiry and admission races through their actual runtime
ingress. This is local transport proof, not a signed-in browser, Google callback or
deployed-service proof.

### Existing clients and rollback

Human mode does not import existing passwords, passkeys or trusted-device labels
as people. Legacy issuance, URL token and credential mutations return explicit
409 refusals directing the client to Google. Session access requires a new human
sign-in. The stored legacy credentials, drafts and native sessions remain intact.
The account UI edits name/photo, signs out the current session, and revokes other
sessions through official Better Auth APIs. Historical chat metadata is separate
from mutable profiles and must never be inferred from prompt text.

Before activation, qualify existing browsers/desktop clients and disclose any
required Google reauthentication. Preserve the database, old credential files,
native history and Code alias/actor sidecar on rollback. A previous artifact must
preserve the activated access restrictions; otherwise stop presentation rather
than silently re-enable weaker legacy admission. Do not delete human accounts or
replay uncertain native submissions to make a rollback appear successful.

### Verification boundary

The actual 1.7.5 library is tested with a private SQLite fixture and its official
test-only helpers. They are never enabled in production options. These checks prove
API behavior, not real Google login, protected landing or activated service behavior.
Provider enrollment, owning CI, exact-artifact browser/device and native receipt
proof remain separate required acceptance gates.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated, humanAuth })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`

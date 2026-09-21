# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Optional Google human authentication

`createConfiguredHumanAuth(env)` is the explicit startup adapter. Unset, empty or
`off` `OPENCHAMBER_HUMAN_AUTH` returns `null` and leaves legacy mode unchanged.
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
`hd` provider option and its verified ID-token claim checks, then validates the
raw OAuth profile `hd` claim again in `validateUserInfo`; a request `hd` hint or
email suffix alone never grants access. The current authorized deployment has
exact hosted domain `smartypants.ai`.

`createHumanAuth({database, baseURL, secret, googleClientId, googleClientSecret,
allowedDomains})` uses official Better Auth 1.7.5. The caller supplies a private
SQLite connection and complete configuration. It runs the library's supported
`better-auth/db/migration` migration API; no parallel account schema is maintained.
Pass the returned controller as `humanAuth` to `createUiAuth` to enable human mode.
Without it the existing legacy behavior and storage remain unchanged.

The integration owner must mount `humanAuth.handler` at `/api/auth/*` **before**
Express JSON body parsing, apply existing origin/tunnel restrictions, and protect
all downstream HTTP, SSE and upgrade paths. Better Auth owns OAuth state, cookies,
CSRF, account bindings and sessions. Do not parse Google tokens in product code.
`resolve(req)` returns the current admitted Better Auth session or null;
`actor(session)` returns `{version:1,issuer,subject,name,image?}`. Profile fields are
presentation only. `protect` attaches this actor to `req.humanIdentity` and closes
registered responses on expiry or session deletion. It registers each response
before an authoritative session recheck to close the revocation/admission race.
`status` is the existing
`/auth/session` seam. `dispose` closes registered responses, not the caller's DB.

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

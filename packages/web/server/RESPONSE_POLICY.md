# Optional HTTP response policy

`HTTP_RESPONSE_POLICY_VERSION` is `1`. A server integrator can pass a trusted
`responsePolicy` callback to `startWebUiServer`. There is no CLI flag or client
header that enables this hook. With the option absent, OpenChamber does not add
this middleware or perform extra authentication lookups.

## Contract and placement

The callback receives the native HTTP request and a frozen context:

```ts
responsePolicy(request, {
  signal: AbortSignal,
  getHumanSession(): Promise<{
    readonly id: string;
    readonly createdAt: number;
    readonly expiresAt: number;
  } | null>
}): readonly (readonly [string, string])[]
   | Promise<readonly (readonly [string, string])[]>;
```

The callback is captured at startup. It runs after the human application Host
check and before robots, CORS, bootstrap and static routes. It has no response
writer or middleware continuation. The integrator owns the designation logic;
OpenChamber does not interpret a helper role or create an authentication session.
The hook covers HTTP responses, not WebSocket upgrade authorization.

`getHumanSession` lazily resolves the real server-authenticated session once per
request. Its result contains only the session ID and creation/expiry epoch
milliseconds. Missing, deleted or expired authentication returns `null`.
Malformed non-null metadata or a resolver failure refuses the request. No cookie,
token, user object or client-supplied designation is returned to the callback.

The complete policy/auth observation has a five-second deadline. Response close
or deadline aborts the signal. Invalid results and failures produce a fixed
`503` response when the response is still writable. Late completions cannot add
headers or invoke the next route. A trusted callback must honor the signal for
its own external work; the hook cannot forcibly stop arbitrary JavaScript or an
underlying authentication promise.

## Header and cache behavior

Results must contain at most 64 valid header pairs totaling at most 16 KiB.
Validation completes before any policy header is applied. `Vary` field lists are
validated and normalized (including HTTP tab/space separators) before publication,
then append to existing fields. Content Security Policies append as independent policies;
preview sandbox policies remain in force and intersect with the added policy.
Other header names use their normal replacement behavior.

A supplied Cache-Control must include `private` and `no-store`, and cannot
include `public` or `s-maxage`. Commas inside quoted extension values, including
quoted-pair escapes, are not directive separators. A quoted `no-store` string is
not a no-store directive; malformed quoted values refuse before any policy header.
Only a successfully validated policy can set the
server-owned cache override. Static, manifest and file-preview cache setters
preserve that override. Restricted static GET and HEAD requests bypass conditional
freshness so a previous cached asset cannot suppress the current policy-bearing
response. Without a policy override, stock asset ETags and `304` responses remain.

This is not a universal final-header interceptor. Unrelated API route families
retain their existing setters. In particular, Better Auth's real
`GET /api/auth/get-session` still finishes with `Cache-Control: no-store`.
Integrators must test their actual Document, Script and authentication response
paths rather than assume every response retains the same cache header. A
session-selective integrator must return `Vary: Cookie` for **ordinary** executable
responses too, not just restricted ones: otherwise a fresh unrestricted worker
can remain reusable after the cookie changes. The generic hook appends that field
without disabling ordinary CSP/socket behavior. Pre-activation cache or an
unchanged cookie designated after restart requires a fresh isolated helper context.

## Validation

The explicit Node probe `lib/1190-response-policy-server-probe.js` imports the
public server factory. The Vitest file `lib/1190-response-policy-http.test.js` uses
real auth, bootstrap and static factories. The probe checks startup capability,
Host/order, real session metadata, deadline and closed-response publication.
The HTTP tests cover default behavior, CSP intersection, malformed metadata,
restricted conditional GET/HEAD and unchanged stock `304` responses. The companion
`1190-response-policy-header-validation.test.js` checks quoted directives, escaped
quoted pairs, invalid output with zero early publication, and normalized Vary.

Run from `packages/web` with the owning frozen dependencies:

```sh
node --test --test-force-exit --test-timeout=20000 server/lib/1190-response-policy-server-probe.js
node node_modules/vitest/vitest.mjs run server/lib/1190-response-policy-http.test.js server/lib/1190-response-policy-header-validation.test.js --maxWorkers=1 --fileParallelism=false
```

These source tests do not prove a deployed browser policy, real voice or terminal
use, a security review, or a release. Any integrator-specific browser policy must
have its own served-page and normal-session controls before deployment.

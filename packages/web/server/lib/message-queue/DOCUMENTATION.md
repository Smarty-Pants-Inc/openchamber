# Message queue

## Ownership

This module owns accepted background messages for web, Electron, hosted mobile,
and Capacitor mobile. Shared UI renders its projection. VS Code has no
OpenChamber server and keeps its existing foreground queue. Closing all VS Code
webviews stops foreground delivery.

- `runtime.js` owns admission, serialized transactions, dispatch, recovery and routes.
- `persistence.js` owns v2 file writes and v1 migration.
- `runtime.test.js` covers delivery, holds, commands, context and route behavior.
- `durability.test.js` covers write failures, capacity, uncertain attempts,
  capability refusal, recovery and migration.

The server creates the runtime in `server/index.js`, registers its routes through
`opencode/feature-routes-runtime.js`, and stops it through
`opencode/shutdown-runtime.js`. The existing authenticated route family and JSON
body limit apply to recovery too. Recovery routes are not URL-token allowlisted.

The UI owners are `stores/messageQueueStore.ts`, the queue branch of
`components/chat/ChatInput.tsx`, and `components/chat/QueueRecoveryNotice.tsx`.
Runtime request lifetime remains owned by the shared runtime transport. Queue
code does not mint backend history views or grant session readiness.

## Admission and capacity

Before accepting an item, the server reads authenticated, directory-scoped
`GET /global/health`. An explicit `capabilities.messageQueue: 1` permits queueing.
A value of `0`, an invalid value, or an identifiable Code backend with a missing
value refuses queueing. Code is identifiable by `displayAttribution: 1` or the
legacy `ordinaryCreateOnly: 1` signal. Healthy stock OpenCode without these fields
retains its supported path. Capability is not authorization or an admission
receipt. The Code owner must advertise `1` only for a qualified backend.

Admission checks run before mutation and again inside the serialized transaction
for capacity and backend identity. Limits are 20 retained items per session and
50 retained sessions. Overflow returns `409`; accepted work is never evicted.
Uncertain and taken records count toward capacity until explicitly removed.
A session queue cannot change directory while it retains items. Content is
limited to 200,000 characters; the route family's 50 MB JSON limit bounds payloads.

A transaction builds a candidate map, writes it, then publishes the in-memory
state, revision, event and response. Failed persistence leaves the prior map
intact. Dispatch cannot observe an uncommitted admission. Broadcast failure cannot
undo acceptance. A client-supplied `requestId` identifies a lost admission response
in a later snapshot. Repeated IDs still present in the queue return `409`.
This is not a permanent deduplication ledger: clients must not retry an admission
POST after an ambiguous response, including after an item has already settled.

## Payload and states

Each item stores its ID, creation time, raw `content`, delivery `text`, optional
`agentMention`, attachments, captured context and required send configuration.
Attachments include their `dataUrl`, filename, MIME type, size and source.
The captured model is `{ providerID, modelID, agent?, variant? }`.

Context preserves order and includes one of:

- `{ kind: 'context', text, metadata, instructions? }` for attached draft or linked context.
- `{ kind: 'instruction', text }` for instructions derived from the message.
- `{ kind: 'synthetic', text }` for context supplied by another UI action.

The server validates the context envelope. The metadata payload belongs to
`packages/ui/src/lib/messages/contextParts.ts`, where the UI parses it on recovery.
Public snapshots and events omit attachment data URLs and all captured context.
Authenticated item recovery returns the full payload without changing custody.

| State | Meaning |
|---|---|
| `pending` | Accepted, not yet attempted; eligible for dispatch |
| `attempting` | Attempt marker persisted before the upstream POST |
| `unknown` | An attempt may have taken effect; review required, never automatic replay |
| `blocked` | Backend no longer supports queueing, or the session was deleted; review required |
| `taken` | Full payload transferred to a foreground caller; retained for recovery, never server replay |

A recovered `attempting` item becomes `unknown`. Failed attempt settlement also
leaves a non-replayable item, even if the write of `unknown` fails. In that case
the stored `attempting` marker remains the recovery evidence. An uncertain head
holds subsequent work in that session. Other sessions continue independently.
Reorder requests list every visible pending or live-attempting item exactly once.
Recovery records keep their slots, and live attempts are fixed barriers too.
Pending items can move only within their existing segment between barriers.
Cross-barrier moves return `409`; missing, duplicate or hidden IDs return `400`.
A failed settlement's non-live attempt marker is projected as unknown and is not
part of the reorderable ID set. Reordering never requires deleting custody.
Bulk clear removes only pending items not reserved for sending. Individual
reviewed removal can delete an uncertain or taken record. Session deletion blocks
pending items rather than destroying their payloads.

## Delivery

Startup, reconnect and live idle/completed events arm dispatch. The quiet timer
coalesces turn-boundary events. A recent abort and UI holds delay delivery.
Before each attempt, the runtime checks capability again and verifies live idle
state using session status and the trailing message. Failed reads mean unknown
readiness, not idle. Read/preparation failures may retry; an upstream POST failure
never automatically retries.

The runtime captures backend URL and auth headers and checks they are unchanged
before dispatch. It persists `attempting` before issuing the POST. Successful
upstream completion removes the item in another persisted transaction. A lost
response or failed settlement becomes `unknown` without another POST.

Recognized slash commands without captured context use the command route.
Commands with context use the prompt route, with their template expanded or a
skill invocation instruction attached. Prompt part order is text, files, captured
context, skill instruction, pending project knowledge, then agent mention.
Project knowledge is marked delivered only after upstream acceptance.

Auto-review holds use `PUT .../hold`, defaulting to five minutes and capped at ten.
The UI refreshes active holds. Holds, live send reservations and timers are
process-local; persisted attempt state is the restart safety boundary.

## Persistence and migration

`<data-dir>/message-queue-v2.json` stores
`{ version: 2, revision, sessions: { [sessionId]: { directory, items } } }`.
The data directory is the existing `OPENCHAMBER_DATA_DIR` location. Writes use a
same-directory temporary file with mode `0600`, then rename. Transactions serialize
read-modify-write operations, not merely file writes. This requires one owning
server process per data directory; concurrent old/new processes are unsupported.

This implementation covers process restart and observed write/rename failures.
It does not fsync the file or parent directory and does not claim power-loss or
storage-controller durability. Browser foreground persistence is also not a
server durability guarantee. These limits must remain visible in release approval.

Old queue readers ignore the version field. V2 therefore uses a separate filename
and leaves an empty v2 guard in `message-queue.json` so an older binary cannot replay
uncertain v2 items. The guard is checked before every write and on v2 load.

On first v1 load:

1. Validate the entire legacy file. Every legacy item becomes `unknown`, since v1
   cannot prove whether it was already attempted.
2. Save the original bytes to `message-queue.json.v1-backup`, without overwriting
   a different existing backup.
3. Write the v2 recovery file, then replace the legacy file with the empty guard.

A crash between migration writes can leave both files. Loading then fails closed
until an operator reconciles them. Malformed legacy JSON is moved to
`message-queue.json.corrupt-<timestamp>` before empty startup is allowed. A failed
quarantine, invalid stored record, unsupported version or unreadable file blocks
admission; none becomes authoritative empty success. Invalid v2 bytes stay in place.

### Rollback

Stop the owning server before rollback or file repair. Preserve the v2 file,
legacy file, v1 backup and any quarantine files together. Recover full payloads
and reconcile uncertain effects against backend receipts or history before
removing reviewed records. Recovery itself never resends a message.

An older binary sees the empty legacy guard and does not deliver v2 work. Keep the
v2 file for return to the new binary. Do not copy the v1 backup over the guard or
import it as pending work: it can contain already-delivered messages. If the old
binary writes new legacy work, the new binary refuses startup/admission rather
than merge it into v2. Reconcile both sets offline before repairing the guard.
There is no automatic downgrade conversion or automatic reconciliation command.

## Routes

All paths below are under `/api/message-queue`. Snapshots are payload-free
projections, despite including all item IDs and states.

| Route | Contract |
|---|---|
| `GET /` | `{ revision, sessions[] }` projection |
| `GET /sessions/:id/admission?directory=...` | Capability/capacity preflight; `{ supported: true }` |
| `POST /sessions/:id/items` | `{ directory, item, requestId? }`; durable admission response includes `itemId` |
| `GET /sessions/:id/items/:itemId` | Read-only full-payload recovery |
| `DELETE /sessions/:id/items/:itemId` | Explicit removal; `409` while sending |
| `POST /sessions/:id/items/:itemId/take` | Persist `taken`, return full item; repeat transfer refuses |
| `POST /sessions/:id/take` | Persist `taken` for all transferable pending items, return payloads |
| `PUT /sessions/:id/order` | Complete permutation of visible IDs, preserving attempt/recovery barriers |
| `DELETE /sessions/:id` | Clear pending work, preserve uncertain/transferred/in-flight records |
| `PUT /sessions/:id/hold` | `{ held, ttlMs? }` |

Mutations broadcast `openchamber:message-queue.updated` with `{ revision, session }`.
The session retains its directory even when its last item is removed. Full recovery
payloads are returned only to the authenticated requester, never broadcast.

## UI and foreground recovery

The composer captures text, synthetic parts and inline draft identities before
its first preflight await. It preflights before preparing documents or consuming
input, and consumes only those captured entries after acceptance. Later edits
remain intact. An ambiguous POST retains local payload as `unconfirmed` and makes
only a read to reconcile the request ID. An unresolved item blocks further intake
for that target. The recovery notice downloads full JSON and confirms reviewed
removal; it has no Send or retry action.

Unknown, blocked and taken items stay out of ordinary queue chips and foreground
sendable lists. Browser legacy queues are retained for review, never uploaded on
hydration. Foreground VS Code admission checks the selected backend through its
existing scoped SDK. Its in-flight failures become unknown. Persisted foreground
items return as recovery work on reload, not ready-to-send work.

Full-snapshot hydration preserves every newer per-session projection, including
recovery and sending IDs, even if that session is absent from the older snapshot.

Edit takes remain accepted even when the initiating editor is no longer current.
The store retains the full taken payload under the captured queue target. Only
editor publication checks the captured composer identity, current input and
runtime request scope, including transport/auth generations. Late takes never
append attachments or replace text/context in another editor, and never become
fake rejection or automatic retry. Queue chips delegate the entire Edit action
to the composer rather than writing to the global input store themselves.

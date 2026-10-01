# Inbox-backed Steps

`StepsLayout` sits below the desktop or mobile chat header and outside the transcript scroller. It keeps the chat mounted. `StepsAnchorBoundary` captures the outgoing viewport before a chrome update and compensates in the same commit. A reading anchor keeps its screen position; a reader at the end stays there. The fixed row height also prevents Copy feedback and next-step changes from resizing the transcript. Dropdown and phone sheet closing use the existing focus-return behavior.

## Authority and grouping

`smartyInbox.ts` owns one all-state snapshot per existing inbox badge SSE refresh. Completed and snoozed items remain in this snapshot; only open items contribute to the badge. There is no Steps watcher or persisted checklist. Fetch failure retains visible records but revokes actionable group authority. Runtime changes clear the snapshot and reconnect the existing subscription. Late reads and mutation receipts cannot publish into a replacement runtime or identity.

`inboxSteps.ts` accepts `steps:v1:<list-id>:NN/TT`. The list ID is 1–128 ASCII letters, digits, periods, underscores or hyphens, starting with a letter or digit. Ordinals and totals are exactly two decimal digits, from 01 to 99, with ordinal no greater than total. Groups are recipient-scoped. Titles use `<topic> — <instruction>` and actions are exactly `["respond"]`. Duplicate ordinals or item IDs, inconsistent totals/topics, and malformed members poison their claimed group. The HTTP parser retains a malformed member's group identity as a blocker rather than silently dropping it. Unrelated valid groups remain usable. A group is complete only when every ordinal exists once. New arrivals do not replace the selected list.

## Copy and completion

The whole recommendation is one raw Copy target. It is never trimmed, split, prefixed, sanitized, or given a newline. LF, CR and every C0/C1 control refuse Copy. Visual wrapping does not change the payload. The existing clipboard helper must return success before the UI says Copied. Its legacy fallback removes its temporary textarea and restores focus even on failure. Safe HTTP(S) links have a separate Open action.

Done posts the exact report in `STEP_DONE_REPORT`, `action: "respond"`, the displayed `updated`, and a fresh `opKey`. A tick requires the recorded recipient answer plus its matching recipient resolution, `respond` actions and timestamp. Generic resolution or Ignore is not Done. No optimistic tick is stored. An uncertain write performs one item read and never replays. Failed reconciliation requires an explicit read-only Check status before another action.

Undo appears only when the all-state response explicitly advertises `capabilities.guardedReopen: true`. Otherwise the row explains why it is unavailable. Supported Undo posts the displayed version and a fresh operation key to reopen; no unguarded fallback exists in Steps.

Web, Electron, hosted mobile and Capacitor use the existing authenticated inbox route and shared runtime fetch. VS Code and embedded/mini chats intentionally do not mount this person-inbox UI or start a watcher; they have no existing inbox badge subscription to reuse.

Mounted tests model the real flex viewport geometry because happy-dom does not calculate layout. They prove synchronous compensation, draft/focus preservation, overlay return focus, and guarded state transitions. Main owns browser layout, reload/reconnect, native-client and real-sitting evidence. These unit tests do not claim those acceptance gates.

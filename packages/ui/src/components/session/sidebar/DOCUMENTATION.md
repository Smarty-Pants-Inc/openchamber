# Session Sidebar

Sidebar code is organized by the business object it owns. Shared contracts are
kept at this root in `types.ts` and `utils.tsx`.

- `shell/` owns sidebar chrome, navigation, search, confirmations, and switcher effects.
- `list/` owns global-first session collection, directory bootstrap demand,
  layout-owned synchronization, authoritative cleanup, and nearby-session prefetch.
- `projects/` owns project zones, grouping, ordering, scroller behavior, project
  view state, repository state, and worktree presentation.
- `sessions/` owns session rows, row actions, expansion, ownership, and activity indicators. A collapsed group or folder shows one indicator for its hidden sessions: a pending permission (shield) outranks a pending question, which outranks a running turn, which outranks unread. Pending requests are read from the cross-directory `global-blocking-requests` index, so a project never opened in this launch still shows them; running and unread come from the global status index and the notification store.
- `recent/` owns Recent and managed Chats activity projections.
- `folders/` owns folder DnD, bulk actions, archived folders, and folder UI.
- `sessionSidebarRowModel.ts` owns the ordered, mode-neutral projection for
  Chats, Recent, projects, groups, folders, sessions, status notices, empty
  states, and reveal controls. `SessionSidebarRows.tsx` is the shared desktop
  Web, Electron and VS Code sidebar row renderer. Normal and committed-search modes use the same
  model and the same `@tanstack/react-virtual` instance.
- `list/useSidebarGroupStatus.ts` subscribes to project and standalone Chats
  directories together. Chats uses the same `activity:chats` identity for status
  and row projection, including a Chats-only sidebar. A successful list stops
  loading independently of initialization; failures keep their retry/access actions.
- Root session right-click and overflow menus expose `Move to worktree`: a submenu
  listing catalog-admitted primary and linked worktree destinations, with the current
  target disabled and a separate `New worktree...` action. Opening the submenu
  refreshes the worktree topology. Moving transfers the full idle subtree. Clean
  and non-Git sources move session-only; a dirty Git source prompts to move only
  the session, move all source changes, or cancel. Descendants move first without
  changes and roll back session-only if a later descendant fails. The root moves
  last and carries source changes once, which prevents rollback from replaying the
  transferred patch into the source.
- Failure cleanup: a worktree created for the move is removed only after a
  definite failure. When the change-carrying request fails without confirming
  its outcome, that worktree is KEPT (it may hold the only copy of the user's
  changes), both directories are refreshed authoritatively because the session
  may have moved server-side, and the toast points the user at the destination.
  Existing destinations are never removed; they get the same guidance.

`MainLayout` and `VSCodeLayout` call `useSessionListSync({ isVSCode })`
unconditionally. The hook is the only bootstrap demand owner and publishes
only the current directory and the selected session's directory; it also
refreshes newly added topology, coalesces control events, and performs
authoritative cleanup. Root-level `useGlobalSessionsPolling` remains the only
initial and 45-second global poller. `useSessionListSync` must not create a
second global polling lifecycle.

The global sessions cache is the complete source for active and archived
coverage. Initialized directory stores only supply sessions missing from that
cache. Live busy and retry state comes from `global-session-status`, never from
the global cache or persisted history. A failed global or directory fetch keeps
existing data; it is never treated as an authoritative empty list.

Web and desktop show managed Chats before optional Recent activity. Chats use
their shared managed root for folders and never expose worktree actions. Project
display can be all projects or one selected project. The mobile sessions sheet
(`apps/MobileSessionsSheet.tsx`) partitions the same way through
`partitionSidebarSessions` and lists Chats as a collapsible section above the
project tree, with no Recent projection. VS Code excludes worktrees and managed
Chats, while retaining its workspace-scoped grouped list and inline archived
buckets.

Hosted mobile and Capacitor use their separate `MobileSessionsSheet` renderer.
The shared directory-cache rules apply there, but this sidebar virtualizer does not.

Both project display modes use `projects/CrossfadeZoneHeaders.tsx` for sticky
zone headers. The live header keeps one portal host as it moves between its
virtual row placeholder and a stationary layer inside the native scroller,
preserving its controls and menu state. The global virtualizer keeps the current
and adjacent project/activity headers mounted and publishes each row's logical
start for boundary measurement. Row and header resizing or virtual-start changes
refresh cached boundaries; scrolling only compares those offsets
and changes the DOM at a zone handoff. An inert, accessibility-hidden snapshot of
the outgoing header fades over the incoming header for 150 ms. Reduced motion
skips the fade. Project dragging temporarily returns headers to their sections
without remounting controls. Reordering refreshes boundaries using layout offsets
that include virtual positioning but exclude sortable transforms, so settling
animations cannot leave stale header positions. The sidebar has no separate
desktop-only top gradient or identity overlay.

Directory demand covers only the directory being worked in. Showing,
expanding, or restoring a project never bootstraps it. Row mounts must not start
bootstrap work. Selection and activity subscriptions stay session-scoped so a
structural list update does not make every row observe unrelated streaming
updates.

Session menus share `SessionAiRenameMenuItem` with header tabs and the
single-session header. AI renaming uses the same leading spinner as a worktree
move; the pending operation survives closing the menu or selecting another
session. Eligibility loads only while a menu is open. See the AI session titles
section in `sync/DOCUMENTATION.md` for context selection and mutation guards.

Manual rename inputs share `components/session/sessionRenameKeyboard.ts` with
the header and mobile list. Enter explicitly submits the owning form on
keydown; Escape cancels. IME composition keys keep their text-input behavior,
and held Enter does not submit repeatedly.

Run fusion eligibility comes from `lib/multirun/identity.ts`, with title parsing
only for unmarked legacy sessions. Row memoization compares those same semantics
so metadata-only membership changes update the menu. See
`lib/multirun/DOCUMENTATION.md` for source selection and fork rules.

## Search

Dedicated search fields in the sidebar, mobile session list, and archive submit
only on Enter. `SessionSearchInput` owns draft text locally; list owners receive
only committed queries, so typing does not invalidate the session tree. Clearing
the field resets the applied query immediately. IME confirmation and held Enter
do not submit. Escape clears text first, then closes the sidebar search when
already empty. Session rows receive one stable reset action rather than transient
search-open or draft state. Closing a retained mobile search discards unsubmitted
text.

Sidebar and Recent queries beginning with `ses_` match only the full session ID,
case-insensitively and ignoring surrounding whitespace. Partial IDs and typos
return no matches, without falling back to titles, directories, group labels,
or folder names. Ancestors remain as tree context for a matching child. A matched
node keeps its subtree for rendering and subtree actions. Only exact ID matches
count toward the result total.

Search changes model inputs, not renderer ownership. It forces project, group,
folder, and activity rows open without changing the normal-mode collapse or
show-more state. Closing search therefore restores the exact prior Chats,
Recent, project, group, and folder projection.
ID search does not include archived sessions. `ArchiveView` applies the same
exact-ID rule to its own archived list. Other queries keep each view's existing
matching and ordering. Search does not fetch sessions or broaden list membership.

## Loading rules

- Publish bootstrap demand only for the current directory and the selected session's directory. Known project roots and worktrees are topology, not demand: rows and sessions come from the global session list, activity from the global status index and the host status seed. Every directory bootstrap makes OpenCode create an instance, so demanding the whole topology created one per project at startup.
- Directory demand, refresh requests, and sidebar membership preserve path case after separator and drive-letter normalization, in stock and managed runtimes. Differently cased Linux project paths are distinct scopes; a lowercase alias must not admit sessions or address another directory.
- A never-bootstrapped directory shows as ready. Load failures and denied folder access surface when it is selected; the group notice retry still forces a bootstrap. Once the managed catalog has answered and its global session list has loaded, queued directory enrichment does not turn a known-empty workspace into a loading notice. Stock loading and managed list, initialization, and permission failures remain explicit.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. The session row tree unmounts so row-owned status, permission, unseen, and viewport subscriptions do no background work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- The sidebar does not subscribe its whole tree to the cross-directory live-session aggregate. Global create/structural/lifecycle snapshots drive rendered session metadata; the cached sync index only fills sessions not yet present globally and provides refresh fallback data. Row activity continues to come from the session-keyed live status index.
- Session selection does not invalidate the sidebar orchestration component. Each mounted row selects only whether its own session ID is active, while parent expansion, project selection memory, and neighbor prefetch run in small effect-only subscribers.
- Parent expansion is exclusively manual. Selecting or navigating to a subsession never expands its parent automatically. Project/worktree and `recent` trees use independent persisted context keys and receive separate stable projections, so expansion changes in one context neither invalidate nor change the other. The persisted storage key remains `v3`; older state mixed contexts and is not migrated into this contract.
- The sidebar model flattens parent/child sessions into occurrence-keyed rows.
  `SessionTreeItem` renders one row with `renderChildren={false}`; it must never
  recursively mount descendants in the shared scroller. One preorder ID pool
  plus index ranges supplies hidden descendants to subtree selection without
  copying a descendant array for every ancestor.
- The existing `ScrollableOverlay` is the sole scroll owner. The shared row
  renderer measures variable-height rows, uses stable occurrence keys, keeps a
  bounded pre-initialization window, and pins editing, focused, and open-menu
  occurrences in its range extractor. The scroller publishes its DOM element
  through callback-backed state so virtualization activates after every mount
  without waiting for an unrelated render. Archived groups must not add a
  nested virtualizer.
- Sticky project/activity identity comes from model header descriptors and the
  first visible virtual index, which keeps the live current and adjacent header
  rows mounted. `CrossfadeZoneHeaders` uses their cached virtual layout offsets
  for the visual handoff. DOM sentinels and intersection observers are not used.
- Shift selection and Ctrl/Cmd+A consume the model's logical row order. API
  session IDs are deduplicated only at the action boundary, after hidden
  descendants have been included. Selection is cleared on runtime switch and
  confirmed session deletion. Bulk destructive actions classify archive state
  from the model's current session records at action time, never mounted DOM or
  selection-time metadata. A confirmation owns an immutable ID and action
  snapshot; changed targets or archive authority require confirmation again.
  The current session map comes from unfiltered project sections, so collapsing
  a project or entering search cannot hide authority for an existing selection.
- Rename drafts stay parent-owned, while editing and menu lifecycles are keyed
  by row occurrence. Duplicate Recent, project, and folder rows never open a
  second rename input, and the owning occurrence remains mounted through menu
  close completion. `useSessionRowMenuState` keeps the shared open-menu key
  pinned until close completion while a local close request drives the
  controlled `open` prop; a controlled menu whose `open` follows the pinned key
  never closes, so its deferred rename never starts.
- Folder drops carry occurrence drag keys and owner-scoped targets. A drop is
  accepted only when the current model marks every owner scope complete and
  the source and target owner match. Archived rows and archived targets never
  accept drops.
- Session rows allow vertical touch panning before the long-press drag activates.
  The TouchSensor owns movement only after activation; disabling touch panning on
  the whole row prevents quick swipes from scrolling even when no drag starts.
- `folders/SessionSidebarFolderItem.tsx` owns activity subscriptions for mounted
  collapsed folder headers. It includes descendant activity and respects the
  unread-subtask preference without mounting those sessions. Expanded and archived
  folders do not derive hidden activity.
- Single-project flat mode reveals 20 root sessions initially and 20 per Show
  more; Show fewer resets to 20. Chats retains its own default reveal size. Reveal
  controls change the logical list, not the viewport's bounded mounted window.
- Archiving or deleting a session takes its whole active subtree with it on every surface, because the server does not cascade `time.archived`. Recent and managed Chats build their rows with `buildActiveSessionNode` from `list/sessionCollection.ts`, so the descendants a row collects match the project tree at any depth; the mobile sessions sheet resolves the same lineage with `getDescendantIds` over its full active list rather than the rendered bucket. `sessions/sessionSubtreeActions.ts` owns the single-versus-batch store calls and the outcome toasts for all of them, and `collectSessionSubtreeIds` extends the surface's own descendant list at action time with a walk over the global active-plus-archived cache, so an active subagent below an archived intermediate is still archived (archive skips the archived intermediate; delete includes it). A projection that flattens a tree to one level silently leaves grandchildren active.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, share, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- A worktree Git still registers but whose directory is gone (`prunable` in `git worktree list`) stays in the topology with `worktreeStatus: 'missing'` and a warning icon on its group header. Its sessions remain accessible for manual movement or archiving through worktree deletion. Opening a session does not move it. The ordinary worktree delete action accepts a missing directory. Topology discovery remains event-driven, including `session-created` and server `worktree-changed` control events, with no idle polling. The server sends `worktree-changed` after its own worktree create/remove and when a status or listing request notices that a repository's worktree set changed (see `packages/web/server/lib/git/DOCUMENTATION.md`); the event names every directory of that repository the server has seen, and the stock sidebar refreshes each registered project among them once, bypassing the 30-second list cache. Managed topology remains catalog-owned and does not start stock Git discovery from that event. A worktree this client created and is still bootstrapping keeps its `pending`/`invalid` status through that refresh. Hosted mobile and the desktop mini chat handle the same control event through `lib/worktrees/worktreeTopologyRefresh.ts`; VS Code intentionally excludes worktree topology.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's physical worktree topology. Raw discovery and the manager cache retain unadmitted paths. Both menu and background discovery filter sidebar publications against the current project catalog after partitioning, including retained topology from other projects. Cached and refreshed menu targets use the same admission rule, including synthetic primary/current targets. Admission can reveal a cached path; removal during a refresh cannot republish it. Runtime guards, force generations, and raw-topology revisions still reject stale work. If refresh fails, the menu retains its admitted cached targets and the load failure stays explicit. Failure cleanup never removes or manages an existing destination worktree.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event retriggers bounded worktree discovery so a catalog-admitted external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- Recent membership includes active root sessions immediately even when their last committed `time.updated` falls outside the 48-hour window. Children and archived sessions remain excluded, and inactive roots remain timestamp-based. The active-ID subscription is disabled while the sidebar is hidden and ignores retry/status detail changes, avoiding streaming-frequency rerenders.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, or branch changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- List loading and workspace initialization have separate states. The spinner follows only the list queue; config, MCP, LSP, and live-state recovery cannot keep a successful empty list spinning. A core initialization failure has a separate localized notice and reuses the retry/native-access actions without clearing loaded sessions.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges fade with the same hover/menu-open rule as the date label, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the badges shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its badges keep fading (`selectRowBadgeVisibilityClass` in `sessions/sessionNodeItemUtils.ts`).


## Personal open/create reveal

`list/sessionReveal.ts` mounts an effect-only subscriber in the desktop collection
and mobile sheet. Explicit local opens, including same-ID reopen, and creation
capture one runtime/auth-scoped intent with its initiating preference-admission
cohort. Creation captures before asynchronous preparation and forwards that
ticket at selection. An initial shared `?session=`
link is an explicit open, including when bootstrap already selected that ID.
Only a reload of this tab's last admitted shown session is non-revealing. The
router records that receipt in safe sessionStorage, keyed by runtime and the
sidebar preference GET's admitted issuer/subject. Browser-wide last-session
memory and cached human profile data never classify the link. A draft clears the
tab receipt. Back/Forward and explicit same-ID reopen still reveal once.
Embedded session chats and VS Code retain their existing navigation policy.
Restore, background rows and model changes do not create reveal work. A later explicit choice retires earlier
work; old request scopes cannot reveal the new person's view.

Reveal waits for the selected root row in its admitted rendered group, consumes
the marker before writing personal expansion through `lib/sidebar-view.ts`, and
expands only its project and group. Explicit same-target collapse cancels pending
work even before ownership arrives. Unrelated collapse does not cancel it.
A waiting catalog open keeps its original scoped ticket through admission, so
catalog publication cannot undo a later manual collapse.
Desktop pagination uses the target group's sorted, unfoldered roots. The collection mounts `SessionGroupRevealPagination` independently of virtual rows, so a headerless root or an offscreen group still consumes its receipt. Header-only `SessionGroupSection` instances do not own that pagination. Mobile uses
the target bucket's actual roots. Neither path fetches history to reveal a row.

Human mobile uses the same sparse personal maps and shared project defaults,
without claiming `mobile-session-tree` anonymous values. Worktree keys adapt to
`${projectId}:worktree:${normalizedPath}`; its unheaded root bucket uses
`${projectId}:root`. Mobile still renders one root bucket rather than desktop's
workspace subgroups. Legacy mobile and VS Code retain their existing view path.

A current preference PATCH returning owner-mismatch 409 retires the old person's
maps and request authority, then loads the newly admitted person's preferences.
Queued old-person choices reject without dispatch or replay. A stale 409 cannot
retire a newer view. Ordinary storage errors keep same-person rollback behavior.

Before the preference GET admits an owner, desktop and mobile may queue local
choices. Failure of that owner-admission attempt retires its pending choices and
optimistic maps. A later successful read cannot authorize those old payloads;
saving requires a fresh choice. Healthy same-person pre-admission choices still
save after the original read succeeds. A stale failed read cannot retire a newer
entry. An open/create ticket cannot borrow a successor cohort: failed admission
revokes its expansion-save authority and delayed publication. A fresh open is
required before saving expansion under the successor. Publication requires the
original live marker; consumed work cannot resurrect even in the same cohort.
First consumer mounting does not retire a healthy initiating cohort. Manual-collapse reveal cancellation
remains local intent, independent of whether its durable preference save succeeds.

#1061 covers root rows and containing project/worktree groups only. Child and
folder reveal belong to [#1066](https://github.com/Smarty-Pants-Inc/smarty-code/issues/1066).
Parent and folder expansion remain manual, as agreed in the
[scope decision](https://github.com/Smarty-Pants-Inc/smarty-code/issues/1061#issuecomment-5909719193).
A root hidden inside a manually collapsed folder is not a #1061 visibility claim.
Mobile drawer page retention, a supported waiting-open caller/proof, cached
read-only person-change maps/receipts and test-fixture placement are tracked in
[#1132](https://github.com/Smarty-Pants-Inc/smarty-code/issues/1132). That follow-up
does not defer the failed-admission reveal fence or final repaired-head proof.

## Project action indicators

`SidebarTerminalActivity` shares terminal discovery with the action header and terminal
panel while the sidebar is visible. One server listing covers all directories, including
collapsed projects. The sidebar keeps that loop running only while a project action is
known to be running anywhere; with nothing running it lists once on mount, to pick up
runs another client started, and then stays quiet so an idle sidebar costs no polling. It preserves local mutations newer than the listing and keeps known
state on failure. Terminal discovery is separate from OpenCode session bootstrap.

`DirectoryActionIndicator` reads only its directory's terminal metadata. Output chunks and
unrelated directories do not rerender it. It displays a static `pulse` icon in `status.info`
for live project actions, including auto-discovered commands. Persisted idle tabs and ordinary
interactive terminals do not indicate activity. This indicates process activity, not server
readiness.

Grouped views show the icon on project-root and worktree headers. Flat project views show
it on the project-root header and on sessions in linked worktrees. Recent shows it on every
session with an active action in its own directory. Archived buckets do not show action
indicators. Indicators stay inside the existing row/header action-padding boundary, so
hover, keyboard focus, and always-visible action buttons move them left without hiding them.

# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them.

`ChatContainer.tsx` keeps one `ChatInput` mounted while a new-session draft
becomes its first session. Draft-only UI first fades for 120ms while the editor
stays in place. The parent then moves the editor to its final session position
with a 180ms transform-only FLIP animation. Reduced-motion mode skips these
transitions. `session-ui-store.ts` marks sessions materialized from a submitted
draft, so selecting an existing session while a draft is open switches without
animation. Do not restore separate draft and session composer branches:
remounting the editor loses focus and interrupts the transition. Keep the
existing mobile fixed-position rules unchanged.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer-local lifecycle state: ArrowUp/ArrowDown browsing, draft stash/restore, mobile shell, popup placement, draft targeting |
| `submit/` | Turning what the user has into what gets sent |
| `attachments/` | Files: paths, drop payloads |
| `ui/` | Presentation |
| `text.ts` | How inserted text meets the text already there |
| `largeTextPaste.ts` | Detect large plain-text pastes and build virtual `.txt` files |
| `largeTextPasteOffer.ts` | Ask-toast offer id begin/resolve (supersede + double-apply guards) |

`ChatInput.handlePaste` owns paste orchestration: URL-over-selection markdown
links, clipboard images (attach + citation), and large plain-text pastes.
Large pastes (about 2,000 characters or 25 lines) follow the composer setting
`largeTextPasteBehavior` (`ask` / `attach` / `inline`). Attaching creates an
in-memory `text/plain` file named `pasted-context-N.txt`, inserts a bracket
citation, and sends it through the same attachment pipeline as a manually
picked `.txt` file. Ask-toast actions read live composer/attachment state so
typing or other attaches between paste and choice stay consistent. Short text,
images, and URL wraps keep their existing paths.

## The prompt language

`language/` is the single source of truth for composer syntax. Everything that
needs to know what a token means — highlighting, send-time resolution, and the
autocomplete triggers — goes through it.

**This is the invariant that matters most in this module.** Before it existed,
the `@` rule was written four times with divergent cleanup and the `/` rule
three times with different valid character sets, so a token could be painted as
a reference and then not resolve as one. Adding a construct meant finding every
copy.

- `mentions.ts` — `@` references. The `start..end` span is the reference
  itself and is what gets highlighted; in `see @a/b.ts,` the comma is sentence
  punctuation, not part of the file being referenced. Mentions are plain
  editable text: deleting a character edits the token and reopens the mention
  picker, the same way `/skill` tokens behave — not an atomic delete.
- `prefixTokens.ts` — `/command`, `/skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` stays plain prose.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention`.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
  to the language means adding it here, once.

## The editor

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

The document is not, however, the string it was given: CodeMirror normalizes
line endings, so a `\r\n` pair becomes one break and the document ends up
shorter than the inserted string. **Never derive a caret position from the
length of text you are inserting** — a caret past the end makes `dispatch`
throw, the transaction never applies, and the un-normalized text stays in React
state to crash again on the next restore. Every edit that moves the caret goes
through `replaceWithCaret` (`editor/documentEdits.ts`), which measures the
change instead of the string.

The composer previously painted a transparent `<textarea>` over a mirror
`<div>`. That restricted highlighting to styles which do not change glyph
advance width — colour, background, underline — because anything else made the
mirror drift out from under the caret. Bold and italic were impossible, and the
overlay was disabled outright on mobile, where wrapped text drifted anyway.
**Those constraints are gone**; adding a width-affecting style is now a
question of design, not of feasibility.

Selection rendering: every device runs CodeMirror's `drawSelection()` — it
keeps typing on the drawn-selection code path, and removing it makes
CodeMirror enforce cursor association on the native selection, which iOS
answers with severe input lag. **That much is not platform-specific and must
not be undone.** What differs is who paints the selection, and
`composerSelectionExtension` (`editor/theme.ts`) picks that per platform.

When CodeMirror 6.43.9's iOS predicate does not match,
`composerNativeSelectionExtension` layers over `drawSelection()`: it re-shows
the native selection, and — only while a range is selected — the native caret,
hiding the painted layers those replace. The native selection is the one that
shows for two reasons: the painted layer sits behind the content, so tokens
with their own background (inline code, fences) cover it completely; and the
platform's selection drag handles attach to the visible native selection and
take their colour from the caret, so a transparent caret means invisible
handles. The range-only caret scoping is load-bearing — a native caret visible
while typing makes the browser re-render its caret UI after every keystroke,
felt as severe input lag.

When CodeMirror 6.43.9's exact iOS predicate matches,
`composerIOSSelectionExtension` leaves selection-handle geometry and appearance
to CodeMirror. CodeMirror puts the handles in `.cm-selectionLayer`, normally at
`z-index: -1`; the extension raises that layer above the content so opaque
token backgrounds cannot cover them, and leaves it transparent to touch.
The handle dots extend 8px past their range; matching scroller padding and
negative margin expand the clip area without moving the text or changing the
composer height. iOS still paints its taller system selection overlay even
when CSS makes `::selection` transparent. The extension therefore suppresses
CodeMirror's synthetic selection rectangles on iOS while leaving its handles,
cursor path and `nativeSelectionHidden` facet active. Otherwise the grey system
highlight and themed rectangle overlap with visibly different heights.
Do not add a second custom layer or custom handles here: overlapping translucent
rectangles make selection darker at their seams and imitated handles drift from
the geometry WebKit actually manipulates. What iOS avoids is installing the
native-selection workaround above: explicitly restoring native paint and caret
makes WebKit re-measure them after every decoration redraw, and the composer
rebuilds every decoration on every keystroke. That cost is felt worst during
IME composition.

The non-iOS native selection tint comes from `--primary`, not the selection
token: themes define `--interactive-selection` with its own alpha, so mixing it
with transparent again is nearly invisible. The iOS system overlay owns its
visible selection fill.

The content element keeps the existing correction policy: on in the mobile UI,
off elsewhere. CodeMirror also reads the attribute and reverts Apple and
Android's insert-period-on-double-space only when its value is exactly `off`.
`editor/autocorrect.ts` uses the HTML standard's
[ASCII case-insensitive `autocorrect` keywords](https://html.spec.whatwg.org/multipage/interaction.html#attr-autocorrect)
to keep desktop word correction off while avoiding that CodeMirror-only
revert. Its platform checks deliberately match CodeMirror's own browser flags.

`composerLanguage.ts` retokenizes the whole document on every change. The
composer holds a prompt, not a source file: it is short enough that a full pass
is cheaper and far simpler than incremental mapping, and it keeps the editor
and the send path reading the same grammar.

## Ordering rules worth knowing

- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  context drafts and linked references into OpenCode's one-primary-plus-parts
  shape. The oldest queued message becomes primary. **Every attached context
  item (inline comments, terminal selections, browser annotations, PR context,
  linked issue/PR) becomes its own synthetic text part carrying structured
  metadata** built by `lib/messages/contextParts.ts`; the timeline reads that
  metadata back to render context blocks. PR instructions precede the PR diff.
  The same module's `buildComposerContext` captures that context when a message
  is **queued** instead of sent: the chips leave the composer with the message
  (as `QueuedContextPart`s on the queue item), the server or the VS Code
  auto-send delivers them through `queuedContextToParts`, and editing the
  queued message puts them back. A queued message is placed as captured — its
  mention, file mentions, and skill instruction were resolved when it was
  queued, never at delivery — and its context follows it before the next
  queued message.
- Local slash commands are planned by `submit/slashCommands.ts` before any
  attached context is consumed. Commands that act on session or UI state
  (`/undo`, `/redo`, `/compact`, `/timeline`, `/handoff-review`) take only
  their command text and leave comments, files, and linked context attached;
  commands that produce a prompt (`/btw` and the magic prompts) send that
  context with the prompt they produce. Session actions are planned only when
  a session exists, so typing one into a new-session draft stays on the normal
  send path. A local command is never queued as text: queueing runs it
  instead. A failed prompt command restores everything it consumed: text,
  confirmed mentions, files, comment drafts, and pending synthetic context.
- `state/useComposerDraft.ts` — a draft belongs to a (runtime, directory,
  session) identity. Writes are debounced while typing but forced at every edge
  where the page may stop running, because a pending timer is not a saved
  draft. Two orderings are load-bearing: the debounced write is skipped once
  while a draft is being restored, and a deleted draft's empty signature is
  recorded before a queued write could resurrect it.
- `state/useDraftTarget.ts` — the draft can target a directory that does not
  exist yet (a worktree being created). It must survive not appearing in the
  branch list, or the selector snaps back to the project root mid-creation. It
  also owns the advisory dirty state for the selected directory, clearing it as
  soon as the target changes so a warning never names a previous branch.
- `ui/DraftTargetSelectors.tsx` owns the controlled project/worktree picker
  state and registers its application shortcuts locally. The selectors only
  consume their shared prefix while the draft target UI is mounted.

## Native create-only drafts

`state/useNativeCreation.ts` reads the selected directory's SDK `global.health`.
Only `capabilities.ordinaryCreateOnly: 1` enables the separate **Create native Pi
session** button in `ui/NativeCreationNotice.tsx`. A valid missing capability keeps
the existing OpenCode/Chord path. A failed or malformed read is not absence; it
shows a connection check, not permission to fall back to another runtime.

Creation requires a selected project draft with no title, parent session, or
pending worktree setup. `sync/native-draft-creation.ts` binds the one request and
its result to the runtime, draft ID, project ID and directory. The canonical
`session-actions.createNativeSession` indexes the returned owner but does not
select it, close the draft, consume input/context, or send a prompt. Duplicate
clicks and uncertain completion never submit another creation request. Records
are keyed by runtime, draft, project and directory in the UI store. Project and
runtime returns restore each result; late completion updates only its original
record. Records survive consumer remounts for this browser lifetime, with no
persistence, background replay, automatic eviction or restart guarantee.
SDK1.18.29 sends `session.create({ directory })` with no body or Content-Type;
the capability-advertising gateway must accept that empty creation request. It
must still validate supplied bodies and must not relax other mutation routes.

The successful attached session must include
`nativeCreation: { model: { providerID, modelID }, inputReady: boolean }` from the
just-created native snapshot. The UI displays that model, not the first connected
session's provider listing. Model and readiness are creation-time observations;
they do not change the native model or grant durable input permission. Finish
original-TUI dialogs and run `/code-ready` there. The UI never arms the session.

A later explicit Send uses `materializeOpenDraftSession` to prepare that owner
with its exact model, without another create POST. `native-draft-send.ts` waits
for the existing loader and checks its actually accepted ready history view.
A resolved loader promise with stored error, missing view or changed loader is
not acceptance. A later explicit Send can request a fresh read; it cannot replay
an earlier prompt. Runtime and draft target are checked after history loading,
after asynchronous SDK preparation and before dispatch. The composer carries the
prepared native intent through settings, snippet and prompt-command awaits into
the store. The store checks that intent before any materialization or mutation;
it cannot recapture another runtime and enter legacy creation. Concurrent sends
of the same prepared owner are refused.

The native branch leaves text, confirmed mentions, files, inline and synthetic
context in place until input admission succeeds. Only then does the acceptance
callback consume the submitted input. A successful response records acceptance
on the originating creation record even after navigation. It is not a stale
pre-dispatch refusal. Cleanup consumes only captured input and scoped inline
context; unrelated current input stays intact. The active original draft selects
its owner now, or on return to that accepted draft, without another prompt.

`useComposerDraft` treats this accepted materialization as an identity transfer.
It keeps newer unsent text and confirmed mentions with the native owner, with
stored drafts either on or off. Only the old draft slot is cleared; new inline
context transfers to the owner and newer files/synthetic parts remain attached.
History and native input refusals retain the original prepared input for another
explicit Send. Native `/code-ready`, model checks and accepted-view validation
remain authoritative; the UI does not manufacture a view or arm input.

Failures keep the draft. Validated non-retryable API errors retain the backend's
safe operation/pane/path details in the visible alert. Malformed success and
runtime/directory mismatch retain a validated returned ID/directory when known.
Arbitrary transport diagnostics stay private causes. A failure known to precede
`session.create` offers **Check connection**, which performs only a health read.
Success clears that failure and requires a separate explicit Create action.
Post-submission uncertainty has no such recovery control. Inspect Herdr before
an explicit new creation after an unknown result, including after a page reload.

Focused SDK/state tests and Happy DOM tests mount the actual composer, CodeMirror
and draft effects for these boundaries. The mounted tests retain the real store,
SDK and history loader, with synthetic HTTP and isolated unrelated widgets.
They do not prove real browser layout, native attachment or input admission. Current desktop/mobile and light/dark evidence, shared-runtime checks,
and browser-to-original-TUI proof remain integration/review gates.

## Optional display attribution

`ui/DisplayNameChoice.tsx`, Send and Queue share `browserDisplayName` in
`lib/messages/displayName.ts` as their applied-choice authority. Persisted names
use sessionStorage, never shared settings, and imply no sign-in, permission or
native-session ownership. Applying an empty name removes the saved choice.
Storage failure stays visible and never silently drops a name. The explicit
"Use unnamed until reload" action works without reading or writing storage. It
overrides naming only in the current tab until reload or a successful Apply;
any saved name remains unchanged. A failed Apply preserves the last accepted
choice and reports an error. A copied tab can inherit saved storage, not this
in-memory override; each person must choose their own label.

Name-input Enter reuses `isIMECompositionEvent`: native composition confirmation
and WebKit keyCode229 do not Apply. A later ordinary Enter or Apply click saves
the final input.

`ChatInput.handleSubmit` snapshots the applied name before asynchronous work.
`session-ui-store.routeMessage` carries that string into `client.sendMessage`,
which uses the SDK's text-part metadata key `smartyCodeDisplayName`. Prompt text
is unchanged on this wire. The existing SDK `global.health` call must advertise
`capabilities.displayAttribution: 1` before a named prompt is dispatched. A backend
that merely retains unknown metadata does not qualify. This is the same shared
path for web, desktop, VS Code and mobile; unsupported backends fail explicitly.

The owning Pi gateway labels its one native input and projects that native text
back into shared history. The name proves no authenticated identity or authority.
The UI does not write a second transcript or rewrite earlier labels. Programmatic
callers that omit `displayName` retain their legacy behavior. Named queue, shell,
slash-command and steering operations are refused before composer consumption,
rather than silently losing names through transports that lack this contract.
The early slash guard checks a nonmutating `trimStart()` view, matching local
command recognition without trimming the submitted draft.

Source tests cover tab storage, explicit storage-denial recovery, validation,
per-request SDK isolation and the actual inline command/IME decision guards.
Source-position checks bind those guards before command planning or side effects.
These tests do not mount React or prove rendered behavior, focus, mobile layout,
actual browser transport or native persistence. The owning Code integration supplies those acceptance gates.

## Input recall ownership

Prompt recall has two owners on purpose.

- `packages/ui/src/stores/useInputHistoryStore.ts` owns the persisted source of
  truth. It keeps the runtime-scoped global bucket and the runtime + directory
  + session bucket, each capped by the configurable input-history limit. That
  setting defaults to 40 entries. Recall reads the current session's bucket by
  default; the Chat setting can widen it to every project on the runtime.
- `state/useMessageHistory.ts` owns only keyboard traversal through whichever
  bucket the composer was given. Moving away from a position stores the
  composer's current text and attachments as an overlay for that position, so
  the live draft and any edit made to a recalled prompt survive a round trip
  through history. Overlays never rewrite stored history; sending resets them.
- `ChatInput.tsx` applies the recalled text and attachments to the composer and
  places the caret.

In session scope the composer merges two sources, oldest first: the visible
transcript's user prompts (`useUserMessageHistory` in `sync-context.tsx`), so
sessions that predate the persisted store still recall, and the persisted
session bucket, which adds attachments and keeps prompts a revert hid from the
timeline. A prompt present in both collapses to the persisted entry. Global
scope reads the persisted runtime bucket only.

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

**Every timeout and `flushSync` in them has a reason recorded next to it, and
none of them is verifiable outside a real device.** Change them only against
hardware.

## Testing

State/logic tests cover the language, submit assembly, paths, text splicing,
large-paste handling, input-history traversal and editor language extensions.
`submit/__tests__/nativeComposer.test.tsx` also uses the UI package's Happy DOM
dependency to mount real composer submission and draft-persistence effects. It
covers settings/snippet/command preparation races, accepted responses after
navigation and newer input through native materialization. It does not replace
browser subscriptions, layout, physical focus/keyboard, IME or WKWebView proof.
ArrowUp/ArrowDown recall and edited-entry overlay behavior still need manual
verification.
Do not report a change to them as validated on the strength of type-check and
unit tests.

Run tests per file (`bun test <path>`): `mock.module` is process-global, so
suites that install module mocks are order-dependent.

## Enter preference

`keyboardPolicy.ts` owns the submission decision. Until the Chat setting is
changed, desktop Enter sends, mobile and focus mode require Ctrl/Cmd+Enter,
and Shift-modified Enter does not send. An explicit choice applies across
shared composers; Ctrl/Cmd+Enter sends in either configured mode.

CodeMirror's deferred mobile Enter loses modifier information. Untouched
settings restore Shift to keep the original policy. Once configured, with mobile
autocapitalization enabled, the editor cannot distinguish its Shift flag from
an intentional Shift press and does not restore Shift. Consequently, deferred
Shift+Enter can send when Enter-to-send is enabled and cannot serve as the send
shortcut when it is disabled. Ctrl/Cmd+Enter remains the supported modified
send shortcut on this path.

/**
 * Per-session draft persistence for the composer.
 *
 * A draft belongs to a (runtime, directory, session) identity. Switching any
 * of those saves the outgoing draft and restores the incoming one, so moving
 * between sessions never loses typed text and never leaks it into the wrong
 * conversation.
 *
 * Writes are debounced while typing but forced at every edge where the page
 * may stop running — tab hidden, frozen, unloading, unmounting — because a
 * pending timer is not a saved draft.
 */

import React from 'react';
import { useInputStore } from '@/sync/input-store';

import {
    getChatDraftIdentityKey,
    claimChatDraftOwnership,
    isChatDraftEphemeral,
    readChatDraft,
    readChatDraftSince,
    savedChatDraftPredates,
    subscribeChatDraftPersistence,
    subscribeChatDraftConsumption,
    subscribeChatDraftDeletion,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Identifies a stored draft's content. Comparing signatures lets a repeated
 * save of unchanged text skip the write entirely.
 */
function draftSignature(text: string, confirmedMentions: Iterable<string>): string {
    // NUL separates the fields: no draft text can contain it, so two different
    // (text, mentions) pairs can never produce the same signature.
    return `${text}\u0000${[...confirmedMentions].sort().join('\u0000')}`;
}

export interface ComposerDraftOptions {
    /** Current composer text. */
    message: string;
    /** Latest text without waiting for a render, for flush-on-unload paths. */
    messageRef: React.RefObject<string>;
    setMessage: (text: string) => void;
    /**
     * Mention paths the user confirmed through the picker. Mutated here:
     * mentions no longer present in the text are dropped before saving.
     */
    confirmedMentionsRef: React.RefObject<Set<string>>;
    /** The draft this composer currently belongs to. */
    identity: ChatDraftIdentity | null;
    /** User setting: when off, drafts stay in memory without durable writes. */
    persistEnabled: boolean;
    /** A successful native first Send transfers the live draft to this session. */
    materializedSessionId?: string | null;
    /** Exact owner-qualified resolution of an implicit cold global draft, never ordinary navigation. */
    consumeCatalogDraftTransfer?: (previous: ChatDraftIdentity | null, current: ChatDraftIdentity | null) => false | 'restore' | 'retain';
    /** The draft restored on mount, if any. */
    initialDraft: { text: string; identity: ChatDraftIdentity | null };
    /** Called when the composer switches to a different draft identity. */
    onIdentityChange?: () => void;
    /** Called after restoring a saved draft or fork replay, to select its text. */
    onDraftRestored?: (source: 'saved' | 'fork') => void;
    readMessage?: () => string;
    onDraftConsumed?: (submitted: string, before?: number) => void;
}

export interface ComposerDraftControls {
    /** The last snapshot write failed. Live text remains available but is not saved across reload. */
    ephemeralOnly: boolean;
    /**
     * Write a draft now, bypassing the debounce. Used on submit, where the
     * cleared composer must be stored before the send resolves.
     */
    persistNow: (identity: ChatDraftIdentity | null, draft: string) => void;
    /** Consume a command in the current draft while opening another draft. */
    handoffDraft: (identity: ChatDraftIdentity | null, draft: string | null) => void;
    /** Restore a draft after a failed send without using persistence as state. */
    restoreDraft: (identity: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => void;
    /** Move an in-memory draft to an identity materialized during an async flow. */
    migrateDraft: (from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => void;
}

export function useComposerDraft(options: ComposerDraftOptions): ComposerDraftControls {
    const {
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity,
        persistEnabled,
        materializedSessionId,
        consumeCatalogDraftTransfer,
        initialDraft,
        onIdentityChange,
        onDraftRestored,
        readMessage,
        onDraftConsumed,
    } = options;

    const ephemeralOnly = React.useSyncExternalStore(subscribeChatDraftPersistence, isChatDraftEphemeral, isChatDraftEphemeral);
    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextPersistRef = React.useRef(false);
    const lastPersistedRef = React.useRef<Map<string, string>>(new Map());
    const currentIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    // When this editor's current text was set (restored: its saved draft's; typed or edited: that change). A
    // delivered text consumes only a copy whose exact text existed at its admission (#220), judged per editor: the
    // saved slot is shared by every tab, so another tab's newer draft there says nothing about this editor's copy.
    // 'unknown': restored text with no saved provenance (treated as an old copy, as before provenance existed).
    const liveSinceRef = React.useRef<number | 'unknown' | null>(initialDraft.text ? readChatDraftSince(initialDraft.identity) ?? 'unknown' : null);
    const liveTextRef = React.useRef(initialDraft.text);
    /** The composer's own restore (not an edit): the text keeps its saved provenance. */
    const restoreProvenance = (text: string, since: number | 'unknown' | null) => { liveTextRef.current = text; liveSinceRef.current = since; };
    React.useEffect(() => {
        if (message === liveTextRef.current) return;
        liveTextRef.current = message;
        liveSinceRef.current = message ? Date.now() : null;
    }, [message]);
    const draftMemoryRef = React.useRef(new Map<string, ChatDraftSnapshot & { since?: number | 'unknown' | null }>());
    const skipOutgoingDraftRef = React.useRef(false);
    const initialKey = initialDraft.identity ? getChatDraftIdentityKey(initialDraft.identity) : null;
    if (persistEnabled && initialKey && !draftMemoryRef.current.has(initialKey) && initialDraft.text) {
        draftMemoryRef.current.set(initialKey, {
            text: initialDraft.text,
            confirmedMentions: new Set(confirmedMentionsRef.current),
            since: liveSinceRef.current,
        });
    }
    const pendingComposerRestore = useInputStore((state) => state.pendingComposerRestore);

    // Callbacks reach the effects through a ref so a caller passing inline
    // functions does not re-run the persistence effects on every render.
    const callbacksRef = React.useRef({ onIdentityChange, onDraftRestored, readMessage, onDraftConsumed, consumeCatalogDraftTransfer });
    callbacksRef.current = { onIdentityChange, onDraftRestored, readMessage, onDraftConsumed, consumeCatalogDraftTransfer };
    const catalogTransferRef = React.useRef<{
        previousKey: string | null;
        currentKey: string | null;
        result: false | 'restore' | 'retain';
    } | null>(null);

    // Follow the rendered composer, not the sidebar's deferred selection.
    // Layout timing prevents the incoming composer painting outgoing files.
    const attachmentIdentityRef = React.useRef(initialDraft.identity);
    React.useLayoutEffect(() => {
        const previous = attachmentIdentityRef.current;
        const previousKey = previous ? getChatDraftIdentityKey(previous) : null;
        const currentKey = identity ? getChatDraftIdentityKey(identity) : null;
        const input = useInputStore.getState();
        let catalogTransfer: false | 'restore' | 'retain' = false;
        if (previousKey !== currentKey) {
            catalogTransfer = callbacksRef.current.consumeCatalogDraftTransfer?.(previous, identity) ?? false;
            catalogTransferRef.current = { previousKey, currentKey, result: catalogTransfer };
        }
        const isNativeMaterialization = Boolean(previous && identity && !previous.sessionId
            && identity.sessionId === materializedSessionId && previous.runtimeKey === identity.runtimeKey
            && previous.directory === identity.directory);
        // An authoritative empty catalog removes the directory, not the live
        // cold draft. Keep its attachment owner until it has a target again.
        if (!identity && catalogTransfer && previous && input.attachmentDraftKey === previousKey) return;
        if ((isNativeMaterialization || catalogTransfer)
            && previous && identity && input.attachmentDraftKey === previousKey) {
            const files = input.attachedFiles;
            input.clearAttachedFiles(previous);
            input.setAttachedFiles(files, identity);
        }
        input.selectAttachmentDraft(identity);
        attachmentIdentityRef.current = identity;
    }, [identity, materializedSessionId]);

    React.useLayoutEffect(() => { claimChatDraftOwnership(identity); }, [identity]);

    React.useEffect(() => {
        currentIdentityRef.current = identity;
    }, [identity]);

    const persistNow = React.useCallback((target: ChatDraftIdentity | null, draft: string) => {
        if (!target || (!persistEnabled && draft)) return;
        const key = getChatDraftIdentityKey(target);

        // Only keep confirmed mentions the draft still contains: a mention the
        // user deleted must not resurrect as a file reference on restore.
        const activeMentions = new Set<string>();
        for (const mention of confirmedMentionsRef.current) {
            if (draft.includes(`@${mention}`)) activeMentions.add(mention);
        }
        confirmedMentionsRef.current = activeMentions;

        // This editor's own provenance for its text (a copy it restored or typed), not the shared slot's. It is part
        // of what was saved: the same words set again later (edited away and back) are saved again with their new start.
        const since = draft && typeof liveSinceRef.current === 'number' ? liveSinceRef.current : undefined;
        const signature = since === undefined ? draftSignature(draft, activeMentions) : `${draftSignature(draft, activeMentions)}\u0000${since}`;
        if (lastPersistedRef.current.get(key) === signature && !isChatDraftEphemeral()) return;

        const stored = writeChatDraft(target, draft, activeMentions, since);
        if (stored === undefined) return;
        if (stored) lastPersistedRef.current.set(key, signature);
        else lastPersistedRef.current.delete(key);
    }, [confirmedMentionsRef, persistEnabled]);

    const clearPending = React.useCallback(() => {
        if (!persistTimerRef.current) return;
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
    }, []);

    // Mount: a restored draft is selected so typing replaces it; with the
    // setting off it is discarded instead of silently kept.
    const handledInitialRef = React.useRef(false);
    React.useEffect(() => {
        if (handledInitialRef.current) return;
        handledInitialRef.current = true;
        if (!initialDraft.text) return;

        if (!persistEnabled) {
            messageRef.current = '';
            confirmedMentionsRef.current = new Set();
            setMessage('');
            return;
        }
        requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        // Runs once; the initial draft is captured at mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persistEnabled]);

    // Identity switch: save the outgoing draft, load the incoming one.
    const previousIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    React.useEffect(() => {
        const previous = previousIdentityRef.current;
        const previousKey = previous ? getChatDraftIdentityKey(previous) : null;
        const currentKey = identity ? getChatDraftIdentityKey(identity) : null;
        previousIdentityRef.current = identity;
        if (previousKey === currentKey) return;
        const cachedTransfer = catalogTransferRef.current;
        const catalogTransfer = cachedTransfer?.previousKey === previousKey && cachedTransfer.currentKey === currentKey
            ? cachedTransfer.result
            : callbacksRef.current.consumeCatalogDraftTransfer?.(previous, identity) ?? false;
        catalogTransferRef.current = null;
        if (catalogTransfer) {
            clearPending();
            skipNextPersistRef.current = true;
            const live = callbacksRef.current.readMessage?.() ?? messageRef.current;
            const restored = persistEnabled && catalogTransfer === 'restore' && !live ? readChatDraft(identity) : null;
            if (restored?.text) {
                restoreProvenance(restored.text, readChatDraftSince(identity) ?? 'unknown');
                messageRef.current = restored.text;
                confirmedMentionsRef.current = restored.confirmedMentions;
                setMessage(restored.text);
                callbacksRef.current.onDraftRestored?.('saved');
            } else {
                messageRef.current = live;
                if (persistEnabled) persistNow(identity, live);
            }
            return; // Keep live input; an empty boot composer must not erase the restored slot.
        }
        callbacksRef.current.onIdentityChange?.();
        clearPending();
        // The incoming draft is being written into state right now; the
        // debounced effect must not immediately write it back out.
        skipNextPersistRef.current = true;

        if (previous && identity && !previous.sessionId && identity.sessionId === materializedSessionId
            && previous.runtimeKey === identity.runtimeKey && previous.directory === identity.directory) {
            // This is an identity transfer, not navigation to another input. Keep newer text and mentions. The shared
            // new-session slot clears only if it still holds this text: another tab's draft saved there stays (#220).
            const slot = readChatDraft(previous).text;
            if (!slot || slot === messageRef.current) writeChatDraft(previous, '', []);
            lastPersistedRef.current.set(getChatDraftIdentityKey(previous), draftSignature('', []));
            if (previousKey) draftMemoryRef.current.set(previousKey, { text: '', confirmedMentions: new Set(), since: null });
            if (currentKey) draftMemoryRef.current.set(currentKey, { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current), since: liveSinceRef.current });
            if (persistEnabled) persistNow(identity, messageRef.current);
            return;
        }
        if (!skipOutgoingDraftRef.current && previousKey) {
            const outgoing = { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current), since: liveSinceRef.current };
            draftMemoryRef.current.set(previousKey, outgoing);
            if (persistEnabled) persistNow(previous, outgoing.text);
        }
        skipOutgoingDraftRef.current = false;

        const remembered = currentKey ? draftMemoryRef.current.get(currentKey) : undefined;
        // Durable state may have been reconciled by an off-screen native Send
        // recovery. Memory owns navigation only when persistence is disabled.
        const restored = persistEnabled ? readChatDraft(identity) : remembered || { text: '', confirmedMentions: new Set<string>() };
        // A controlled restore keeps the copy's original admission provenance, including in-memory drafts.
        restoreProvenance(restored.text, restored.text ? (persistEnabled ? readChatDraftSince(identity) : remembered?.since) ?? 'unknown' : null);
        messageRef.current = restored.text;
        setMessage(restored.text);
        confirmedMentionsRef.current = new Set(restored.confirmedMentions);
        if (restored.text) {
            requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        }
    }, [clearPending, confirmedMentionsRef, identity, materializedSessionId, messageRef, persistEnabled, persistNow, setMessage]);

    React.useEffect(() => subscribeChatDraftConsumption((target, submitted, before) => {
        const key = getChatDraftIdentityKey(target);
        const remembered = draftMemoryRef.current.get(key);
        if (remembered?.text === submitted && (before === undefined || remembered.since == null || remembered.since === 'unknown' || remembered.since <= before)) {
            draftMemoryRef.current.set(key, { text: '', confirmedMentions: new Set(), since: null });
        }
        const current = currentIdentityRef.current;
        if (!current || current.draftId !== target.draftId
            || getChatDraftIdentityKey(current) !== getChatDraftIdentityKey(target)) return;
        // This editor's text began after the admission: a new message with the same words, kept.
        const since = liveSinceRef.current;
        if (before !== undefined && typeof since === 'number' && since > before) return;
        const live = callbacksRef.current.readMessage?.() ?? messageRef.current;
        // Another tab's delivered text this editor does not hold: nothing here to consume or flush over the shared slot
        // (an empty editor would delete another tab's saved draft); this editor's own saves go on as usual.
        if (before !== undefined && live !== submitted) {
            // An empty editor counts as saved, so its unload flushes do not delete that saved draft either.
            if (!live) lastPersistedRef.current.set(getChatDraftIdentityKey(current), draftSignature('', []));
            return;
        }
        clearPending();
        messageRef.current = live;
        if (live === submitted) {
            messageRef.current = '';
            confirmedMentionsRef.current = new Set();
            setMessage('');
            // The shared saved slot clears only if it holds that old copy, never another tab's newer draft. Otherwise this
            // editor's empty text counts as saved, so the debounce and unload flushes do not delete that draft either.
            // With an admission time, only that very copy: the same text, begun by then (another tab's different draft stays).
            if (before === undefined || (readChatDraft(current).text === submitted && savedChatDraftPredates(current, before))) {
                persistNow(current, '');
            }
            else lastPersistedRef.current.set(getChatDraftIdentityKey(current), draftSignature('', []));
            callbacksRef.current.onDraftConsumed?.(submitted, before);
        } else if (persistEnabled) persistNow(current, live);
    }), [clearPending, confirmedMentionsRef, messageRef, persistEnabled, persistNow, setMessage]);

    // The chat column can still show the source after navigation selects a fork.
    // Apply its replay only after the destination's draft has been loaded above.
    React.useEffect(() => {
        if (!pendingComposerRestore) return;
        const input = useInputStore.getState();
        const pending = input.consumePendingComposerRestore(identity);
        if (!pending) return;

        clearPending();
        skipNextPersistRef.current = true;
        restoreProvenance(pending.text, pending.text ? Date.now() : null);
        draftMemoryRef.current.set(getChatDraftIdentityKey(pending.target), { text: pending.text, confirmedMentions: new Set(), since: liveSinceRef.current });
        messageRef.current = pending.text;
        confirmedMentionsRef.current = new Set();
        setMessage(pending.text);
        // Equal source/replay text need not trigger another render to persist.
        if (persistEnabled) persistNow(pending.target, pending.text);
        input.clearAttachedFiles();
        for (const file of pending.files) input.addRestoredAttachment(file);
        requestAnimationFrame(() => {
            const current = currentIdentityRef.current;
            if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(pending.target)) {
                callbacksRef.current.onDraftRestored?.('fork');
            }
        });
    }, [clearPending, confirmedMentionsRef, identity, messageRef, pendingComposerRestore, persistEnabled, persistNow, setMessage]);

    // A draft deleted elsewhere (session deleted, drafts cleared) clears the
    // composer if it is the one on screen.
    React.useEffect(() => subscribeChatDraftDeletion((deleted) => {
        const deletedKey = getChatDraftIdentityKey(deleted);
        // Record the empty signature so a queued write does not resurrect it.
        lastPersistedRef.current.set(deletedKey, draftSignature('', []));
        draftMemoryRef.current.set(deletedKey, { text: '', confirmedMentions: new Set() });

        const current = currentIdentityRef.current;
        if (!current || getChatDraftIdentityKey(current) !== deletedKey) return;

        clearPending();
        skipNextPersistRef.current = true;
        messageRef.current = '';
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }), [clearPending, confirmedMentionsRef, messageRef, setMessage]);

    // Disabling storage clears the saved draft once, not on every keystroke after a storage failure.
    React.useEffect(() => {
        if (!persistEnabled) writeChatDraft(identity, '', []);
    }, [identity, persistEnabled]);

    // Debounced write while typing.
    React.useEffect(() => {
        if (!persistEnabled) {
            clearPending();
            return;
        }

        if (skipNextPersistRef.current) {
            skipNextPersistRef.current = false;
            return;
        }

        clearPending();
        // Identity/fork effects may restore the same text as the previous
        // render. The live ref already holds that replay, even without a new render.
        const draftSnapshot = messageRef.current;
        const identitySnapshot = identity;
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = null;
            persistNow(identitySnapshot, draftSnapshot);
        }, PERSIST_DEBOUNCE_MS);

        return clearPending;
    }, [clearPending, identity, message, messageRef, persistEnabled, persistNow]);

    // Force a write wherever the page may stop running before the timer fires.
    React.useEffect(() => {
        const flush = () => {
            clearPending();
            if (persistEnabled) persistNow(currentIdentityRef.current, messageRef.current);
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };

        document.addEventListener('visibilitychange', onVisibilityChange);
        document.addEventListener('freeze', flush);
        window.addEventListener('pagehide', flush);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            document.removeEventListener('freeze', flush);
            window.removeEventListener('pagehide', flush);
            flush();
        };
    }, [clearPending, messageRef, persistEnabled, persistNow]);

    const restoreDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        const current = currentIdentityRef.current;
        const isCurrent = target && current && getChatDraftIdentityKey(target) === getChatDraftIdentityKey(current);
        const existing = isCurrent
            ? { text: messageRef.current, confirmedMentions: confirmedMentionsRef.current }
            : (targetKey && draftMemoryRef.current.get(targetKey)) || (persistEnabled ? readChatDraft(target) : null);
        const text = existing?.text && existing.text !== draft ? `${existing.text}\n\n${draft}` : draft;
        const mentions = new Set([...(existing?.confirmedMentions ?? []), ...confirmedMentions]);
        const since = text ? Date.now() : null;
        if (targetKey) draftMemoryRef.current.set(targetKey, { text, confirmedMentions: mentions, since });
        if (isCurrent) {
            restoreProvenance(text, since);
            messageRef.current = text;
            confirmedMentionsRef.current = new Set(mentions);
            setMessage(text);
        }
        if (persistEnabled && target) {
            const stored = writeChatDraft(target, text, mentions, since ?? undefined);
            if (stored) lastPersistedRef.current.set(getChatDraftIdentityKey(target), `${draftSignature(text, mentions)}${since === null ? '' : `\u0000${since}`}`);
            else if (stored === false) lastPersistedRef.current.delete(getChatDraftIdentityKey(target));
        }
    }, [confirmedMentionsRef, messageRef, persistEnabled, setMessage]);

    const handoffDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string | null) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        if (targetKey && draft !== null) draftMemoryRef.current.set(targetKey, { text: draft, confirmedMentions: new Set(), since: draft ? Date.now() : null });
        const currentKey = currentIdentityRef.current ? getChatDraftIdentityKey(currentIdentityRef.current) : null;
        if (targetKey === currentKey) {
            if (draft !== null) {
                restoreProvenance(draft, draft ? Date.now() : null);
                messageRef.current = draft;
                confirmedMentionsRef.current = new Set();
                setMessage(draft);
                persistNow(target, draft);
            }
            return;
        }
        if (currentKey) draftMemoryRef.current.set(currentKey, { text: '', confirmedMentions: new Set() });
        persistNow(currentIdentityRef.current, '');
        skipOutgoingDraftRef.current = true;
        messageRef.current = '';
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }, [confirmedMentionsRef, messageRef, persistNow, setMessage]);

    const migrateDraft = React.useCallback((from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => {
        if (!to) return;
        const current = currentIdentityRef.current;
        const draft = from && current && getChatDraftIdentityKey(from) === getChatDraftIdentityKey(current)
            ? { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current) }
            : (from && draftMemoryRef.current.get(getChatDraftIdentityKey(from)))
            || (persistEnabled ? readChatDraft(from) : null);
        if (!draft) return;
        const since = from && current && getChatDraftIdentityKey(from) === getChatDraftIdentityKey(current)
            ? liveSinceRef.current : from ? draftMemoryRef.current.get(getChatDraftIdentityKey(from))?.since ?? readChatDraftSince(from) : null;
        draftMemoryRef.current.set(getChatDraftIdentityKey(to), { text: draft.text, confirmedMentions: new Set(draft.confirmedMentions), since });
        if (persistEnabled) {
            const knownSince = since == null || since === 'unknown' ? undefined : since;
            const stored = writeChatDraft(to, draft.text, draft.confirmedMentions, knownSince);
            if (stored) lastPersistedRef.current.set(getChatDraftIdentityKey(to), `${draftSignature(draft.text, draft.confirmedMentions)}${knownSince === undefined ? '' : `\u0000${knownSince}`}`);
            else if (stored === false) lastPersistedRef.current.delete(getChatDraftIdentityKey(to));
        }
    }, [confirmedMentionsRef, messageRef, persistEnabled]);

    return { persistNow, handoffDraft, restoreDraft, migrateDraft, ephemeralOnly: persistEnabled && ephemeralOnly };
}

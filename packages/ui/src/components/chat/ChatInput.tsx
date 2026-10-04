import { isGloballyUnavailable, readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { pillSendDisabledReason } from './composer/ui/pillSendDisabledReason';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import React from 'react';
import { DisplayNameChoice } from './composer/ui/DisplayNameChoice';
import { NativeDraftIdentity } from './composer/ui/NativeDraftIdentity';
import { NativeCreationNotice } from './composer/ui/NativeCreationNotice';
import { useNativeCreation } from './composer/state/useNativeCreation';
import { ownNativeRequestId, useNativeDraftStarting } from '@/sync/native-draft-start';
import { sentStartLocks, useSentStart } from '@/sync/native-draft-sent';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { assertNativeDraftReady, beginFirstSend, endFirstSend, isNativeDraftCurrent, noteNativeDraftSubmitted, type FirstSendHold, type NativeDraftSend } from '@/sync/native-draft-send';
import { browserDisplayName } from '@/lib/messages/displayName';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { checkQueueAdmission, QueueRequestError, isServerOwnedMessageQueue, createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedContextPart, type QueuedMessage, type MessageQueueTarget } from '@/stores/messageQueueStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { consumeCatalogDraftTransfer, markDraftInputEdited, useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareLocalAttachments, useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import {
    ACCEPTED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    isDocumentAttachmentFilename,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
// Guest surfaces load on demand: VS Code and mobile never mount them, and the
// composer must not pay for the guest bridge before an extension is installed.
const GuestAttachDialog = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
import { buildLinkedGuestIssue, buildLinkedIssue, buildLinkedLinearIssue } from '@/lib/linkedIssues';
import type { AttachIssueRequest, JsonValue } from '@openchamber/sdk';
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { startReviewFlow } from '@/lib/reviewFlow';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    createChatDraftIdentity,
    consumeChatDraft,
    getChatDraftIdentityKey,
    clearChatDraft,
    writeChatDraft,
    readChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { holdReload } from '@/lib/newBuildReload';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { BtwPanel } from './btw/BtwPanel';
import { useBtwPanelState } from './btw/useBtwPanelState';
import { resolveBtwSelection, useBtwStore } from '@/stores/useBtwStore';
import { wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { buildBtwSyntheticTexts, preparePendingBtwSend, startBtwSession } from '@/lib/btw';
import { AttachedFilesList, AttachedVSCodeFileChips, ActiveEditorFileSuggestion } from './FileAttachment';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { ToolPopupContent } from './message/types';
import { QueuedMessageChips } from './QueuedMessageChips';
import { QueueRecoveryNotice } from './QueueRecoveryNotice';
import { AutoReviewBanner } from './AutoReviewBanner';
import type { FileMentionHandle } from './FileMentionAutocomplete';
import type { CommandAutocompleteHandle, CommandInfo } from './CommandAutocomplete';
import type { SkillAutocompleteHandle } from './SkillAutocomplete';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn } from "@/lib/utils";
import { ModelControls } from './ModelControls';
import { focusChatInput } from './composer/editor/dom';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { CONTEXT_METADATA_KEY, draftFromContextPayload } from '@/lib/messages/contextParts';
import { ComposerStatusBar } from './ComposerStatusBar';
import { shouldSubmitEnter } from './composer/keyboardPolicy';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useChatColumnSession } from './chatColumnSession';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { useCurrentSessionActivity, useSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { isVSCodeRuntime } from '@/lib/desktop';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { isIMECompositionEvent } from '@/lib/ime';
import { getCycledPrimaryAgentName, type MobileControlsPanel } from './mobileControlsUtils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { LinearIssuePickerDialog } from '@/components/session/LinearIssuePickerDialog';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useGuestAttachItems, useGuestCommands } from '@/hooks/useGuestSurfaces';
import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { runGuestCommand } from '@/lib/guests/run-command';
import { useGuestsStore } from '@/lib/guests/store';
import { isGuestActive } from '@/lib/guests/capabilities';
import { routeGuestSlashCommand } from './composer/submit/guestCommands';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { opencodeClient } from '@/lib/opencode/client';
import { useGitStore } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForDirectory, useCommandsStore } from '@/stores/useCommandsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useKeybind } from '@/hooks/useKeybind';
import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useI18n } from '@/lib/i18n';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { isClientIdConflict, SendRecovery } from '@/lib/sendRecovery';
import { ascendingId } from '@/sync/session-actions';
import { sessionEvents } from '@/lib/sessionEvents';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { getAllSyncSessions, getSyncMessages, getSyncSessions } from '@/sync/sync-refs';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    nextPastedContextFilename,
} from './attachmentCitations';
import {
    createPastedContextFile,
    isLargePlainTextPaste,
} from './composer/largeTextPaste';
import {
    LARGE_TEXT_PASTE_TOAST_CLASSNAME,
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from './composer/largeTextPasteOffer';
import type { LargeTextPasteBehavior } from '@/stores/useUIStore';
import type { FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { collectKnownTokenNames } from './composer/language/prefixTokens';
import { resolveAutocompleteTrigger, type AutocompleteKind } from './composer/language/triggers';
import { type ComposerLanguageContext } from './composer/language/tokenize';
import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
} from './composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import { composerAutoCorrect } from './composer/editor/autocorrect';
import {
    appendInlineText,
    appendWithLineBreaks,
    buildImagePasteInsertion,
    getMarkdownAutoPairEdit,
    appendOwnedBlock,
    removeOwnedBlock,
    shiftOwnedBlock,
    shouldWrapSelectionAsLink,
    withInlineInsertionBoundaries,
} from './composer/text';
import {
    collectDroppedFileUris,
    collectDroppedFiles,
    hasDraggedFiles,
} from './composer/attachments/dataTransfer';
import {
    normalizeDroppedPath,
    normalizePath,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from './composer/attachments/filePaths';
import { buildComposerContext, buildOutgoingMessage } from './composer/submit/buildOutgoingMessage';
import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    planLocalSlashCommand,
} from './composer/submit/slashCommands';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { useDictationOrigin } from './composer/state/useDictationOrigin';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import {
    DraftTargetSelectors,
    MobileDraftTargetSheets,
    MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import {
    createInputHistoryIdentity,
    selectInputHistoryEntries,
    type InputHistorySubmission,
    useInputHistoryStore,
} from '@/stores/useInputHistoryStore';
import {
    buildChatInputHistorySubmissions,
    buildInputHistoryNavigatorIdentity,
    mapInputHistoryEntriesToValues,
    mergeSessionInputHistory,
} from './inputHistory';
import { reconcileSessionIdleBeforeSend, refreshSessionRecord, useSessionStatus, useUserMessageHistory } from '@/sync/sync-context';
import { useStatusUnavailable } from '@/sync/status-unavailable';

// Lazy like in ChatMessage: a static import would pull the @pierre/diffs and
// Shiki stacks into the eager startup graph for a dialog opened on demand.
const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

const MAX_VISIBLE_COMPOSER_LINES = 8;
/**
 * Mobile grows the composer with content instead of offering a fullscreen
 * gesture — the old swipe-up handle bought barely a line of extra height.
 * The real ceiling is measured: the editor may grow until the composer fills
 * its screen container (marked data-composer-bound in ChatContainer), with
 * the chrome around the editor read from the DOM. The line cap only stops
 * absurdly tall editors on tablets.
 */
const MAX_MOBILE_COMPOSER_LINES = 16;
/**
 * Breathing room between the fully grown composer and the top of its screen
 * container: without it the composer's border lands exactly on the header's
 * bottom edge on the chat screen. A visual gap by design, not an estimate.
 */
const MOBILE_COMPOSER_BOUND_GAP_PX = 4;
const EMPTY_QUEUE: QueuedMessage[] = [];
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;
const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

/**
 * Skills the user named inline with `/name`. Matched against the registry's
 * exact casing, since the name is echoed back to the model as a skill to load.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '/', skillNames, 'exact');

const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
};

/** A given-back text's block in its draft: `at` of `length` chars within the text `seen` (smarty-code#962). */
type OwnedJoin = { identity: ChatDraftIdentity | null; at: number; gone: boolean; seen: string; length: number };
type LinkedReferenceAuthor = { login: string; avatarUrl?: string };
type LinkedGitHubIssue = { number: number; title: string; url: string; contextText: string; author?: LinkedReferenceAuthor };
type LinkedGitHubPr = {
    number: number;
    title: string;
    url: string;
    head: string;
    base: string;
    includeDiff: boolean;
    instructionsText: string;
    contextText: string;
    author?: LinkedReferenceAuthor;
};
type LinkedLinearIssueRef = { identifier: string; title: string; url: string; contextText: string; author?: LinkedReferenceAuthor };
type LinkedReferences = { issue: LinkedGitHubIssue | null; pr: LinkedGitHubPr | null; linear: LinkedLinearIssueRef | null };

/**
 * Record what a session was pointed at, so the work-status panel can show it
 * as a context source long after the message scrolled away. A snapshot only —
 * never re-fetched, never authoritative. Failures are swallowed: the message
 * went out (or was queued), and a missing bookkeeping entry must not surface
 * as an error.
 */
const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.setLinkedIssue>[1],
    refs: LinkedReferences,
) => {
    const attachedThread = refs.issue
        ? { attachment: refs.issue, kind: 'issue' as const }
        : refs.pr
            ? { attachment: refs.pr, kind: 'pull' as const }
            : null;
    if (attachedThread) {
        void sessionActions.setLinkedIssue(
            sessionId,
            directory,
            buildLinkedIssue({
                url: attachedThread.attachment.url,
                number: attachedThread.attachment.number,
                title: attachedThread.attachment.title,
                kind: attachedThread.kind,
                author: attachedThread.attachment.author,
                linkedAt: Date.now(),
            }),
            true,
        ).catch(() => undefined);
    }
    if (refs.linear) {
        void sessionActions.setLinkedIssue(
            sessionId,
            directory,
            buildLinkedLinearIssue({
                identifier: refs.linear.identifier,
                title: refs.linear.title,
                url: refs.linear.url,
                author: refs.linear.author,
                linkedAt: Date.now(),
            }),
            true,
        ).catch(() => undefined);
    }
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);
const MemoMobileAgentButton = React.memo(MobileAgentButton);

const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoComposerStatusBar = React.memo(ComposerStatusBar);

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    // Queued sends do not create a user row (the queue delivers later), so
    // the anchor-arming scrollToBottom is wrong for them; this returns the
    // viewport to the live edge instead.
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
    /** The open session's history failed to load: say why nothing can be sent (#536). */
    sessionLoadFailed?: boolean;
    /** Its fleet Pi is reloading (smarty-code#870): say why Send is off for now; the draft stays. */
    piReloading?: boolean;
    /** A Code-made session whose Pi lost Code's connection (smarty-code#957): say so, and how to reconnect. */
    piDisconnected?: boolean;
}

const resolveChatDraftIdentity = (sessionId: string | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const newSessionDirectory = sessionState.newSessionDraft?.open
        ? sessionState.newSessionDraft.bootstrapPendingDirectory ?? sessionState.newSessionDraft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? sessionState.currentSessionDirectory
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId,
        !sessionId && sessionState.newSessionDraft.open ? sessionState.newSessionDraft.draftId : undefined);
};

// Files are memory-only. Keep their exact native submission ownership across
// composer epoch remounts, without retaining files after the input store drops them.
const nativeSubmittedAttachments = new WeakMap<AttachedFile, { key: string; text: string; at: number }>();

const ChatInputComponent: React.FC<ChatInputProps> = ({
    onOpenSettings,
    scrollToBottom,
    scrollToLatest,
    active = true,
    draftPresentationExiting = false,
    sessionLoadFailed = false,
    piReloading = false,
    piDisconnected = false,
}) => {
    const { t } = useI18n();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);
    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });
    const [message, setMessage] = React.useState(() => {
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const identity = resolveChatDraftIdentity(sessionId);
        const snapshot = readChatDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return snapshot.text;
    });
    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);
    const [storedInputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const inputModeParentRef = React.useRef<string | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);
    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');
    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
    const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
    // Message history navigation state (up/down arrow to recall previous messages)
    const composerRef = React.useRef<ComposerEditorHandle>(null);
    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;
    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const shellTriggerNormalizationRef = React.useRef(false);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    // smarty-code#962: where each given-back text was joined (its draft and offset), so a late acceptance removes only
    // that copy; removing one moves the ones joined after it.
    // `seen` is the draft text `at` is valid in: every composer change moves `at` or ends the ownership (review r3 1).
    const ownedJoinsRef = React.useRef(new Set<OwnedJoin>());
    const followEdit = React.useCallback((own: OwnedJoin, text: string) => {
        if (own.at < 0 || own.seen === text) return;
        own.at = shiftOwnedBlock(own.seen, text, own.at, own.length); own.seen = text;
        if (own.at < 0) ownedJoinsRef.current.delete(own);
    }, []);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    const largeTextPasteToastIdRef = React.useRef<string | number | null>(null);
    const largeTextPasteOfferIdRef = React.useRef(0);

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    // Inside the chat column the composer follows the session the timeline is
    // showing (see chatColumnSession.ts); elsewhere it follows the live one.
    const liveSessionId = useSessionUIStore((s) => s.currentSessionId);
    const chatColumnSession = useChatColumnSession();
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    React.useEffect(() => {
        if (inputModeParentRef.current !== null && inputModeParentRef.current !== currentSessionId) {
            setInputMode('normal');
        }
        inputModeParentRef.current = currentSessionId;
    }, [currentSessionId]);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const liveEffectiveDirectory = useEffectiveDirectory();
    const currentDirectory = (chatColumnSession?.sessionId ? chatColumnSession.directory : null)
        ?? liveEffectiveDirectory
        ?? fallbackDirectory;
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );
    // btw mode: the CURRENT session's metadata links an active btw fork and
    // the panel is expanded, so this composer's sends route to the fork
    // instead of the main session. Collapsed keeps the fork alive (chip stays
    // visible) while the composer talks to the main session again.
    const btwPanel = useBtwPanelState(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const btwSessionId = btwPanel.btwSessionId;
    const btwDirectory = btwPanel.btwDirectory;
    const btwComposerSessionId = btwPanel.pending && currentSessionId
        ? `btw-pending:${currentSessionId}`
        : btwSessionId;
    const isBtwActive = Boolean(btwComposerSessionId) && !btwPanel.collapsed;
    const isBtwPanelVisible = Boolean((btwPanel.btwSessionId && btwPanel.btwDirectory) || btwPanel.creating || btwPanel.pending);
    const immediateBtwSubmitRef = React.useRef<{ identity: ChatDraftIdentity; text: string } | null>(null);
    const draftCaretModeRef = React.useRef({ btw: isBtwActive, atEnd: isBtwActive });
    const inputMode = isBtwActive ? 'normal' : storedInputMode;
    // A session promoted out of `/btw` keeps the boundary instructions in its
    // transcript — there is no way to delete a message part — so it has to say
    // they no longer apply.
    const isPromotedBtwSession = wasPromotedBtwSession(btwPanel.parentSession);
    const activeRuntimeKey = getRuntimeKey();
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const draftId = !currentSessionId && newSessionDraft.open ? newSessionDraft.draftId : undefined;
    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            (isBtwActive ? btwDirectory : currentSessionDirectoryForSync) ?? currentDirectory,
            isBtwActive ? btwComposerSessionId : currentSessionId,
            draftId,
        ),
        [activeRuntimeKey, btwComposerSessionId, btwDirectory, currentDirectory, currentSessionDirectoryForSync, currentSessionId, draftId, isBtwActive],
    );
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const nativeCreation = useNativeCreation(newSessionDraft, currentSessionId, currentDirectory, activeRuntimeKey);
    // Text another tab sent to start a session is not an ordinary draft until that start resolves (#117).
    const sentStart = useSentStart(activeRuntimeKey, newSessionDraftOpen ? newSessionDraft.directoryOverride : null,
        newSessionDraft.draftId, () => ownNativeRequestId(useSessionUIStore.getState().newSessionDraft, activeRuntimeKey));
    const sentLocked = newSessionDraftOpen && sentStartLocks(sentStart);
    const nativeModel = nativeCreation.session?.nativeCreation.model;
    const materializedSessionId = useSessionUIStore(s => s.materializedDraftSessionId);
    const nativeStarting = useNativeDraftStarting();
    const nativeModelControls = (newSessionDraftOpen && (nativeCreation.creation?.status === 'pending' || nativeCreation.mode === 'ordinary'))
        || Boolean(nativeModel);
    const newSessionDraftAnnouncesDirtyState = newSessionDraftOpen && newSessionDraft?.openedAutomatically !== true;
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const prepareChatDraftDirectory = useSessionUIStore((s) => s.prepareChatDraftDirectory);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useInputStore((s) => s.attachedFiles);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const btwModelSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionModelSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const btwAgentSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionAgentSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const consumePendingBtwComposerRequest = useInputStore((s) => s.consumePendingBtwComposerRequest);
    const pendingBtwComposerRequest = useInputStore((s) => s.pendingBtwComposerRequest);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const setPendingInputText = useInputStore((s) => s.setPendingInputText);
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const pendingGuestIssue = useInputStore((s) => s.pendingGuestIssue);
    const consumePendingGuestIssue = useInputStore((s) => s.consumePendingGuestIssue);

    React.useEffect(() => {
        if (!newSessionDraftOpen || newSessionDraft.target !== 'chat' || message.trim().length === 0) return;
        void prepareChatDraftDirectory();
    }, [message, newSessionDraft.target, newSessionDraftOpen, prepareChatDraftDirectory]);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const stopSessionId = isBtwActive && btwSessionId ? btwSessionId : currentSessionId;
    const stopDirectory = (isBtwActive ? btwDirectory : currentSessionDirectoryForSync ?? currentDirectory) ?? undefined;
    const displayedStopStatus = useSessionStatus(stopSessionId ?? '', stopDirectory);
    // The open session's project status is unknown (smarty-code#539): say so instead of a stale Stop.
    const statusUnavailable = useStatusUnavailable(stopSessionId && !newSessionDraftOpen ? stopDirectory : null);
    const abortCurrentOperation = React.useCallback(
        () => sessionActions.abortCurrentOperation(stopSessionId ?? '', { status: displayedStopStatus }),
        [displayedStopStatus, stopSessionId],
    );
    const currentManagementSessionId = currentSessionId;
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    // Subscribe to both sources read by getModelMetadata so async metadata and provider updates are observed.
    useConfigStore((state) => state.modelsMetadata);
    useConfigStore((state) => state.providers);
    const currentModelMetadata = currentProviderId && currentModelId
        ? getModelMetadata(currentProviderId, currentModelId)
        : undefined;
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentVariantSelection = useConfigStore((state) => state.currentVariantSelection);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const btwSavedVariant = useSelectionStore(React.useCallback(
        (state) => btwComposerSessionId && btwAgentSelection && btwModelSelection
            ? state.getAgentModelVariantForSession(
                btwComposerSessionId,
                btwAgentSelection,
                btwModelSelection.providerId,
                btwModelSelection.modelId,
            )
            : undefined,
        [btwAgentSelection, btwComposerSessionId, btwModelSelection],
    ));
    const effectiveBtwSelection = resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: currentVariantSelection.override === null ? null : currentVariantSelection.override ?? currentVariant,
    });
    React.useEffect(() => {
        const { model, agent, variant } = effectiveBtwSelection;
        if (!isBtwActive || !btwComposerSessionId || !model || !agent) return;
        const selections = useSelectionStore.getState();
        if (selections.getSessionModelSelection(btwComposerSessionId)) return;
        selections.saveSessionAgentSelection(btwComposerSessionId, agent);
        selections.saveSessionModelSelection(btwComposerSessionId, model.providerId, model.modelId);
        selections.saveAgentModelForSession(btwComposerSessionId, agent, model.providerId, model.modelId);
        selections.saveAgentModelVariantForSession(btwComposerSessionId, agent, model.providerId, model.modelId, variant);
    }, [btwComposerSessionId, effectiveBtwSelection, isBtwActive]);
    const isMobile = useUIStore((state) => state.isMobile);
    const hasHardwareKeyboard = useHardwareKeyboard();
    const enterToSend = useUIStore((state) => state.enterToSend);
    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);
    const { enabled: isTabletLayout } = useTabletLayout();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
    const persistedExpandedInput = useUIStore((state) => state.isExpandedInput);
    const isExpandedInput = !isBtwActive && persistedExpandedInput;
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const { git: runtimeGit, vscode: vscodeApi, linear: runtimeLinear } = useRuntimeAPIs();
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });
    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);
    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const incompatibleFiles = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: t('chat.modelControls.modality.text'),
            image: t('chat.modelControls.modality.image'),
            pdf: t('chat.modelControls.modality.pdf'),
            audio: t('chat.modelControls.modality.audio'),
            video: t('chat.modelControls.modality.video'),
        };
        const filenames = incompatibleFiles.map(({ attachment }) => attachment.filename);
        const fileSummary = filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', ');

        toast.warning(t('chat.chatInput.toast.unsupportedAttachmentModalities', {
            model: currentModelMetadata.name ?? currentModelId ?? '',
            modalities: unsupportedModalities.map((modality) => modalityLabels[modality]).join(', '),
            files: fileSummary,
        }), { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId, t]);

    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        if (!content.image) return;
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);

    const handleStartReviewFlow = React.useCallback(async (execution: ReviewFlowExecution) => {
        if (!currentSessionId) return;
        const directory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || '';
        if (!directory) {
            toast.error(t('diffView.reviewDialog.toast.noSessionDirectory'));
            return;
        }

        setReviewFlowSubmitting(true);
        try {
            await startReviewFlow({
                originalSessionID: currentSessionId,
                directory,
                providerID: execution.providerID,
                modelID: execution.modelID,
                agent: execution.agent || undefined,
                variant: execution.variant || undefined,
                generateHandoff: execution.generateHandoff,
                returnAfterHandoffRequest: execution.generateHandoff,
                autoReview: execution.autoReview,
            });
            setReviewDialogOpen(false);
        } catch (error) {
            console.error('[review-flow] failed to start review flow', error);
            toast.error(error instanceof Error ? error.message : t('diffView.reviewDialog.toast.startFailed'));
        } finally {
            setReviewFlowSubmitting(false);
        }
    }, [currentSessionId, currentDirectory, t]);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    // Rounder composer on mobile (touch UI reads better with a softer corner).
    const chatInputRadius = isMobile ? '1.5rem' : 'var(--radius-xl)';
    const useCompactChatPlaceholder = isMobile || isNarrowComposer;

    React.useEffect(() => {
        const element = dropZoneRef.current;
        if (!element) return;

        const updateWidth = (width: number) => {
            const next = width > 0 && width < COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH;
            setIsNarrowComposer((prev) => (prev === next ? prev : next));
        };

        updateWidth(element.clientWidth);

        if (typeof ResizeObserver === 'undefined') {
            const handleResize = () => updateWidth(element.clientWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }

        const observer = new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + skills + built-ins) used to highlight
    // matching /tokens in the composer, the same way confirmed @files are.
    const availableCommands = useCommandsStore((s) => selectCommandsForDirectory(s, currentDirectory));
    const availableSkills = useSkillsStore((s) => selectSkillsForDirectory(s, currentDirectory));
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'btw', 'summary', 'workspace-review', 'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        for (const skill of availableSkills) names.add(skill.name.toLowerCase());
        return names;
    }, [availableCommands, availableSkills, isMobile]);

    // Extension slash commands. Built-ins, OpenCode commands, and skills are
    // reserved: an extension command with one of those names is ignored.
    const guestCommands = useGuestCommands(knownSlashNames);
    const knownSlashNamesWithGuests = React.useMemo(() => {
        if (guestCommands.length === 0) return knownSlashNames;
        const names = new Set(knownSlashNames);
        for (const entry of guestCommands) names.add(entry.command.name);
        return names;
    }, [guestCommands, knownSlashNames]);

    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const attachmentFilenames = React.useMemo(
        () => attachedFiles.map((file) => file.filename),
        [attachedFiles],
    );

    /**
     * Everything the prompt language needs to resolve references. Rebuilt only
     * when a registry changes, so typing does not churn the tokenizer input.
     */
    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        knownAgentNames,
        confirmedMentions: confirmedMentionsRef.current,
        knownSlashNames: knownSlashNamesWithGuests,
        knownSnippetTriggers,
        attachmentFilenames,
    }), [attachmentFilenames, inputMode, knownAgentNames, knownSlashNamesWithGuests, knownSnippetTriggers]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: readonly AttachedFile[] | undefined): AttachedFile[] => [...(files ?? [])]
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const resolveInlineFileMention = React.useCallback((mentionPath: string): { serverPath: string; filename: string } | null => {
        const kind = classifyMention(mentionPath, {
            knownAgentNames: knownAgentNamesRef.current,
            confirmedMentions: confirmedMentionsRef.current,
        });
        if (kind !== 'file') return null;

        const normalizedMentionPath = mentionPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        if (!normalizedMentionPath) return null;

        const clientDirectory = opencodeClient.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        let serverPath: string | null = null;
        if (mentionPath.startsWith('/')) {
            serverPath = mentionPath.replace(/\\/g, '/');
        } else if (root) {
            serverPath = `${root}/${normalizedMentionPath}`;
        }
        if (!serverPath) return null;

        return {
            serverPath: serverPath.replace(/\/+/g, '/'),
            filename: normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath,
        };
    }, [chatSearchDirectory]);

    const extractInlineFileMentions = React.useCallback((
        rawText: string,
        preparedDocumentMentions?: ReadonlyMap<string, AttachedFile[]>,
    ) => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [] };
        }

        const seenPaths = new Set<string>();
        const attachments: AttachedFile[] = [];

        for (const token of scanMentions(rawText)) {
            const mention = resolveInlineFileMention(token.name);
            if (!mention || seenPaths.has(mention.serverPath)) continue;
            seenPaths.add(mention.serverPath);

            const prepared = preparedDocumentMentions?.get(mention.serverPath);
            if (prepared) {
                attachments.push(...prepared);
                continue;
            }
            attachments.push({
                id: `inline-server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], mention.filename, { type: 'text/plain' }),
                filename: mention.filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(mention.serverPath),
                source: 'server',
                serverPath: mention.serverPath,
            });
        }

        return {
            sanitizedText: rawText,
            attachments,
        };
    }, [resolveInlineFileMention]);

    type DocumentMentionPreparation =
        | { status: 'ready'; prepared: Map<string, AttachedFile[]> }
        | { status: 'failed'; filename: string }
        | { status: 'runtime-changed' };

    /**
     * Document mentions (`@notes.pdf`) are sent as converted attachments. Their
     * sources are fetched up front — by the send, or by queueing, since the
     * server that later delivers a queued message cannot read them.
     */
    const prepareDocumentMentions = React.useCallback(async (
        texts: readonly string[],
        reservedFilenames: Set<string>,
        runtimeKey: string,
    ): Promise<DocumentMentionPreparation> => {
        const prepared = new Map<string, AttachedFile[]>();
        for (const rawText of texts) {
            for (const token of scanMentions(rawText)) {
                const mention = resolveInlineFileMention(token.name);
                if (
                    !mention
                    || !isDocumentAttachmentFilename(mention.filename)
                    || prepared.has(mention.serverPath)
                ) {
                    continue;
                }
                try {
                    const response = await runtimeFetch('/api/fs/raw', { query: { path: mention.serverPath } });
                    if (!response.ok) throw new Error(`Failed to read ${mention.filename}`);
                    const sourceBlob = await response.blob();
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    const source = new File([sourceBlob], mention.filename);
                    const converted = await prepareLocalAttachments(source, reservedFilenames);
                    if (!converted || converted.length === 0) throw new Error(`Failed to prepare ${mention.filename}`);
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    prepared.set(mention.serverPath, converted);
                    for (const attachment of converted) reservedFilenames.add(attachment.filename);
                } catch {
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    return { status: 'failed', filename: mention.filename };
                }
            }
        }
        return { status: 'ready', prepared };
    }, [resolveInlineFileMention]);
    const prevWasAbortedRef = React.useRef(false);

    // Issue linking state
    const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
    const [prPickerOpen, setPrPickerOpen] = React.useState(false);
    const [linearPickerOpen, setLinearPickerOpen] = React.useState(false);
    const [linkedIssue, setLinkedIssue] = React.useState<{
        number: number;
        title: string;
        url: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [linkedPr, setLinkedPr] = React.useState<{
        number: number;
        title: string;
        url: string;
        head: string;
        base: string;
        includeDiff: boolean;
        instructionsText: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [linkedLinearIssue, setLinkedLinearIssue] = React.useState<{
        identifier: string;
        title: string;
        url: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [attachDialogGuestId, setAttachDialogGuestId] = React.useState<string | null>(null);
    // The chip the attach dialog was opened from; null when opened from the + menu.
    const [attachDialogItem, setAttachDialogItem] = React.useState<AttachIssueRequest | null>(null);
    const [linkedGuestIssue, setLinkedGuestIssue] = React.useState<{
        providerId: string;
        id: string;
        title: string;
        url: string;
        contextText: string;
        thread?: 'issue' | 'pull';
        author?: string;
        head?: string;
        base?: string;
        /** Opaque guest payload from `attach`; handed back on chip click, never shown. */
        data?: JsonValue;
    } | null>(null);

    // Message queue
    const parentMessageQueueTarget = currentSessionId
        ? createMessageQueueTarget(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory)
        : null;
    const parentMessageQueueKey = parentMessageQueueTarget ? getMessageQueueKey(parentMessageQueueTarget) : null;
    const messageQueueTarget = !isBtwActive ? parentMessageQueueTarget : null;
    const messageQueueKey = !isBtwActive ? parentMessageQueueKey : null;
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!messageQueueKey) return EMPTY_QUEUE;
                return state.queuedMessages[messageQueueKey] ?? EMPTY_QUEUE;
            },
            [messageQueueKey]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const takeForSend = useMessageQueueStore((state) => state.takeForSend);

    // Inline comment drafts
    const inlineDraftSessionKey = isBtwActive ? btwComposerSessionId ?? '' : currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
    const inlineDraftDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const inlineDraftTarget = React.useMemo<InlineCommentDraftTarget | null>(
        () => inlineDraftSessionKey && inlineDraftDirectory
            ? { directory: inlineDraftDirectory, sessionKey: inlineDraftSessionKey }
            : null,
        [inlineDraftDirectory, inlineDraftSessionKey],
    );
    const inlineDraftKey = inlineDraftTarget
        ? getInlineCommentDraftKey(activeRuntimeKey, inlineDraftTarget.directory, inlineDraftTarget.sessionKey)
        : null;
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []).length : 0,
            [inlineDraftKey]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

    const inputHistoryScope = useInputHistoryStore((state) => state.scope);
    const inputHistoryIdentity = React.useMemo(
        () => createInputHistoryIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory ?? '',
            inlineDraftSessionKey || 'draft',
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, inlineDraftSessionKey],
    );
    const inputHistoryEntries = useInputHistoryStore(React.useCallback(
        (state) => selectInputHistoryEntries(state, inputHistoryIdentity),
        [inputHistoryIdentity],
    ));
    // Session scope also reads the visible transcript, so sessions older than
    // the persisted history still recall their prompts.
    const transcriptPrompts = useUserMessageHistory((isBtwActive ? btwSessionId : currentSessionId) ?? '');
    const historyValues = React.useMemo(
        () => (inputHistoryScope === 'session'
            ? mergeSessionInputHistory(transcriptPrompts, inputHistoryEntries)
            : mapInputHistoryEntriesToValues(inputHistoryEntries)),
        [inputHistoryEntries, inputHistoryScope, transcriptPrompts],
    );
    const messageHistoryIdentity = React.useMemo(
        () => buildInputHistoryNavigatorIdentity(inputHistoryScope, inputHistoryIdentity),
        [inputHistoryIdentity, inputHistoryScope],
    );
    const messageHistory = useMessageHistory<AttachedFile>(historyValues, messageHistoryIdentity);

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useEffect(() => {
        currentChatDraftIdentityRef.current = chatDraftIdentity;
    }, [chatDraftIdentity]);

    // smarty-code#962 review r3 1: each change of the shown draft moves or ends the given-back blocks it touches. The
    // first render after a switch still holds the previous draft's text, so it is not an edit of this one.
    const followedIdentityRef = React.useRef(chatDraftIdentity);
    React.useEffect(() => {
        const switched = !sameDraftIdentity(followedIdentityRef.current, chatDraftIdentity);
        followedIdentityRef.current = chatDraftIdentity;
        if (switched) return;
        for (const own of [...ownedJoinsRef.current]) if (sameDraftIdentity(own.identity, chatDraftIdentity)) followEdit(own, message);
    }, [chatDraftIdentity, followEdit, message]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const {
        persistNow: persistDraftImmediately,
        ephemeralOnly: draftEphemeralOnly,
        handoffDraft,
        restoreDraft,
        migrateDraft,
        hasReloadBlockingText,
    } = useComposerDraft({
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        persistEnabled: persistChatDraft,
        materializedSessionId: nativeModel ? materializedSessionId ?? nativeCreation.session?.id : null,
        consumeCatalogDraftTransfer,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        onIdentityChange: () => {
            setInputMode('normal');
            draftCaretModeRef.current.atEnd = isBtwActive || draftCaretModeRef.current.btw;
            draftCaretModeRef.current.btw = isBtwActive;
        },
        onDraftRestored: (source) => {
            const editor = composerRef.current;
            if (!editor) return;
            if (source === 'fork') editor.focus();
            if (source !== 'fork' && draftCaretModeRef.current.atEnd) {
                editor.setSelection(editor.getValue().length);
            } else {
                editor.selectAll();
            }
        },
        readMessage: () => composerRef.current?.getValue() ?? messageRef.current,
        onDraftConsumed: (submitted, before) => {
            // A recovered sent-start has no acceptance callback left. Consume
            // only files recorded with that delivered text, never newer files.
            if (chatDraftIdentity) {
                const input = useInputStore.getState();
                const key = getChatDraftIdentityKey(chatDraftIdentity);
                if (input.attachmentDraftKey === key) {
                    const remaining = input.attachedFiles.filter(file => {
                        const sent = nativeSubmittedAttachments.get(file);
                        return !sent || sent.key !== key || sent.text !== submitted
                            || (before !== undefined && sent.at > before);
                    });
                    if (remaining.length !== input.attachedFiles.length) input.setAttachedFiles(remaining, chatDraftIdentity);
                }
            }
            messageHistory.reset();
        },
    });
    // Any text in the composer holds a new-build reload (openchamber#333 reviews): read live, the editor's own text.
    React.useEffect(() => holdReload(() => (composerRef.current?.getValue() ?? messageRef.current) !== ''), []);
    React.useEffect(() => holdReload(hasReloadBlockingText), [hasReloadBlockingText]);

    const handleExitBtw = React.useCallback(() => {
        if (!currentSessionId) return;
        immediateBtwSubmitRef.current = null;
        const panels = useBtwStore.getState();
        const pending = panels.byParent[currentSessionId];
        if (pending?.pending && !pending.creating && !btwSessionId) {
            const pendingSessionId = `btw-pending:${currentSessionId}`;
            const identity = createChatDraftIdentity(activeRuntimeKey, currentSessionDirectoryForSync ?? currentDirectory, pendingSessionId);
            if (identity) {
                clearChatDraft(identity, true);
                useInlineCommentDraftStore.getState().clearDrafts({ directory: identity.directory, sessionKey: pendingSessionId });
            }
            useSelectionStore.getState().clearSessionSelections(pendingSessionId);
            useInputStore.getState().consumePendingBtwComposerRequest(currentSessionId);
            panels.clearPanelState(currentSessionId);
            return;
        }
        panels.setPanelState(currentSessionId, { collapsed: true });
    }, [activeRuntimeKey, btwSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId]);

    React.useEffect(() => {
        const request = pendingBtwComposerRequest;
        if (!request || request.parentSessionId !== currentSessionId) return;
        if (!isBtwActive) {
            useBtwStore.getState().setPanelState(
                request.parentSessionId,
                btwSessionId ? { collapsed: false } : { pending: true, collapsed: false },
            );
            return;
        }
        if (!chatDraftIdentity) return;
        const consumed = consumePendingBtwComposerRequest(currentSessionId);
        if (!consumed) return;
        restoreDraft(chatDraftIdentity, consumed.text, new Set());
        queueMicrotask(() => focusChatInput());
    }, [btwSessionId, chatDraftIdentity, consumePendingBtwComposerRequest, currentSessionId, isBtwActive, pendingBtwComposerRequest, restoreDraft]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    composerRef.current?.focus({ preventScroll: true });
                } else {
                    composerRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Session activity for queue availability and controls. In btw mode the
    // composer controls the temporary fork, so the stop button and send-button
    // state follow the FORK's activity; the queue affordance stays tied to the
    // main session (queued messages always belong to the main chat).
    const { phase: currentSessionPhase } = useCurrentSessionActivity();
    const { phase: btwSessionPhase } = useSessionActivity(btwSessionId, btwDirectory ?? undefined);
    const sessionPhase = isBtwActive ? btwSessionPhase : currentSessionPhase;
    const autoReviewRunning = useAutoReviewStore(React.useCallback((state) => {
        if (!currentSessionId) return false;
        const run = state.runsByOriginalSessionID[currentSessionId];
        return run?.status === 'running' && run.runtimeKey === getRuntimeKey();
    }, [currentSessionId]));

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        // Set the panel state BEFORE blurring: the collapse watcher and the
        // overlay-host observer must already see the overlay as open when the
        // keyboard-close lands, otherwise the composer folds into the pill
        // under the sheet.
        setMobileControlsPanel(panel);
        composerRef.current?.blur();
    }, [isMobile]);

    // Consume pending input text (e.g., from revert action)
    React.useEffect(() => {
        if (!isBtwActive && pendingInputText !== null) {
            const pending = consumePendingInputText();
            if (pending?.text) {
                if (pending.mode === 'append') {
                    setMessage((prev) => {
                        const next = pending.text;
                        if (!next.trim()) return prev;
                        return appendWithLineBreaks(prev, next);
                    });
                } else if (pending.mode === 'append-inline') {
                    setMessage((prev) => appendInlineText(prev, pending.text));
                } else {
                    setMessage(pending.text);
                }
                // Focus textarea after setting message
                setTimeout(() => {
                    composerRef.current?.focus();
                }, 0);
            }
        }
    }, [isBtwActive, pendingInputText, consumePendingInputText]);

    const hasContent = message.trim().length > 0 || attachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = !isBtwActive && queuedMessages.length > 0;
    const preparingBtwSend = useBtwStore((state) => Boolean(currentSessionId && state.byParent[currentSessionId]?.pendingSend));
    // Send itself starts a new draft's session (smarty-code#126); only a start already running blocks it.
    // A new-session draft cannot be sent until its project is known (G13: discovery still answering).
    // smarty-code#778: while its ordinary (Pi) session is unavailable (the model control reads "Unavailable", for example
    // right after its Pi was relaunched), Send is shown disabled, with the reason, instead of refusing on press.
    // Read as Send's own check reads it (every render); while unavailable it is read again each second, so Send comes
    // back as soon as the session does, even with no keystroke.
    // The open session's availability (lib/openOrdinaryState): a session the managed listing left out is unavailable
    // over any older sync row, and this composer re-renders when that mark changes (openchamber#364 review).
    // Observed (a change re-renders this composer): a session the managed listing left out is unavailable over any older sync row.
    const modelTargetSessionId = isBtwActive ? btwSessionId : currentSessionId;
    const modelTargetDirectory = (isBtwActive ? btwDirectory : currentSessionDirectoryForSync ?? currentDirectory) ?? undefined;
    const retainedUnavailable = useGlobalSessionsStore((state) => Boolean(modelTargetSessionId) && isGloballyUnavailable(state.entityById.get(modelTargetSessionId!)));
    const ordinaryNow = modelTargetSessionId ? readOpenOrdinaryState(modelTargetSessionId, modelTargetDirectory, retainedUnavailable) : undefined;
    const ordinaryUnavailable = ordinaryNow !== undefined && !ordinaryNow.model;
    const [, recheckOrdinary] = React.useReducer((n: number) => n + 1, 0);
    // The page is not always told when the session returns (an idle session relaunched in place sends no event), so
    // while it is unavailable its view is also re-read every 2 s: the model control and Send come back on their own.
    const unavailableTarget = ordinaryUnavailable && modelTargetSessionId
        ? { sessionID: modelTargetSessionId, directory: modelTargetDirectory ?? '' } : null;
    const unavailableKey = unavailableTarget ? `${unavailableTarget.directory}\n${unavailableTarget.sessionID}` : null;
    React.useEffect(() => {
        if (!unavailableKey) return;
        const [directory, sessionID] = unavailableKey.split('\n');
        let tick = 0;
        const timer = setInterval(() => {
            recheckOrdinary();
            tick += 1;
            if (tick % 2 === 0 && directory && sessionID) void refreshSessionRecord(sessionID, directory).catch(() => undefined);
        }, 1000);
        return () => clearInterval(timer);
    }, [unavailableKey]);
    const canSend = (hasContent || hasQueuedMessages) && !(newSessionDraftOpen && (nativeStarting || nativeCreation.mode === 'discovering' || nativeCreation.mode === 'notAdmitted')) && !sentLocked
        && !ordinaryUnavailable && !(isBtwActive && (btwPanel.creating || preparingBtwSend));

    const canAbort = sessionPhase !== 'idle' && !statusUnavailable
        && (!displayedStopStatus?.ordinary || (displayedStopStatus.type === 'busy' && Boolean(displayedStopStatus.ordinaryTarget)));

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
        };
    }, [attachedFiles.length, hasDrafts, message]);

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    /** One Send press: its hold on opening a new draft's session, and its dispatched send (smarty-dev#856). */
    type SubmitAttempt = { hold?: FirstSendHold; sent?: Promise<unknown> };
    type SubmitOptions = {
        queuedOnly?: boolean;
        queuedMessageId?: string;
        delivery?: 'steer';
        /** Submit this text instead of the composer input. Used by preset
            starter chips: on mobile the collapsed pill has no mounted textarea,
            so the DOM-first input snapshot would read empty content. */
        presetText?: string;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});
    // The session this composer shows and sends to (the chat column's, which can lag the store's selection), and the
    // latest queue handler: Send's status check compares the first and, once it passes, calls the second.
    const composerSessionIdRef = React.useRef(currentSessionId);
    const handleQueueMessageRef = React.useRef<() => Promise<void>>(async () => {});
    // An ordinary (Pi) session takes a message while its agent works: the server steers it into the running turn
    // (co-steer, MVP 1 G5). So its Send never queues, steers locally or pre-reads the status; it just sends.
    const isOrdinarySession = React.useCallback((sessionId: string | null | undefined) => Boolean(sessionId) && (
        readOrdinaryModel(getSyncSessions(currentSessionDirectoryForSync ?? currentDirectory ?? undefined)
            .find(session => session.id === sessionId))
        ?? readOrdinaryModel(getAllSyncSessions().find(session => session.id === sessionId))) !== undefined,
    [currentDirectory, currentSessionDirectoryForSync]);
    const sendsWhileWorking = !isBtwActive && (Boolean(displayedStopStatus?.ordinary) || isOrdinarySession(currentSessionId));

    const queueAdmissionInFlight = React.useRef(false);
    // Set while Send asks the server whether a session shown working is idle (followUpUnlessIdle): one at a time.
    const followUpPreflight = React.useRef(false);
    // Add message to queue instead of sending.
    const handleQueueMessage = React.useCallback(async () => {
        if (queueAdmissionInFlight.current || followUpPreflight.current) return;
        try {
            if (browserDisplayName.read()) { toast.error(t('chat.displayName.plainOnly')); return; }
        } catch { toast.error(t('chat.displayName.error')); return; }
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;

        // A local or extension command is run, not queued: the queue delivers
        // text to the model, and `/compact`, `/btw`, or `/task` mean nothing there.
        if (planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, true)
            || routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)) {
            void handleSubmitRef.current();
            return;
        }
        const queueRuntimeKey = getRuntimeKey();
        const queueTarget = messageQueueTarget;
        const queueSessionId = currentSessionId;
        const messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
        // Capture submission context with the text, before preflight can yield.
        const syntheticParts = [...(useInputStore.getState().pendingSyntheticParts ?? [])];
        const draftTarget = inlineDraftTarget ? { ...inlineDraftTarget, runtimeKey: queueRuntimeKey } : null;
        const drafts = draftTarget ? [...useInlineCommentDraftStore.getState().getDrafts(draftTarget)] : [];
        const linked: LinkedReferences = { issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue };
        queueAdmissionInFlight.current = true;
        try {
        // Shell identity is not backend capability. This read refuses before
        // document preparation or any text, file, mention or context consumption.
        try { await checkQueueAdmission(queueTarget); }
        catch (error) {
            toast.error(t(error instanceof QueueRequestError && error.status === 501
                ? 'chat.queuedMessage.unsupported' : 'chat.queuedMessage.toast.queueFailed'));
            return;
        }
        if (!sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) return;
        const composerAttachments = sanitizeAttachmentsForSend(attachedFiles);

        // A queued message is resolved now, not at delivery: the server that
        // sends it has no agent list, no confirmed mentions, and no way to read
        // a document the user named — and the mention must match what was
        // visible when the user typed it.
        const documentMentions = await prepareDocumentMentions(
            [messageToQueue],
            new Set(composerAttachments.map((attachment) => attachment.filename)),
            queueRuntimeKey,
        );
        if (documentMentions.status === 'runtime-changed') return;
        if (documentMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: documentMentions.filename }));
            return;
        }
        const { sanitizedText, mention } = parseAgentMentions(messageToQueue, agents);
        const { attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText, documentMentions.prepared);
        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );
        const skillInstruction = buildSkillMentionInstruction(collectInlineSkillMentions(sanitizedText, availableSkillNames));

        // Everything attached to the composer leaves with the message: the
        // chips are part of what was queued, and come back if it is edited.
        const context = buildComposerContext({
            inlineComments: drafts,
            syntheticTexts: syntheticParts.map((part) => part.text),
            linkedIssue: linked.issue
                ? { number: linked.issue.number, title: linked.issue.title, url: linked.issue.url, contextText: linked.issue.contextText }
                : null,
            linkedPr: linked.pr
                ? { number: linked.pr.number, title: linked.pr.title, url: linked.pr.url, instructions: linked.pr.instructionsText, context: linked.pr.contextText }
                : null,
            linkedLinearIssue: linked.linear
                ? { identifier: linked.linear.identifier, title: linked.linear.title, url: linked.linear.url, contextText: linked.linear.contextText }
                : null,
            linkedGuestIssue: linkedGuestIssue
                ? {
                    providerId: linkedGuestIssue.providerId,
                    id: linkedGuestIssue.id,
                    title: linkedGuestIssue.title,
                    url: linkedGuestIssue.url,
                    contextText: linkedGuestIssue.contextText,
                    thread: linkedGuestIssue.thread,
                    data: linkedGuestIssue.data,
                }
                : null,
        }, skillInstruction);
        const attachmentsToQueue = [...composerAttachments, ...mentionAttachments];
        if (getRuntimeKey() !== queueRuntimeKey || !sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) return;

        // Sending while the agent works must still take the reader to the
        // live edge — a queued message produces no user row yet, so the
        // anchor path has nothing to claim and would leave the viewport
        // parked mid-history.
        scrollToLatest?.();

        // Keep the live input until the queue confirms durable acceptance.
        try {
            await addToQueue(queueTarget, {
                content: messageToQueue,
                text: sanitizedText,
                agentMention: mention?.name,
                attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
                context: context.length > 0 ? context : undefined,
                sendConfig: currentProviderId && currentModelId ? {
                    providerID: currentProviderId,
                    modelID: currentModelId,
                    agent: currentAgentName ?? undefined,
                    variant: currentVariant ?? undefined,
                } : undefined,
            });
        } catch (error) {
            const uncertain = useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(queueTarget)]?.some(item => item.state === 'unconfirmed');
            toast.error(t(uncertain ? 'chat.queuedMessage.admissionUnknown'
                : error instanceof QueueRequestError && error.status === 501 ? 'chat.queuedMessage.unsupported' : 'chat.queuedMessage.toast.queueFailed'));
            return;
        }
        consumeChatDraft(chatDraftIdentity, inputSnapshot.message);
        const input = useInputStore.getState();
        input.setAttachedFiles(input.attachedFiles.filter(file => !attachedFiles.includes(file)));
        input.setPendingSyntheticParts((input.pendingSyntheticParts ?? []).filter(part => !syntheticParts.includes(part)));
        if (draftTarget) {
            const live = useInlineCommentDraftStore.getState();
            for (const draft of drafts) if (live.getDrafts(draftTarget).includes(draft)) live.removeDraft(draftTarget, draft.id);
        }
        setLinkedIssue(current => current === linked.issue ? null : current);
        setLinkedPr(current => current === linked.pr ? null : current);
        setLinkedLinearIssue(current => current === linked.linear ? null : current);
        setLinkedGuestIssue(current => current === linkedGuestIssue ? null : current);
        if (!isMobile && currentChatDraftIdentityRef.current === chatDraftIdentity) composerRef.current?.focus();
        recordLinkedReferences(queueSessionId, queueTarget.directory, linked);
        } finally { queueAdmissionInFlight.current = false; }
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, attachedFiles, sanitizeAttachmentsForSend, prepareDocumentMentions, extractInlineFileMentions, agents, currentDirectory, inlineDraftTarget, linkedIssue, linkedPr, linkedLinearIssue, linkedGuestIssue, scrollToLatest, isMobile, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, chatDraftIdentity, t]);

    /** Put the context a queued message was captured with back on the composer chips. */
    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        for (const part of context) {
            if (part.kind === 'synthetic') {
                synthetic.push({ text: part.text, synthetic: true });
                continue;
            }
            // An instruction is derived from the text, and derived again on send.
            if (part.kind !== 'context') continue;
            const payload = part.metadata[CONTEXT_METADATA_KEY];
            if (payload.kind === 'github-issue') {
                setLinkedIssue({ number: payload.number, title: payload.title, url: payload.url, contextText: part.text });
                setLinkedPr(null);
                setLinkedLinearIssue(null);
                setLinkedGuestIssue(null);
            } else if (payload.kind === 'github-pr') {
                // The captured context is final: whatever diff it includes is
                // already in the text, and the branches were not captured.
                setLinkedPr({
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    head: '',
                    base: '',
                    includeDiff: false,
                    instructionsText: part.instructions ?? '',
                    contextText: part.text,
                });
                setLinkedIssue(null);
                setLinkedLinearIssue(null);
                setLinkedGuestIssue(null);
            } else if (payload.kind === 'linear-issue') {
                setLinkedLinearIssue({ identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
                setLinkedIssue(null);
                setLinkedPr(null);
                setLinkedGuestIssue(null);
            } else if (payload.kind === 'guest-issue' || payload.kind === 'guest-pr') {
                setLinkedGuestIssue({
                    providerId: payload.providerId,
                    id: payload.id,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                    thread: payload.kind === 'guest-pr' ? 'pull' : 'issue',
                    data: payload.data,
                });
                setLinkedIssue(null);
                setLinkedPr(null);
                setLinkedLinearIssue(null);
            } else {
                const draft = draftFromContextPayload(payload);
                if (draft && inlineDraftTarget) {
                    useInlineCommentDraftStore.getState().addDraft(inlineDraftTarget, draft);
                }
            }
        }
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().pendingSyntheticParts ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic]);
        }
    }, [inlineDraftTarget]);

    const liveLinkedReferences = React.useRef({ issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue, guest: linkedGuestIssue });
    React.useLayoutEffect(() => {
        liveLinkedReferences.current = { issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue, guest: linkedGuestIssue };
    }, [linkedIssue, linkedPr, linkedLinearIssue, linkedGuestIssue]);

    const handleQueuedMessageEdit = React.useCallback(async (target: MessageQueueTarget, messageId: string) => {
        if (!messageQueueTarget || getMessageQueueKey(target) !== getMessageQueueKey(messageQueueTarget)) return;
        const scope = captureRuntimeRequestScope();
        const editor = composerRef.current;
        const text = editor?.getValue() ?? messageRef.current;
        const input = useInputStore.getState();
        const linkedAtTake = liveLinkedReferences.current;
        const draftTarget = inlineDraftTarget ? { ...inlineDraftTarget, runtimeKey: target.runtimeKey } : null;
        const drafts = draftTarget ? useInlineCommentDraftStore.getState().getDrafts(draftTarget) : null;
        let queued;
        try { queued = await useMessageQueueStore.getState().popToInput(target, messageId); }
        catch { toast.error(t('chat.queuedMessage.toast.takeFailed')); return; }
        // A successful transfer remains accepted under its origin. Only editor
        // publication is conditional; navigation is never a rejected receipt.
        if (!queued || !isRuntimeRequestScopeCurrent(scope)
            || !sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)
            || !editor || composerRef.current !== editor || editor.getValue() !== text) return;
        const currentLinked = liveLinkedReferences.current;
        if (currentLinked.issue !== linkedAtTake.issue || currentLinked.pr !== linkedAtTake.pr || currentLinked.linear !== linkedAtTake.linear || currentLinked.guest !== linkedAtTake.guest) return;
        const currentInput = useInputStore.getState();
        if (currentInput.attachedFiles !== input.attachedFiles || currentInput.pendingSyntheticParts !== input.pendingSyntheticParts
            || (draftTarget && useInlineCommentDraftStore.getState().getDrafts(draftTarget) !== drafts)) return;
        if (queued.attachments?.length) currentInput.setAttachedFiles([...currentInput.attachedFiles, ...queued.attachments]);
        setMessage(queued.content);
        restoreQueuedContext(queued.context ?? []);
        editor.focus();
    }, [messageQueueTarget, chatDraftIdentity, inlineDraftTarget, restoreQueuedContext, t]);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        // Force-sending from the queue during a busy session counts as steer
        void handleSubmitRef.current({ queuedOnly: true, queuedMessageId: messageId, delivery: 'steer' });
    }, []);

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, []);

    const handleToggleExpandedInput = React.useCallback(() => {
        if (isBtwActive) return;
        setExpandedInput(!isExpandedInput);
    }, [isBtwActive, isExpandedInput, setExpandedInput]);

    const openIssuePicker = React.useCallback(() => {
        setIssuePickerOpen(true);
    }, []);

    const openPrPicker = React.useCallback(() => {
        setPrPickerOpen(true);
    }, []);

    const openLinearPicker = React.useCallback(() => {
        setLinearPickerOpen(true);
    }, []);

    const getSubmitErrorMessage = (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? t('chat.chatInput.toast.messageSendFailed')
            : message || fallback;
    };

    // A Send on a new-session draft holds the opening of its new session until its message is admitted or it ends
    // (smarty-dev#856). The press owns its hold: an exit that dispatches nothing ends it here, a dispatched send when
    // it settles. Another press or another draft target never ends it.
    // smarty-code#827: each send to a Pi session, by its target and content, until it is delivered (lib/sendRecovery).
    // smarty-code#827: the same draft by value; coming back to a session makes a new identity object for it.
    const sameDraftIdentity = (a: ChatDraftIdentity | null, b: ChatDraftIdentity | null) =>
        a === b || (!!a && !!b && getChatDraftIdentityKey(a) === getChatDraftIdentityKey(b) && a.draftId === b.draftId);
    const sendRecovery = React.useRef<SendRecovery | null>(null);
    sendRecovery.current ??= new SendRecovery(() => sendUnconfirmed.ms, () => ascendingId('msg'));
    // A due recovery's attachments and context live only here: a new-build reload waits (openchamber#375 review 5).
    React.useEffect(() => holdReload(() => !!sendRecovery.current?.hasDue()), []);
    /** A Pi session send's target (runtime, directory, session) and content (text, attachments, context parts). */
    // A recovery that came due while its target was not shown comes back when it is (after that target's own draft loads).
    const shownTarget = currentSessionId && isOrdinarySession(currentSessionId)
        ? [getRuntimeKey(), currentSessionDirectoryForSync ?? currentDirectory ?? '', currentSessionId].join('\u0000') : null;
    React.useEffect(() => {
        if (!shownTarget) return;
        // Once the editor shows this target's loaded draft (bounded: a composing IME may hold it back).
        let tries = 0;
        const run = () => {
            const shown = composerRef.current?.getValue();
            if (shown !== undefined && shown !== messageRef.current && ++tries < 20) { timer = setTimeout(run, 16); return; }
            sendRecovery.current?.flush(shownTarget);
        };
        let timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
    }, [shownTarget, chatDraftIdentity]);
    const recoveryKeys = (sessionId: string | null | undefined, text: string) => {
        if (!sessionId || !isOrdinarySession(sessionId)) return null;
        const input = useInputStore.getState();
        return { target: [getRuntimeKey(), currentSessionDirectoryForSync ?? currentDirectory ?? '', sessionId].join('\u0000'),
            content: SendRecovery.signature(text, [...input.attachedFiles.map(file => file.id), ...(input.pendingSyntheticParts ?? []).map(part => part.text)]) };
    };
    const submitComposer = async (options?: SubmitOptions) => {
        const attempt: SubmitAttempt = {};
        // The whole send, from preparation to its settled request, holds a new-build reload: the composer is cleared
        // before the prompt is sent, so a reload in between would lose it (openchamber#333 review).
        const releaseReload = holdReload();
        try { await handleSubmit(options, attempt); }
        finally {
            const end = () => { releaseReload(); endFirstSend(attempt.hold); };
            if (attempt.sent) void attempt.sent.then(end, end); else end();
        }
    };

    const handleSubmit = async (options: SubmitOptions | undefined, attempt: SubmitAttempt) => {
        if (queueAdmissionInFlight.current || (followUpPreflight.current && !options?.queuedOnly)) return;
        if (sentLocked) return; // The notice above the composer says why, and offers Check again.
        // smarty-code#966: the draft's project is no longer admitted: no Send by button or keyboard; the text stays, and the
        // notice says to choose another project (openchamber#441 r1).
        if (newSessionDraftOpen && nativeCreation.mode === 'notAdmitted') return;
        // smarty-code#827: the same content to the same session, while its send is unanswered: never posted twice.
        const pendingKeys = options?.queuedOnly || isBtwActive ? null : recoveryKeys(currentSessionId, composerRef.current?.getValue() ?? messageRef.current);
        if (pendingKeys && sendRecovery.current!.wouldBlock(pendingKeys.target, pendingKeys.content)) {
            toast.info(t('chat.send.stillPending'));
            return;
        }
        if (messageQueueKey && useMessageQueueStore.getState().recoveryMessages[messageQueueKey]?.some(item => item.state === 'unconfirmed')) {
            toast.error(t('chat.queuedMessage.admissionUnknown'));
            return;
        }
        if (isBtwActive && currentSessionId && (btwPanel.creating || useBtwStore.getState().byParent[currentSessionId]?.pendingSend)) return;
        const submitRuntimeKey = getRuntimeKey();
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        let displayName: string | undefined;
        try { displayName = browserDisplayName.read(); }
        catch { toast.error(t('chat.displayName.error')); return; }
        if (displayName && (queuedOnly || hasQueuedMessages || delivery || inputMode === 'shell')) {
            toast.error(t('chat.displayName.plainOnly')); return;
        }
        // An expired session cannot deliver anything: keep the prompt in the
        // composer and point at the login banner instead of burning the send
        // on a guaranteed 401.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        // Snapshot the draft and current-session identity before the first
        // async gap so a later sidebar selection cannot reroute the send.
        const capturedDraftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        let inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
            }
            : getCurrentInputSnapshot();
        if (displayName && inputSnapshot.message.trimStart().startsWith('/')) {
            toast.error(t('chat.displayName.plainOnly')); return;
        }
        let nativeIntent: NativeDraftSend | undefined;
        // Nothing to send starts nothing: Enter reaches here without the Send button's content check (#126).
        if (newSessionDraftOpen && !queuedOnly && !inputSnapshot.hasContent && !hasQueuedMessages) return;
        if (newSessionDraftOpen) {
            attempt.hold = beginFirstSend(useSessionUIStore.getState().newSessionDraft, getRuntimeKey());
            try { nativeIntent = await nativeCreation.beforeSend(); }
            catch (error) { toast.error(nativeCreation.describeError(error)); return; }
            // Starting the session can take a while; send the composer as it is now, so text typed meanwhile is
            // sent (and cleared) with it rather than lost (smarty-code#126).
            if (nativeIntent && options?.presetText == null) {
                inputSnapshot = getCurrentInputSnapshot();
                if (displayName && inputSnapshot.message.trimStart().startsWith('/')) {
                    const message = t('chat.displayName.plainOnly');
                    toast.error(message); nativeCreation.noteRefusal(new NativeCreationError('unavailable', undefined, message)); return;
                }
            }
        }
        const retainNativeDraft = Boolean(nativeIntent);
        // After its session started, a Send that stops here sends nothing: say why and keep saying it (smarty-dev#856).
        const refuse = (message: string) => {
            toast.error(message);
            if (nativeIntent) nativeCreation.noteRefusal(new NativeCreationError('unavailable', undefined, message));
        };
        // Any store's record, as the model control finds it: an "Unavailable" control must explain Send (#126 1b); a session
        // the managed listing left out is unavailable over them (openchamber#364).
        const sendSessionId = isBtwActive ? btwSessionId : currentSessionId;
        const ordinary = readOpenOrdinaryState(sendSessionId, (isBtwActive ? btwDirectory : currentSessionDirectoryForSync ?? currentDirectory) ?? undefined,
            isGloballyUnavailable(sendSessionId ? useGlobalSessionsStore.getState().entityById.get(sendSessionId) : undefined));
        if (ordinary && !ordinary.model) { toast.error(t('chat.ordinary.sendUnavailable')); return; }
        const nativeModelToSend = ordinary?.model ?? nativeIntent?.session.nativeCreation.model ?? (isBtwActive ? undefined : nativeModel);
        if (queuedOnly && autoReviewRunning) {
            return;
        }

        if (queuedOnly) {
            if (!queuedMessages.some((message) => !queuedMessageId || message.id === queuedMessageId) || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        // Local slash commands are planned before anything is taken or
        // consumed. An action command must leave the queue and the attached
        // context where they are; a prompt command must send that context with
        // the prompt it produces. A command the composer cannot run here is not
        // a local command at all and goes out as typed.
        let commandPlan = !queuedOnly && inputSnapshot.hasContent
            ? planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, Boolean(currentSessionId))
            : null;
        if (commandPlan?.kind === 'prompt') {
            const magicCommand = findMagicPromptCommand(commandPlan.command.name);
            const commandIsAvailable = commandPlan.command.name === 'btw'
                ? Boolean(currentSessionId)
                : magicCommand !== null && canRunCommand(magicCommand, {
                    hasSession: Boolean(currentSessionId),
                    hasDraft: newSessionDraftOpen,
                });
            if (!commandIsAvailable) commandPlan = null;
        }
        if (commandPlan?.command.name === 'handoff-review' && (isMobile || isVSCodeRuntime())) commandPlan = null;

        // Enter BTW before sending so the question uses its isolated selections.
        // A bare command waits for input; an argument requests one immediate send.
        if (commandPlan?.kind === 'prompt' && commandPlan.command.name === 'btw' && currentSessionId) {
            const targetComposerId = btwSessionId ?? `btw-pending:${currentSessionId}`;
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            if (argument && targetIdentity) immediateBtwSubmitRef.current = { identity: targetIdentity, text: argument };
            if (btwSessionId) {
                useBtwStore.getState().setPanelState(currentSessionId, { collapsed: false });
                return;
            }
            useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false });
            return;
        }

        // Opening BTW is local and still works while authentication is expired.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        // A failed send returns the typed prompt no matter WHY it failed —
        // auth, network, server, anything. Losing a long prompt to a toast is
        // the one outcome this handler must never produce. The mentions are
        // snapshotted here because sending clears them before it can fail.
        const confirmedMentionsSnapshot = new Set(confirmedMentionsRef.current);
        // openchamber#375 review 5: once its recovery saved the text into this session's draft, it is not added again
        // where that draft still holds it (with drafts off, the composer does not load it: then it comes back here).
        let textInDraft = false;
        // smarty-code#962: the copy this submission joined, and where. A late acceptance removes that copy only.
        const own: OwnedJoin = { identity: chatDraftIdentity, at: -1, gone: false, seen: '', length: inputSnapshot.message.length };
        // A submission without text (review r3 2: newlines only too) gives back and takes back only its parts.
        const textless = !inputSnapshot.message.trim();
        const restoreComposerText = () => {
            if (queuedOnly || textless) return;
            if (!pendingKeys) {
                restoreDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsSnapshot);
                return;
            }
            for (const mention of confirmedMentionsSnapshot) confirmedMentionsRef.current.add(mention);
            // New text already there (typed, a loaded draft, an earlier restore) is kept: this text joins it.
            const join = (base: string) => {
                const joined = !base.trim() || base === inputSnapshot.message ? { text: inputSnapshot.message, at: 0 } : appendOwnedBlock(base, inputSnapshot.message);
                // Joined after everything already there: the blocks given back before it stay where they are.
                for (const other of [...ownedJoinsRef.current]) {
                    if (other === own || !sameDraftIdentity(other.identity, own.identity)) continue;
                    followEdit(other, base); if (other.at >= 0) other.seen = joined.text;
                }
                own.at = joined.at; own.seen = joined.text; ownedJoinsRef.current.add(own);
                return joined.text;
            };
            if (!sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) {
                if (textInDraft) return;
                // The user switched sessions mid-send: restore into that
                // session's persisted draft, not the visible composer.
                writeChatDraft(chatDraftIdentity, join(chatDraftIdentity ? readChatDraft(chatDraftIdentity).text : ''), confirmedMentionsRef.current);
                return;
            }
            // openchamber#375 review 4: composed on the composer STATE, not the editor document (a render behind a draft
            // load or an earlier restore in the same tick), so every restore keeps the ones before it and the loaded draft.
            // ponytail: the updater also saves the draft; it is idempotent for a given prev (StrictMode may run it twice).
            setMessage((prev) => {
                const next = textInDraft && prev.includes(inputSnapshot.message) ? prev : join(prev);
                messageRef.current = next;
                writeChatDraft(chatDraftIdentity, next, confirmedMentionsRef.current);
                return next;
            });
        };

        // An extension command never reaches the model: the extension turns
        // `/name args` into a chip, which lands through the same pending slot
        // a guest panel's `attach` uses. Nothing else in the composer moves.
        const guestRoute = !queuedOnly && !isBtwActive && inputSnapshot.hasContent
            ? routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)
            : null;
        if (guestRoute) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            const outcome = await runGuestCommand(guestRoute);
            if (outcome.ok) {
                if (outcome.item) {
                    useInputStore.getState().setPendingGuestIssue(outcome.item);
                } else {
                    // Nothing matched: give the command back so the user can fix the argument.
                    restoreComposerText();
                    toast.info(t('chat.chatInput.toast.guestCommandNothing', { name: guestRoute.entry.guestName }));
                }
                return;
            }
            restoreComposerText();
            toast.error(outcome.reason === 'error'
                ? t('chat.chatInput.toast.guestCommandFailed', { command: guestRoute.entry.command.name, reason: outcome.message })
                : t('chat.chatInput.toast.guestCommandUnavailable', { name: guestRoute.entry.guestName }));
            return;
        }

        // The projection knows the captured send configuration; the full
        // messages are taken from the queue only once nothing below can still
        // bail out, so an early return leaves the queue untouched.
        const queuedProjection = queuedMessageId
            ? queuedMessages.filter((message) => message.id === queuedMessageId)
            : queuedMessages;
        const capturedSendConfig = queuedOnly ? queuedProjection[0]?.sendConfig : undefined;
        const providerIdToSend = nativeModelToSend?.providerID ?? capturedSendConfig?.providerID ?? (isBtwActive ? effectiveBtwSelection.model?.providerId : currentProviderId);
        const modelIdToSend = nativeModelToSend?.modelID ?? capturedSendConfig?.modelID ?? (isBtwActive ? effectiveBtwSelection.model?.modelId : currentModelId);
        const agentNameToSend = nativeModelToSend ? undefined : capturedSendConfig?.agent ?? (isBtwActive ? effectiveBtwSelection.agent : currentAgentName);
        const variantToSend = nativeModelToSend ? undefined : capturedSendConfig?.variant ?? (isBtwActive ? effectiveBtwSelection.variant : currentVariant);

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            refuse(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        // Sending is authoritative: if a question prompt is open, dismiss it
        // so the prompt cannot linger or strand the session. The dismiss clears
        // the card instantly (optimistic) and formally rejects the question.
        // Rejecting unblocks the agent's tool but does NOT end its turn, so a
        // direct send would race with the still-active run and be silently
        // discarded by the OpenCode runner. Instead we queue the message; the
        // queued-message auto-send hook delivers it as the next turn once the
        // rejected turn winds down and the session returns to idle. This avoids
        // aborting the turn (which would surface an "aborted" notice).
        if (currentSessionId && !queuedOnly && autoReviewRunning && !isBtwActive && !commandPlan) {
            void handleQueueMessage();
            return;
        }

        // btw mode: the child fork's blocking prompts are answered inside the
        // panel; the composer send goes straight to the fork (routeMessage
        // queues if the fork's own turn is busy).
        // Named prompts leave dialogs to native admission; this queue cannot carry their attribution.
        if (currentSessionId && !queuedOnly && !isBtwActive && !commandPlan && displayName === undefined) {
            // Sending is authoritative for blocking prompts: deny pending
            // permissions and dismiss open questions for the session subtree,
            // then queue the message once if either was open. The deny/clear
            // vanishes the card instantly (optimistic); rejecting unblocks the
            // agent's tool but does NOT end its turn, so a direct send would
            // race with the still-active run and be silently discarded by the
            // OpenCode runner. Instead we queue; the queued-message auto-send
            // hook delivers it as the next turn once the rejected turn winds
            // down and the session returns to idle (parity with #1740).
            const [deniedPermissions, dismissedQuestions] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenQuestionsForSession(currentSessionId),
            ]);
            if (deniedPermissions || dismissedQuestions) {
                void handleQueueMessage();
                return;
            }
        }

        // Action commands change session or UI state and send nothing. The
        // command text goes; the queue and whatever the composer had attached
        // stay exactly where they are.
        if (commandPlan?.kind === 'action' && currentSessionId) {
            const actionName = commandPlan.command.name;
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (!isBtwActive) setExpandedInput(false);
            if (isMobile) composerRef.current?.blur();
            try {
                if (actionName === 'undo') {
                    await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'redo') {
                    await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'timeline') {
                    setTimelineDialogOpen(true);
                } else if (actionName === 'handoff-review') {
                    setReviewDialogOpen(true);
                } else if (actionName === 'compact') {
                    await sessionActions.waitForConnectionOrThrow();
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await opencodeClient.summarizeSession(currentSessionId, providerIdToSend, modelIdToSend, compactDirectory);
                }
            } catch (error) {
                restoreComposerText();
                if (actionName !== 'compact') throw error;
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
            }
            return;
        }

        let sendMessageOptions: {
            target?: NonNullable<typeof capturedTarget>;
            sessionId?: string;
            directory?: string;
            draftSnapshot?: NonNullable<typeof capturedDraftSnapshot>;
            onNativeAccepted?: () => void;
            nativeIntent?: NativeDraftSend;
            historySubmissions?: InputHistorySubmission[];
            delivery?: 'steer';
            displayName?: string;
            messageID?: string;
            onMessageID?: (messageID: string) => void;
        } | undefined;
        if (isBtwActive && btwSessionId && btwDirectory) {
            sendMessageOptions = {
                sessionId: btwSessionId,
                directory: btwDirectory,
            };
        } else if (capturedTarget || capturedDraftSnapshot || delivery) {
            sendMessageOptions = {};
            if (capturedTarget) sendMessageOptions.target = capturedTarget;
            if (capturedDraftSnapshot) sendMessageOptions.draftSnapshot = capturedDraftSnapshot;
        }
        // An ordinary session is never sent a local steer: its server decides (G5).
        if (delivery && sendMessageOptions && !ordinary) sendMessageOptions.delivery = delivery;
        if (displayName) sendMessageOptions = { ...sendMessageOptions, displayName };
        if (nativeIntent) sendMessageOptions = { ...sendMessageOptions, nativeIntent };

        // Queued messages resolved their mentions when they were queued; only
        // the composer's own text can still name a document.
        const reservedFilenames = new Set([
            ...attachedFiles.map((attachment) => attachment.filename),
            ...queuedProjection.flatMap((queued) => queued.attachments?.map((attachment) => attachment.filename) ?? []),
        ]);
        const documentMentions = await prepareDocumentMentions(
            !isBtwActive && !queuedOnly && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
            reservedFilenames,
            submitRuntimeKey,
        );
        if (documentMentions.status === 'runtime-changed') return;
        if (documentMentions.status === 'failed') {
            refuse(t('chat.chatInput.toast.attachNamedFailed', { name: documentMentions.filename }));
            return;
        }
        const preparedDocumentMentions = documentMentions.prepared;

        // The composer delivers these itself, so they leave the queue now — the
        // queue's own delivery (server-side, or the auto-send hook in VS Code)
        // skips anything already in flight, and a message already being
        // delivered stays out of this send so it cannot go out twice.
        let queuedMessagesToSend: QueuedMessage[] = [];
        if (capturedTarget && hasQueuedMessages && !commandPlan) {
            try {
                queuedMessagesToSend = await takeForSend(capturedTarget, queuedMessageId);
            } catch (error) {
                console.warn('[queue] failed to take queued messages for sending:', error);
                toast.error(t('chat.queuedMessage.toast.takeFailed'));
                return;
            }
            if (queuedOnly && queuedMessagesToSend.length === 0) return;
        }

        const historySubmissions = buildChatInputHistorySubmissions({
            inputMode,
            // Server-owned items were recorded on acceptance. VS Code records
            // the full items actually taken, never the metadata projection.
            queuedMessages: isServerOwnedMessageQueue() ? [] : queuedMessagesToSend,
            composerText: inputSnapshot.message,
            composerAttachments: attachedFiles,
            includeComposer: !queuedOnly && inputSnapshot.hasContent,
        });
        if (historySubmissions?.length) {
            sendMessageOptions = { ...sendMessageOptions, historySubmissions };
        }

        // Native first Send only reads this context until admission. Other
        // sends consume it now and restore it on failure; queued context was
        // already taken by its own send. BTW never consumes the parent's synthetic context.
        const syntheticParts = isBtwActive ? [] : retainNativeDraft ? useInputStore.getState().pendingSyntheticParts : consumePendingSyntheticParts();
        const consumedDraftTarget = inlineDraftTarget ? { ...inlineDraftTarget, runtimeKey: submitRuntimeKey } : null;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? retainNativeDraft ? useInlineCommentDraftStore.getState().getDrafts(consumedDraftTarget) : consumeDrafts(consumedDraftTarget)
            : [];
        const restoreConsumedDrafts = () => {
            if (!retainNativeDraft && consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };
        // Everything a prompt command consumed comes back if it fails: the
        // attached context, the typed text, and the files.
        const restoreConsumedInput = () => {
            if (retainNativeDraft) return;
            restoreConsumedDrafts();
            if (syntheticParts?.length) {
                const inputState = useInputStore.getState();
                inputState.setPendingSyntheticParts([...syntheticParts, ...(inputState.pendingSyntheticParts ?? [])]);
            }
            restoreComposerText();
            if (!queuedOnly && attachedFiles.length > 0) {
                useInputStore.getState().restoreAttachedFiles(attachedFiles, chatDraftIdentity);
            }
        };

        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : null,
            composerAttachments: attachedFiles,
            inlineComments: drafts,
            syntheticTexts: [
                ...buildBtwSyntheticTexts({ isBtwActive, isPromotedBtwSession }),
                ...(syntheticParts?.map((part) => part.text) ?? []),
            ],
            linkedIssue: !isBtwActive && linkedIssue
                ? { number: linkedIssue.number, title: linkedIssue.title, url: linkedIssue.url, contextText: linkedIssue.contextText }
                : null,
            linkedPr: !isBtwActive && linkedPr
                ? { number: linkedPr.number, title: linkedPr.title, url: linkedPr.url, instructions: linkedPr.instructionsText, context: linkedPr.contextText }
                : null,
            linkedLinearIssue: !isBtwActive && linkedLinearIssue
                ? { identifier: linkedLinearIssue.identifier, title: linkedLinearIssue.title, url: linkedLinearIssue.url, contextText: linkedLinearIssue.contextText }
                : null,
            linkedGuestIssue: linkedGuestIssue
                ? {
                    providerId: linkedGuestIssue.providerId,
                    id: linkedGuestIssue.id,
                    title: linkedGuestIssue.title,
                    url: linkedGuestIssue.url,
                    contextText: linkedGuestIssue.contextText,
                    thread: linkedGuestIssue.thread,
                    data: linkedGuestIssue.data,
                }
                : null,
        }, {
            parseAgentMention: (text) => {
                if (isBtwActive) return { text };
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                if (isBtwActive) return { text, attachments: [] };
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedDocumentMentions);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
            buildSkillInstruction: buildSkillMentionInstruction,
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName } = outgoing;

        if (outgoing.isEmpty) return;

        // A native Send consumes only copies set by its submission (#220): not a new draft typed while it was held.
        const submittedAt = Date.now();
        const clearSubmittedInput = () => {
            if (queuedOnly) return;
            const origin = nativeIntent;
            const ownsInput = origin ? consumeChatDraft(createChatDraftIdentity(origin.runtimeKey,
                origin.session.directory, null, origin.draft.draftId), inputSnapshot.message, submittedAt) : false;
            if (!origin) {
                messageRef.current = '';
                setMessage('');
                confirmedMentionsRef.current.clear();
                persistDraftImmediately(chatDraftIdentity, '');
                messageHistory.reset();
            }
            if (origin) {
                const input = useInputStore.getState();
                const remainingFiles = input.attachedFiles.filter(file => !attachedFiles.includes(file));
                if (remainingFiles.length !== input.attachedFiles.length) input.setAttachedFiles(remainingFiles);
                const remainingParts = input.pendingSyntheticParts?.filter(part => !syntheticParts?.includes(part)) ?? [];
                if (ownsInput && isNativeDraftCurrent(origin)) {
                    const liveParts = useSessionUIStore.getState().newSessionDraft.syntheticParts ?? [];
                    remainingParts.push(...liveParts.filter(part => !origin.draft.syntheticParts?.includes(part) && !remainingParts.includes(part)));
                }
                if (remainingParts.length !== (input.pendingSyntheticParts?.length ?? 0)
                    || remainingParts.some((part, index) => part !== input.pendingSyntheticParts?.[index])) input.setPendingSyntheticParts(remainingParts);
                setLinkedIssue(current => current === linkedIssue ? null : current);
                setLinkedPr(current => current === linkedPr ? null : current);
                setLinkedLinearIssue(current => current === linkedLinearIssue ? null : current);
                setLinkedGuestIssue(current => current === linkedGuestIssue ? null : current);
                if (consumedDraftTarget) {
                    const live = useInlineCommentDraftStore.getState();
                    for (const sent of drafts) if (live.getDrafts(consumedDraftTarget).includes(sent)) live.removeDraft(consumedDraftTarget, sent.id);
                    if (ownsInput) {
                        const destination = { ...consumedDraftTarget, sessionKey: origin.session.id };
                        const remaining = live.getDrafts(consumedDraftTarget);
                        live.restoreDrafts(destination, remaining.map(draft => ({ ...draft, sessionKey: destination.sessionKey })));
                        for (const draft of remaining) if (live.getDrafts(destination).some(item => item.id === draft.id)) live.removeDraft(consumedDraftTarget, draft.id);
                    }
                }
            } else if (attachedFiles.length > 0) clearAttachedFiles(chatDraftIdentity);
            if (!isBtwActive && (!origin || isNativeDraftCurrent(origin))) setExpandedInput(false);
        };
        // Native first Send keeps the original input until admission succeeds, before the draft transition.
        if (retainNativeDraft) sendMessageOptions = { ...sendMessageOptions, onNativeAccepted: clearSubmittedInput };
        // smarty-code#827: a send to a Pi session never loses its text. The composer clears at Send (the next message is
        // typed clean: kept there instead, a steer typed during a 10 s admission merged into it); a failure brings the
        // text back (below); and a send not answered within sendUnconfirmed.ms (a stalled POST, as slice 1 saw once) brings
        // it back too, with an honest line. A late acceptance then clears that copy again if it is untouched.
        const watchUnconfirmed = !nativeIntent && !queuedOnly && !isBtwActive && !commandPlan && !!pendingKeys && inputSnapshot.hasContent;
        // This submission's recovery: its own target and content, its own timers (lib/sendRecovery). Taken before the
        // composer clears: a same-content Send that raced this one is refused here and everything it took goes back.
        const recovery = watchUnconfirmed ? sendRecovery.current!.begin(pendingKeys!.target, pendingKeys!.content, {
            // The whole consumed input comes back (text, files, context parts), so an unedited re-send is the same content,
            // but only into this target's own composer (review 3): shown elsewhere, it waits until this target is shown.
            restore: () => {
                // By value: coming back to a session makes a new identity object for the same draft.
                if (!chatDraftIdentity || !sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) return false;
                restoreConsumedInput(); return true;
            },
            // Due while another session is shown: the text joins this session's saved draft now (a reload or unmount keeps it).
            save: () => { if (retainNativeDraft || !chatDraftIdentity) return; restoreComposerText(); textInDraft = true; },
            clearIfUntouched: () => {
                // Joined with other texts (smarty-code#962): only its own copy goes, and only while it is intact where it
                // was joined; edited, moved or ambiguous, it is the person's text now and stays.
                const removeOwn = (text: string) => {
                    const cut = removeOwnedBlock(text, inputSnapshot.message, own.at);
                    if (!cut || own.gone) return cut?.text ?? null;
                    own.gone = true; ownedJoinsRef.current.delete(own);
                    for (const other of [...ownedJoinsRef.current]) {
                        if (!sameDraftIdentity(other.identity, own.identity)) continue;
                        followEdit(other, text);
                        if (other.at >= own.at + cut.removed) other.at -= cut.removed;
                        else if (other.at > own.at) { other.at = -1; ownedJoinsRef.current.delete(other); }
                        other.seen = cut.text;
                    }
                    return cut.text;
                };
                // Exactly the restored files and context parts go with it (after this render: another store).
                const clearOwnParts = () => queueMicrotask(() => {
                    const input = useInputStore.getState();
                    if (attachedFiles.length) input.setAttachedFiles(input.attachedFiles.filter(file => !attachedFiles.some(sent => sent.id === file.id)));
                    if (syntheticParts?.length) input.setPendingSyntheticParts((input.pendingSyntheticParts ?? []).filter(part => !syntheticParts.includes(part)));
                });
                // An attachment-only send (review r2 2) has no text block to find: its restored parts still go.
                if (textless) {
                    if (!own.gone && sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) { own.gone = true; clearOwnParts(); }
                    return;
                }
                if (!sameDraftIdentity(currentChatDraftIdentityRef.current, chatDraftIdentity)) {
                    // Off-screen, only a saved draft unchanged since this block was joined or last followed (review r3 1).
                    const saved = chatDraftIdentity ? readChatDraft(chatDraftIdentity).text : null;
                    const rest = saved !== null && saved === own.seen ? removeOwn(saved) : null;
                    if (rest !== null) writeChatDraft(chatDraftIdentity, rest, confirmedMentionsRef.current);
                    ownedJoinsRef.current.delete(own);
                    return;
                }
                // Composed on the composer STATE (review r1 2): two acceptances before the editor renders apply in order.
                // ponytail: StrictMode may run the updater twice; `own.gone` makes the side effects run once.
                setMessage((prev) => {
                    const first = !own.gone;
                    if (!own.gone) followEdit(own, prev);
                    const rest = removeOwn(prev);
                    if (rest === null) { ownedJoinsRef.current.delete(own); return prev; }
                    messageRef.current = rest; persistDraftImmediately(chatDraftIdentity, rest);
                    if (first) clearOwnParts();
                    return rest;
                });
            },
            notify: kind => { if (kind === 'unconfirmed') toast.info(t('chat.send.unconfirmed'));
                else if (kind === 'delivered-late') toast.success(t('chat.send.deliveredLate')); else toast.info(t('chat.send.stillPending')); },
        }) : null;
        if (watchUnconfirmed && !recovery) { restoreConsumedInput(); return; }
        if (nativeIntent) {
            noteNativeDraftSubmitted(nativeIntent, inputSnapshot.message, submittedAt);
            if (chatDraftIdentity) {
                const key = getChatDraftIdentityKey(chatDraftIdentity);
                for (const file of attachedFiles) nativeSubmittedAttachments.set(file, { key, text: inputSnapshot.message, at: submittedAt });
            }
        } else clearSubmittedInput();


        if (isMobile) {
            composerRef.current?.blur();
        }

        // Prompt commands render a visible prompt and send it with everything
        // the composer had attached. `/btw` was handled above as a composer
        // transition and never reaches this sending path.
        if (commandPlan?.kind === 'prompt') {
            const { name: commandName, argument } = commandPlan.command;

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message, the attached context riding along.
            const command = findMagicPromptCommand(commandName);
            if (command) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    if (nativeIntent) assertNativeDraftReady(nativeIntent);
                    const visibleText = await renderMagicPrompt(command.visiblePrompt, variables.visible);
                    if (nativeIntent) assertNativeDraftReady(nativeIntent);
                    const instructionsText = await renderMagicPrompt(command.instructionsPrompt, variables.instructions);
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        primaryAttachments,
                        agentMentionName,
                        [...additionalParts, { text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    restoreConsumedInput();
                    toast.error(nativeIntent ? nativeCreation.describeError(nativeCreation.noteRefusal(error)) : getSubmitErrorMessage(error, t(command.errorToastKey)));
                }
                return;
            }
        }

        const currentSessionDirectory = capturedTarget?.directory ?? currentDirectory;
        // btw mode: the fork already carries the question plus full history,
        // so the response-style instruction never applies there.
        const shouldAddResponseStyle = !isBtwActive && (newSessionDraftOpen || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false));
        const expandOutgoingSnippets = async () => {
            try {
                if (nativeIntent) assertNativeDraftReady(nativeIntent);
                const expandText = useSnippetsStore.getState().expandText;
                primaryText = await expandText(primaryText);
                for (const part of additionalParts) {
                    if (nativeIntent) assertNativeDraftReady(nativeIntent);
                    if (!part.synthetic) part.text = await expandText(part.text);
                }
            } catch (error) {
                if (nativeIntent) throw error;
                console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
            }
        };
        let pendingBtwSend: symbol | null = null;
        try {
            if (nativeIntent) assertNativeDraftReady(nativeIntent);
            if (shouldAddResponseStyle) {
                const responseStyleInstruction = await fetchResponseStyleInstruction().catch(() => null);
                if (responseStyleInstruction) additionalParts.push({ text: wrapSystemReminder(responseStyleInstruction), synthetic: true });
            }
            if (isBtwActive && btwPanel.pending && currentSessionId) {
                pendingBtwSend = await preparePendingBtwSend(currentSessionId, submitRuntimeKey, expandOutgoingSnippets);
                if (!pendingBtwSend) {
                    if (getRuntimeKey() !== submitRuntimeKey) restoreComposerText();
                    return;
                }
            } else {
                await expandOutgoingSnippets();
            }
        } catch (error) {
            if (nativeIntent) { toast.error(nativeCreation.describeError(nativeCreation.noteRefusal(error))); return; }
            console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
        }
        const ownsPendingBtwSend = () => Boolean(pendingBtwSend && currentSessionId
            && useBtwStore.getState().byParent[currentSessionId]?.pendingSend === pendingBtwSend);

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        // Arm the timeline anchor BEFORE the optimistic user row can commit;
        // arming after (or a frame later) races the commit and the anchor
        // never claims the new message.
        scrollToBottom?.();

        // Every attempt of this content keeps the same client message ID.
        if (recovery) sendMessageOptions = { ...sendMessageOptions, messageID: recovery.messageID };
        if (isBtwActive && btwPanel.pending && currentSessionId && btwComposerSessionId) {
            const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                || currentDirectory
                || null;
            if (!targetDirectory) {
                useBtwStore.getState().setPanelState(currentSessionId, { pendingSend: undefined });
                restoreConsumedInput();
                toast.error(t('chat.btw.toast.createFailed'));
                return;
            }
            try {
                const fork = await startBtwSession({
                    parentSessionId: currentSessionId,
                    expectedRuntimeKey: submitRuntimeKey,
                    question: primaryText,
                    directory: targetDirectory,
                    providerID: providerIdToSend,
                    modelID: modelIdToSend,
                    agent: agentNameToSend,
                    variant: variantToSend,
                    attachments: primaryAttachments,
                    additionalParts,
                });
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    return;
                }
                const forkDirectory = fork.directory ?? targetDirectory;
                migrateDraft(chatDraftIdentity, createChatDraftIdentity(activeRuntimeKey, forkDirectory, fork.id));
                if (inlineDraftTarget) {
                    const drafts = useInlineCommentDraftStore.getState();
                    drafts.restoreDrafts({ directory: forkDirectory, sessionKey: fork.id }, drafts.consumeDrafts(inlineDraftTarget));
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: false, creating: false, pendingSend: undefined });
                scrollToBottom?.();
            } catch (error) {
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    restoreComposerText();
                    return;
                }
                // Preserve the pending owner before restoring text so a failed
                // first send never drops back into the parent draft.
                useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false, pendingSend: undefined });
                restoreConsumedInput();
                toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
            }
            return;
        }

        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );
        attempt.sent = sendPromise;
        void sendPromise.then(() => {
            recovery?.accepted();
            if (isBtwActive) return;
            // On a draft there is no session yet in this closure: the send path
            // creates one and makes it current before resolving, so the id is
            // read from the store. The fallback is used only when the closure
            // had no session at all, so a mid-send session switch cannot
            // redirect the write to an unrelated session.
            const sameRuntime = !nativeIntent || getRuntimeKey() === nativeIntent.runtimeKey;
            const sessionState = useSessionUIStore.getState();
            const linkTargetSessionId = nativeIntent?.session.id ?? currentSessionId ?? sessionState.currentSessionId;
            const linkTargetDirectory = nativeIntent?.session.directory ?? (currentSessionId
                ? currentSessionDirectoryForSync ?? currentDirectory
                : sessionState.currentSessionDirectory
                    ?? (linkTargetSessionId ? sessionState.getDirectoryForSession(linkTargetSessionId) : null)
                    ?? currentDirectory);
            if (linkTargetSessionId && sameRuntime) {
                recordLinkedReferences(linkTargetSessionId, linkTargetDirectory, { issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue });
            }
            if (linkedGuestIssue && linkTargetSessionId && sameRuntime) {
                void sessionActions.setLinkedIssue(
                    linkTargetSessionId,
                    linkTargetDirectory,
                    buildLinkedGuestIssue({
                        providerId: linkedGuestIssue.providerId,
                        identifier: linkedGuestIssue.id,
                        title: linkedGuestIssue.title,
                        url: linkedGuestIssue.url,
                        thread: linkedGuestIssue.thread,
                        author: linkedGuestIssue.author,
                        head: linkedGuestIssue.head,
                        base: linkedGuestIssue.base,
                        data: linkedGuestIssue.data,
                        linkedAt: Date.now(),
                    }),
                    true,
                ).catch(() => undefined);
            }

            // Linked references were sent; clear them from the composer.
            setLinkedIssue(current => current === linkedIssue ? null : current);
            setLinkedPr(current => current === linkedPr ? null : current);
            setLinkedLinearIssue(current => current === linkedLinearIssue ? null : current);
            setLinkedGuestIssue(current => current === linkedGuestIssue ? null : current);
        }).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);
            // smarty-code#827: this send's text belongs to its recovery. A client-ID reservation conflict is not acceptance
            // (the other attempt is pending or was delivered): the recovery waits for that, and gives the text back if
            // nothing is delivered. A definite refusal gives it back now, unless another attempt is still pending.
            if (recovery) {
                if (isClientIdConflict(rawMessage)) {
                    // Already accepted (smarty-code#962): the message went, so there is nothing to say.
                    if (!recovery.conflict()) toast.info(t('chat.send.stillPending'));
                    return;
                }
                recovery.refused();
            }
            if (retainNativeDraft) {
                // The started session's first message was not admitted: its text stays, and the composer says why.
                toast.error(nativeCreation.describeError(nativeCreation.noteRefusal(error)));
                return;
            }
            restoreConsumedDrafts();
            if (!recovery) restoreComposerText();

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                }
                return;
            }

            if (isSoftNetworkError) {
                // smarty-code#827: a message to a Pi session is still in the composer; say why it has not gone.
                if (watchUnconfirmed) toast.error(rawMessage || t('chat.send.stillPending'));
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            if (normalized.includes('runtime changed')) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                }
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
            }
            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            composerRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = submitComposer;
    composerSessionIdRef.current = currentSessionId;
    handleQueueMessageRef.current = handleQueueMessage;

    // Primary action for send/queue button — respects selected follow-up behavior
    // A missed idle event can leave the session shown working, so Send would queue or steer into a turn that is
    // not running. Ask the server first: a session idle there gets a plain send (F11). A failed read keeps the
    // chosen follow-up. An auto-review run is local state and needs no check.
    // The read is an async gap, and the composer stays mounted across session selections. So the session and the
    // draft (text and files) are captured before it, and afterwards the send or queue goes ahead only if both are
    // unchanged: the latest composer then holds exactly the captured draft for the captured session. Otherwise nothing
    // is sent or queued, and a plain notice says so; each session keeps its own draft.
    const followUpUnlessIdle = React.useCallback(async (followUp: () => void) => {
        const directory = currentSessionDirectoryForSync ?? currentDirectory;
        if (autoReviewRunning || !currentSessionId || !directory) { followUp(); return; }
        if (followUpPreflight.current) return;
        // What the person sees, compared by value: the session the composer shows and the store's selection, the
        // runtime, the exact text, and each attached file's identity and content. A view refresh republishes equal
        // objects without changing any of these, so it never cancels; a session switch, an edit or a changed
        // attachment does (smarty-dev#777 gap 5).
        const identity = () => [composerSessionIdRef.current ?? '', useSessionUIStore.getState().currentSessionId ?? '',
            getRuntimeKey(), composerRef.current?.getValue() ?? messageRef.current,
            JSON.stringify(useInputStore.getState().attachedFiles.map((file) => [file.id, file.filename, file.mimeType,
                file.size, file.source, file.serverPath ?? '', file.vscodePath ?? '', file.dataUrl]))] as const;
        const before = identity();
        followUpPreflight.current = true;
        let idle: boolean;
        try { idle = await reconcileSessionIdleBeforeSend(directory, currentSessionId); }
        finally { followUpPreflight.current = false; }
        const after = identity();
        if (before.some((value, index) => value !== after[index])) {
            toast.error(t('chat.followUp.changedDuringCheck'));
            return;
        }
        if (idle) { void handleSubmitRef.current(); return; }
        followUp();
    }, [autoReviewRunning, currentDirectory, currentSessionDirectoryForSync, currentSessionId, t]);

    const handlePrimaryAction = React.useCallback(() => {
        if (followUpPreflight.current) return;
        if (!isBtwActive && isOrdinarySession(currentSessionId)) { void handleSubmitRef.current(); return; }
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            void followUpUnlessIdle(() => { void handleQueueMessageRef.current(); });
        } else if (followUpBehavior === 'steer' && canQueue) {
            void followUpUnlessIdle(() => { void handleSubmitRef.current({ delivery: 'steer' }); });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, isBtwActive, followUpUnlessIdle, isOrdinarySession]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        const draft = (composerRef.current?.getValue() ?? messageRef.current).trim();
        // OpenCode recognizes slash commands only when their arguments follow
        // the command on the same line. Skills retain the multiline prompt form.
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, []);

    const { markDictationStart, keepTranscriptForOrigin } = useDictationOrigin({
        identityRef: currentChatDraftIdentityRef,
        restoreDraft,
        onKeptForOrigin: () => {
            toast.info(t('chat.chatInput.toast.dictationKeptForOriginalSession'));
        },
    });

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads composerRef.current.getValue() first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    // A transcript belongs to the draft that was on screen when recording
    // started. After a session switch it is kept for that draft and must not
    // be inserted or sent here.
    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        setMessage((prev) => {
            // The editor is controlled by this state; getCurrentInputSnapshot
            // reads it back, so no imperative write is needed.
            return appendInlineText(prev, text);
        });
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [keepTranscriptForOrigin]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        // Same as preset chips: the composed text goes into the submit as an
        // explicit override instead of being staged in the textarea, which may
        // not be mounted (collapsed mobile pill).
        const next = appendInlineText(composerRef.current?.getValue() ?? messageRef.current, text);
        void handleSubmitRef.current({ presetText: next });
    }, [keepTranscriptForOrigin]);

    // A command with an argument sends once the isolated composer owns its draft.
    React.useEffect(() => {
        const pending = immediateBtwSubmitRef.current;
        if (!pending || !isBtwActive || !chatDraftIdentity) return;
        if (getChatDraftIdentityKey(pending.identity) !== getChatDraftIdentityKey(chatDraftIdentity)) {
            immediateBtwSubmitRef.current = null;
            return;
        }
        immediateBtwSubmitRef.current = null;
        void handleSubmitRef.current({ presetText: pending.text });
    });

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [pendingPresetSubmit, submitPresetPrompt]);

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        // Enter shell mode before CodeMirror inserts the trigger. Keeping the
        // document unchanged also keeps the caret at the start for the first
        // command character.
        if (!isBtwActive && inputMode === 'normal' && e.key === '!') {
            const selection = composerRef.current?.getSelection();
            if (selection?.start === 0 && selection.end === 0) {
                e.preventDefault();
                setInputMode('shell');
                closeAutocomplete();
                return;
            }
        }

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        const autocomplete = openAutocomplete === 'command' ? commandRef.current
            : openAutocomplete === 'skill' ? skillRef.current
                : openAutocomplete === 'snippet' ? snippetRef.current
                    : openAutocomplete === 'mention' ? mentionRef.current
                        : null;
        const autocompleteKey = getDropdownNavigationKey(e) ?? e.key;
        if (autocomplete && (autocompleteKey === 'Enter' || autocompleteKey === 'ArrowUp' || autocompleteKey === 'ArrowDown' || autocompleteKey === 'Escape' || autocompleteKey === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            autocomplete.handleKeyDown(autocompleteKey);
            return;
        }

        if (isBtwActive && currentSessionId && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            handleExitBtw();
            return;
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';
        const cycleAgentDirection = cycleAgentBackwardShortcut && eventMatchesShortcut(e, cycleAgentBackwardShortcut)
            ? -1
            : eventMatchesShortcut(e, cycleAgentShortcut)
                ? 1
                : 0;

        if (!isBtwActive && cycleAgentDirection !== 0 && openAutocomplete === null) {
            e.preventDefault();
            e.stopPropagation();
            handleCycleAgent(cycleAgentDirection);
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;

            if (ta && selStart >= 0) {
                const edit = getMarkdownAutoPairEdit(message, e.key, selStart, selEnd);
                if (edit) {
                    e.preventDefault();
                    ta.replaceRange(
                        edit.from,
                        edit.to,
                        edit.insert,
                        edit.selectionStart,
                        edit.selectionEnd,
                    );
                    return;
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
            e.preventDefault();
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                requestAnimationFrame(() => composerRef.current?.setSelection(recalled.text.length, recalled.text.length));
            }
            return;
        }

        // Preserve each surface's existing default until the user changes the
        // setting. Once configured, the choice applies consistently everywhere.
        const isCtrlEnter = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && shouldSubmitEnter({
            isMobile,
            isDesktopExpanded,
            enterToSend,
            enterToSendConfigured,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
        })) {
            e.preventDefault();
            if (followUpPreflight.current) return; // A Send is already checking the session; one at a time.
            if (!isBtwActive && isOrdinarySession(currentSessionId)) { void submitComposer(); return; } // The server steers it (G5).

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = !isBtwActive && inputMode === 'normal' && hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    void submitComposer();
                } else {
                    void followUpUnlessIdle(() => { void handleQueueMessageRef.current(); });
                }
            } else {
                // steer: Enter steers into the running turn, Ctrl+Enter sends now.
                if (isCtrlEnter || !canQueue) {
                    void submitComposer();
                } else {
                    void followUpUnlessIdle(() => { void handleSubmitRef.current({ delivery: 'steer' }); });
                }
            }
        }
    };

    // Focus mode places the open picker at the caret; elsewhere each picker
    // anchors to the composer itself.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        enabled: isDesktopExpanded,
        openAutocomplete,
        message,
        editorRef: composerRef,
        containerRef: dropZoneRef,
    });


    const handleAbort = React.useCallback(() => {
        void abortCurrentOperation().then((accepted) => {
            if (accepted) clearAbortPrompt();
            else toast.error(t('errorBoundary.title'));
        });
    }, [abortCurrentOperation, clearAbortPrompt, t]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction);
        if (!nextAgentName) return;

        setAgent(nextAgentName);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgentName);
        }
    }, [agents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    // Height the dictation transcript needs (null when idle). Its overlay sits
    // absolutely over the composer, so the composer must be able to grow for
    // it. The editor sizes itself to its own content; this is the one external
    // constraint, applied as a floor on the editor's container.
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            mentionsEnabled: !isBtwActive,
            inputSource,
            insertedText,
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [inputMode, isBtwActive]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // No mounted editor (collapsed mobile pill): append to the state
            // the editor will be seeded from.
            const nextValue = messageRef.current + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            return;
        }

        const { start, end } = editor.getSelection();
        // Read the live document — delayed toast actions must not use a
        // paste-time React `message` closure.
        const currentMessage = editor.getValue();
        const nextValue = `${currentMessage.substring(0, start)}${text}${currentMessage.substring(end)}`;
        const cursorPosition = start + text.length;

        // One dispatch places both the text and the caret, so there is no
        // frame where the caret sits at a stale offset.
        editor.insertText(text);
        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [updateAutocompleteState]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, []);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, []);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, []);

    const handleComposerChange = ({ value, selection, fromPaste, insertedText }: ComposerChange) => {
        if (!currentSessionId && newSessionDraftOpen && value !== messageRef.current) {
            markDraftInputEdited(newSessionDraft.draftId);
        }
        if (shellTriggerNormalizationRef.current) {
            shellTriggerNormalizationRef.current = false;
            setMessage(value);
            return;
        }

        // VS Code drops the dragged path as text as well as firing the drop
        // handler; swallow that duplicate insertion.
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            if (candidateAbsolutePaths.some((path) => path.length > 0 && value.includes(path))) {
                clearDropTextSuppression();
                return;
            }
        }

        const pastedInsertedText = fromPaste ? insertedText : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput ? 'paste' : 'manual';

        // A leading `!` switches the composer into shell mode and is consumed.
        // Mobile keyboards and paste may update the document without a usable
        // keydown, so consume the trigger in the same editor transaction rather
        // than moving the caret in a later frame against stale text.
        if (!isBtwActive && inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            closeAutocomplete();
            const editor = composerRef.current;
            if (editor) {
                shellTriggerNormalizationRef.current = true;
                editor.replaceRange(0, 1, '', nextCursor);
            } else {
                setMessage(shellCommand);
            }
            return;
        }

        setMessage(value);
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    /**
     * Attach files that arrived by paste or drop and cite each one in the
     * draft as `[name]`, the same way pasted images are cited. Images get a
     * generated unique name up front; other files keep their own name and are
     * cited only once they attached, so a rejected file leaves no dangling
     * citation.
     */
    const attachFilesWithCitation = React.useCallback(async (
        files: File[],
        leadingText: string = '',
    ): Promise<void> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            if (filenames.length === 0 && !text) return;
            const citationText = buildAttachmentCitationText(filenames);
            const editor = composerRef.current;
            const currentMessage = editor?.getValue() ?? messageRef.current;
            const selectionStart = editor?.getSelection().start ?? currentMessage.length;
            const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
            const insertionText = withInlineInsertionBoundaries(
                buildImagePasteInsertion(text, citationText),
                currentMessage.slice(0, selectionStart),
                currentMessage.slice(selectionEnd),
            );
            insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
        };

        const assignedImageNames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...useInputStore.getState().attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        insertCitation(assignedImageNames, leadingText);

        let attached = false;
        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            pendingPastedAttachmentFilenamesRef.current.add(filename);
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }

        const attachedOtherNames: string[] = [];
        for (const file of otherFiles) {
            try {
                if (await addAttachedFile(file)) {
                    attached = true;
                    attachedOtherNames.push(file.name);
                }
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        insertCitation(attachedOtherNames, '');

        if (files.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, insertTextAtSelection, t]);

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (shouldWrapSelectionAsLink(url, selected)) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    composerRef.current?.setSelection(caret, caret);
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    return;
                }
            }
        }

        // Images get a citation and a generated name; every other clipboard
        // file (Finder/Explorer copy, a saved document) attaches as picked.
        const imageMap = new Map<string, File>();
        const otherFileMap = new Map<string, File>();
        const collectClipboardFile = (file: File) => {
            const target = file.type.startsWith('image/') ? imageMap : otherFileMap;
            target.set(`${file.name}-${file.size}`, file);
        };

        Array.from(e.clipboardData.files || []).forEach(collectClipboardFile);

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind !== 'file') return;
            const file = item.getAsFile();
            if (file) collectClipboardFile(file);
        });

        const imageFiles = Array.from(imageMap.values());
        const otherFiles = Array.from(otherFileMap.values());
        const pastedText = e.clipboardData.getData('text');
        const sessionReady = Boolean(currentSessionId || newSessionDraftOpen);

        if (imageFiles.length === 0 && otherFiles.length > 0) {
            // A copied file also carries its name as text; keep it out of the draft.
            e.preventDefault();
            if (!sessionReady) return;
            await attachFilesWithCitation(otherFiles);
            return;
        }

        if (imageFiles.length === 0) {
            const behavior: LargeTextPasteBehavior = largeTextPasteBehavior;
            const shouldOfferLargePaste = sessionReady
                && inputMode === 'normal'
                && behavior !== 'inline'
                && isLargePlainTextPaste(pastedText);

            if (!shouldOfferLargePaste) {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                return;
            }

            // Must run synchronously — ComposerEditor does not consume paste.
            e.preventDefault();

            const pasteInline = () => {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                insertTextAtSelection(
                    pastedText,
                    getFileMentionInputSourceForInsertedText(pastedText),
                );
            };

            const attachAsFile = async () => {
                // Read live attachment + composer state at action time — the ask
                // toast can outlive the paste while the user types or attaches more.
                const liveAttachedFiles = useInputStore.getState().attachedFiles;
                const filename = nextPastedContextFilename([
                    ...liveAttachedFiles.map((file) => file.filename),
                    ...pendingPastedAttachmentFilenamesRef.current,
                ]);
                const citationText = buildAttachmentCitationText([filename]);
                const editor = composerRef.current;
                const currentMessage = editor?.getValue() ?? messageRef.current;
                const selectionStart = editor?.getSelection().start ?? currentMessage.length;
                const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
                const insertionText = withInlineInsertionBoundaries(
                    citationText,
                    currentMessage.slice(0, selectionStart),
                    currentMessage.slice(selectionEnd),
                );

                insertTextAtSelection(
                    insertionText,
                    getFileMentionInputSourceForInsertedText(insertionText),
                );

                const file = createPastedContextFile(pastedText, filename);
                pendingPastedAttachmentFilenamesRef.current.add(filename);
                try {
                    await addAttachedFile(file);
                } catch (error) {
                    console.error('Clipboard text attach failed', error);
                    toast.error(
                        error instanceof Error
                            ? error.message
                            : t('chat.chatInput.toast.clipboardTextAttachFailed'),
                    );
                } finally {
                    pendingPastedAttachmentFilenamesRef.current.delete(filename);
                }
            };

            if (behavior === 'attach') {
                await attachAsFile();
                return;
            }

            const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
            largeTextPasteOfferIdRef.current = offerId;

            if (largeTextPasteToastIdRef.current !== null) {
                // Invalidate first so a synchronous onDismiss from dismiss()
                // cannot apply the superseded paste.
                toast.dismiss(largeTextPasteToastIdRef.current);
                largeTextPasteToastIdRef.current = null;
            }

            const resolveLargePaste = (action: 'attach' | 'inline') => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                largeTextPasteToastIdRef.current = null;
                if (action === 'attach') {
                    void attachAsFile();
                    return;
                }
                pasteInline();
            };

            largeTextPasteToastIdRef.current = toast.info(
                t('chat.chatInput.toast.largeTextPaste.title'),
                {
                    duration: Infinity,
                    className: LARGE_TEXT_PASTE_TOAST_CLASSNAME,
                    action: {
                        label: t('chat.chatInput.toast.largeTextPaste.attach'),
                        onClick: () => resolveLargePaste('attach'),
                    },
                    cancel: {
                        label: t('chat.chatInput.toast.largeTextPaste.inline'),
                        onClick: () => resolveLargePaste('inline'),
                    },
                    onDismiss: () => {
                        // Dismissing without a choice keeps the paste — insert inline
                        // so clipboard content is not lost.
                        resolveLargePaste('inline');
                    },
                },
            );
            return;
        }

        if (!sessionReady) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();
        await attachFilesWithCitation([...imageFiles, ...otherFiles], pastedText);
    }, [addAttachedFile, attachFilesWithCitation, currentSessionId, inputMode, largeTextPasteBehavior, markFileMentionPasteSuppression, message, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = composerRef.current?.getSelection().start || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');

        if (lastSlashSymbol !== -1) {
            const newMessage =
                message.substring(0, lastSlashSymbol) +
                `/${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastSlashSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSnippetSelect = (_snippet: unknown, trigger: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (composerRef.current) {
                composerRef.current.setSelection(nextCursor);
            }
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    };

    const handleCommandSelect = (command: CommandInfo) => {
        if (command.name === 'btw' && currentSessionId) {
            closeAutocomplete();
            void handleSubmitRef.current({ presetText: '/btw' });
            return;
        }
        setMessage(`/${command.name} `);

        closeAutocomplete();

        const refocus = () => {
            if (composerRef.current) {
                try {
                    composerRef.current.focus({ preventScroll: true });
                } catch {
                    composerRef.current.focus();
                }
                composerRef.current.setSelection(composerRef.current.getValue().length, composerRef.current.getValue().length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {
        if (!active || !currentSessionId || isMobile) return;
        // Focusing forces layout. Right after a session switch the layout is
        // dirty from the whole timeline mounting, so the focus call would pay
        // for that layout inside the commit; a frame later it is nearly free.
        const frame = window.requestAnimationFrame(() => {
            composerRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    React.useEffect(() => {
        if (abortPromptSessionId && abortPromptSessionId !== currentSessionId) {
            clearAbortPrompt();
        }
    }, [abortPromptSessionId, currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0);

        for (const p of paths) {
            confirmedMentionsRef.current.add(p);
        }

        const mentions = Array.from(new Set(paths.map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline');
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [setPendingInputText, t, toMentionPath]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmedMentionsRef.current.add(internalPath);
            const mention = `@${internalPath}`;
            const textarea = composerRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const { start: pos, end } = textarea.getSelection();
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                // Insert through the editor rather than setMessage: an editor
                // dispatch places the caret right after the mention, while the
                // external-rewrite path would send it to the end of the
                // message and pin the scroll to the bottom.
                textarea.replaceRange(pos, end, insert);
                cursorPosRef.current = pos + insert.length;
                textarea.focus();
            } else {
                setMessage((prev) => appendInlineText(prev, mention));
            }
            clearDropTextSuppression();
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length === 0 && isVSCodeRuntime()) {
            const droppedUris = collectDroppedFileUris(e.dataTransfer);
            if (droppedUris.length > 0) {
                pendingDroppedAbsolutePathsRef.current = droppedUris
                    .map((entry) => normalizeDroppedPath(entry))
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                addVSCodeDroppedUrisAsMentions(droppedUris);
            } else {
                clearDropTextSuppression();
            }
            return;
        }

        if (files.length > 0) {
            await attachFilesWithCitation(files);
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const list = Array.isArray(files) ? files : Array.from(files);
        let attached = false;

        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        if (list.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.({ extensions: ACCEPTED_ATTACHMENT_EXTENSIONS })) as {
                files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
                skipped?: Array<{ name?: string; reason?: string }>;
            } | undefined;
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, t, vscodeApi]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const guestAttachItems = useGuestAttachItems();
    const openGuestAttach = React.useCallback((guestId: string) => {
        const item = guestAttachItems.find((guest) => guest.id === guestId);
        if (item?.mode === 'dialog') {
            setAttachDialogItem(null);
            setAttachDialogGuestId(guestId);
            return;
        }
        useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(guestId));
    }, [currentDirectory, guestAttachItems]);
    // Clicking the guest chip reopens that guest with the chip as `ready.item`,
    // so it can show the item's details instead of its whole list. A panel
    // guest gets it through the rail hand-off store; a dialog guest as a prop.
    const reopenGuestItem = React.useCallback(() => {
        if (!linkedGuestIssue) return;
        const issue: AttachIssueRequest = {
            providerId: linkedGuestIssue.providerId,
            id: linkedGuestIssue.id,
            title: linkedGuestIssue.title,
            url: linkedGuestIssue.url,
            text: linkedGuestIssue.contextText,
            kind: linkedGuestIssue.thread ?? 'issue',
        };
        if (linkedGuestIssue.author) issue.author = linkedGuestIssue.author;
        if (linkedGuestIssue.head && linkedGuestIssue.base) {
            issue.branches = { head: linkedGuestIssue.head, base: linkedGuestIssue.base };
        }
        if (linkedGuestIssue.data !== undefined) issue.data = linkedGuestIssue.data;
        // A chip can outlive the place it was attached in: the session may be
        // open on mobile or VS Code, where extensions never load, or the
        // extension may be paused or removed here. Say so instead of opening
        // an empty surface.
        const installed = useGuestsStore.getState().guests.find((entry) => entry.id === issue.providerId);
        if (!installed || !isGuestActive(installed)) {
            toast.info(t('chat.chatInput.toast.guestUnavailableHere'));
            return;
        }
        if (!installed.entry) {
            toast.info(t('chat.chatInput.toast.guestHasNoPanel'));
            return;
        }
        const guest = guestAttachItems.find((entry) => entry.id === issue.providerId);
        // Only an extension that declared a dialog gets one; everything else
        // (panel mode, no attach declared) opens the rail with the item.
        if (guest?.mode !== 'dialog') {
            useGuestItemStore.getState().setPendingItem(issue.providerId, issue);
            useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(issue.providerId));
            return;
        }
        setAttachDialogItem(issue);
        setAttachDialogGuestId(issue.providerId);
    }, [currentDirectory, guestAttachItems, linkedGuestIssue, t]);
    const handleGuestAttach = React.useCallback((issue: AttachIssueRequest) => {
        const contextText = issue.text
            ?? `Attached ${issue.providerId} ${issue.id}: ${issue.title}\n${issue.url}`;
        setLinkedGuestIssue({
            providerId: issue.providerId,
            id: issue.id,
            title: issue.title,
            url: issue.url,
            contextText,
            thread: issue.kind === 'pull' ? 'pull' : 'issue',
            author: issue.author,
            head: issue.branches?.head,
            base: issue.branches?.base,
            data: issue.data,
        });
        setLinkedIssue(null);
        setLinkedPr(null);
        setLinkedLinearIssue(null);
        setAttachDialogGuestId(null);
        setAttachDialogItem(null);
        // A message or session action may have opened the guest in the
        // layout-level dialog; attaching from there closes it the same way.
        useGuestDialogStore.getState().close();
    }, []);
    React.useEffect(() => {
        if (!pendingGuestIssue) {
            return;
        }
        const issue = consumePendingGuestIssue();
        if (issue) {
            handleGuestAttach(issue);
        }
    }, [consumePendingGuestIssue, handleGuestAttach, pendingGuestIssue]);
    const showLinearPicker = Boolean(runtimeLinear) && !isVSCode;
    // The work-status panel carries the agent's todos, but only on the
    // desktop/web layout — VS Code and mobile have no panel, so the todos keep
    // their place above the composer there.
    const composerStatusExtrasEnabled = isVSCode || isMobile;
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    // Which project and directory a new session will target.
    const {
        projects: draftProjects,
        selectedDraftProject,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
    } = useDraftTarget(showDraftTargetSelectors);

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const showDesktopDraftPresentation = (newSessionDraftOpen || draftPresentationExiting)
        && !isDesktopExpanded
        && !isMobile
        && !isVSCode
        && !isMiniChatSurface;
    const draftPresentationClassName = cn(
        'transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
        draftPresentationExiting && 'pointer-events-none opacity-0',
    );

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || selectedDraftProject.kind === 'chat' || !selectedDraftDirectory) {
            return;
        }
        if (newSessionDraft?.pendingWorktreeRequestId || newSessionDraft?.bootstrapPendingDirectory || newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        // The root is already the fallback, even before its branch metadata loads.
        // Re-selecting it is not user intent and would cancel pending route restoration.
        const alreadyAtRoot = newSessionDraft?.selectedProjectId === selectedDraftProject.id
            && normalizePath(newSessionDraft.directoryOverride) === normalizePath(selectedDraftProject.path);
        if (valid || alreadyAtRoot) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, newSessionDraft?.selectedProjectId, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);


    // Mobile pill composer: the collapse/expand state machine and the
    // platform corrections that keep it from fighting the soft keyboard.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // The pill exists to buy screen back from the soft keyboard. A tablet
        // has the room regardless, and with a hardware keyboard there is no
        // soft keyboard to buy it back from — keep the real composer up.
        alwaysExpanded: hasHardwareKeyboard || isTabletLayout,
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            issuePickerOpen,
            prPickerOpen,
            linearPickerOpen,
            isDragging,
        },
    });
    const mobileComposerExpanded = mobileShell.expanded;
    const mobileTextareaFocused = mobileShell.focused;


    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        } else {
            requestAnimationFrame(() => composerRef.current?.focus());
        }
    }, [isMobile, mobileComposerExpanded, mobileShell]);

    // Linked references render as chips beside the attached files, inside the
    // composer box and inside the mobile pill.
    const hasLinkedReferences = !isVSCode && Boolean(linkedIssue || linkedPr || linkedLinearIssue || linkedGuestIssue);
    const linkedReferenceChips = hasLinkedReferences ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
            {linkedIssue && !isVSCode ? (
                <LinkedReferenceRow
                    numberLabel={`#${linkedIssue.number}`}
                    title={linkedIssue.title}
                    url={linkedIssue.url}
                    author={linkedIssue.author}
                    openInBrowserLabel={t('chat.chatInput.linked.issue.openInBrowserAria')}
                    removeLabel={t('chat.chatInput.linked.issue.removeAria')}
                    onReopenPicker={() => setIssuePickerOpen(true)}
                    onRemove={() => setLinkedIssue(null)}
                />
            ) : null}
            {linkedPr && !isVSCode ? (
                <LinkedReferenceRow
                    numberLabel={t('chat.chatInput.linked.pr.number', { number: linkedPr.number })}
                    title={linkedPr.title}
                    url={linkedPr.url}
                    author={linkedPr.author}
                    branches={linkedPr.head && linkedPr.base ? { head: linkedPr.head, base: linkedPr.base } : undefined}
                    openInBrowserLabel={t('chat.chatInput.linked.pr.openInBrowserAria')}
                    removeLabel={t('chat.chatInput.linked.pr.removeAria')}
                    onReopenPicker={() => setPrPickerOpen(true)}
                    onRemove={() => setLinkedPr(null)}
                />
            ) : null}
            {linkedLinearIssue && !isVSCode ? (
                <LinkedReferenceRow
                    numberLabel={linkedLinearIssue.identifier}
                    title={linkedLinearIssue.title}
                    url={linkedLinearIssue.url}
                    author={linkedLinearIssue.author}
                    openInBrowserLabel={t('chat.chatInput.linked.linearIssue.openInBrowserAria')}
                    removeLabel={t('chat.chatInput.linked.linearIssue.removeAria')}
                    onReopenPicker={() => setLinearPickerOpen(true)}
                    onRemove={() => setLinkedLinearIssue(null)}
                />
            ) : null}
            {linkedGuestIssue && !isVSCode ? (
                <LinkedReferenceRow
                    numberLabel={linkedGuestIssue.thread === 'pull'
                        ? t('chat.chatInput.linked.guest.pr.number', { id: linkedGuestIssue.id })
                        : linkedGuestIssue.id}
                    title={linkedGuestIssue.title}
                    url={linkedGuestIssue.url}
                    author={linkedGuestIssue.author ? { login: linkedGuestIssue.author } : undefined}
                    branches={linkedGuestIssue.thread === 'pull' && linkedGuestIssue.head && linkedGuestIssue.base
                        ? { head: linkedGuestIssue.head, base: linkedGuestIssue.base }
                        : undefined}
                    openInBrowserLabel={t('chat.chatInput.linked.guest.openInBrowserAria', { id: linkedGuestIssue.id })}
                    removeLabel={t('chat.chatInput.linked.guest.removeAria', { id: linkedGuestIssue.id })}
                    onReopenPicker={reopenGuestItem}
                    onRemove={() => setLinkedGuestIssue(null)}
                />
            ) : null}
        </div>
    ) : null;
    // The suggested follow-up is the composer's own top row on every surface
    // (inside the mobile pill and the box alike); on mobile the model and
    // agent are its bottom row too, so the surface stays one shape.
    const suggestionHidden = hasContent || newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasQueuedMessages;
    const suggestionRow = !isBtwActive ? (
        <SessionSuggestionChip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            hidden={suggestionHidden}
            onApply={applyAssistSuggestion}
        />
    ) : null;
    const mobileModelAgentRow = isMobile && !isBtwActive ? (
        // px-3.5 lines the model logo and the agent label up with the attach
        // and mic icons above them; the buttons drop their own padding so the
        // row alone owns the inset.
        <div className="flex items-center justify-between gap-x-2 px-3.5 pb-2 pt-0.5">
            <MemoMobileModelButton onOpenModel={() => handleOpenMobilePanel('model')} className="min-w-0 px-0" />
            <MemoMobileAgentButton
                onOpenAgentPanel={handleOpenAgentPanel}
                onCycleAgent={handleCycleAgent}
                className="flex-shrink-0 px-0"
            />
        </div>
    ) : null;

    /** The dictation engine listens for this globally; the composer only asks. */
    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
    }, []);

    const openMobileAttachSheet = React.useCallback(() => {
        // Same order as handleOpenMobilePanel: mark the sheet open BEFORE the
        // blur so the collapse watcher sees an overlay when the keyboard-close
        // lands. The trigger button blocks the tap's own focus transfer, so
        // the keyboard must be dismissed explicitly here.
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, []);


    // Reset the picker search whenever a draft picker sheet opens/closes.
    React.useEffect(() => {
        setMobileDraftPickerQuery('');
    }, [mobileDraftPicker]);

    // Mobile browsers pan the visual viewport instead of resizing the layout,
    // so the composer form is pinned to it explicitly.
    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    const permissionScopeSessionId = isBtwActive ? btwSessionId : currentSessionId ?? currentManagementSessionId;
    const permissionAutoAcceptEnabled = false;
    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen || isBtwActive);

    // The button and shortcut share this refusal, including unsent BTW/drafts.
    // Do not turn a local pending flag into an opt-in for the disabled feature.
    const handlePermissionAutoAcceptToggle = React.useCallback(() => {
        toast.error(t('common.unavailable'));
    }, [t]);

    useKeybind('toggle_permission_auto_accept', () => {
        if (!isPermissionAutoAcceptInteractive) return false;
        handlePermissionAutoAcceptToggle();
    });

    // Acknowledging the abort record is what lets the working chip resume for
    // the next run; the old "Aborted" banner that used to accompany it is gone.
    React.useEffect(() => {
        const pendingAbort = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbort && currentSessionId) {
            acknowledgeSessionAbort(currentSessionId);
        }
        prevWasAbortedRef.current = pendingAbort;
    }, [abortPromptSessionId, acknowledgeSessionAbort, currentSessionId]);

    return (
        <>
        <form
            ref={composerFormRef}
            data-btw-composer={isBtwActive ? 'true' : undefined}
            onKeyDownCapture={(event) => {
                if (!isBtwActive || event.key !== 'Escape' || isIMECompositionEvent(event) || hasOpenDropdown()) return;
                if (!(event.target instanceof Element) || !event.target.closest('[data-chat-input-footer]')) return;
                // Footer tooltips must not consume the only exit key for a pending BTW.
                event.preventDefault();
                event.stopPropagation();
                handleExitBtw();
            }}
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            {showDesktopDraftPresentation ? (
                <div className={cn('chat-input-column mb-7 text-center', draftPresentationClassName)}>
                    <h1 className="text-balance text-2xl font-normal tracking-tight text-foreground md:text-3xl">
                        {renderDraftTitle(
                            draftProjectLabel
                                ? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
                                : t('chat.emptyState.draftTitle'),
                            draftProjectLabel,
                        )}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <DisplayNameChoice />
                <NativeDraftIdentity observedCapability={{ runtimeKey: activeRuntimeKey, directory: newSessionDraft.directoryOverride ?? currentDirectory ?? null, mode: nativeCreation.mode }} />
                <NativeCreationNotice native={nativeCreation} draftOpen={newSessionDraftOpen} sent={sentStart} onSend={() => { void submitComposer(); }} />
                {sessionLoadFailed ? (
                    <p role="alert" className="mb-2 text-sm text-[var(--status-error)]">
                        {t('chat.container.sessionLoadError.composer')}
                    </p>
                ) : null}
                {piReloading ? (
                    <p role="status" data-testid="pi-reloading" className="mb-2 text-sm text-muted-foreground">
                        {t('sessions.sidebar.herdr.reloading')}
                    </p>
                ) : null}
                {piDisconnected && ordinaryUnavailable ? (
                    <p role="status" data-testid="pi-disconnected" className="mb-2 text-sm text-muted-foreground">
                        {t('sessions.sidebar.herdr.disconnected')}
                    </p>
                ) : null}
                {statusUnavailable ? (
                    <p role="status" data-testid="status-unavailable" className="mb-2 text-sm text-muted-foreground">
                        {t('sessions.sidebar.session.status.unavailable')}
                    </p>
                ) : null}
                {draftEphemeralOnly ? (
                    <p role="alert" className="mb-2 text-sm text-[var(--status-warning)]">
                        {t('chat.draft.ephemeralOnly')}
                    </p>
                ) : null}
                <AttachedFilesList onShowPopup={handleShowAttachmentPreview} />
                <QueueRecoveryNotice target={messageQueueTarget} />

                <AutoReviewBanner />
                {hasDrafts ? (
                    <ComposerContextChips
                        draftTarget={inlineDraftTarget}
                        colors={currentTheme.colors}
                    />
                ) : null}

                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                <MemoComposerStatusBar showTodos={composerStatusExtrasEnabled} />
                {!isMobile && (showDraftTargetSelectors || draftPresentationExiting) && selectedDraftProject ? (
                    <div className={draftPresentationClassName}>
                        <DraftTargetSelectors
                            projects={draftProjects}
                            selectedProject={selectedDraftProject}
                            selectedDirectory={selectedDraftDirectory}
                            selectedBranchLabel={selectedDraftBranchLabel}
                            selectedBranchIsKnown={selectedDraftBranchIsKnown}
                            hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                            announceDirtyState={newSessionDraftAnnouncesDirtyState}
                            projectRootBranchOption={projectRootBranchOption}
                            worktreeBranchOptions={worktreeBranchOptions}
                            branchItems={draftBranchItems}
                            showBranchSelector={shouldShowDraftBranchSelector}
                            onProjectChange={handleDraftProjectChange}
                            onDirectoryChange={handleDraftDirectoryChange}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={setMobileDraftPicker}
                    />
                ) : null}
                <div
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
                    data-dictation-host="true"
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {isMobile && !mobileComposerExpanded && !isBtwActive ? (
                    <MobilePillComposer
                        message={message}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        hasContent={Boolean(hasContent)}
                        isVSCode={isVSCode}
                        canAbort={canAbort}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        topRow={suggestionRow}
                        attachments={(
                            <div className="px-3 pt-1">
                                <AttachedFilesList onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                                {linkedReferenceChips}
                            </div>
                        )}
                        bottomRow={mobileModelAgentRow}
                        onExpand={mobileShell.expand}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={sendsWhileWorking ? () => { void handleSubmitRef.current(); } : () => { void handleQueueMessage(); }}
                        sendWhileWorking={sendsWhileWorking}
                        sendDisabledReason={pillSendDisabledReason({ ordinaryUnavailable, newSessionDraftOpen, nativeMode: nativeCreation.mode }, t)}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                {!isBtwActive ? <SessionGoalRow
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                    className="mb-1.5"
                /> : null}
                {/* The autocomplete popups anchor to this wrapper, not to the
                    glass box: a backdrop-filter ancestor is a backdrop root,
                    so a glass popup inside the box would only blur the box's
                    own contents and read as a flat tint over the transcript. */}
                <div className={cn('relative', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={isDesktopExpanded ? autocompleteOverlayPosition : null}
                        commandRef={commandRef}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={handleAgentSelect}
                        onClose={closeAutocomplete}
                    />
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        "border border-border/80 focus-within:border-interactive-selection-foreground/35",
                        "shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]",
                        // The box floats over the transcript, so it is glass.
                        'oc-glass-composer',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    // The mobile pill morph measures and animates this box.
                    data-composer-box={isMobile ? 'true' : undefined}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly. */}
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')}>
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {suggestionRow}
                        {isMobile && isBtwActive ? (
                            <div className="scrollbar-none relative z-10 flex items-center gap-x-2 overflow-x-auto px-3 pb-0.5 pt-1.5">
                                <ModelControls
                                    className="flex-1 min-w-0"
                                    sessionId={btwComposerSessionId}
                                    selection={effectiveBtwSelection}
                                />
                            </div>
                        ) : null}
                        <div className="flex items-center gap-1 px-3 pt-1 flex-wrap relative z-10">
                            <AttachedFilesList onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                            {!isBtwActive ? linkedReferenceChips : null}
                            <AttachedVSCodeFileChips onShowPopup={handleShowAttachmentPreview} />
                            {!isBtwActive ? <ActiveEditorFileSuggestion /> : null}
                        </div>
                        <div
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            // The mobile pill morph moves this block from the
                            // pill's text line and unfurls it.
                            data-composer-morph-prompt={isMobile ? 'true' : undefined}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                            style={dictationContentHeight !== null
                                ? { minHeight: `${dictationContentHeight}px` }
                                : undefined}
                        >
                            <ComposerEditor
                                ref={composerRef}
                                viewStore={composerViewStore}
                                data-testid="chat-input"
                                value={message}
                                languageContext={languageContext}
                                onChange={handleComposerChange}
                                onKeyDown={(event) => {
                                    // Every interception branch calls
                                    // preventDefault, so the event itself
                                    // reports whether the composer consumed it.
                                    handleKeyDown(event);
                                    return event.defaultPrevented;
                                }}
                                onPaste={handlePaste}
                                onSelectionChange={(selection) => {
                                    cursorPosRef.current = selection.start;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={mobileShell.onEditorBlur}
                                placeholder={isBtwActive
                                    ? t('chat.btw.mainComposerPlaceholder')
                                    : currentSessionId || newSessionDraftOpen
                                        ? inputMode === 'shell'
                                            ? t('chat.chatInput.placeholder.shell')
                                            : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
                                        : t('chat.chatInput.placeholder.selectSession')}
                                editable={Boolean(currentSessionId || newSessionDraftOpen) && !sentLocked}
                                autoCorrect={composerAutoCorrect({ isMobile })}
                                autoCapitalize={isMobile ? 'sentences' : 'none'}
                                preserveDeferredEnterShift={!enterToSendConfigured || !isMobile}
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                maxLines={isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES}
                                boundSelector={isMobile ? '[data-composer-bound]' : undefined}
                                boundGapPx={MOBILE_COMPOSER_BOUND_GAP_PX}
                                className={cn(
                                    'min-h-[52px] px-3 relative z-10',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'pt-4 pb-2.5'
                                            : 'pt-4 pb-2',
                                    inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                )}
                            />
                        </div>
                    </div>
                    <ComposerFooter
                        isMobile={isMobile}
                        isVSCode={isVSCode}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        nativeModelControls={nativeModelControls}
                        nativeSession={nativeCreation.session}
                        messageLength={message.length}
                        radius={chatInputRadius}
                        footerPaddingClass={footerPaddingClass}
                        footerGapClass={footerGapClass}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend}
                        sendDisabledReason={pillSendDisabledReason({ ordinaryUnavailable, newSessionDraftOpen, nativeMode: nativeCreation.mode }, t)}
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        isExpandedInput={isExpandedInput}
                        permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        attachGuests={isMobile ? [] : guestAttachItems}
                        onOpenGuestAttach={openGuestAttach}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onToggleExpandedInput={handleToggleExpandedInput}
                        onTogglePermissionAutoAccept={handlePermissionAutoAcceptToggle}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={sendsWhileWorking ? () => { void handleSubmitRef.current(); } : handleQueueMessage}
                        sendWhileWorking={sendsWhileWorking}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationStart={markDictationStart}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                        isBtw={isBtwActive}
                        modelSessionId={btwComposerSessionId}
                        btwSelection={effectiveBtwSelection}
                    />
                    {mobileModelAgentRow}
                    </div>

                </div>
                </div>
                </>
                )}
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    the pill ↔ composer swap so a recording started from the pill
                    survives the morph. Its absolute overlay covers whichever
                    shape the wrapper currently has. */}
                {isMobile && !isBtwActive ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onStart={markDictationStart}
                        onActiveChange={mobileShell.onDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                    />
                ) : null}
                </div>
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside the pill conditional so an open panel survives (and
                    stays visible over) the collapsed composer. */}
                {isMobile && !isBtwActive && !nativeModelControls ? (
                    <MemoModelControls
                        className="hidden"
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {showDesktopDraftPresentation ? (
                <DraftPresetChips
                    onSubmit={(starter) => submitPresetPrompt(starter.submitText, starter.ref.type)}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            <QueuedMessageChips
                key={parentMessageQueueKey}
                target={parentMessageQueueTarget}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible}
                onEditMessage={handleQueuedMessageEdit}
                onSendMessage={handleQueuedMessageSend}
            />
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} onExit={handleExitBtw} /> : null}
        </form>

        {/* Issue Picker Dialog */}
        <GitHubIssuePickerDialog
            open={issuePickerOpen}
            onOpenChange={setIssuePickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedIssue(issue);
                setLinkedPr(null);
                setLinkedLinearIssue(null);
                setLinkedGuestIssue(null);
            }}
        />
        <GitHubPrPickerDialog
            open={prPickerOpen}
            onOpenChange={setPrPickerOpen}
            onSelect={(pr) => {
                setLinkedPr(pr);
                setLinkedIssue(null);
                setLinkedLinearIssue(null);
                setLinkedGuestIssue(null);
            }}
        />
        {attachDialogGuestId && !isMobile ? (
            <React.Suspense fallback={null}>
                <GuestAttachDialog
                    guestId={attachDialogGuestId}
                    item={attachDialogItem}
                    onOpenChange={(open) => {
                        if (!open) {
                            setAttachDialogGuestId(null);
                            setAttachDialogItem(null);
                        }
                    }}
                />
            </React.Suspense>
        ) : null}
        <LinearIssuePickerDialog
            open={linearPickerOpen}
            onOpenChange={setLinearPickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedLinearIssue(issue);
                setLinkedIssue(null);
                setLinkedPr(null);
                setLinkedGuestIssue(null);
            }}
        />
        <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        />
        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Single always-mounted picker input. It must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleLocalFileSelect}
            accept={ATTACHMENT_ACCEPT}
        />

        {/* Mobile attachment sheet: replaces the dropdown (which stole focus and
            dismissed the keyboard) and leaves room for more actions later. */}
        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={t('chat.chatInput.actions.addAttachment')}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <div className="flex flex-col px-3 pb-4 pt-1">
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // The native file/photo picker takes over next — restoring
                            // the keyboard in between would flash it open and shut.
                            mobileShell.cancelOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(handlePickLocalFiles);
                        }}
                    >
                        <Icon name="attachment-2" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.attachFiles')}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // Hand-off to the picker: don't sync-restore the
                            // keyboard under the overlay that opens next frame.
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openIssuePicker);
                        }}
                    >
                        <Icon name="github" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.linkGithubIssue')}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openPrPicker);
                        }}
                    >
                        <Icon name="git-pull-request" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.linkGithubPr')}
                    </button>
                    {showLinearPicker ? (
                        <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onClick={() => {
                                mobileShell.skipNextOverlayCloseRestore();
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(openLinearPicker);
                            }}
                        >
                            <Icon name="linear" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                            {t('chat.chatInput.actions.linkLinearIssue')}
                        </button>
                    ) : null}
                </div>
            </MobileOverlayPanel>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <MobileDraftTargetSheets
                projects={draftProjects}
                selectedProject={selectedDraftProject}
                selectedDirectory={selectedDraftDirectory}
                selectedBranchLabel={selectedDraftBranchLabel}
                selectedBranchIsKnown={selectedDraftBranchIsKnown}
                hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                            announceDirtyState={newSessionDraftAnnouncesDirtyState}
                projectRootBranchOption={projectRootBranchOption}
                worktreeBranchOptions={worktreeBranchOptions}
                branchItems={draftBranchItems}
                showBranchSelector={shouldShowDraftBranchSelector}
                onProjectChange={handleDraftProjectChange}
                onDirectoryChange={handleDraftDirectoryChange}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={setMobileDraftPicker}
                query={mobileDraftPickerQuery}
                onQueryChange={setMobileDraftPickerQuery}
            />
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);

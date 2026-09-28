import * as React from 'react';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';

import { humanAuthClient } from '@/lib/human-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

import { COEDIT_TEXT, coeditColor, parseCoeditConflict, type CoeditConflict } from './coeditData';

export type CoeditPhase = 'off' | 'connecting' | 'live' | 'offline' | 'refused';
/** The editor's binding: its first text (the room's, when it first synced) and the CodeMirror extension. */
export type CoeditBinding = { text: string; extension: Extension };
export type CoeditRoom = { phase: CoeditPhase; binding: CoeditBinding | null; conflict: CoeditConflict | null; dismissConflict: () => void };

const ROOM_PATH = '/api/coedit';

/** The server's canonical room name for this file (its pre-flight); the Files path itself while the server lacks it. */
async function roomName(directory: string, path: string): Promise<string | null> {
    const response = await runtimeFetch(getRuntimeUrlResolver().api(`${ROOM_PATH}/room`, { directory, path })).catch(() => null);
    if (response?.ok) {
        const body = await response.json().catch(() => null) as { name?: unknown } | null;
        return typeof body?.name === 'string' && body.name ? body.name : null;
    }
    if (response?.status === 403 || response?.status === 401) return null;
    // ponytail: before the server's pre-flight lands, the Files path works whenever it is already canonical.
    return path;
}

async function personName(): Promise<string> {
    const session = await humanAuthClient().getSession().catch(() => null);
    const user = session?.data?.user as { name?: string; email?: string } | undefined;
    return user?.name || user?.email || 'Someone';
}

/**
 * smartyfs#18: the Files editor's co-editing room for one project file. While `enabled`, it joins the server's
 * Hocuspocus room (auth, admission and the room name are the server's), shows everyone's cursors with the signed-in
 * person's name, keeps edits made while offline in the doc and lets Yjs merge them on reconnect, and reports the disk
 * bridge's conflicts. It never writes the file: the room saves it.
 */
export function useCoeditRoom({ directory, path, enabled }: { directory: string | null; path: string | null; enabled: boolean }): CoeditRoom {
    const [phase, setPhase] = React.useState<CoeditPhase>('off');
    const [binding, setBinding] = React.useState<CoeditBinding | null>(null);
    const [conflict, setConflict] = React.useState<CoeditConflict | null>(null);
    const dismissConflict = React.useCallback(() => setConflict(null), []);

    React.useEffect(() => {
        setBinding(null); setConflict(null);
        if (!enabled || !directory || !path) { setPhase('off'); return; }
        setPhase('connecting');
        let provider: HocuspocusProvider | null = null;
        let cancelled = false;
        const doc = new Y.Doc();
        void (async () => {
            const [name, person] = await Promise.all([roomName(directory, path), personName()]);
            if (cancelled) return;
            if (!name) { setPhase('refused'); return; }
            provider = new HocuspocusProvider({
                url: getRuntimeUrlResolver().websocket(ROOM_PATH, { directory, path }),
                name,
                document: doc,
                onStatus: ({ status }) => {
                    if (cancelled) return;
                    if (status === WebSocketStatus.Disconnected) setPhase((current) => (current === 'connecting' ? current : 'offline'));
                },
                onSynced: () => {
                    if (cancelled || !provider) return;
                    setPhase('live');
                    // The editor starts from the room's text once; after that yCollab keeps both in step, reconnects included.
                    setBinding((current) => current ?? (() => {
                        const text = doc.getText(COEDIT_TEXT);
                        const undoManager = new Y.UndoManager(text);
                        return { text: text.toString(), extension: [yCollab(text, provider!.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)] };
                    })());
                },
                onStateless: ({ payload }) => {
                    const found = parseCoeditConflict(payload);
                    if (found && !cancelled) setConflict(found);
                },
                onAuthenticationFailed: () => { if (!cancelled) setPhase('refused'); },
            });
            provider.awareness?.setLocalStateField('user', { name: person, ...coeditColor(person) });
        })();
        return () => {
            cancelled = true;
            provider?.destroy();
            doc.destroy();
        };
    }, [directory, path, enabled]);

    return { phase, binding, conflict, dismissConflict };
}

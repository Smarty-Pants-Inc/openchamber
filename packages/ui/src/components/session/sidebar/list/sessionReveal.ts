import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useSessionUIStore, type SessionRevealTicket } from '@/sync/session-ui-store';
import { isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { setPersonalSidebarView, subscribePersonalSidebarViewMutations, usePersonalSidebarView } from '@/lib/sidebar-view';
import type { SessionGroup, SessionNode } from '../types';

export type SessionRevealTarget = { projectId: string; groupKey: string };
type Receipt = SessionRevealTicket & SessionRevealTarget & { sessionId: string };
// Only the last consumed local action is needed for a newly mounted target group's page.
const useReceipt = create<{ receipt: Receipt | null }>(() => ({ receipt: null }));

/** Resolve only from admitted rows in the actual renderer projection, never an active-directory guess. */
export function findSessionRevealTarget(
  sections: readonly { project: { id: string }; groups: SessionGroup[] }[], sessionId: string,
): SessionRevealTarget | null {
  for (const section of sections) {
    const group = section.groups.find(group => !group.isArchivedBucket && group.sessions.some(node => node.session.id === sessionId));
    if (group) return { projectId: section.project.id, groupKey: `${section.project.id}:${group.id}` };
  }
  return null;
}

/** Mount in a small effect-only subscriber, not the sidebar orchestration component. */
export function useSessionReveal(
  resolve: (sessionId: string) => SessionRevealTarget | null,
  onReveal?: (target: SessionRevealTarget, sessionId: string) => void,
): void {
  const intent = useSessionUIStore(state => state.sessionRevealIntent);
  const selected = useSessionUIStore(state => state.currentSessionId);
  const { enabled, ready } = usePersonalSidebarView();
  const target = intent?.sessionId ? resolve(intent.sessionId) : null;
  useEffect(() => subscribePersonalSidebarViewMutations(patch => {
    useSessionUIStore.getState().blockSessionReveal(patch);
  }), []);
  useEffect(() => {
    if (!intent) return;
    const ui = useSessionUIStore.getState();
    if (!enabled || !isRuntimeRequestScopeCurrent(intent.scope)) { ui.consumeSessionReveal(intent.revision); return; }
    if (!ready || !intent.sessionId || selected !== intent.sessionId || !target) return;
    const cancelled = intent.collapsedProjects.has(target.projectId) || intent.collapsedGroups.has(target.groupKey);
    // Clear before our explicit preference mutation notifies manual-action subscribers.
    if (!ui.consumeSessionReveal(intent.revision) || cancelled) return;
    useReceipt.setState({ receipt: { ...intent, ...target, sessionId: intent.sessionId } });
    onReveal?.(target, intent.sessionId);
    void setPersonalSidebarView({ projects: { [target.projectId]: false }, groups: { [target.groupKey]: false } }).catch(() => undefined);
    // The preference owner reports and rolls back a failed save. No automatic replay.
  }, [enabled, intent, onReveal, ready, selected, target]);
}

export function SessionRevealEffect(props: {
  sections: readonly { project: { id: string }; groups: SessionGroup[] }[];
}) {
  useSessionReveal(id => findSessionRevealTarget(props.sections, id));
  return null;
}

/** Pagination only. Parent and folder expansion stay manual; no history request is made. */
export function useRevealSessionPagination(groupKey: string, nodes: SessionNode[], reveal: (count: number) => void): void {
  const receipt = useReceipt(state => state.receipt?.groupKey === groupKey ? state.receipt : null);
  const processed = useRef<Receipt | null>(null);
  useEffect(() => {
    if (!receipt || processed.current === receipt || !isRuntimeRequestScopeCurrent(receipt.scope)) return;
    const index = nodes.findIndex(node => node.session.id === receipt.sessionId);
    if (index < 0) return;
    processed.current = receipt;
    reveal(index + 1);
  }, [nodes, receipt, reveal]);
}

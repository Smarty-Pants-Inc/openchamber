import React from 'react';
import { useInboxStore } from '@/lib/smartyInbox';
import { isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { groupInboxSteps, type InboxStepList } from '@/lib/inboxSteps';
import { StepsRow } from './StepsRow';
import type { StepsSheetDismiss } from './useStepsSheetBack';

type Props = { children: React.ReactNode; mobile?: boolean; sheet?: StepsSheetDismiss };
type BoundaryProps = Props & { lists: InboxStepList[]; scope: RuntimeRequestScope | null };
type Snapshot = { node: HTMLElement; top: number; scroll: number; atEnd: boolean; focused: Element | null } | null;

/** Capture before DOM mutation: layout-effect cleanup is too late to measure outgoing chrome reliably. */
class StepsAnchorBoundary extends React.Component<BoundaryProps> {
  private host = React.createRef<HTMLDivElement>();
  getSnapshotBeforeUpdate(): Snapshot {
    const node = this.host.current?.querySelector<HTMLElement>('[data-scrollbar="chat"]');
    return node ? { node, top: node.getBoundingClientRect().top, scroll: node.scrollTop,
      atEnd: node.scrollHeight - node.clientHeight - node.scrollTop <= 1,
      focused: this.host.current?.contains(document.activeElement) ? document.activeElement : null } : null;
  }
  componentDidUpdate(_props: BoundaryProps, _state: never, snapshot: Snapshot) {
    if (!snapshot || !this.host.current?.contains(snapshot.node)) return;
    if (snapshot.focused && !snapshot.focused.isConnected) {
      const target = this.host.current.querySelector<HTMLElement>('[data-step-id] button') ?? snapshot.node;
      target.focus({ preventScroll: true });
    }
    const delta = snapshot.node.getBoundingClientRect().top - snapshot.top;
    if (!delta) return;
    const end = Math.max(0, snapshot.node.scrollHeight - snapshot.node.clientHeight);
    snapshot.node.scrollTop = snapshot.atEnd ? end : Math.min(end, Math.max(0, snapshot.scroll + delta));
  }
  render() {
    const scope = this.props.scope;
    const actionKey = scope ? JSON.stringify([scope.runtimeKey, scope.transportGeneration, scope.authGeneration]) : 'retired';
    return <div ref={this.host} className="flex h-full min-h-0 flex-col" data-steps-layout="true">
      <StepsRow key={actionKey} scope={scope} lists={this.props.lists} mobile={this.props.mobile} sheet={this.props.sheet} />
      <div className="min-h-0 flex-1">{this.props.children}</div>
    </div>;
  }
}

export function StepsLayout({ children, mobile, sheet }: Props) {
  const scope = useInboxStore(s => s.snapshotScope);
  useAuthSessionStore(s => s.recoveryGeneration);
  const current = scope !== null && isRuntimeRequestScopeCurrent(scope);
  const items = useInboxStore(s => s.items);
  const poisoned = useInboxStore(s => s.invalidStepGroups);
  // Inbox events only, never transcript/token updates; grouping is bounded to 99 ordinals per list.
  const lists = React.useMemo(() => current ? groupInboxSteps(items, poisoned) : [], [items, poisoned, current]);
  return <StepsAnchorBoundary lists={lists} scope={scope} mobile={mobile} sheet={sheet}>{children}</StepsAnchorBoundary>;
}

import React from 'react';
import { useInboxStore } from '@/lib/smartyInbox';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { groupInboxSteps, type InboxStepList } from '@/lib/inboxSteps';
import { StepsRow } from './StepsRow';

type Props = { children: React.ReactNode; mobile?: boolean };
type BoundaryProps = Props & { lists: InboxStepList[] };
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
    return <div ref={this.host} className="flex h-full min-h-0 flex-col" data-steps-layout="true">
      <StepsRow key={getRuntimeKey()} lists={this.props.lists} mobile={this.props.mobile} />
      <div className="min-h-0 flex-1">{this.props.children}</div>
    </div>;
  }
}

export function StepsLayout({ children, mobile }: Props) {
  const items = useInboxStore(s => s.items);
  const poisoned = useInboxStore(s => s.invalidStepGroups);
  // Inbox events only, never transcript/token updates; grouping is bounded to 99 ordinals per list.
  const lists = React.useMemo(() => groupInboxSteps(items, poisoned), [items, poisoned]);
  return <StepsAnchorBoundary lists={lists} mobile={mobile}>{children}</StepsAnchorBoundary>;
}

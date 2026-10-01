import type { InboxItem } from './smartyInbox';

export const STEP_DONE_REPORT = 'Step marked done (self-reported; not approval).';
const SOURCE = /^steps:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([0-9]{2})\/([0-9]{2})$/;

export type InboxStep = { ordinal: number; item: InboxItem };
export type InboxStepList = {
  key: string; id: string; to: string; topic: string; total: number; complete: boolean; steps: InboxStep[];
};

/** An invalid item claiming an existing list poisons that list, never an unrelated recipient/list. */
export function groupInboxSteps(items: InboxItem[], poisoned: readonly string[] = []): InboxStepList[] {
  const groups = new Map<string, InboxStepList>();
  const invalid = new Set(poisoned);
  for (const item of items) {
    if (!item.source?.startsWith('steps:v1:')) continue;
    const claimedId = item.source.split(':')[2] ?? '';
    const key = JSON.stringify([item.to, claimedId]);
    const match = SOURCE.exec(item.source);
    const ordinal = Number(match?.[2]), total = Number(match?.[3]);
    const separator = item.title.indexOf(' — ');
    const topic = separator > 0 ? item.title.slice(0, separator) : '';
    if (!match || ordinal < 1 || ordinal > total || total < 1 || !item.to || !topic
      || !item.title.slice(separator + 3) || item.actions.length !== 1 || item.actions[0] !== 'respond') {
      invalid.add(key);
      continue;
    }
    const group = groups.get(key) ?? { key, id: claimedId, to: item.to, topic, total, complete: false, steps: [] };
    if (group.total !== total || group.topic !== topic || group.steps.some(s => s.ordinal === ordinal || s.item.id === item.id)) {
      invalid.add(key);
    }
    group.steps.push({ ordinal, item });
    groups.set(key, group);
  }
  return [...groups.values()].filter(g => !invalid.has(g.key)).map(g => ({
    ...g, steps: g.steps.sort((a, b) => a.ordinal - b.ordinal), complete: g.steps.length === g.total,
  }));
}

export const selectStepList = (lists: InboxStepList[], selected: string | null) =>
  lists.find(l => l.key === selected) ?? lists[0];

/** The current resolution must belong to the recorded recipient response, not a later withdrawal/Ignore. */
export const isStepDone = (item: InboxItem): boolean => Boolean(
  item.resolved && item.answer?.text === STEP_DONE_REPORT && item.answer.by === item.to
  && item.answer.action === 'respond' && item.resolved.by === item.to
  && item.resolved.action === 'respond' && item.resolved.at === item.answer.at,
);

/** One raw recommendation is one copy target. Even LF is refused, never split or silently removed. */
export function stepCopyTarget(text: string) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return { text, safe: false };
  }
  return { text, safe: true };
}

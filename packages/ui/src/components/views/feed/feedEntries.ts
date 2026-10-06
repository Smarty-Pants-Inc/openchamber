// smarty-code#1407: the Feed reads a person's conversation with their Smarty as a chat between two people: their own
// messages and, for each assistant turn, only its final answer. Tool calls and their results, reasoning, and the text an
// assistant writes between tool calls stay in the session view.
import type { Message, Part, TextPart } from '@opencode-ai/sdk/v2';

export type FeedRecord = { info: Message; parts: Part[] };
export type FeedEntry = { id: string; role: 'user' | 'assistant'; text: string; time: number; part: TextPart };

const shownText = (part: Part): part is TextPart => part.type === 'text' && !part.synthetic && !part.ignored && part.text.trim().length > 0;

/** A user message: its own typed text (synthetic context the client added, such as pinned notes, is not hers). */
function userEntry(record: FeedRecord): FeedEntry | null {
  const parts = record.parts.filter(shownText);
  const first = parts[0];
  if (!first) return null;
  return { id: record.info.id, role: 'user', text: parts.map(part => part.text).join('\n\n'), time: record.info.time.created, part: first };
}

/**
 * A turn's answer: the last text part of the turn's last assistant message, once that message is complete and no tool
 * call follows the text. A message still running, or one whose text leads into a tool call, has no answer yet.
 */
function turnAnswer(record: FeedRecord | null): FeedEntry | null {
  if (!record || record.info.role !== 'assistant' || !record.info.time.completed) return null;
  let index = record.parts.length - 1;
  while (index >= 0 && !shownText(record.parts[index])) index -= 1;
  const part = record.parts[index];
  if (!part || part.type !== 'text' || record.parts.slice(index + 1).some(later => later.type === 'tool')) return null;
  return { id: record.info.id, role: 'assistant', text: part.text, time: record.info.time.completed, part };
}

/** The Feed's entries, in the transcript's chronological order (oldest first). */
export function feedEntries(records: readonly FeedRecord[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  let lastAssistant: FeedRecord | null = null;
  const closeTurn = () => {
    const answer = turnAnswer(lastAssistant);
    if (answer) entries.push(answer);
    lastAssistant = null;
  };
  for (const record of records) {
    if (record.info.role === 'assistant') { lastAssistant = record; continue; }
    closeTurn();
    const entry = userEntry(record);
    if (entry) entries.push(entry);
  }
  closeTurn();
  return entries;
}

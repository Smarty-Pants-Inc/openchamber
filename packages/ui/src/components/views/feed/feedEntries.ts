// smarty-code#1407: the Feed reads a person's conversation with their Smarty as a chat between two people: their own
// messages and, for each assistant turn, only its final answer. Tool calls and their results, reasoning, and the text an
// assistant writes between tool calls stay in the session view. Each entry is a message record for the chat's own
// message component (ChatMessage): the Feed filters which parts it passes, never how they render.
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { fabricMessageOf } from '@/components/chat/message/fabricMessageData';

export type FeedRecord = { info: Message; parts: Part[] };
export type FeedEntry = { id: string; role: 'user' | 'assistant'; time: number; message: FeedRecord };

const shownText = (part: Part): boolean => part.type === 'text' && !part.synthetic && !part.ignored && part.text.trim().length > 0;

/**
 * A message the person wrote (typed text or an attachment), with all its parts, as the chat shows them. A message with
 * only synthetic context the client added (such as pinned notes) is not hers, nor is an agent-to-agent Fabric message.
 */
function userEntry(record: FeedRecord): FeedEntry | null {
  if (fabricMessageOf(record.info) || !record.parts.some(part => shownText(part) || part.type === 'file')) return null;
  return { id: record.info.id, role: 'user', time: record.info.time.created, message: record };
}

/**
 * A turn's answer: the last text part of the turn's last assistant message, once that message is complete and no tool
 * call follows the text, with that message's image and file parts. A message still running, or one whose text leads
 * into a tool call, has no answer yet.
 */
function turnAnswer(record: FeedRecord | null): FeedEntry | null {
  if (!record || record.info.role !== 'assistant' || !record.info.time.completed) return null;
  let index = record.parts.length - 1;
  while (index >= 0 && !shownText(record.parts[index])) index -= 1;
  const answer = record.parts[index];
  if (!answer || record.parts.slice(index + 1).some(later => later.type === 'tool')) return null;
  const parts = record.parts.filter(part => part === answer || part.type === 'file');
  return { id: record.info.id, role: 'assistant', time: record.info.time.completed, message: { info: record.info, parts } };
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

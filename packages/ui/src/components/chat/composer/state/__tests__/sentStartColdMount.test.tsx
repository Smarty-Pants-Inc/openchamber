import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';

// #117 (Astra pre-check 4): a composer mounted cold (a load or New session) with an admitted sent mark must consume the
// delivered text from its live editor too, not only from storage: the composer's draft consumer listens by then.
const dom = nativeComposerDom();
afterAll(async () => { await dom.restore(); });
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('../useComposerDraft');
const { useSentStart } = await import('@/sync/native-draft-sent');

test('a cold-mounted composer consumes text another tab already delivered, and stays editable for new text', async () => {
  const runtimeKey = 'sent-cold-mount', directory = '/synthetic', draftId = 3, delivered = 'already delivered text';
  const identity = { runtimeKey, directory, sessionId: null, draftId };
  localStorage.setItem(`oc.nativeCreation.sent:${JSON.stringify([runtimeKey, directory])}`,
    JSON.stringify({ clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', admitted: true, text: delivered, at: Date.now() }));
  const messageRef = { current: delivered }, confirmedMentionsRef = { current: new Set<string>() };
  let shown = '', outcome: string | null = 'unset';
  function Composer() {
    const [message, setMessage] = React.useState(delivered);
    const change = (text: string) => { messageRef.current = text; setMessage(text); };
    // The same order as ChatInput: the sent-start hook before the draft hook.
    outcome = useSentStart(runtimeKey, directory, draftId, () => undefined);
    useComposerDraft({ message, messageRef, setMessage: change, confirmedMentionsRef, identity, persistEnabled: true,
      initialDraft: { text: delivered, identity } });
    shown = message;
    return null;
  }
  const root = createRoot(dom.container);
  try {
    await act(async () => { root.render(<Composer />); });
    await act(async () => { await new Promise(done => setTimeout(done, 10)); });
    expect(shown).toBe('');
    expect(outcome).toBeNull(); // Delivered: not locked.
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

// smarty-code#455: a session view holds its watch only while it is shown with a View only session.
const browser = new Window({ url: 'http://runtime.test/' });
const install = <T,>(name: string, value: T) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
install('window', browser); install('document', browser.document); install('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => { void browser.happyDOM.close(); });
const { createRoot } = await import('react-dom/client');
const { setViewOnlyWatchDeps, useViewOnlyWatch, viewOnlyWatchesHeld } = await import('./view-only-watch');

const View: React.FC<{ id: string; readOnly: boolean; shown: boolean }> = ({ id, readOnly, shown }) => {
  useViewOnlyWatch(id, '/project', readOnly, shown);
  return null;
};

test('shown -> hidden (another panel) -> shown -> not View only -> unmounted: a watch only while shown and View only', async () => {
  setViewOnlyWatchDeps({ fetch: (async () => Response.json({ healthy: true, capabilities: {} })) as never, runtime: () => 'A' });
  const root = createRoot(browser.document.createElement('div') as unknown as Element);
  const render = (props: React.ComponentProps<typeof View>) => act(() => { root.render(<View {...props} />); });
  try {
    await render({ id: 's', readOnly: true, shown: true }); expect(viewOnlyWatchesHeld()).toBe(1);
    await render({ id: 's', readOnly: true, shown: false }); expect(viewOnlyWatchesHeld()).toBe(0); // Archive shown instead.
    await render({ id: 's', readOnly: true, shown: true }); expect(viewOnlyWatchesHeld()).toBe(1);
    await render({ id: 't', readOnly: true, shown: true }); expect(viewOnlyWatchesHeld()).toBe(1); // Another session: still one.
    await render({ id: 't', readOnly: false, shown: true }); expect(viewOnlyWatchesHeld()).toBe(0); // Not View only.
    await render({ id: 't', readOnly: true, shown: true }); expect(viewOnlyWatchesHeld()).toBe(1);
    // A phone opens full-screen Settings over the chat (ChatContainer: shown = messagesEnabled && !covered), then returns.
    await render({ id: 't', readOnly: true, shown: false }); expect(viewOnlyWatchesHeld()).toBe(0);
    await render({ id: 't', readOnly: true, shown: true }); expect(viewOnlyWatchesHeld()).toBe(1);
    await act(() => { root.unmount(); }); expect(viewOnlyWatchesHeld()).toBe(0);
  } finally { setViewOnlyWatchDeps(); }
});

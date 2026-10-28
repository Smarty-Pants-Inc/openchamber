import React, { act } from 'react';
import { afterAll, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Part } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';

import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { createWebAPIs } from '../../../../../../web/src/api';
import { loadMarkdownRendererModule } from '../../markdownRendererLoader';
import ReasoningPart, { ReasoningTimelineBlock } from './ReasoningPart';
import type { StreamPhase } from '../types';

// Bun does not perform Vite's worker-URL transform. Prose needs no worker.
await plugin({ name: 'reasoning-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
    contents: "export default 'data:text/javascript,'", loader: 'js',
  }));
} });

const apis = createWebAPIs({ urls: getRuntimeUrlResolver() });
const sdk = createOpencodeClient({
  baseUrl: 'http://reasoning.test',
  fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});
const Providers = ({ children }: { children: React.ReactNode }) => (
  <RuntimeAPIProvider apis={apis}>
    <SyncProvider sdk={sdk} directory="/fixture">{children}</SyncProvider>
  </RuntimeAPIProvider>
);
const renderToStaticMarkup = (node: React.ReactNode) => renderMarkup(<Providers>{node}</Providers>);

type ReasoningPartFixture = Extract<Part, { type: 'reasoning' }>;

/**
 * Mounts a real client root against a happy-dom document so mount/unmount
 * lifecycle is observable. bun test shares globalThis across a file, so the
 * globals React DOM reads are defined here and restored afterwards; defining
 * them directly avoids asserting that happy-dom's objects are the platform
 * `Window`/`Document`.
 */
const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'customElements',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'SVGElement',
  'Document',
  'Text',
  'NodeFilter',
  'MutationObserver',
  'ResizeObserver',
  'DOMParser',
  'XMLSerializer',
  'HTMLAnchorElement',
  'HTMLButtonElement',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDomStub = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  happyWindow.document.write('<!doctype html><html><head></head><body></body></html>');
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    Document: happyWindow.Document,
    Text: happyWindow.Text,
    NodeFilter: happyWindow.NodeFilter,
    MutationObserver: happyWindow.MutationObserver,
    ResizeObserver: happyWindow.ResizeObserver,
    DOMParser: happyWindow.DOMParser,
    XMLSerializer: happyWindow.XMLSerializer,
    HTMLAnchorElement: happyWindow.HTMLAnchorElement,
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  // Read back through the global bindings just installed, so the container is
  // typed as the DOM element React expects rather than happy-dom's own class.
  const container = document.createElement('div');
  document.body.appendChild(container);

  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

// Install the browser before lazy Markdown imports initialize DOMPurify.
const dom = installDomStub();
afterAll(() => dom.restore());

// A reasoning text whose summary (first 120 chars) fits in the header but
// whose expanded body content should only appear when the disclosure is open.
const LONG_REASONING =
  'First thought about the task at hand and how to approach it carefully.\n' +
  'This second line goes into much deeper detail about the internal reasoning ' +
  'process that should remain hidden in the collapsed header view.';

// A long text that should render the collapsible header with a label
const LONG_JUSTIFICATION =
  'Sorting by activity first because the active session needs immediate attention.\n' +
  'Secondary sort by last updated timestamp ensures a stable deterministic ordering ' +
  'when multiple sessions have the same activity state.';

describe('ReasoningTimelineBlock', () => {
  test('renders reasoning traces behind an accessible collapsed disclosure by default', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    // Accessible toggle row is rendered
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');

    // Summary preview (beginning of text) is visible in the header
    expect(markup).toContain('First thought');

    // Historical collapsed blocks do not mount the expanded body, avoiding a
    // first-frame flash when Activity reveals previously hidden rows.
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('renders "Justification" label for justification variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_JUSTIFICATION}
          variant="justification"
          blockId="justification-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </I18nProvider>,
    );

    // Label shown in expanded header should be "Justification" not "Thinking"
    expect(markup).toContain('Justification');
    expect(markup).not.toContain('Thinking');
  });

  test('renders "Thinking" label for thinking variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="thinking-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </I18nProvider>,
    );

    // Label shown in expanded header should be "Thinking"
    expect(markup).toContain('Thinking');
  });

  test('header summary is a truncated excerpt from the beginning', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    // Deep body content beyond 120 chars should be cut from the summary span
    expect(markup).not.toContain('remain hidden in the collapsed header view');
    // The ellipsis character marks that the text was truncated
    expect(markup).toContain('…');
  });

  test('omits trailing empty HTML comments from the header summary', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ReasoningTimelineBlock
          text={'Planning accessible icon labels with translations <!-- -->'}
          variant="thinking"
          blockId="reasoning-comment-test"
          showDuration={false}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Planning accessible icon labels with translations');
    expect(markup).not.toContain('&lt;!-- --&gt;');
  });
});

// Regression tests for issue #2020: a persisted reasoning part must not be
// presented as live streaming just because cached data lacks `time.end` or a
// stream phase. Live activity derives from the live stream phase only.
describe('ReasoningPart streaming gating (issue #2020)', () => {
  // Mounted coverage below checks the full body after the lazy renderer loads.
  const SHORT_REASONING = 'Persisted reasoning text that is already fully available.';

  const BUSY_INDICATOR = 'animate-busy-pulse';

  const makeReasoningPart = (
    time: ReasoningPartFixture['time'],
    text: string = SHORT_REASONING,
  ): ReasoningPartFixture => ({
    id: 'prt_reasoning_2020',
    sessionID: 'ses_2020',
    messageID: 'msg_2020',
    type: 'reasoning',
    text,
    time,
  });

  // Server rendering reads the UI store's initial state, which is
  // chatRenderMode 'live' — the mode in which the streaming presentation is
  // reachable and the issue reproduces.
  const renderPart = (part: ReasoningPartFixture, streamPhase?: StreamPhase): string =>
    renderToStaticMarkup(
      <I18nProvider>
        <ReasoningPart part={part} messageId="msg_2020" streamPhase={streamPhase} />
      </I18nProvider>,
    );

  test('reasoning without time.end and without a live stream phase renders complete, not streaming', () => {
    // Freshly opened completed session: cached part never received `time.end`
    // and no message-level stream phase is available. The full text is already
    // local, so the block must render as finished content on first paint.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), undefined);

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-message-text-export-source="true"');
  });

  test('reasoning without time.end in a completed message renders complete, not streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'completed');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-message-text-export-source="true"');
  });

  test('reasoning with time.end is never treated as streaming, even when the phase claims streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000, end: 2_000 }), 'streaming');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-message-text-export-source="true"');
  });

  test('live in-progress reasoning still renders as streaming', () => {
    // Genuinely live: the message-level stream phase reports streaming and the
    // part has not ended. The block auto-expands and shows the busy indicator.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'streaming');

    expect(markup).toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
  });

  test('a live part with no committed text yet shows the busy header and no empty summary', () => {
    // The streaming early-return keeps the block mounted before the block-level
    // reveal commits a first line. The header must read as busy and must not
    // paint an empty summary row.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }, ''), 'streaming');
    expect(markup).toContain(BUSY_INDICATOR);
    expect(markup).toContain('role="button"');
    // The summary span carries `title="<summary>"`; with no text there must be
    // no summary span at all rather than an empty one.
    expect(markup).toContain('Thinking');
    expect(markup).not.toContain('title="');
  });

  test('remounting a completed reasoning part does not re-trigger the streaming presentation', async () => {
    // renderToStaticMarkup cannot observe this: it has no mount lifecycle, so
    // comparing two server renders is true by construction. Mount, unmount and
    // remount a real client root instead, watching the busy indicator across
    // every commit.
    const part = makeReasoningPart({ start: 1_000 });
    const busySeen: boolean[] = [];
    const root = createRoot(dom.container);

    const renderTree = (streamPhase?: StreamPhase) => (
      <Providers>
        <I18nProvider>
          <ReasoningPart part={part} messageId="msg_2020" streamPhase={streamPhase} />
        </I18nProvider>
      </Providers>
    );

    try {
      await loadMarkdownRendererModule();
      await act(async () => {
        root.render(renderTree());
      });
      busySeen.push(dom.container.innerHTML.includes(BUSY_INDICATOR));
      expect(dom.container.textContent).toContain(SHORT_REASONING);

      await act(async () => {
        root.render(null);
      });
      await act(async () => {
        root.render(renderTree());
      });
      busySeen.push(dom.container.innerHTML.includes(BUSY_INDICATOR));

      expect(busySeen).toEqual([false, false]);
      expect(dom.container.textContent).toContain(SHORT_REASONING);
      const toggle = dom.container.querySelector<HTMLElement>('[role="button"]');
      if (!toggle) throw new Error('Thinking disclosure is missing');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(dom.container.querySelector('[data-message-text-export-source]')?.className)
        .toBe('text-muted-foreground italic');
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      await act(async () => toggle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await act(async () => root.render(renderTree('streaming')));
      expect(dom.container.innerHTML).toContain(BUSY_INDICATOR);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await act(async () => root.render(renderTree('completed')));
      expect(dom.container.innerHTML).not.toContain(BUSY_INDICATOR);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(dom.container.textContent).toContain(SHORT_REASONING);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const requests = [];
const window = new Window({
  url: 'https://openchamber.test/',
  settings: {
    fetch: {
      interceptor: {
        beforeAsyncRequest: async ({ request, window: requestWindow }) => {
          requests.push(request.url);
          return new requestWindow.Response(null, { status: 404 });
        },
      },
    },
    navigation: { disableMainFrameNavigation: true, disableChildPageNavigation: true },
  },
});
window.document.documentElement.innerHTML = '<head></head><body></body>';
window.document.insertBefore(window.document.implementation.createDocumentType('html', '', ''), window.document.documentElement);
window.localStorage.setItem('homeDirectory', '/workspace');
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  customElements: window.customElements,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Element: window.Element,
  MutationObserver: window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  requests.push(new Request(input).url);
  return new Response(null, { status: 404 });
});
// Bun does not implement Vite's worker asset query. Resolve only that asset
// syntax to a local URL; all rendering and decoration modules stay real.
plugin({
  name: 'vite-worker-url',
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, ({ path, importer }) => ({
      path: pathToFileURL(Bun.resolveSync(path.replace(/\?worker&url$/, ''), dirname(importer))).href,
      namespace: 'worker-url',
    }));
    build.onLoad({ filter: /.*/, namespace: 'worker-url' }, ({ path }) => ({
      contents: `export default ${JSON.stringify(path)};`, loader: 'js',
    }));
  },
});
const { renderMarkdownSync } = await import('./markdown/markdownCore');
const { decorateMarkdown, attachMarkdownInteractions } = await import('./markdown/decorate');
const { StaticToolRow } = await import('./message/parts/ProgressiveGroup');

const context = {
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview server',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  renderMermaid: () => ({}),
};

const urls = [
  'https://example.com/docs?from=chat',
  'https://private.corp.internal/plans',
  'http://intranet/wiki',
  'http://localhost:3000/preview',
];
const thirdPartyRequests = () => requests.filter((url) => new URL(url).origin !== window.location.origin);
const assertLocalIcons = (container) => {
  expect(thirdPartyRequests()).toEqual([]);
  const thirdPartySources = Array.from(container.querySelectorAll('[src]'))
    .map((element) => new URL(element.getAttribute('src') ?? '', window.location.href))
    .filter((url) => url.origin !== window.location.origin)
    .map((url) => url.href);
  expect(thirdPartySources).toEqual([]);
  expect(container.querySelectorAll('img')).toHaveLength(0);
  expect(container.querySelectorAll('use[href="#oc-external-link"]')).toHaveLength(urls.length);
};

const activityForUrl = (url, index) => ({
  id: `activity-${index}`, turnId: 'turn-1', messageId: 'message-1', partIndex: index,
  kind: 'tool', endedAt: 2,
  part: {
    id: `part-${index}`, sessionID: 'session-1', messageID: 'message-1', type: 'tool',
    callID: `call-${index}`, tool: 'webfetch',
    state: { status: 'completed', input: { url }, output: '', title: url, metadata: {}, time: { start: 1, end: 2 } },
  },
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await window.happyDOM.close();
});

describe('chat link icon privacy', () => {
  test('request observers catch third-party requests without sending them', async () => {
    requests.length = 0;
    await window.fetch('https://network-probe.test/window');
    await globalThis.fetch('https://network-probe.test/global');
    expect(thirdPartyRequests()).toEqual([
      'https://network-probe.test/window', 'https://network-probe.test/global',
    ]);
    requests.length = 0;
  });

  test('real markdown rendering and decoration keep links clickable without remote icons', async () => {
    requests.length = 0;
    const container = document.createElement('div');
    container.innerHTML = renderMarkdownSync(urls.map((url, index) => `[Link ${index}](${url})`).join('\n\n'), 'label');
    document.body.appendChild(container);
    const previews = [];
    const ctx = { ...context, onPreviewLoopback: (url) => { previews.push(url); } };
    const detach = attachMarkdownInteractions(container, ctx);
    try {
      decorateMarkdown(container, ctx);
      const markup = container.innerHTML;
      decorateMarkdown(container, ctx);
      expect(container.innerHTML).toBe(markup);
      const anchors = Array.from(container.querySelectorAll('a'));
      expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(urls);
      expect(anchors.map((anchor) => anchor.textContent)).toEqual(urls.map((_, index) => `Link ${index}`));
      expect(anchors.every((anchor) => anchor.target === '_blank')).toBe(true);
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      anchors[0]?.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      container.querySelector('[data-md-action="preview-loopback"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(previews).toEqual(['http://localhost:3000/preview']);
      await window.happyDOM.waitUntilComplete();
      assertLocalIcons(container);
    } finally {
      detach();
      container.remove();
    }
  });

  test('ProgressiveGroup fetch rows keep links clickable without remote icons', async () => {
    requests.length = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<StaticToolRow toolName="webfetch" activities={urls.map(activityForUrl)} animateTailText={false} />);
      });
      const anchors = Array.from(container.querySelectorAll('a'));
      expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(urls);
      expect(anchors.map((anchor) => anchor.textContent)).toEqual(urls);
      expect(anchors.every((anchor) => anchor.target === '_blank' && anchor.rel === 'noopener noreferrer')).toBe(true);
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      anchors[0]?.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      await window.happyDOM.waitUntilComplete();
      assertLocalIcons(container);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

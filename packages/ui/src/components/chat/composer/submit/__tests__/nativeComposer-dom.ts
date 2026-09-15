import { Window } from 'happy-dom';

export function nativeComposerDom() {
  const window = new Window({ url: 'http://synthetic.invalid' });
  const values = {
    window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement, Document: window.Document,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    DOMRect: window.DOMRect, Range: window.Range, Event: window.Event, CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    localStorage: window.localStorage, sessionStorage: window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const container = document.createElement('div'); document.body.appendChild(container);
  return { window, container, restore: async () => {
    await window.happyDOM.abort(); window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

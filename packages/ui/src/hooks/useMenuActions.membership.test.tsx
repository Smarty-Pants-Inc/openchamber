import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { I18nProvider } from "@/lib/i18n";

let directoryRequests = 0;

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    success: () => undefined,
  },
}));

mock.module("@/contexts/useThemeSystem", () => ({
  useThemeSystem: () => ({
    setThemeMode: () => undefined,
  }),
}));

mock.module("@/lib/sessionEvents", () => ({
  sessionEvents: {
    requestDirectoryDialog: () => {
      directoryRequests += 1;
    },
  },
}));

mock.module("@/lib/worktreeSessionCreator", () => ({
  createWorktreeSession: () => undefined,
}));

mock.module("@/lib/openCodeStatus", () => ({
  showOpenCodeStatus: async () => undefined,
}));

mock.module("@/lib/addSelectionToChat", () => ({
  addSelectionToChat: () => undefined,
}));

const { useMenuActions } = await import("./useMenuActions");

const installHappyDom = () => {
  const happyWindow = new Window({ url: "http://localhost/" });
  const happyDocument = happyWindow.document;
  const domGlobals = {
    window: happyWindow,
    document: happyDocument,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    Element: happyWindow.Element,
    Node: happyWindow.Node,
    MutationObserver: happyWindow.MutationObserver,
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  } as const;
  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(domGlobals)) {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return {
    window: happyWindow,
    document: happyDocument,
    restore: async () => {
      for (const [key, descriptor] of savedDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await happyWindow.happyDOM.close();
    },
  };
};

const MenuActionsHarness = () => {
  useMenuActions();
  return null;
};

let root: Root | null = null;
let restoreDom: (() => Promise<void>) | null = null;
let restoreProjects: (() => void) | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  restoreProjects?.();
  restoreProjects = null;
  await restoreDom?.();
  restoreDom = null;
  directoryRequests = 0;
});

describe("useMenuActions runtime membership gating", () => {
  test("blocks change-workspace after live authority becomes active", async () => {
    const dom = installHappyDom();
    restoreDom = dom.restore;
    const originalProjectsState = useProjectsStore.getState();
    restoreProjects = () => {
      useProjectsStore.setState(originalProjectsState, true);
    };
    useProjectsStore.setState({ runtimeProjectMembershipActive: false });
    const element = document.createElement("div");
    document.body.appendChild(element);
    root = createRoot(element);

    await act(async () => {
      root?.render(<I18nProvider><MenuActionsHarness /></I18nProvider>);
    });
    await act(async () => {
      const event = new dom.window.Event("openchamber:menu-action");
      Object.defineProperty(event, "detail", { value: "change-workspace" });
      dom.window.dispatchEvent(event);
    });
    expect(directoryRequests).toBe(1);

    await act(async () => {
      useProjectsStore.setState({ runtimeProjectMembershipActive: true });
    });
    await act(async () => {
      const event = new dom.window.Event("openchamber:menu-action");
      Object.defineProperty(event, "detail", { value: "change-workspace" });
      dom.window.dispatchEvent(event);
    });
    expect(directoryRequests).toBe(1);
  });
});

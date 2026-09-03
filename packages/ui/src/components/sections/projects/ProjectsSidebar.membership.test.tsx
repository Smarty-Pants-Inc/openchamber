import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { I18nProvider } from "@/lib/i18n";
import { useProjectsStore } from "@/stores/useProjectsStore";

let directoryRequests = 0;

mock.module("@/contexts/useThemeSystem", () => ({
  useThemeSystem: () => ({
    currentTheme: {
      metadata: { variant: "light" },
      colors: { surface: { foreground: "#111111" } },
    },
  }),
}));

mock.module("@/lib/sessionEvents", () => ({
  sessionEvents: {
    requestDirectoryDialog: () => {
      directoryRequests += 1;
    },
  },
}));

const { ProjectsSidebar } = await import("./ProjectsSidebar");

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

let root: Root | null = null;
let restoreDom: (() => Promise<void>) | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  await restoreDom?.();
  restoreDom = null;
  directoryRequests = 0;
  useProjectsStore.setState({
    projects: [],
    presentationProjects: [],
    runtimeProjectMembershipActive: false,
    activeProjectId: null,
    manualProjectOrder: [],
  });
});

describe("ProjectsSidebar runtime membership gating", () => {
  test("shows Add project when settings own membership", async () => {
    const dom = installHappyDom();
    restoreDom = dom.restore;
    useProjectsStore.setState({ runtimeProjectMembershipActive: false });
    const element = document.createElement("div");
    document.body.appendChild(element);
    root = createRoot(element);

    await act(async () => {
      root?.render(
        <I18nProvider>
          <ProjectsSidebar />
        </I18nProvider>,
      );
    });

    expect(element.innerHTML).toContain('aria-label="Add project"');
    const addProjectButton = element.querySelector("button");
    expect(addProjectButton).not.toBeNull();
    await act(async () => {
      addProjectButton?.click();
    });
    expect(directoryRequests).toBe(1);
    await act(async () => {
      useProjectsStore.setState({ runtimeProjectMembershipActive: true });
    });
    await act(async () => {
      addProjectButton?.click();
    });
    expect(directoryRequests).toBe(1);
  });
  test("hides Add project when the runtime owns membership", async () => {
    const dom = installHappyDom();
    restoreDom = dom.restore;
    useProjectsStore.setState({ runtimeProjectMembershipActive: true });
    const element = document.createElement("div");
    document.body.appendChild(element);
    root = createRoot(element);

    await act(async () => {
      root?.render(
        <I18nProvider>
          <ProjectsSidebar />
        </I18nProvider>,
      );
    });

    expect(element.textContent).not.toContain("Add project");
    expect(element.querySelector("button")).toBeNull();
  });
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { RuntimeAPIContext } from "@/contexts/runtimeAPIContext";
import { I18nProvider } from "@/lib/i18n";
import type { RuntimeAPIs } from "@/lib/api/types";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useUIStore } from "@/stores/useUIStore";

mock.module("@/hooks/useEffectiveDirectory", () => ({
  useEffectiveDirectory: () => null,
}));

mock.module("@/components/icon/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

mock.module("@/components/icons/FileTypeIcon", () => ({
  FileTypeIcon: () => <span data-file-type-icon="true" />,
}));

mock.module("@/components/icons/McpIcon", () => ({
  McpIcon: () => <span data-mcp-icon="true" />,
}));

mock.module("@/components/ui/command", () => ({
  Command: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CommandEmpty: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  CommandGroup: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  CommandInput: ({ onValueChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
    onValueChange?: (value: string) => void;
  }) => {
    void onValueChange;
    return <input {...props} />;
  },
  CommandItem: ({
    children,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onSelect?: () => void;
    value?: string;
  }) => (
    <button type="button" {...props} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CommandShortcut: ({ children }: React.PropsWithChildren) => (
    <span>{children}</span>
  ),
}));

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const { CommandPalette } = await import("./CommandPalette");

const runtimeAPIs = {
  files: null,
  git: null,
} as unknown as RuntimeAPIs;

const installHappyDom = () => {
  const happyWindow = new Window({ url: "http://localhost/" });
  const happyDocument = happyWindow.document;
  Object.defineProperty(happyWindow, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
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
let restoreStores: (() => void) | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  restoreStores?.();
  restoreStores = null;
  await restoreDom?.();
  restoreDom = null;
});

const renderPalette = async (
  runtimeProjectMembershipActive: boolean,
): Promise<string> => {
  const dom = installHappyDom();
  restoreDom = dom.restore;
  const originalUIState = useUIStore.getState();
  const originalProjectsState = useProjectsStore.getState();
  restoreStores = () => {
    useUIStore.setState(originalUIState, true);
    useProjectsStore.setState(originalProjectsState, true);
  };
  useUIStore.setState({ isCommandPaletteOpen: true });
  useProjectsStore.setState({ runtimeProjectMembershipActive });
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);

  await act(async () => {
    root?.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <I18nProvider>
          <CommandPalette />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    );
  });

  return element.textContent ?? "";
};

describe("CommandPalette runtime membership gating", () => {
  test("shows Add Project when settings own membership", async () => {
    expect(await renderPalette(false)).toContain("Add Project");
  });

  test("omits Add Project when the runtime owns membership", async () => {
    expect(await renderPalette(true)).not.toContain("Add Project");
  });
});

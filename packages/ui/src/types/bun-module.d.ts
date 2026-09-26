// Test-local asset loaders use Bun's module API, not a blanket Bun global. A module file mapped by tsconfig "paths",
// so an import of 'bun' never resolves to a bun-types package found above this repository (a checkout nested in
// another tree typechecked against the parent's Bun types; smarty-dev#723).
export interface TestPluginBuilder {
  onLoad(
    options: { filter: RegExp },
    callback: (args: { path: string }) =>
      { contents: string; loader: "js" | "ts" } |
      Promise<{ contents: string; loader: "js" | "ts" }>,
  ): void;
}
export function plugin(options: {
  name: string;
  setup: (build: TestPluginBuilder) => void;
}): void;

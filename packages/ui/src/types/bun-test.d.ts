// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by our test files is declared.

// Test-local asset loaders use Bun's module API, not a blanket Bun global.
declare module "bun" {
  interface TestPluginBuilder {
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
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
  export interface ExpectResult {
    toEqual(expected: unknown): void;
    toMatchObject: ExpectResult['toEqual'];
    toBe(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    rejects: {
      toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): Promise<void>;
      toBe(expected: unknown): Promise<void>;
      toBeInstanceOf(expected: unknown): Promise<void>;
    };
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toHaveBeenCalledTimes(expected: number): void;
    toHaveBeenCalledWith(...expected: unknown[]): void;
    toBeInstanceOf(expected: unknown): void;
    not: {
      toEqual(expected: unknown): void;
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
      toBeNull(): void;
      toHaveBeenCalled(): void;
    };
  }
  export function expect(value: unknown): ExpectResult;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function setSystemTime(now?: Date | number): void;
  // Mock<T> matches the bun:test runtime mock: T (callable) plus spy methods.
  // Tests that need to swap implementations at runtime cast through `Mock<T>`.
  export interface Mock<T extends (...args: never[]) => unknown> {
    (...args: Parameters<T>): ReturnType<T>;
    mockImplementation(fn: T): Mock<T>;
    mockReturnValue(value: ReturnType<T>): Mock<T>;
    mockReset(): Mock<T>;
  }
  export interface Spy<T extends (...args: never[]) => void> extends Mock<T> {
    mock: { calls: Parameters<T>[] };
    // Bun replaces the callable implementation, not properties attached to the
    // original function, such as Node's setTimeout.__promisify__.
    mockImplementation(fn: (...args: Parameters<T>) => ReturnType<T>): Spy<T>;
    mockImplementationOnce(fn: T): Spy<T>;
    mockResolvedValue(value: Awaited<ReturnType<T>>): Spy<T>;
    mockRejectedValue(value: Error): Spy<T>;
    mockRejectedValueOnce(value: Error): Spy<T>;
    mockRestore(): void;
  }
  export function spyOn<T, K extends keyof T>(target: T, method: K): Spy<Extract<T[K], (...args: never[]) => void>>;
  export function mock<T extends (...args: never[]) => unknown>(fn?: T): Mock<T>;
  export namespace mock {
    function module(moduleName: string, factory: () => Record<string, unknown>): void;
    function restore(): void;
  }
}

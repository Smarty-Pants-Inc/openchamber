type Owner = { issuer: string; subject: string };
type Maps = { projects: Record<string, boolean>; groups: Record<string, boolean> };
type Gate = { promise: Promise<void>; resolve(): void };
/** Contract for the private, real HTTP/auth test fixture, not a production adapter. */
export function createSidebarOwnerFixture(): Promise<{
  baseURL: string;
  subjects: string[];
  cookie: string;
  gets: number;
  requests: { owner: Owner; projects?: Maps['projects']; groups?: Maps['groups'] }[];
  heldPatch: Gate | undefined;
  heldRead: Gate | undefined;
  refuse: boolean;
  person(index: number): void;
  gate(): Gate;
  fetch: typeof globalThis.fetch;
  stored(index: number): Promise<Maps & { owner: Owner }>;
  seed(index: number, projects: Maps['projects']): Promise<void>;
  close(): Promise<void>;
}>;

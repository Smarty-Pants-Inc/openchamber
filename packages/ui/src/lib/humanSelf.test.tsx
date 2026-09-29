import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { configureRuntimeUrlResolver } from './runtime-url';
import { switchRuntimeEndpoint } from './runtime-switch';
import { useHumanAuth } from './human-auth';
import { useHumanSelf, useHumanSelfSubject } from './humanSelf';

// smarty-code#849 review: the subject belongs to the selected runtime. A switch clears it, and a read still in flight
// from the previous runtime cannot land after the switch. Real Better Auth client; only the HTTP answer is synthetic.
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const win = new Window({ url: 'https://ui.example.test/' });
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fetchSpy = spyOn(globalThis, 'fetch');
const { createRoot } = await import('react-dom/client');
afterAll(async () => {
  fetchSpy.mockRestore();
  useHumanAuth.setState({ enabled: false });
  useHumanSelf.setState({ subject: undefined });
  configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); });
const session = (id: string) => Response.json({ user: { id, name: id, email: `${id}@example.test`, emailVerified: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  session: { id: `s-${id}`, userId: id, token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() } });

let seen: string | undefined;
const Probe = () => { seen = useHumanSelfSubject(); return null; };
const reads: string[] = [];
const answer = (late?: Promise<void>) => fetchSpy.mockImplementation(async (input, init) => {
  const url = new Request(input, init).url;
  if (!url.includes('/api/auth/get-session')) return Response.json({ token: 'fixture', expiresAt: Date.now() + 60_000 });
  const host = new URL(url).host; reads.push(host);
  if (late && host === 'runtime-a.example.test') { await late; return session('a-late'); }
  return session(host === 'runtime-a.example.test' ? 'a-user' : 'b-user');
});
const mount = async (run: () => Promise<void>) => {
  reads.length = 0; seen = undefined;
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
  useHumanAuth.setState({ enabled: true });
  const root = createRoot(document.createElement('div'));
  try { await act(async () => root.render(<Probe />)); await run(); } finally { await act(async () => root.unmount()); }
};

test('a known subject is cleared on a runtime switch and read again from the new runtime', async () => {
  answer();
  await mount(async () => {
    await settle();
    expect(seen).toBe('a-user');
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example.test' }));
    await settle();
    expect(seen).toBe('b-user');
  });
});

test('a session read still in flight from the previous runtime does not land, and the new runtime is read', async () => {
  let release!: () => void;
  answer(new Promise<void>(resolve => { release = resolve; }));
  useHumanSelf.setState({ subject: undefined });
  await mount(async () => {
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example.test' }));
    await settle();
    await act(async () => release()); await settle();
    expect(seen).toBe('b-user');
    expect(reads).toEqual(['runtime-a.example.test', 'runtime-b.example.test']);
  });
});

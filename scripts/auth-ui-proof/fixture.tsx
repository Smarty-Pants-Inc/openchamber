import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleSignIn, HumanAccount } from '@/components/auth/HumanAccount';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { I18nProvider } from '@/lib/i18n';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import '@/index.css';

// Only composition and observable fixture controls; no substitute auth/UI logic.
export function Fixture() {
  const state = useAuthSessionStore(s => s.state);
  return <I18nProvider><main className="p-6 space-y-4">
    <GoogleSignIn />
    <HumanAccount />
    <output data-testid="auth-state">{state}</output>
    <button onClick={() => switchRuntimeEndpoint({
      apiBaseUrl: window.location.origin, runtimeKey: 'fixture-second-runtime',
    })}>Fixture: change runtime</button>
    <section data-testid="historical"><HumanAuthor info={{ metadata: { smartyCodeHuman: {
      version: 1, issuer: 'https://identity.example.test', subject: 'historical-user', name: 'Historical Alice',
    } } }} /></section>
    <section data-testid="unnamed"><HumanAuthor info={{ role: 'user' }} /></section>
    <section data-testid="forged"><HumanAuthor info={{ name: 'Forged Alice' }} /></section>
  </main></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

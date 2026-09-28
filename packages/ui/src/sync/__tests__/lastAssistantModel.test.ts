import { expect, test } from 'bun:test';
import { createOpencodeClient, type AssistantMessage } from '@opencode-ai/sdk/v2';
import { ChildStoreManager } from '../child-store';
import { getSessionLastAssistantModel, setActionRefs } from '../session-actions';

const assistant = (id: string, providerID: string, modelID: string): AssistantMessage => ({
  id, sessionID: 's', role: 'assistant', parentID: 'ask', providerID, modelID, time: { created: 1 }, mode: 'build', agent: 'build',
  path: { cwd: '/repo', root: '/repo' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const withClientRole = (id: string, providerID: string, modelID: string, clientRole: string): AssistantMessage & { clientRole: string } =>
  ({ ...assistant(id, providerID, modelID), clientRole });

// smallModel.ts asks for the model that answered last. A voice call note (clientRole 'system-note') and a messaging peer
// ('native-peer') ride the assistant container with placeholder models; neither is that model.
test('the last answering model skips voice call notes and messaging peers', () => {
  const children = new ChildStoreManager();
  // The client is never called here: the lookup reads the child store only.
  setActionRefs(createOpencodeClient({ baseUrl: 'http://opencode.test' }), children, () => '/repo');
  const store = children.ensureChild('/repo', { bootstrap: false });
  store.setState({ message: { s: [
    assistant('reply', 'anthropic', 'claude-x'),
    withClientRole('peer', 'pi-native', 'peer-message', 'native-peer'),
    withClientRole('note', 'pi-native', 'system-note', 'system-note'),
  ] } });
  expect(getSessionLastAssistantModel('s')).toEqual({ providerID: 'anthropic', modelID: 'claude-x' });
  store.setState({ message: { s: [withClientRole('note', 'pi-native', 'system-note', 'system-note')] } });
  expect(getSessionLastAssistantModel('s')).toBeNull();
  children.disposeAll();
});

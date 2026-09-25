import { expect, test } from 'bun:test';
import { ChildStoreManager } from '../child-store';
import { getSessionLastAssistantModel, setActionRefs } from '../session-actions';

// smallModel.ts asks for the model that answered last. A voice call note (clientRole 'system-note') and a messaging peer
// ('native-peer') ride the assistant container with placeholder models; neither is that model.
test('the last answering model skips voice call notes and messaging peers', () => {
  const children = new ChildStoreManager();
  setActionRefs({} as never, children, () => '/repo');
  const store = children.ensureChild('/repo', { bootstrap: false });
  const assistant = (id: string, providerID: string, modelID: string, clientRole?: string) =>
    ({ id, sessionID: 's', role: 'assistant', providerID, modelID, ...(clientRole ? { clientRole } : {}), time: { created: 1 } });
  store.setState({ message: { s: [
    assistant('reply', 'anthropic', 'claude-x'),
    assistant('peer', 'pi-native', 'peer-message', 'native-peer'),
    assistant('note', 'pi-native', 'system-note', 'system-note'),
  ] as never } });
  expect(getSessionLastAssistantModel('s')).toEqual({ providerID: 'anthropic', modelID: 'claude-x' });
  store.setState({ message: { s: [assistant('note', 'pi-native', 'system-note', 'system-note')] as never } });
  expect(getSessionLastAssistantModel('s')).toBeNull();
  children.disposeAll();
});

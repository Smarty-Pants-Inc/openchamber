/**
 * The composer's attachment destination (SEC551R3): the current session, else the new-session draft,
 * on the active runtime. Selecting an existing session or restoring a runtime's remembered session
 * changes it without touching the attachment list, so `input-store.ts` compares this identity before
 * it publishes a prepared file. Imported for its registration by the surfaces that start batches.
 */
import { getRuntimeKey } from '@/lib/runtime-switch'
import { registerAttachmentOwnerIdentity } from './input-store'
import { useSessionUIStore } from './session-ui-store'

registerAttachmentOwnerIdentity(() => {
  const { currentSessionId, newSessionDraft } = useSessionUIStore.getState()
  const owner = currentSessionId
    ? ['session', currentSessionId]
    : ['draft', newSessionDraft.draftId, newSessionDraft.open]
  return JSON.stringify([getRuntimeKey(), ...owner])
})

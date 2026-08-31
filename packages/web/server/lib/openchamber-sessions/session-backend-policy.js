const asRecord = (value) => {
  if (value === null || value === undefined || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : {};
};

const asNonEmptyString = (value) => {
  if (value === null
    || value === undefined
    || Object.getPrototypeOf(value) !== String.prototype
    || value !== value.valueOf()) return null;
  const normalized = value.trim();
  return normalized || null;
};

export const isManagedBackendProviderID = (providerID) => providerID === 'pi' || providerID === 'omp';

const getAgentBackendProviderID = (session) => {
  const value = asRecord(asRecord(session?.metadata).openchamber).agent_backend;
  return isManagedBackendProviderID(value) ? value : null;
};

export const withAgentBackendMetadata = (metadata, providerID) => {
  if (!isManagedBackendProviderID(providerID)) return metadata;
  const source = asRecord(metadata);
  const openchamber = asRecord(source.openchamber);
  const existingBackend = openchamber.agent_backend;
  return {
    ...source,
    openchamber: {
      ...openchamber,
      agent_backend: isManagedBackendProviderID(existingBackend) ? existingBackend : providerID,
    },
  };
};

const isReviewSession = (session) => {
  const openchamber = asRecord(asRecord(session?.metadata).openchamber);
  return openchamber.kind === 'review' && Boolean(asNonEmptyString(openchamber.originalSessionID));
};

export class SessionBackendPolicyError extends Error {
  constructor(code, message, category = 'conflict') {
    super(message);
    this.name = 'SessionBackendPolicyError';
    this.code = code;
    this.category = category;
  }
}

const conflict = (code, message) => new SessionBackendPolicyError(code, message);
const incompleteHistory = (code, message) => new SessionBackendPolicyError(code, message, 'incomplete-history');

const messageBackendClass = (record) => {
  const info = asRecord(asRecord(record).info);
  const model = asRecord(info.model);
  const providerID = asNonEmptyString(model.providerID) || asNonEmptyString(info.providerID);
  if (!providerID) return null;
  return isManagedBackendProviderID(providerID) ? providerID : 'native';
};

/**
 * Fold complete session history without retaining message records. The reader
 * owns transport details and returns one page plus its next cursor.
 */
export const foldSessionBackendHistory = async (readPage) => {
  let backendClass = null;
  const seenCursors = new Set();
  let before;

  for (;;) {
    const page = await readPage(before);
    if (!page || !Array.isArray(page.records)) {
      throw incompleteHistory('invalid-history-page', 'Failed to read source session history');
    }

    for (const record of page.records) {
      const currentClass = messageBackendClass(record);
      if (!currentClass) continue;
      if (backendClass && backendClass !== currentClass) {
        throw conflict('mixed-history', 'Mixed native/Pi/OMP session backend history cannot be used');
      }
      backendClass = currentClass;
    }

    if (page.nextCursor === undefined || page.nextCursor === null) {
      return backendClass;
    }
    const nextCursor = asNonEmptyString(page.nextCursor);
    if (!nextCursor) {
      throw incompleteHistory('invalid-history-cursor', 'Source session history returned an invalid pagination cursor');
    }
    if (seenCursors.has(nextCursor)) {
      throw incompleteHistory('stalled-history-cursor', 'Source session history pagination made no progress');
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }
};

const reconcileManagedBackend = (session, historyBackendClass) => {
  const existingBackend = getAgentBackendProviderID(session);
  const historyBackend = isManagedBackendProviderID(historyBackendClass) ? historyBackendClass : null;
  if (historyBackend && existingBackend && historyBackend !== existingBackend) {
    throw conflict('managed-backend-change', 'Managed Pi/OMP session backend cannot be changed');
  }
  return {
    backend: existingBackend || historyBackend,
    backfillBackend: historyBackend && !existingBackend ? historyBackend : null,
  };
};

export const resolveSessionSend = ({ session, historyBackendClass }) => (
  reconcileManagedBackend(session, historyBackendClass)
);

export const assertSessionSendBackend = ({ backend, providerID }) => {
  if (!backend && isManagedBackendProviderID(providerID)) {
    throw conflict(
      'native-to-managed-send',
      'Native sessions cannot be converted to a managed Pi/OMP backend by sending a prompt',
    );
  }
  if (backend && backend !== providerID) {
    throw conflict('managed-backend-change', 'Managed Pi/OMP session backend cannot be changed');
  }
};

export const assertForkSourceSession = (session) => {
  if (isReviewSession(session)) {
    throw conflict('review-session-fork', 'Review sessions cannot be forked');
  }
};

export const resolveSessionForkSource = ({ session, historyBackendClass }) => {
  assertForkSourceSession(session);
  return reconcileManagedBackend(session, historyBackendClass);
};

export const assertSessionForkSourceBackend = (backend) => {
  if (backend === 'pi') {
    throw conflict('pi-session-fork', 'Pi sessions cannot be forked');
  }
};

export const authorizeSessionForkTarget = ({ sourceBackend, targetProviderID }) => {
  if (targetProviderID === 'pi') {
    throw conflict(
      'pi-fork-target',
      'Pi sessions cannot be created by forking because startup dialogs require an interactive client',
    );
  }
  const hasTarget = Boolean(targetProviderID);
  if ((sourceBackend === 'omp' && hasTarget && targetProviderID !== 'omp')
    || (sourceBackend === null && targetProviderID === 'omp')) {
    throw conflict('fork-backend-change', 'Session backend cannot be changed by forking');
  }
};

export const authorizeManagedBackendStamp = ({ session, providerID }) => {
  const existingBackend = getAgentBackendProviderID(session);
  if (existingBackend && existingBackend !== providerID) {
    throw conflict('managed-backend-change', 'Managed Pi/OMP session backend cannot be changed');
  }
  return {
    backend: existingBackend || providerID,
    backfillBackend: existingBackend ? null : providerID,
  };
};

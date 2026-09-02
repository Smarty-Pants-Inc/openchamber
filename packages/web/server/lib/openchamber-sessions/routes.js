import express from 'express';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { cancelWorktreeBootstrap, createWorktree, finalizeWorktreeBootstrapOwnership, getWorktreeBootstrapStatus, removeWorktree } from '../git/index.js';
import { expandSnippets } from '../opencode/snippets.js';
import { expandCommandGoalObjective, parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import {
  SessionBackendPolicyError,
  assertForkSourceSession,
  authorizeManagedBackendStamp,
  assertSessionForkSourceBackend,
  authorizeSessionForkTarget,
  assertSessionSendBackend,
  foldSessionBackendHistory,
  resolveSessionForkSource,
  resolveSessionSend,
  isManagedBackendProviderID,
  withAgentBackendMetadata,
} from './session-backend-policy.js';
import { sessionMetadataMutationRuntime } from './session-metadata.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const splitModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

const resolveRequestedModel = (payload) => {
  const model = splitModel(payload?.model);
  if (model) return model;

  const providerID = asNonEmptyString(payload?.providerID);
  const modelID = asNonEmptyString(payload?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

const FALLBACK_PROVIDER_ID = 'opencode';
const FALLBACK_MODEL_ID = 'big-pickle';
const MIN_GOAL_TOKEN_BUDGET = 1_000;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;
const SESSION_CLEANUP_TIMEOUT_MS = 5_000;
const sessionOperationLocks = new Map();

const createInteractivePiRequiredError = () => new OpenChamberControlError(
  'Pi session creation requires an interactive client to own startup dialogs',
  409,
);

// Policy conflicts and structurally incomplete history have the same HTTP
// meaning in Web and VS Code. SDK transport failures remain adapter-owned.
export const sessionBackendPolicyStatus = (error) => {
  if (!(error instanceof SessionBackendPolicyError)) return null;
  return error.category === 'conflict' ? 409 : 502;
};


const createRequestCancelledError = () => new OpenChamberControlError('Request cancelled', 499);

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw createRequestCancelledError();
};

const waitForAbortableDelay = (delayMs, signal) => new Promise((resolve, reject) => {
  throwIfAborted(signal);
  let timeout;
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => {
    cleanup();
    reject(createRequestCancelledError());
  };
  timeout = setTimeout(() => {
    cleanup();
    resolve();
  }, delayMs);
  signal?.addEventListener('abort', abort, { once: true });
});

const withServerSessionLock = async ({ baseUrl, directory, sessionID }, operation) => {
  const key = `${baseUrl}\0${directory}\0${sessionID}`;
  const previous = sessionOperationLocks.get(key);
  let release;
  const completion = new Promise((resolve) => {
    release = resolve;
  });
  sessionOperationLocks.set(key, completion);
  try {
    await previous?.catch(() => undefined);
    return await operation();
  } finally {
    release();
    if (sessionOperationLocks.get(key) === completion) sessionOperationLocks.delete(key);
  }
};

const resolveGoalInput = (payload, prompt) => {
  const enabled = payload?.goal === true;
  if (payload?.goalTokenBudget !== undefined && !enabled) {
    return { ok: false, error: 'goalTokenBudget requires goal' };
  }
  if (enabled && !prompt) {
    return { ok: false, error: 'prompt is required when goal is enabled' };
  }
  if (payload?.goalTokenBudget === undefined) {
    return { ok: true, enabled, tokenBudget: null };
  }
  const tokenBudget = payload.goalTokenBudget;
  if (!Number.isSafeInteger(tokenBudget)
    || tokenBudget < MIN_GOAL_TOKEN_BUDGET
    || tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
    return { ok: false, error: `goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}` };
  }
  return { ok: true, enabled, tokenBudget };
};

const isPrimaryAgentMode = (mode) => !mode || mode === 'primary' || mode === 'all';

const providerModels = (provider) => {
  if (Array.isArray(provider?.models)) return provider.models;
  if (provider?.models && typeof provider.models === 'object') return Object.values(provider.models);
  return [];
};

const hasProviderModel = (providers, providerID, modelID) => {
  return providers.some((provider) => provider?.id === providerID
    && providerModels(provider).some((model) => model?.id === modelID));
};

const resolveVariant = (providers, providerID, modelID, variant) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  const provider = providers.find((entry) => entry?.id === providerID);
  const model = providerModels(provider).find((entry) => entry?.id === modelID);
  return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, normalized)
    ? normalized
    : undefined;
};

const parseConfigModel = (value) => splitModel(value);

const buildDirectoryHeaders = (directory) => ({
  ...(directory ? { 'x-opencode-directory': directory } : {}),
});

const fetchJson = async (url, authHeaders, fallback, directory) => {
  const response = await fetch(url.toString(), {
    headers: { ...authHeaders, ...buildDirectoryHeaders(directory), accept: 'application/json' },
  });
  if (!response.ok) return fallback;
  return response.json().catch(() => fallback);
};

const fetchSelectionInputs = async ({ buildOpenCodeUrl, authHeaders, directory, readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const providersUrl = new URL(buildOpenCodeUrl('/config/providers', ''));
  providersUrl.searchParams.set('directory', directory);
  const agentsUrl = new URL(buildOpenCodeUrl('/agent', ''));
  agentsUrl.searchParams.set('directory', directory);
  const configUrl = new URL(buildOpenCodeUrl('/config', ''));
  configUrl.searchParams.set('directory', directory);

  const [providersBody, agentsBody, configBody] = await Promise.all([
    fetchJson(providersUrl, authHeaders, { providers: [] }, directory),
    fetchJson(agentsUrl, authHeaders, [], directory),
    fetchJson(configUrl, authHeaders, {}, directory),
  ]);

  return {
    settings,
    providers: Array.isArray(providersBody?.providers) ? providersBody.providers : [],
    agents: Array.isArray(agentsBody) ? agentsBody : [],
    opencodeDefaultAgent: asNonEmptyString(configBody?.default_agent) || asNonEmptyString(configBody?.defaultAgent),
    opencodeDefaultModel: asNonEmptyString(configBody?.model),
  };
};

const resolveDefaultSelection = ({ agents, providers, settings, opencodeDefaultAgent, opencodeDefaultModel }) => {
  const primaryAgents = agents.filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true);
  let resolvedAgent = null;
  const settingsDefaultAgent = asNonEmptyString(settings?.defaultAgent);
  if (settingsDefaultAgent) {
    resolvedAgent = agents.find((agent) => agent?.name === settingsDefaultAgent) || null;
  }
  if (!resolvedAgent && opencodeDefaultAgent) {
    const candidate = agents.find((agent) => agent?.name === opencodeDefaultAgent) || null;
    if (candidate && isPrimaryAgentMode(candidate.mode) && candidate.hidden !== true) {
      resolvedAgent = candidate;
    }
  }
  if (!resolvedAgent) {
    resolvedAgent = primaryAgents.find((agent) => agent?.name === 'build') || primaryAgents[0] || agents[0] || null;
  }

  let model = null;
  let variant;
  const settingsDefaultModel = parseConfigModel(settings?.defaultModel);
  if (settingsDefaultModel && hasProviderModel(providers, settingsDefaultModel.providerID, settingsDefaultModel.modelID)) {
    model = settingsDefaultModel;
    variant = resolveVariant(providers, model.providerID, model.modelID, settings?.defaultVariant);
  }

  if (!model && resolvedAgent?.model?.providerID && resolvedAgent?.model?.modelID
    && hasProviderModel(providers, resolvedAgent.model.providerID, resolvedAgent.model.modelID)) {
    model = { providerID: resolvedAgent.model.providerID, modelID: resolvedAgent.model.modelID };
    variant = resolveVariant(providers, model.providerID, model.modelID, resolvedAgent.variant);
  }

  const opencodeModel = parseConfigModel(opencodeDefaultModel);
  if (!model && opencodeModel && hasProviderModel(providers, opencodeModel.providerID, opencodeModel.modelID)) {
    model = opencodeModel;
  }

  if (!model && hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
    model = { providerID: FALLBACK_PROVIDER_ID, modelID: FALLBACK_MODEL_ID };
  }

  if (!model) {
    const provider = providers[0];
    const firstModel = providerModels(provider)[0];
    if (provider?.id && firstModel?.id) {
      model = { providerID: provider.id, modelID: firstModel.id };
    }
  }

  return {
    agent: resolvedAgent?.name,
    model,
    variant,
  };
};

const runPromptAsync = async ({ baseUrl, authHeaders, sessionID, directory, payload, signal }) => {
  throwIfAborted(signal);
  const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
  promptUrl.searchParams.set('directory', directory);
  const response = await fetch(promptUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      ...buildDirectoryHeaders(directory),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  throwIfAborted(signal);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`prompt_async failed (${response.status})${body ? `: ${body}` : ''}`);
  }
};


const getReviewSessionID = (session) => asNonEmptyString(session?.metadata?.openchamber?.reviewSessionID);

const replaceReviewSessionLinkMetadata = (metadata, replacementReviewSessionID) => {
  const source = metadata ?? {};
  const openchamber = source.openchamber && typeof source.openchamber === 'object' && !Array.isArray(source.openchamber)
    ? source.openchamber
    : {};
  const nextOpenChamber = { ...openchamber };
  if (replacementReviewSessionID) {
    nextOpenChamber.reviewSessionID = replacementReviewSessionID;
  } else {
    delete nextOpenChamber.reviewSessionID;
  }
  return { ...source, openchamber: nextOpenChamber };
};


const requestSessionMessages = async ({ client, sessionID, directory, limit, before, signal }) => {
  throwIfAborted(signal);
  const input = { sessionID, directory, limit, ...(before ? { before } : {}) };
  const response = signal
    ? await client.session.messages(input, { signal })
    : await client.session.messages(input);
  throwIfAborted(signal);
  return response;
};

const readSessionBackendHistory = ({ client, sessionID, directory, signal }) => (
  foldSessionBackendHistory(async (before) => {
    const response = await requestSessionMessages({ client, sessionID, directory, limit: 100, before, signal });
    return {
      records: response?.data,
      nextCursor: response?.response?.headers?.get('x-next-cursor') ?? null,
    };
  })
);

const requireSession = (response, operation) => {
  if (response?.data?.id) return response.data;
  throw new Error(`failed to ${operation}`);
};
const requireAuthoritativeSessionDirectory = (session, operation) => {
  const directory = asNonEmptyString(session?.directory);
  if (!directory) {
    throw new OpenChamberControlError(`${operation} did not return an authoritative session directory`, 502);
  }
  return directory;
};


const readSession = async ({ client, sessionID, directory, signal, operation }) => {
  throwIfAborted(signal);
  const input = { sessionID, directory };
  const response = signal
    ? await client.session.get(input, { signal })
    : await client.session.get(input);
  throwIfAborted(signal);
  return requireSession(response, operation);
};

const writeMetadata = async ({ client, sessionID, directory, metadata }) => {
  // Session update has no idempotency key. Never attach the request signal: if
  // the caller leaves after dispatch, recover its outcome under the shared
  // metadata lock instead of turning a committed patch into an unknown write.
  return client.session.update({ sessionID, directory, metadata });
};

const mutateSessionMetadata = async ({ client, sessionID, directory, signal, mutateMetadata }) => {
  return sessionMetadataMutationRuntime.mutate({
    sessionID,
    directory,
    signal,
    assertCurrent: () => throwIfAborted(signal),
    readSession: (readSignal) => readSession({
      client,
      sessionID,
      directory,
      signal: readSignal,
      operation: 'read session metadata',
    }),
    writeMetadata: (metadata) => writeMetadata({ client, sessionID, directory, metadata }),
    mutateMetadata,
  });
};

const mutateSessionMetadataOperations = async ({ client, sessionID, directory, signal, operations }) => {
  return sessionMetadataMutationRuntime.mutateOperations({
    sessionID,
    directory,
    signal,
    operations,
    assertCurrent: () => throwIfAborted(signal),
    readSession: (readSignal) => readSession({
      client,
      sessionID,
      directory,
      signal: readSignal,
      operation: 'read session metadata',
    }),
    writeMetadata: (metadata) => writeMetadata({ client, sessionID, directory, metadata }),
  });
};

const persistManagedBackend = async ({ client, sessionID, directory, providerID, signal }) => {
  return mutateSessionMetadata({
    client,
    sessionID,
    directory,
    signal,
    mutateMetadata: (metadata, session) => {
      const decision = authorizeManagedBackendStamp({ session, providerID });
      return {
        metadata: decision.backfillBackend
          ? withAgentBackendMetadata(metadata, decision.backfillBackend)
          : metadata,
        result: { backend: decision.backend },
      };
    },
  });
};

const authorizeForkSource = async ({ client, sessionID, directory, signal }) => {
  const sourceSession = await readSession({
    client,
    sessionID,
    directory,
    signal,
    operation: 'read source session backend metadata',
  });
  assertForkSourceSession(sourceSession);

  const historyBackendClass = await readSessionBackendHistory({ client, sessionID, directory, signal });
  const mutation = await mutateSessionMetadata({
    client,
    sessionID,
    directory,
    signal,
    mutateMetadata: (metadata, session) => {
      const decision = resolveSessionForkSource({ session, historyBackendClass });
      return {
        metadata: decision.backfillBackend
          ? withAgentBackendMetadata(metadata, decision.backfillBackend)
          : metadata,
        result: { backend: decision.backend },
      };
    },
  });
  assertSessionForkSourceBackend(mutation.result.backend);
  return { session: mutation.session, backend: mutation.result.backend };
};

const stampManagedBackendForPrompt = async ({ client, sessionID, directory, providerID, signal }) => {
  const historyBackendClass = await readSessionBackendHistory({ client, sessionID, directory, signal });
  const mutation = await mutateSessionMetadata({
    client,
    sessionID,
    directory,
    signal,
    mutateMetadata: (metadata, session) => {
      const decision = resolveSessionSend({ session, historyBackendClass });
      return {
        metadata: decision.backfillBackend
          ? withAgentBackendMetadata(metadata, decision.backfillBackend)
          : metadata,
        result: decision,
      };
    },
  });
  assertSessionSendBackend({ backend: mutation.result.backend, providerID });
  return mutation.session;
};

const stampForkedSessionBackend = async ({ client, session, directory, sourceBackend, signal }) => {
  if (sourceBackend !== 'omp') return { ...session, directory };
  const mutation = await persistManagedBackend({
    client,
    sessionID: session.id,
    directory,
    providerID: 'omp',
    signal,
  });
  return { ...session, ...mutation.session, directory };
};

const createSession = async ({ baseUrl, authHeaders, directory, title, model, agent, variant, includeSelection = false, signal }) => {
  throwIfAborted(signal);
  if (model?.providerID === 'pi') throw createInteractivePiRequiredError();
  const sessionUrl = new URL(`${baseUrl}/session`);
  sessionUrl.searchParams.set('directory', directory);
  // This POST has no idempotency key. Let it finish if the HTTP caller goes
  // away, then the surrounding create flow can compensate the known session.
  const sessionBody = { directory };
  if (title) sessionBody.title = title;
  if (includeSelection && agent) sessionBody.agent = agent;
  if (includeSelection && model) {
    sessionBody.model = {
      id: model.modelID,
      providerID: model.providerID,
    };
    if (variant) sessionBody.model.variant = variant;
  }
  sessionBody.metadata = withAgentBackendMetadata(undefined, model?.providerID);
  const response = await fetch(sessionUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      ...buildDirectoryHeaders(directory),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(sessionBody),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`session create failed (${response.status})${body ? `: ${body}` : ''}`);
  }

  const body = await response.json().catch(() => null);
  const session = body?.data ?? body;
  if (!asNonEmptyString(session?.id)) {
    throw new Error('failed to create session');
  }
  return session;
};

const cleanupSessionRequestOptions = () => (
  typeof AbortSignal?.timeout === 'function'
    ? { signal: AbortSignal.timeout(SESSION_CLEANUP_TIMEOUT_MS) }
    : {}
);

const confirmSessionRemoved = async ({ client, sessionID, directory, description = 'session' }) => {
  let deleteError = '';
  try {
    const response = await client.session.delete(
      { sessionID, directory },
      cleanupSessionRequestOptions(),
    );
    if (response?.data !== true && Number(response?.response?.status) !== 404) {
      deleteError = `The engine did not confirm deletion of the ${description}`;
    }
  } catch (error) {
    deleteError = error instanceof Error ? error.message : String(error);
  }
  try {
    const response = await client.session.get(
      { sessionID, directory },
      cleanupSessionRequestOptions(),
    );
    if (response?.data?.id) {
      return { confirmed: false, detail: deleteError || `the ${description} still exists` };
    }
    if (Number(response?.response?.status) === 404) return { confirmed: true, detail: '' };
    return { confirmed: false, detail: deleteError || `could not confirm that the ${description} was removed` };
  } catch (error) {
    if (Number(error?.response?.status ?? error?.status) === 404) return { confirmed: true, detail: '' };
    const detail = error instanceof Error ? error.message : String(error);
    return { confirmed: false, detail: deleteError ? `${deleteError}; ${detail}` : detail };
  }
};

const forkSession = async ({ client, sessionID, directory, messageID, signal }) => {
  throwIfAborted(signal);
  // Fork is non-idempotent. Do not abort it after it starts; callers that lose
  // their response compensate a confirmed child with this same client.
  const response = await client.session.fork({
    sessionID,
    directory,
    ...(messageID ? { messageID } : {}),
  });
  return requireSession(response, 'fork session');
};

const latestCompletedAssistantMessageID = async ({ client, sessionID, directory, signal }) => {
  let response;
  try {
    response = await requestSessionMessages({ client, sessionID, directory, limit: 100, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  const messages = Array.isArray(response?.data) ? response.data : [];
  let latest = null;
  for (const message of messages) {
    const info = message?.info;
    if (info?.role !== 'assistant' || !Number.isFinite(info?.time?.completed)) continue;
    if (!latest || (info.time.created || 0) >= (latest.time?.created || 0)) latest = info;
  }
  return asNonEmptyString(latest?.id);
};


const resolveRequestedDirectory = async ({ payload, readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath }) => {
  const projectID = asNonEmptyString(payload?.projectId) || asNonEmptyString(payload?.projectID);
  if (projectID) {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []);
    const project = projects.find((entry) => entry.id === projectID) || null;
    if (!project?.path) {
      return { ok: false, status: 404, error: 'Project not found' };
    }
    const validated = await validateDirectoryPath(project.path);
    return validated.ok
      ? { ok: true, directory: validated.directory, projectId: projectID }
      : { ok: false, status: 400, error: validated.error || 'Invalid project directory' };
  }

  const directory = asNonEmptyString(payload?.directory);
  const validated = await validateDirectoryPath(directory);
  return validated.ok
    ? { ok: true, directory: validated.directory }
    : { ok: false, status: 400, error: validated.error || 'Invalid directory' };
};

const PROMPT_LANDED_TIMEOUT_MS = 5_000;
const PROMPT_LANDED_POLL_MS = 150;

// createWorktree returns while the worktree is still being populated in the
// background (git reset --hard after a --no-checkout add). Dispatching a
// prompt into a half-populated directory makes opencode's run die with
// UnknownError (agent and config files are not there yet), so wait until the
// bootstrap reaches git-ready (population done) or fails before creating the
// session and dispatching.
const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 60_000;
const WORKTREE_BOOTSTRAP_POLL_MS = 150;

const waitForWorktreeBootstrapReady = async ({ directory, signal }) => {
  const deadline = Date.now() + WORKTREE_BOOTSTRAP_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    const status = await getWorktreeBootstrapStatus(directory);
    throwIfAborted(signal);
    if (status?.status === 'failed') {
      throw new OpenChamberControlError(`Worktree bootstrap failed: ${status.error || 'unknown error'}`, 500);
    }
    const phase = status?.phase;
    if (status?.status === 'ready' || phase === 'git-ready' || phase === 'setup-ready') return;
    if (Date.now() >= deadline) {
      throw new OpenChamberControlError('Timed out waiting for the worktree bootstrap', 500);
    }
    await waitForAbortableDelay(WORKTREE_BOOTSTRAP_POLL_MS, signal);
  }
};

const latestUserMessageID = async ({ client, sessionID, directory, signal }) => {
  let response;
  try {
    response = await requestSessionMessages({ client, sessionID, directory, limit: 100, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, messageID: null };
  }
  const messages = Array.isArray(response?.data) ? response.data : [];
  let latest = null;
  for (const message of messages) {
    const info = message?.info;
    if (info?.role !== 'user') continue;
    if (!latest || (info.time?.created || 0) >= (latest.time?.created || 0)) latest = info;
  }
  return { ok: true, messageID: asNonEmptyString(latest?.id) };
};

// `prompt_async` answers 204 as soon as OpenCode forks the run, and every later
// failure is reported only on the session event stream. Confirm the prompt was
// actually recorded so `promptDispatched` never claims a dispatch that vanished.
const waitForPromptLanded = async ({ client, sessionID, directory, baselineUserMessageID, signal }) => {
  const deadline = Date.now() + PROMPT_LANDED_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    const latest = await latestUserMessageID({ client, sessionID, directory, signal });
    throwIfAborted(signal);
    // A failed lookup is not authoritative evidence that the prompt was lost.
    if (!latest.ok) return true;
    if (latest.messageID && latest.messageID !== baselineUserMessageID) return true;
    if (Date.now() >= deadline) return false;
    await waitForAbortableDelay(PROMPT_LANDED_POLL_MS, signal);
  }
};

const resolveWorktreeInput = (payload) => {
  if (!payload?.worktree || typeof payload.worktree !== 'object') return null;
  const name = asNonEmptyString(payload.worktree.name);
  if (!name) return null;
  const branchName = asNonEmptyString(payload.worktree.branchName);
  const startRef = asNonEmptyString(payload.worktree.startRef);
  return {
    mode: 'new',
    name,
    ...(branchName ? { branchName } : {}),
    ...(startRef ? { startRef } : {}),
    ...(typeof payload.setUpstream === 'boolean' ? { setUpstream: payload.setUpstream } : {}),
  };
};

export const createOpenChamberSessionService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
    createSessionGoal: createSessionGoalOverride,
    sessionKnowledgeRuntime = null,
  } = dependencies;

  // Last user message of an existing session, as a selection to reuse. Returns
  // null when the session has no user message carrying a model.
  const fetchLastUserSelection = async ({ client, sessionID, directory, signal }) => {
    try {
      const response = await requestSessionMessages({ client, sessionID, directory, limit: 20, signal });
      const records = Array.isArray(response?.data) ? response.data : [];
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const info = records[index]?.info;
        if (info?.role !== 'user') continue;
        const providerID = asNonEmptyString(info.model?.providerID);
        const modelID = asNonEmptyString(info.model?.modelID);
        if (!providerID || !modelID) continue;
        return {
          model: { providerID, modelID },
          agent: asNonEmptyString(info.agent),
          variant: asNonEmptyString(info.model?.variant),
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return null;
  };
  // Promptless creation persists its selection on the session record, before
  // any user message exists to carry that configuration forward.
  const fetchPersistedSessionSelection = async ({ client, sessionID, directory, signal }) => {
    try {
      const session = await readSession({
        client,
        sessionID,
        directory,
        signal,
        operation: 'read persisted session selection',
      });
      const providerID = asNonEmptyString(session?.model?.providerID);
      const modelID = asNonEmptyString(session?.model?.id);
      const agent = asNonEmptyString(session?.agent);
      if (!providerID || !modelID) {
        return agent ? { model: null, agent, variant: undefined } : null;
      }
      return {
        model: { providerID, modelID },
        agent,
        variant: asNonEmptyString(session?.model?.variant),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  };

  // Explicit model/agent/variant are never checked by `prompt_async`: an unknown
  // agent makes the forked run fail silently, leaving a session with no message.
  // Reject them before any session, worktree, or goal side effect happens.
  const validateRequestedSelection = async ({ directory, requestedModel, requestedAgent, requestedVariant }) => {
    if (!requestedModel && !requestedAgent && !requestedVariant) return;
    const authHeaders = getOpenCodeAuthHeaders();
    const { providers, agents } = await fetchSelectionInputs({
      buildOpenCodeUrl,
      authHeaders,
      directory,
      readSettingsFromDiskMigrated,
    });

    // An empty list means the lookup failed or returned nothing authoritative;
    // it must not turn a valid selection into a rejection.
    if (requestedAgent && agents.length > 0) {
      const agent = agents.find((entry) => entry?.name === requestedAgent) || null;
      if (!agent) {
        throw new OpenChamberControlError(`Unknown agent '${requestedAgent}' for ${directory}`, 400);
      }
      if (!isPrimaryAgentMode(agent.mode)) {
        throw new OpenChamberControlError(`Agent '${requestedAgent}' is a subagent and cannot receive a prompt directly`, 400);
      }
    }

    if (requestedModel && providers.length > 0) {
      if (!hasProviderModel(providers, requestedModel.providerID, requestedModel.modelID)) {
        throw new OpenChamberControlError(
          `Unknown model '${requestedModel.providerID}/${requestedModel.modelID}' for ${directory}`,
          400,
        );
      }
      if (requestedVariant
        && !resolveVariant(providers, requestedModel.providerID, requestedModel.modelID, requestedVariant)) {
        throw new OpenChamberControlError(
          `Unknown variant '${requestedVariant}' for model '${requestedModel.providerID}/${requestedModel.modelID}'`,
          400,
        );
      }
    }
  };

  const resolvePromptSelection = async ({
    client,
    authHeaders,
    sessionID,
    directory,
    requestedModel,
    requestedAgent,
    requestedVariant,
    reuseSessionSelection = false,
    signal,
  }) => {
    let model = requestedModel;
    let agent = requestedAgent;
    let variant = requestedVariant;
    if (reuseSessionSelection && (!model || !agent)) {
      const previous = await fetchLastUserSelection({ client, sessionID, directory, signal });
      if (previous) {
        if (!model && previous.model) {
          model = previous.model;
          if (variant == null) variant = previous.variant ?? undefined;
        }
        if (!agent && previous.agent) agent = previous.agent;
      }
    }
    if (reuseSessionSelection && (!model || !agent)) {
      const persisted = await fetchPersistedSessionSelection({ client, sessionID, directory, signal });
      if (persisted) {
        if (!model && persisted.model) {
          model = persisted.model;
          if (variant == null) variant = persisted.variant;
        }
        if (!agent && persisted.agent) agent = persisted.agent;
      }
    }
    if (!model || !agent) {
      const inputs = await fetchSelectionInputs({
        buildOpenCodeUrl,
        authHeaders,
        directory,
        readSettingsFromDiskMigrated,
      });
      const defaults = resolveDefaultSelection(inputs);
      if (!model) {
        model = defaults.model;
        if (variant == null) variant = defaults.variant;
      }
      agent = agent || defaults.agent;
    }
    if (!model) {
      const error = new Error('No model is configured or available for the requested directory');
      error.statusCode = 400;
      throw error;
    }
    return { model, agent, variant };
  };

  const dispatchPrompt = async ({
    client,
    baseUrl,
    authHeaders,
    sessionID,
    directory,
    prompt,
    goalInput,
    requestedModel,
    requestedAgent,
    requestedVariant,
    reuseSessionSelection = false,
    resolvedSelection,
    signal,
    onDispatchStarted,
  }) => {
    throwIfAborted(signal);
    const { model, agent, variant } = resolvedSelection || await resolvePromptSelection({
      client,
      authHeaders,
      sessionID,
      directory,
      requestedModel,
      requestedAgent,
      requestedVariant,
      reuseSessionSelection,
      signal,
    });

    const expandedPrompt = expandSnippets(prompt, directory);
    const parsedCommand = parseScheduledCommandPrompt(prompt);
    let resolvedCommand = null;
    if (parsedCommand) {
      try {
        const response = await client.command.list({ directory });
        const commands = Array.isArray(response?.data) ? response.data : [];
        const command = commands.find((candidate) => candidate?.name === parsedCommand.command);
        if (command) resolvedCommand = { ...parsedCommand, template: command.template };
      } catch {
      }
    }
    if (goalInput.enabled) {
      const commandObjective = resolvedCommand
        ? expandCommandGoalObjective(resolvedCommand.template, resolvedCommand.arguments)
        : null;
      await (createSessionGoalOverride || createSessionGoal)({
        baseUrl,
        authHeaders,
        sessionID,
        directory,
        objective: commandObjective ?? expandedPrompt,
        tokenBudget: goalInput.tokenBudget,
        providerID: model.providerID,
        modelID: model.modelID,
        onWarning: (message, error) => console.warn(`[OpenChamberSessions] ${message}:`, error?.message || error),
        sessionMetadataMutationRuntime,
      });
    }

    const markGoalPartial = (error) => {
      if (goalInput.enabled && error && typeof error === 'object') error.goalConfigured = true;
      return error;
    };

    if (resolvedCommand) {
      throwIfAborted(signal);
      onDispatchStarted?.();
      try {
        await client.session.command({
          sessionID,
          directory,
          command: resolvedCommand.command,
          arguments: resolvedCommand.arguments,
          ...(agent ? { agent } : {}),
          model: `${model.providerID}/${model.modelID}`,
          ...(variant ? { variant } : {}),
        });
        throwIfAborted(signal);
      } catch (error) {
        throw markGoalPartial(error);
      }
    } else {
      const baseline = await latestUserMessageID({ client, sessionID, directory, signal });
      // A session the agent dispatched has no UI to attach the project's
      // standing context, so it is asked for here. Never fails the dispatch:
      // a session that runs without its background beats one that never runs.
      const knowledge = sessionKnowledgeRuntime
        ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionID, directory)
          .catch(() => ({ text: '', signature: '' }))
        : { text: '', signature: '' };
      try {
        throwIfAborted(signal);
        onDispatchStarted?.();
        await runPromptAsync({
          baseUrl,
          authHeaders,
          sessionID,
          directory,
          payload: {
            model,
            ...(agent ? { agent } : {}),
            ...(variant ? { variant } : {}),
            parts: [
              ...(knowledge.text ? [{ type: 'text', text: knowledge.text, synthetic: true }] : []),
              { type: 'text', text: expandedPrompt },
              ...(goalInput.enabled
                ? [{ type: 'text', text: buildGoalIntroText(goalInput.tokenBudget), synthetic: true }]
                : []),
            ],
          },
          signal,
        });
      } catch (error) {
        throw markGoalPartial(error);
      }
      if (knowledge.text && sessionKnowledgeRuntime) {
        // After the prompt is accepted, so a rejected dispatch carries it again.
        await sessionKnowledgeRuntime.recordDelivered(sessionID, directory, knowledge.signature)
          .catch(() => undefined);
      }
      const landed = await waitForPromptLanded({
        client,
        sessionID,
        directory,
        baselineUserMessageID: baseline.messageID,
        signal,
      });
      if (!landed) {
        return {
          model,
          agent,
          variant,
          promptDispatched: false,
          dispatchedAsCommand: false,
          promptError: 'The engine accepted the prompt but it never appeared in the session',
        };
      }
    }

    return { model, agent, variant, promptDispatched: true, dispatchedAsCommand: Boolean(resolvedCommand) };
  };

  const create = async (payload = {}, { signal } = {}) => {
    throwIfAborted(signal);
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      throw new OpenChamberControlError(goalInput.error, 400);
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);
    const hasExplicitModel = payload?.model !== undefined
      || payload?.providerID !== undefined
      || payload?.modelID !== undefined;
    const hasExplicitSelection = hasExplicitModel || agent !== null || variant !== null;

    const resolvedDirectory = await resolveRequestedDirectory({
      payload,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    });
    if (!resolvedDirectory.ok) {
      throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
    }
    if (!prompt && hasExplicitModel && !model) {
      throw new OpenChamberControlError('model must be provider/model or provide both providerID and modelID', 400);
    }
    if (!prompt && variant && !model) {
      throw new OpenChamberControlError('variant requires model', 400);
    }
    if (!prompt && model?.providerID === 'pi') throw createInteractivePiRequiredError();
    throwIfAborted(signal);

    const worktreeInput = resolveWorktreeInput(payload);
    let worktree = null;
    let worktreeDirectory = null;
    let sessionRequestDirectory = resolvedDirectory.directory;
    let sessionDirectory = null;
    let createdSessionID = null;
    let dispatchStarted = false;
    if (payload?.worktree && !worktreeInput) {
      throw new OpenChamberControlError('worktree.name is required when worktree is provided', 400);
    }

    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    throwIfAborted(signal);
    let baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    let authHeaders = getOpenCodeAuthHeaders();
    let client = createOpencodeClient({ baseUrl, headers: authHeaders });
    const refreshOpenCodeConnection = async () => {
      if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
      throwIfAborted(signal);
      baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
      authHeaders = getOpenCodeAuthHeaders();
      client = createOpencodeClient({ baseUrl, headers: authHeaders });
    };

    if (hasExplicitSelection && (!prompt || !worktreeInput)) {
      await validateRequestedSelection({
        directory: resolvedDirectory.directory,
        requestedModel: model,
        requestedAgent: agent,
        requestedVariant: variant,
      });
      throwIfAborted(signal);
    }

    let resolvedPromptSelection = null;
    if (prompt && !worktreeInput) {
      resolvedPromptSelection = await resolvePromptSelection({
        client,
        authHeaders,
        sessionID: null,
        directory: resolvedDirectory.directory,
        requestedModel: model,
        requestedAgent: agent,
        requestedVariant: variant,
        signal,
      });
      throwIfAborted(signal);
    }

    const recoveryError = (error, partialAction, detail, sessionCleaned = false, recovery = null, statusCode = 500) => {
      const message = error instanceof Error ? error.message : String(error);
      const recoveryDirectory = createdSessionID
        ? sessionDirectory
        : (worktreeDirectory || sessionRequestDirectory);
      return new OpenChamberControlError(`${message}; ${detail}`, statusCode, {
        partial: true,
        partialAction,
        ...(createdSessionID ? { sessionId: createdSessionID } : {}),
        ...(recoveryDirectory ? { directory: recoveryDirectory } : {}),
        ...(worktree ? {
          worktree: {
            name: worktree.name || null,
            branch: worktree.branch || null,
            path: worktreeDirectory,
          },
        } : {}),
        ...(sessionCleaned ? { sessionCleaned: true } : {}),
        ...(recovery ? { recovery } : {}),
      });
    };
    const confirmCreatedSessionRemoved = () => {
      if (!sessionDirectory) {
        return Promise.resolve({
          confirmed: false,
          detail: 'the new session did not return an authoritative directory',
        });
      }
      return confirmSessionRemoved({
        client,
        sessionID: createdSessionID,
        directory: sessionDirectory,
        description: 'new session',
      });
    };
    const removeCreatedWorktree = (expectedHead) => {
      const expectedBranch = asNonEmptyString(worktree?.branch);
      if (!expectedBranch || !expectedHead || !worktreeDirectory) {
        throw new Error('Refusing to remove worktree without its created branch, HEAD, and path');
      }
      return removeWorktree(resolvedDirectory.directory, {
        directory: worktreeDirectory,
        deleteLocalBranch: true,
        expectedBranch,
        expectedHead,
        requireClean: true,
      });
    };
    const rollbackWorktree = async (error) => {
      let sessionCleaned = false;
      if (createdSessionID) {
        const cleanup = await confirmCreatedSessionRemoved();
        if (!cleanup.confirmed) {
          throw recoveryError(
            error,
            'session-worktree-recovery-required',
            `preserved the new session and worktree because session cleanup is unconfirmed: ${cleanup.detail}`,
            false,
            { session: cleanup },
          );
        }
        sessionCleaned = true;
      }
      const expectedBranch = asNonEmptyString(worktree?.branch);
      const expectedHead = asNonEmptyString(worktree?.createdHead);
      let cancellation;
      try {
        cancellation = await cancelWorktreeBootstrap(worktreeDirectory, SESSION_CLEANUP_TIMEOUT_MS);
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw recoveryError(
          error,
          'worktree-retained',
          `preserved created worktree because bootstrap cancellation could not establish a safe removal state: ${detail}`,
          sessionCleaned,
          { bootstrap: null, expectedBranch, expectedHead },
        );
      }
      const safeToRemove = cancellation?.settled === true
        && cancellation.attached === true
        && cancellation.branch === expectedBranch
        && cancellation.clean === true
        && cancellation.safeToRemove === true
        && Boolean(expectedHead)
        && cancellation.createdHead === expectedHead
        && cancellation.currentHead === expectedHead;
      if (!safeToRemove) {
        throw recoveryError(
          error,
          'worktree-retained',
          'preserved created worktree because bootstrap state is dirty or cannot prove it is safe to remove',
          sessionCleaned,
          { bootstrap: cancellation ?? null, expectedBranch, expectedHead },
        );
      }
      try {
        await removeCreatedWorktree(expectedHead);
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw recoveryError(
          error,
          'worktree-retained',
          `preserved created worktree because safe removal failed: ${detail}`,
          sessionCleaned,
          { bootstrap: cancellation, expectedBranch, expectedHead },
        );
      }
      throw error;
    };

    try {
      if (worktreeInput) {
        worktree = await createWorktree(resolvedDirectory.directory, worktreeInput, { signal });
        worktreeDirectory = worktree.path;
        sessionRequestDirectory = worktreeDirectory;
        throwIfAborted(signal);
        await waitForWorktreeBootstrapReady({ directory: worktreeDirectory, signal });
        await refreshOpenCodeConnection();
        await validateRequestedSelection({
          directory: sessionRequestDirectory,
          requestedModel: model,
          requestedAgent: agent,
          requestedVariant: variant,
        });
        throwIfAborted(signal);
        if (prompt) {
          resolvedPromptSelection = await resolvePromptSelection({
            client,
            authHeaders,
            sessionID: null,
            directory: sessionRequestDirectory,
            requestedModel: model,
            requestedAgent: agent,
            requestedVariant: variant,
            signal,
          });
          throwIfAborted(signal);
        }
      }
      const createdSession = await createSession({
        client,
        baseUrl,
        authHeaders,
        directory: sessionRequestDirectory,
        ...(title ? { title } : {}),
        model: resolvedPromptSelection?.model ?? model,
        agent: resolvedPromptSelection?.agent ?? agent,
        variant: resolvedPromptSelection?.variant ?? variant,
        includeSelection: !prompt,
        signal,
      });
      createdSessionID = createdSession.id;
      sessionDirectory = asNonEmptyString(createdSession.directory);
      if (!sessionDirectory) {
        if (worktreeDirectory) finalizeWorktreeBootstrapOwnership(worktreeDirectory);
        throw recoveryError(
          new OpenChamberControlError('Session creation did not return an authoritative session directory', 502),
          worktree ? 'session-worktree-retained' : 'session-retained',
          `preserved the new ${worktree ? 'session and worktree' : 'session'} because its authoritative directory is unknown`,
          false,
          { session: { confirmed: false, detail: 'authoritative session directory is unavailable' } },
          502,
        );
      }
      const sessionID = createdSessionID;
      throwIfAborted(signal);

      let dispatch = resolvedPromptSelection
        ? { ...resolvedPromptSelection, promptDispatched: false, dispatchedAsCommand: false }
        : { model, agent, variant, promptDispatched: false, dispatchedAsCommand: false };
      if (prompt) {
        dispatch = await dispatchPrompt({
          client,
          baseUrl,
          authHeaders,
          sessionID,
          directory: sessionDirectory,
          prompt,
          goalInput,
          requestedModel: model,
          requestedAgent: agent,
          requestedVariant: variant,
          resolvedSelection: resolvedPromptSelection,
          signal,
          onDispatchStarted: () => {
            dispatchStarted = true;
            if (worktreeDirectory) finalizeWorktreeBootstrapOwnership(worktreeDirectory);
          },
        });
      }
      if (!prompt && worktreeDirectory) finalizeWorktreeBootstrapOwnership(worktreeDirectory);

      const result = {
        sessionId: sessionID,
        directory: sessionDirectory,
        ...(resolvedDirectory.projectId ? { projectId: resolvedDirectory.projectId } : {}),
        ...(title ? { title } : {}),
        ...(worktree ? { worktree } : {}),
        promptDispatched: dispatch.promptDispatched,
        ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
      };
      if (dispatch.model) result.model = dispatch.model;
      if (dispatch.agent) result.agent = dispatch.agent;
      if (dispatch.variant) result.variant = dispatch.variant;

      try {
        const createdEvent = {
          sessionID,
          directory: sessionDirectory,
          ...(resolvedDirectory.projectId ? { projectID: resolvedDirectory.projectId } : {}),
          ...(title ? { title } : {}),
          ...(worktree ? { worktree } : {}),
          promptDispatched: dispatch.promptDispatched,
          dispatchedAsCommand: dispatch.dispatchedAsCommand,
          ...(goalInput.enabled ? { goalEnabled: true } : {}),
          ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
          createdAt: Date.now(),
        };
        if (dispatch.model) createdEvent.model = dispatch.model;
        if (dispatch.agent) createdEvent.agent = dispatch.agent;
        if (dispatch.variant) createdEvent.variant = dispatch.variant;
        emitSessionCreatedEvent?.(createdEvent);
      } catch {
      }

      return result;
    } catch (error) {
      if (error?.partial === true) throw error;
      if (createdSessionID && dispatchStarted) {
        throw recoveryError(
          error,
          worktree ? 'session-worktree-retained' : 'session-retained',
          `preserved the new ${worktree ? 'session and worktree' : 'session'} because prompt or command dispatch already began`,
          false,
          { dispatch: { started: true } },
          Number(error?.statusCode) || 500,
        );
      }
      if (worktree) return rollbackWorktree(error);
      if (createdSessionID && (signal?.aborted || Number(error?.statusCode) === 499)) {
        const cleanup = await confirmCreatedSessionRemoved();
        if (!cleanup.confirmed) {
          throw recoveryError(
            error,
            'session-recovery-required',
            `preserved the new session because session cleanup is unconfirmed: ${cleanup.detail}`,
            false,
            { session: cleanup },
          );
        }
      }
      throw error;
    }
  };

  const resolveSessionRequest = async (payload, signal) => {
    throwIfAborted(signal);
    const resolvedDirectory = await resolveRequestedDirectory({
      payload,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    });
    if (!resolvedDirectory.ok) {
      throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
    }
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    throwIfAborted(signal);
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const authHeaders = getOpenCodeAuthHeaders();
    return {
      directory: resolvedDirectory.directory,
      baseUrl,
      authHeaders,
      client: createOpencodeClient({ baseUrl, headers: authHeaders }),
    };
  };

  const runExisting = async (action, sourceSessionId, payload = {}, { signal } = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    const prompt = asNonEmptyString(payload.prompt);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) throw new OpenChamberControlError(goalInput.error, 400);
    const requestedModel = resolveRequestedModel(payload);

    let targetSessionID = sourceSessionID;
    let targetSession = null;
    let targetDirectory = null;
    let capturedClient = null;
    let forkPromptStarted = false;
    const compensateFork = () => {
      if (!capturedClient || targetSessionID === sourceSessionID || !targetDirectory) {
        return {
          confirmed: false,
          detail: targetSessionID === sourceSessionID
            ? 'fork cleanup has no child session'
            : 'forked session did not return an authoritative directory',
        };
      }
      return confirmSessionRemoved({
        client: capturedClient,
        sessionID: targetSessionID,
        directory: targetDirectory,
        description: 'forked session',
      });
    };
    try {
      const request = await resolveSessionRequest(payload, signal);
      const { baseUrl, authHeaders, client, directory: sourceDirectory } = request;
      if (action !== 'fork') targetDirectory = sourceDirectory;
      capturedClient = client;
      let resolvedSelection;
      await withServerSessionLock({ baseUrl, directory: sourceDirectory, sessionID: sourceSessionID }, async () => {
        throwIfAborted(signal);
        await validateRequestedSelection({
          directory: sourceDirectory,
          requestedModel,
          requestedAgent: asNonEmptyString(payload.agent),
          requestedVariant: asNonEmptyString(payload.variant),
        });
        throwIfAborted(signal);

        resolvedSelection = await resolvePromptSelection({
          client,
          authHeaders,
          sessionID: sourceSessionID,
          directory: sourceDirectory,
          requestedModel,
          requestedAgent: asNonEmptyString(payload.agent),
          requestedVariant: asNonEmptyString(payload.variant),
          reuseSessionSelection: true,
          signal,
        });
        throwIfAborted(signal);
        if (action === 'fork') {
          const authorization = await authorizeForkSource({
            client,
            sessionID: sourceSessionID,
            directory: sourceDirectory,
            signal,
          });
          authorizeSessionForkTarget({
            sourceBackend: authorization.backend,
            targetProviderID: resolvedSelection.model.providerID,
          });
          throwIfAborted(signal);
          targetSession = await forkSession({
            client,
            sessionID: sourceSessionID,
            directory: sourceDirectory,
            messageID: asNonEmptyString(payload.messageId) || undefined,
            signal,
          });
          targetSessionID = targetSession.id;
          targetDirectory = requireAuthoritativeSessionDirectory(targetSession, 'Fork session');
          targetSession = await stampForkedSessionBackend({
            client,
            session: targetSession,
            directory: targetDirectory,
            sourceBackend: authorization.backend,
            signal,
          });
          return;
        }
        await stampManagedBackendForPrompt({
          client,
          sessionID: sourceSessionID,
          directory: sourceDirectory,
          providerID: resolvedSelection.model.providerID,
          signal,
        });
      });
      throwIfAborted(signal);

      const baselineAssistantMessageId = await latestCompletedAssistantMessageID({
        client,
        sessionID: targetSessionID,
        directory: targetDirectory,
        signal,
      });

      const dispatch = await dispatchPrompt({
        client,
        baseUrl,
        authHeaders,
        sessionID: targetSessionID,
        directory: targetDirectory,
        prompt,
        goalInput,
        requestedModel,
        requestedAgent: asNonEmptyString(payload.agent),
        requestedVariant: asNonEmptyString(payload.variant),
        resolvedSelection,
        signal,
        onDispatchStarted: () => {
          if (action === 'fork') forkPromptStarted = true;
        },
      });
      const result = {
        action,
        sessionId: targetSessionID,
        directory: targetDirectory,
        ...(action === 'fork' ? { sourceSessionId: sourceSessionID } : {}),
        ...(targetSession?.title ? { title: targetSession.title } : {}),
        ...(baselineAssistantMessageId ? { baselineAssistantMessageId } : {}),
        model: dispatch.model,
        ...(dispatch.agent ? { agent: dispatch.agent } : {}),
        ...(dispatch.variant ? { variant: dispatch.variant } : {}),
        promptDispatched: dispatch.promptDispatched,
        ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
      };

      if (action === 'fork') {
        try {
          emitSessionCreatedEvent?.({
            sessionID: targetSessionID,
            directory: targetDirectory,
            sourceSessionID,
            ...(targetSession?.title ? { title: targetSession.title } : {}),
            model: dispatch.model,
            ...(dispatch.agent ? { agent: dispatch.agent } : {}),
            ...(dispatch.variant ? { variant: dispatch.variant } : {}),
            promptDispatched: dispatch.promptDispatched,
            dispatchedAsCommand: dispatch.dispatchedAsCommand,
            ...(goalInput.enabled ? { goalEnabled: true } : {}),
            ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
            createdAt: Date.now(),
          });
        } catch {
        }
      }
      return result;
    } catch (error) {
      const statusCode = sessionBackendPolicyStatus(error) || Number(error?.statusCode) || 500;
      const forkCreated = action === 'fork' && targetSessionID !== sourceSessionID;
      const forkCleanup = forkCreated && !forkPromptStarted
        ? await compensateFork()
        : forkCreated
          ? { confirmed: false, detail: 'fork retained because its prompt dispatch already began' }
          : null;
      const forkRetained = forkCreated && forkCleanup?.confirmed !== true;
      const goalConfigured = error?.goalConfigured === true;
      throw new OpenChamberControlError(
        error instanceof Error ? error.message : `Failed to ${action} session`,
        statusCode,
        {
          ...(forkRetained || goalConfigured
            ? {
              partial: true,
              partialAction: forkRetained ? 'fork-retained' : 'goal-configured',
              sessionId: targetSessionID,
              ...(targetDirectory ? { directory: targetDirectory } : {}),
              ...(forkRetained ? { recovery: { fork: forkCleanup } } : {}),
            }
            : {}),
        },
      );
    }
  };

  const preflightSend = async (sourceSessionId, payload = {}, { signal } = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    const providerID = asNonEmptyString(payload.providerID);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!providerID) throw new OpenChamberControlError('providerID is required', 400);
    const { baseUrl, directory, client } = await resolveSessionRequest(payload, signal);
    await withServerSessionLock({ baseUrl, directory, sessionID: sourceSessionID }, async () => {
      throwIfAborted(signal);
      await stampManagedBackendForPrompt({
        client,
        sessionID: sourceSessionID,
        directory,
        providerID,
        signal,
      });
      throwIfAborted(signal);
    });
    return { authorized: true };
  };

  const getForkCapability = async (sourceSessionId, payload = {}, { signal } = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const { baseUrl, directory, client } = await resolveSessionRequest(payload, signal);
    try {
      await withServerSessionLock({ baseUrl, directory, sessionID: sourceSessionID }, async () => {
        throwIfAborted(signal);
        await authorizeForkSource({ client, sessionID: sourceSessionID, directory, signal });
      });
      return { supported: true };
    } catch (error) {
      if ((sessionBackendPolicyStatus(error) || Number(error?.statusCode)) === 409) return { supported: false };
      throw error;
    }
  };

  const forkAuthorized = async (sourceSessionId, payload = {}, { signal } = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const { baseUrl, directory: sourceDirectory, client } = await resolveSessionRequest(payload, signal);
    const providerID = asNonEmptyString(payload.providerID) || resolveRequestedModel(payload)?.providerID;
    let forked = null;
    let childDirectory = null;
    try {
      const session = await withServerSessionLock({ baseUrl, directory: sourceDirectory, sessionID: sourceSessionID }, async () => {
        throwIfAborted(signal);
        const authorization = await authorizeForkSource({
          client,
          sessionID: sourceSessionID,
          directory: sourceDirectory,
          signal,
        });
        authorizeSessionForkTarget({ sourceBackend: authorization.backend, targetProviderID: providerID });
        throwIfAborted(signal);
        forked = await forkSession({
          client,
          sessionID: sourceSessionID,
          directory: sourceDirectory,
          messageID: asNonEmptyString(payload.messageId) || undefined,
          signal,
        });
        childDirectory = requireAuthoritativeSessionDirectory(forked, 'Fork session');
        const stamped = await stampForkedSessionBackend({
          client,
          session: forked,
          directory: childDirectory,
          sourceBackend: authorization.backend,
          signal,
        });
        throwIfAborted(signal);
        return stamped;
      });
      throwIfAborted(signal);
      return {
        sessionId: session.id,
        sourceSessionId: sourceSessionID,
        directory: childDirectory,
        session,
      };
    } catch (error) {
      if (!forked?.id) throw error;
      const cleanup = childDirectory
        ? await confirmSessionRemoved({
            client,
            sessionID: forked.id,
            directory: childDirectory,
            description: 'forked session',
          })
        : { confirmed: false, detail: 'forked session did not return an authoritative directory' };
      if (cleanup.confirmed) throw error;
      throw new OpenChamberControlError(
        error instanceof Error ? error.message : 'Failed to authorize fork session',
        sessionBackendPolicyStatus(error) || Number(error?.statusCode) || 500,
        {
          partial: true,
          partialAction: 'fork-retained',
          sessionId: forked.id,
          ...(childDirectory ? { directory: childDirectory } : {}),
          recovery: { fork: cleanup },
        },
      );
    }
  };

  const replaceReviewLink = async (sourceSessionId, payload = {}, { signal } = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const expectedReviewSessionID = payload.expectedReviewSessionId === null
      ? null
      : asNonEmptyString(payload.expectedReviewSessionId);
    const replacementReviewSessionID = payload.replacementReviewSessionId === null
      ? null
      : asNonEmptyString(payload.replacementReviewSessionId);
    if (payload.expectedReviewSessionId !== null && !expectedReviewSessionID) {
      throw new OpenChamberControlError('expectedReviewSessionId must be a session id or null', 400);
    }
    if (payload.replacementReviewSessionId !== null && !replacementReviewSessionID) {
      throw new OpenChamberControlError('replacementReviewSessionId must be a session id or null', 400);
    }
    const { baseUrl, directory, client } = await resolveSessionRequest(payload, signal);
    return withServerSessionLock({ baseUrl, directory, sessionID: sourceSessionID }, async () => {
      const mutation = await mutateSessionMetadata({
        client,
        sessionID: sourceSessionID,
        directory,
        signal,
        mutateMetadata: (metadata, current) => {
          if (getReviewSessionID(current) !== expectedReviewSessionID) {
            return { metadata, result: { replaced: false } };
          }
          return {
            metadata: replaceReviewSessionLinkMetadata(metadata, replacementReviewSessionID),
            result: { replaced: true },
          };
        },
      });
      throwIfAborted(signal);
      return {
        replaced: mutation.result?.replaced === true
          && getReviewSessionID(mutation.session) === replacementReviewSessionID,
        session: mutation.session,
      };
    });
  };
  const mutateMetadata = async (sessionId, payload = {}, { signal } = {}) => {
    const sessionID = asNonEmptyString(sessionId);
    if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const { directory, client } = await resolveSessionRequest(payload, signal);
    const mutation = await mutateSessionMetadataOperations({
      client,
      sessionID,
      directory,
      signal,
      operations: payload.operations,
    });
    throwIfAborted(signal);
    return { session: mutation.session };
  };


  return {
    create,
    send: (sessionID, payload, options) => runExisting('send', sessionID, payload, options),
    preflightSend,
    fork: (sessionID, payload, options) => runExisting('fork', sessionID, payload, options),
    getForkCapability,
    forkAuthorized,
    mutateMetadata,
    replaceReviewLink,
  };
};

const sendServiceError = (res, error, fallback) => {
  const controlError = asControlError(error, fallback, sessionBackendPolicyStatus(error) || 500);
  return res.status(controlError.statusCode).json({
    error: controlError.message,
    ...(controlError.partial === true ? {
      partial: true,
      partialAction: controlError.partialAction,
      sessionId: controlError.sessionId,
      directory: controlError.directory,
      ...(controlError.worktree ? { worktree: controlError.worktree } : {}),
      ...(controlError.sessionCleaned === true ? { sessionCleaned: true } : {}),
      ...(controlError.recovery ? { recovery: controlError.recovery } : {}),
    } : {}),
  });
};

export const registerOpenChamberSessionRoutes = (app, dependencies) => {
  const service = dependencies.sessionService || createOpenChamberSessionService(dependencies);
  const withRequestSignal = async (req, res, operation, fallback) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      const result = await operation({ signal: controller.signal });
      if (res.writableEnded || res.destroyed) return undefined;
      return res.json(result);
    } catch (error) {
      console.error(`[OpenChamberSessions] ${fallback}:`, error);
      if (res.writableEnded || res.destroyed) return undefined;
      return sendServiceError(res, error, fallback);
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), (req, res) =>
    withRequestSignal(req, res, (options) => service.create(body(req), options), 'Failed to create session'));

  app.post(
    '/api/openchamber/sessions/:sessionId/send-preflight',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.preflightSend(req.params.sessionId, body(req), options),
      'Failed to authorize session send',
    ),
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/send',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.send(req.params.sessionId, body(req), options),
      'Failed to send session',
    ),
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.fork(req.params.sessionId, body(req), options),
      'Failed to fork session',
    ),
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork-capability',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.getForkCapability(req.params.sessionId, body(req), options),
      'Failed to check session fork capability',
    ),
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork-authorized',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.forkAuthorized(req.params.sessionId, body(req), options),
      'Failed to fork session',
    ),
  );
  app.patch(
    '/api/openchamber/sessions/:sessionId/metadata',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.mutateMetadata(req.params.sessionId, body(req), options),
      'Failed to update session metadata',
    ),
  );

  app.post(
    '/api/openchamber/sessions/:sessionId/review-link',
    express.json({ limit: '1mb' }),
    (req, res) => withRequestSignal(
      req,
      res,
      (options) => service.replaceReviewLink(req.params.sessionId, body(req), options),
      'Failed to replace review link',
    ),
  );
};

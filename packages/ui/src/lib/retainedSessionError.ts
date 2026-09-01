export type RetainedSessionCompensationOutcome = {
  confirmed: false;
  detail: string;
};

export type RetainedSessionRecovery = {
  status: 'retained';
  sessionID: string;
  directory: string | null;
  runtimeKey: string;
  cause: Error;
  compensationError: Error;
  outcome?: RetainedSessionCompensationOutcome;
};

export class RetainedSessionError extends Error {
  readonly recovery: RetainedSessionRecovery;

  constructor(message: string, recovery: Omit<RetainedSessionRecovery, 'status'>) {
    super(message);
    this.name = 'RetainedSessionError';
    this.recovery = { status: 'retained', ...recovery };
  }
}

type ConfirmRetainedSessionDeletionInput = {
  sessionID: string;
  directory: string | null;
  runtimeKey: string;
  cause: Error;
  failureMessage: string;
  deleteSession: () => Promise<boolean>;
};

export const confirmRetainedSessionDeletion = async (
  input: ConfirmRetainedSessionDeletionInput,
): Promise<void> => {
  let compensationError: Error;
  try {
    if (await input.deleteSession()) return;
    compensationError = new Error(input.failureMessage);
  } catch (error) {
    compensationError = error instanceof Error ? error : new Error(input.failureMessage);
  }
  throw new RetainedSessionError(`Session ${input.sessionID} was retained: ${compensationError.message}`, {
    sessionID: input.sessionID,
    directory: input.directory,
    runtimeKey: input.runtimeKey,
    cause: input.cause,
    compensationError,
  });
};

import React from 'react';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import {
  replyToPendingPiCreateDialog,
  type PendingPiCreate,
  type PendingPiCreateDialog,
  usePiPendingCreateStore,
} from '@/sync/pi-pending-create';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';

// eslint-disable-next-line react-refresh/only-export-components -- Pure card projection is tested independently.
export const toPiPendingCreatePermission = (
  pending: PendingPiCreate,
  dialog: Extract<PendingPiCreateDialog, { method: 'confirm' }>,
): PermissionRequest => ({
  id: dialog.id,
  sessionID: pending.pendingCreateID,
  permission: dialog.title,
  patterns: [],
  always: [],
  metadata: { description: dialog.message },
});

// eslint-disable-next-line react-refresh/only-export-components -- Pure card projection is tested independently.
export const toPiPendingCreateQuestion = (
  pending: PendingPiCreate,
  dialog: Exclude<PendingPiCreateDialog, { method: 'confirm' }>,
): QuestionRequest => ({
  id: dialog.id,
  sessionID: pending.pendingCreateID,
  questions: [{
    header: dialog.title,
    question: dialog.title,
    options: dialog.method === 'select'
      ? dialog.options.map((label) => ({ label, description: '' }))
      : [],
  }],
});

const PiPendingCreateDialogCard: React.FC<{
  pending: PendingPiCreate;
  dialog: PendingPiCreateDialog;
}> = ({ pending, dialog }) => {
  React.useEffect(() => {
    if (dialog.timeout === undefined) return;
    const remaining = Math.max(0, dialog.observedAt + dialog.timeout - Date.now());
    const timeoutID = window.setTimeout(() => {
      void replyToPendingPiCreateDialog(pending.correlation, dialog.id, {
        cancelled: true,
        timedOut: true,
      }).catch(() => undefined);
    }, remaining);
    return () => window.clearTimeout(timeoutID);
  }, [dialog.id, dialog.observedAt, dialog.timeout, pending.correlation]);

  if (dialog.method === 'confirm') {
    return (
      <PermissionCard
        permission={toPiPendingCreatePermission(pending, dialog)}
        onRespond={(response) => replyToPendingPiCreateDialog(pending.correlation, dialog.id, {
          confirmed: response !== 'reject',
        })}
      />
    );
  }

  const initialCustomAnswer = dialog.method === 'editor' ? dialog.prefill : undefined;
  const customAnswerPlaceholder = dialog.method === 'input' ? dialog.placeholder : undefined;
  return (
    <QuestionCard
      question={toPiPendingCreateQuestion(pending, dialog)}
      forceCustomAnswer={dialog.method === 'input' || dialog.method === 'editor'}
      preserveCustomAnswer={dialog.method === 'input' || dialog.method === 'editor'}
      initialCustomAnswer={initialCustomAnswer}
      customAnswerPlaceholder={customAnswerPlaceholder}
      onSubmit={(answers) => replyToPendingPiCreateDialog(pending.correlation, dialog.id, {
        value: answers[0]?.[0] ?? '',
      })}
      onDismiss={() => replyToPendingPiCreateDialog(pending.correlation, dialog.id, { cancelled: true })}
    />
  );
};

/** Startup Pi prompts are global to the pending create, before a session exists. */
export const PiPendingCreateDialogs: React.FC = () => {
  const pendingCreates = usePiPendingCreateStore((state) => state.pendingCreates);
  const cards = Object.values(pendingCreates).flatMap((pending) => (
    pending.dialogs.map((dialog) => ({ pending, dialog }))
  ));

  if (cards.length === 0) return null;

  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-background/95 px-3 py-4 backdrop-blur-sm">
      {cards.map(({ pending, dialog }) => (
        <PiPendingCreateDialogCard
          key={`${pending.correlation}:${dialog.id}`}
          pending={pending}
          dialog={dialog}
        />
      ))}
    </div>
  );
};

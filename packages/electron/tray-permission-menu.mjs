export const buildPermissionApprovalSubmenu = (approval, onAction) => [
  { label: 'Allow once', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'once' }) },
  ...(approval.canAlwaysAllow === true
    ? [{ label: 'Allow always', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'always' }) }]
    : []),
  { type: 'separator' },
  { label: 'Deny', click: () => onAction({ type: 'respond-permission', sessionId: approval.sessionId, id: approval.id, response: 'reject' }) },
  { type: 'separator' },
  { label: 'Open in app', click: () => onAction({ type: 'focus-session', sessionId: approval.sessionId, directory: approval.directory || '' }) },
];

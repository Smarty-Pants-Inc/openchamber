export const isRuntimeProjectMembershipActive = (browserWindow) =>
  browserWindow?.__ocRuntimeProjectMembershipActive === true;

export const applyRuntimeProjectMembership = (browserWindow, active) => {
  if (!browserWindow) return false;
  browserWindow.__ocRuntimeProjectMembershipActive = active === true;
  return true;
};

export const buildAddWorkspaceMenuItem = ({
  targetWindow,
  getTargetWindow,
  onAction,
}) => ({
  label: "Add Workspace",
  enabled: !isRuntimeProjectMembershipActive(targetWindow),
  click: () => {
    if (isRuntimeProjectMembershipActive(getTargetWindow())) return;
    onAction();
  },
});

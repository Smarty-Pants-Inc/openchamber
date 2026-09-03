import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRuntimeProjectMembership,
  buildAddWorkspaceMenuItem,
  isRuntimeProjectMembershipActive,
} from "./project-membership-menu.mjs";

const createWindow = (active = false) => ({
  __ocRuntimeProjectMembershipActive: active,
});

test("applies runtime membership authority to a window-local state flag", () => {
  const browserWindow = createWindow();

  assert.equal(applyRuntimeProjectMembership(browserWindow, true), true);
  assert.equal(isRuntimeProjectMembershipActive(browserWindow), true);
  assert.equal(applyRuntimeProjectMembership(browserWindow, false), true);
  assert.equal(isRuntimeProjectMembershipActive(browserWindow), false);
});

test("disables Add Workspace for the current live-catalog window", () => {
  const browserWindow = createWindow(true);
  let actions = 0;

  const item = buildAddWorkspaceMenuItem({
    targetWindow: browserWindow,
    getTargetWindow: () => browserWindow,
    onAction: () => {
      actions += 1;
    },
  });

  assert.equal(item.label, "Add Workspace");
  assert.equal(item.enabled, false);
  item.click();
  assert.equal(actions, 0);
});

test("rechecks the current target before dispatching a non-live Add Workspace action", () => {
  const browserWindow = createWindow(false);
  let actions = 0;

  const item = buildAddWorkspaceMenuItem({
    targetWindow: browserWindow,
    getTargetWindow: () => browserWindow,
    onAction: () => {
      actions += 1;
    },
  });

  assert.equal(item.enabled, true);
  item.click();
  assert.equal(actions, 1);

  browserWindow.__ocRuntimeProjectMembershipActive = true;
  item.click();
  assert.equal(actions, 1);
});

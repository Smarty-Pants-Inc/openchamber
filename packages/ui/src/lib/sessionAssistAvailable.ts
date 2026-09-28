import { useProjectsStore } from '@/stores/useProjectsStore';

/**
 * Session assist (the suggested next message and the recap) needs OpenChamber's small model, which it resolves from
 * OpenCode's own auth and config. Under Smarty Code's managed catalog those live in Pi, so no small model is ever found
 * and assist can never appear (smarty-code#729). There it is off, and its settings are hidden: nothing promises it.
 */
export const useSessionAssistAvailable = (): boolean => useProjectsStore((state) => !state.managedCatalogAdmitted);

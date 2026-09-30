import React from 'react';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import type { Provider } from '@opencode-ai/sdk/v2';
import { modelVariantNames } from '@/lib/modelVariants';

type CatalogProvider = { id: string; models: Provider['models'][string][] };

export type OrdinaryModelOption = {
  key: string; providerID: string; modelID: string; name: string; label: string; levels: string[];
};

export const ordinaryOptionKey = (providerID: string, modelID: string) => JSON.stringify([providerID, modelID]);

/**
 * Picker choices for an ordinary session. A choice shows only the model name (smarty-code#126 F7);
 * the provider joins the label only when another provider offers a model with the same name.
 */
export function buildOrdinaryModelOptions(providers: CatalogProvider[]): OrdinaryModelOption[] {
  const options = providers.flatMap(provider => provider.models.map(model => ({
    key: ordinaryOptionKey(provider.id, model.id), providerID: provider.id, modelID: model.id,
    name: model.name || model.id, levels: modelVariantNames(model),
  })));
  const providersByName = new Map<string, Set<string>>();
  for (const option of options) {
    providersByName.set(option.name, (providersByName.get(option.name) ?? new Set()).add(option.providerID));
  }
  return options.map(option => ({
    ...option,
    label: (providersByName.get(option.name)?.size ?? 0) > 1 ? `${option.providerID} / ${option.name}` : option.name,
  }));
}

/**
 * The state the controls show and build the next change from: the state the session last reported to this control, when
 * it is newer than the listed one (same generation, higher sequence). A model change is applied at once, but the listing
 * that feeds `state` can lag; an effort chosen meanwhile sent the stale model and undid the switch (smarty-code#122, 3.54).
 */
export function effectiveOrdinaryState(state: OrdinaryModelState, applied: OrdinaryModelState | null): OrdinaryModelState {
  // An unavailable listing (model null) is authoritative whatever its sequence (mergeOrdinaryModel's rule): it always wins.
  return applied && state.model && applied.model && applied.generation === state.generation && applied.sequence > state.sequence
    ? applied : state;
}

/** The controls' state and the recorder of the session's answer to their own change. The recorded answer is dropped
 * once the listing says the session is unavailable, so it never resurfaces after a later usable listing. */
export function useAppliedOrdinaryState(listed: OrdinaryModelState) {
  const [applied, setApplied] = React.useState<OrdinaryModelState | null>(null);
  const unavailable = !listed.model;
  React.useEffect(() => { if (unavailable) setApplied(null); }, [unavailable]);
  return [effectiveOrdinaryState(listed, unavailable ? null : applied), setApplied] as const;
}

/** How long after a relaunch reports `connected` the last model may still stand in (smarty-code#778: the model is back
 * up to ~1 s after `connected`). */
export const RELAUNCH_MODEL_GRACE_MS = 3000;

/**
 * While the session's Pi relaunches (`reloading`, then briefly after), a listing without a model is the relaunch, not an
 * unavailable session (smarty-code#778). `held` is the last reported state with a model, for display only: it is never
 * applied. `pending` means show a neutral loading state, not "Unavailable". A listing with a model always wins.
 */
export function useRelaunchHeldOrdinaryState(state: OrdinaryModelState, reloading: boolean) {
  const last = React.useRef<OrdinaryModelState | null>(null);
  if (state.model) last.current = state;
  // The grace is derived during render, so the first frame after `reloading` ends already holds the model; an effect
  // would start it only after that frame had committed "Unavailable" (review r1 of #778). The effect only re-renders at expiry.
  const wasReloading = React.useRef(reloading);
  const endedAt = React.useRef<number | null>(null);
  if (reloading) endedAt.current = null;
  else if (wasReloading.current) endedAt.current = Date.now();
  wasReloading.current = reloading;
  const left = endedAt.current === null ? 0 : endedAt.current + RELAUNCH_MODEL_GRACE_MS - Date.now();
  const grace = left > 0;
  const [, expire] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!grace) return;
    const timer = setTimeout(expire, left);
    return () => clearTimeout(timer);
  }, [grace, left]);
  const pending = !state.model && (reloading || grace);
  return { held: pending ? last.current : null, pending };
}

/**
 * The selected native session's live model/effort. With a target, each choice asks the
 * native session to switch; the display changes only when the session reports it.
 */

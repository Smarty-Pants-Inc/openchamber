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

/**
 * Static AI control (agent design §6): one file sets the models and the spending limits; a store may override any
 * field under `stores.<id>`. Plans and an operator console come later and will produce the same resolved shape.
 */
import fs from 'node:fs';

const NUMBERS = ['monthlyLimitUsd', 'perRequestMaxUsd', 'minToStartUsd', 'warnAt', 'maxTurns', 'maxFixRounds'];

export class AiConfigError extends Error {}

function validate(where, settings) {
  for (const key of NUMBERS) {
    if (typeof settings[key] !== 'number' || settings[key] < 0) throw new AiConfigError(`${where}.${key} must be a number >= 0`);
  }
  if (!Array.isArray(settings.allowedModels) || settings.allowedModels.length === 0) throw new AiConfigError(`${where}.allowedModels must list at least one model`);
  if (!settings.allowedModels.includes(settings.editModel)) throw new AiConfigError(`${where}.editModel "${settings.editModel}" is not in allowedModels`);
  if (typeof settings.triageModel !== 'string' || !settings.triageModel) throw new AiConfigError(`${where}.triageModel is required`);
  if (!['fixed', 'auto'].includes(settings.routing)) throw new AiConfigError(`${where}.routing must be "fixed" or "auto"`);
  if (settings.warnAt > 1) throw new AiConfigError(`${where}.warnAt is a fraction (0.8 = 80%)`);
  return settings;
}

/** @param {{ defaults: object, stores?: Record<string, object> }} raw */
export function createAiConfig(raw) {
  if (!raw?.defaults) throw new AiConfigError('The AI config needs "defaults".');
  const defaults = validate('defaults', { ...raw.defaults });
  const stores = raw.stores ?? {};
  for (const [id, override] of Object.entries(stores)) validate(`stores.${id}`, { ...defaults, ...override });

  return {
    /** The settings in force for one store. */
    forStore(id) {
      return Object.freeze({ ...defaults, ...(stores[id] ?? {}) });
    },

    /**
     * The model for an edit: the store's default, or with `routing: auto` the most capable allowed model for a large
     * request (allowedModels is ordered weakest → strongest). Never a model outside the list.
     */
    editModel(id, { large = false } = {}) {
      const settings = this.forStore(id);
      if (settings.routing === 'auto' && large) return settings.allowedModels[settings.allowedModels.length - 1];
      return settings.editModel;
    },
  };
}

export function loadAiConfig(file) {
  return createAiConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

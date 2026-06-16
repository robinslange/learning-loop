// plugin/scripts/lib/defaults.mjs : shared default constants with NO internal
// imports. Leaf module so any layer (env, config, tools) can import it without
// the constants.mjs -> config.mjs cycle. One default, one owner.

export const DEFAULT_MODEL = 'gemma3:12b';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

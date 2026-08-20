/**
 * The provider kinds ModelDock understands, and what each one needs.
 *
 * This is presentation and defaults only — no SDK is touched here. Adding a
 * genuinely new *kind* is rare; most endpoints in the world are
 * OpenAI-shaped and belong to `openai_compatible`, including LiteLLM,
 * OpenRouter, vLLM, LM Studio, Groq and Together. That is why there is no
 * gateway dependency: a proxy is just a base URL.
 */

export type ConnectionKind = "anthropic" | "openai" | "google" | "openai_compatible" | "ollama";

export interface KindSpec {
  kind: ConnectionKind;
  label: string;
  /** Conventional environment variable holding the key, pre-filled in the UI. */
  defaultApiKeyEnv: string | null;
  /** Fixed for first-party providers; user-supplied for the rest. */
  defaultBaseUrl: string | null;
  baseUrlEditable: boolean;
  requiresApiKey: boolean;
  suggestedModels: string[];
  /**
   * The one saturated colour this kind is allowed to paint, and only in the
   * berth. An unbranded endpoint gets a neutral: ModelDock does not invent an
   * identity for someone's private box.
   */
  accent: string;
  hint: string;
}

export const KINDS: Record<ConnectionKind, KindSpec> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic",
    defaultApiKeyEnv: "ANTHROPIC_API_KEY",
    defaultBaseUrl: null,
    baseUrlEditable: false,
    requiresApiKey: true,
    suggestedModels: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    accent: "#C15F3C",
    hint: "Claude models, direct from Anthropic.",
  },
  openai: {
    kind: "openai",
    label: "OpenAI",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: null,
    baseUrlEditable: false,
    requiresApiKey: true,
    suggestedModels: ["gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    accent: "#10A37F",
    hint: "GPT models, direct from OpenAI.",
  },
  google: {
    kind: "google",
    label: "Google",
    defaultApiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaultBaseUrl: null,
    baseUrlEditable: false,
    requiresApiKey: true,
    suggestedModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    accent: "#4285F4",
    hint: "Gemini models, direct from Google.",
  },
  ollama: {
    kind: "ollama",
    label: "Ollama",
    defaultApiKeyEnv: null,
    defaultBaseUrl: "http://localhost:11434/v1",
    baseUrlEditable: true,
    requiresApiKey: false,
    suggestedModels: ["llama3.2", "qwen2.5-coder", "mistral"],
    accent: "#7C6BF5",
    hint: "Models running on this machine. No key needed.",
  },
  openai_compatible: {
    kind: "openai_compatible",
    label: "OpenAI-compatible",
    defaultApiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    defaultBaseUrl: "",
    baseUrlEditable: true,
    requiresApiKey: false,
    suggestedModels: [],
    accent: "#8A8F8C",
    hint: "Any endpoint speaking the OpenAI API: OpenRouter, LiteLLM, vLLM, LM Studio, Groq, Together, your own server.",
  },
};

export const KIND_LIST: KindSpec[] = [
  KINDS.anthropic,
  KINDS.openai,
  KINDS.google,
  KINDS.ollama,
  KINDS.openai_compatible,
];

export function accentFor(kind: string): string {
  return KINDS[kind as ConnectionKind]?.accent ?? KINDS.openai_compatible.accent;
}

/**
 * A named service, pre-filled.
 *
 * A *kind* is a wire protocol; a preset is somewhere you actually have an
 * account. Almost every entry below is `openai_compatible` with a base URL
 * filled in — which is the point, and why the list can be this long without
 * costing a line in `registry.ts`. Nothing here is a new code path, and adding
 * another service is adding a row.
 *
 * `models` is a fallback, not a catalogue. The picker asks the endpoint what it
 * has as soon as there is a key to ask with, so these matter only before that
 * first call succeeds, and are left empty wherever a service's line-up moves
 * faster than this file will. A guessed model id that 404s at the first message
 * is worse than an empty box.
 *
 * The accent stays the *kind*'s accent rather than the service's brand colour.
 * A connection row records its kind and its base URL, not which preset it was
 * created from, so a per-preset colour could be shown here and never again —
 * and the berth is where colour is supposed to mean something.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ConnectionKind;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  models: string[];
  /** Where to get a key, opened in a new tab. Null for anything local. */
  keyUrl: string | null;
  hint: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: null,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: KINDS.anthropic.suggestedModels,
    keyUrl: "https://console.anthropic.com/settings/keys",
    hint: "Claude models, direct.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: null,
    apiKeyEnv: "OPENAI_API_KEY",
    models: KINDS.openai.suggestedModels,
    keyUrl: "https://platform.openai.com/api-keys",
    hint: "GPT models, direct.",
  },
  {
    id: "google",
    label: "Google",
    kind: "google",
    baseUrl: null,
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    models: KINDS.google.suggestedModels,
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Gemini models, direct.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [],
    keyUrl: "https://openrouter.ai/keys",
    hint: "One key, most models. A good first choice if you are not sure.",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: [],
    keyUrl: "https://console.groq.com/keys",
    hint: "Open models, run very fast.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [],
    keyUrl: "https://platform.deepseek.com/api_keys",
    hint: "DeepSeek's own models, direct.",
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: [],
    keyUrl: "https://console.mistral.ai/api-keys",
    hint: "Mistral's own models, direct.",
  },
  {
    id: "xai",
    label: "xAI",
    kind: "openai_compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    models: [],
    keyUrl: "https://console.x.ai",
    hint: "Grok models, direct.",
  },
  {
    id: "together",
    label: "Together",
    kind: "openai_compatible",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    models: [],
    keyUrl: "https://api.together.ai/settings/api-keys",
    hint: "A large catalogue of open models.",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    kind: "openai_compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    models: [],
    keyUrl: "https://fireworks.ai/account/api-keys",
    hint: "Open models, hosted.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai_compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    models: [],
    keyUrl: "https://cloud.cerebras.ai",
    hint: "Open models, run very fast.",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    kind: "openai_compatible",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    models: [],
    keyUrl: "https://deepinfra.com/dash/api_keys",
    hint: "Open models, hosted.",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    kind: "openai_compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: [],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    hint: "Kimi models, direct.",
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "ollama",
    baseUrl: KINDS.ollama.defaultBaseUrl,
    apiKeyEnv: null,
    models: KINDS.ollama.suggestedModels,
    keyUrl: null,
    hint: "Models running on this machine. No key, no account, no network.",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    kind: "openai_compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: null,
    models: [],
    keyUrl: null,
    hint: "Whatever LM Studio is currently serving. No key needed.",
  },
  {
    id: "vllm",
    label: "vLLM",
    kind: "openai_compatible",
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: null,
    models: [],
    keyUrl: null,
    hint: "A vLLM server, here or on your network.",
  },
  {
    id: "custom",
    label: "Something else",
    kind: "openai_compatible",
    baseUrl: "",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    models: [],
    keyUrl: null,
    hint: "Any endpoint speaking the OpenAI API — LiteLLM, a proxy, your own server.",
  },
];

export function presetFor(id: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

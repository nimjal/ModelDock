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

export const PROVIDERS = {
  typesafe: {
    label: "TypeSafe (direct)",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keyHint: "TypeSafe key from console.typesafe.ai/settings/keys",
  },
  openrouter: {
    label: "OpenRouter",
    url: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
    keyHint: "OpenRouter key from openrouter.ai/keys (sk-or-…)",
  },
};

export const DEFAULTS = {
  provider: "typesafe",
  apiKey: "",
  enabled: true,
  // Minimum probability Jev must assign to "false" before a sentence is sent to Claude for review.
  threshold: 0.3,
  anthropicKey: "",
  claudeModel: "claude-haiku-4-5",
  // Empty means the provider's default alias.
  model: "",
  disabledHosts: [],
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

import { DEFAULTS, PROVIDERS, getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const s = await getSettings();

for (const [id, p] of Object.entries(PROVIDERS)) $("provider").add(new Option(p.label, id));
$("provider").value = s.provider;
const showProvider = () => {
  const p = PROVIDERS[$("provider").value];
  $("keyHint").textContent = p.keyHint;
  $("defaultModel").textContent = p.model;
  $("model").placeholder = p.model;
};
$("provider").onchange = showProvider;
showProvider();

$("apiKey").value = s.apiKey;
$("threshold").value = s.threshold;
$("model").value = s.model;
$("anthropicKey").value = s.anthropicKey;
$("claudeModel").value = s.claudeModel;
const updateClaudeTest = () => { $("testClaude").disabled = !$("anthropicKey").value.trim(); };
$("anthropicKey").oninput = updateClaudeTest;
updateClaudeTest();
const showThreshold = () => ($("thresholdOut").textContent = `${Math.round($("threshold").value * 100)}%`);
$("threshold").oninput = showThreshold;
// Apply the threshold as soon as the slider is released; open pages re-check right away.
$("threshold").onchange = async () => {
  await chrome.storage.sync.set({ threshold: Number($("threshold").value) });
  flash(`Threshold saved: ${Math.round($("threshold").value * 100)}%.`);
};
showThreshold();

function flash(msg) {
  $("saved").textContent = msg;
  setTimeout(() => ($("saved").textContent = ""), 4000);
}

$("save").onclick = async () => {
  await chrome.storage.sync.set({
    apiKey: $("apiKey").value.trim(),
    threshold: Number($("threshold").value),
    provider: $("provider").value,
    model: $("model").value.trim(),
    anthropicKey: $("anthropicKey").value.trim(),
    claudeModel: $("claudeModel").value.trim() || DEFAULTS.claudeModel,
  });
  chrome.runtime.sendMessage({ type: "clearError" });
  flash("Saved.");
};

$("test").onclick = async () => {
  await $("save").onclick();
  flash("Asking Jev…");
  const resp = await chrome.runtime.sendMessage({
    type: "check",
    item: {
      sentence: "The Great Wall of China was built in the 1990s by the Roman Empire.",
      context: "",
      title: "TruthScreen key test",
      url: "",
    },
  });
  if (!resp?.ok) return flash(`Failed: ${resp?.error ?? "no response"}`);
  const p = Math.round((resp.result.probabilities?.false ?? 0) * 100);
  flash(`Works. Jev says "${resp.result.choice}" (${p}% false) for a known-false test sentence.`);
};

$("testClaude").onclick = async () => {
  await $("save").onclick();
  flash("Asking Claude (takes up to a minute)…");
  const resp = await chrome.runtime.sendMessage({
    type: "review",
    item: {
      sentence: "The Great Wall of China is easily visible to the naked eye from the Moon.",
      context: "",
      title: "TruthScreen key test",
      url: "",
    },
  });
  if (!resp?.ok) return flash(`Failed: ${resp?.error ?? "no response"}`);
  $("saved").textContent = `Works. Claude says "${resp.review.verdict}": ${resp.review.actualTruth}`;
};

$("clearCache").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => /^[vr]\d+:/.test(k)));
  flash("Cache cleared.");
};

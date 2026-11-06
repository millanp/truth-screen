import { reviewWithClaude } from "./claude.js";
import { PROVIDERS, getSettings } from "./settings.js";

const MAX_CONCURRENT = 4;
const MAX_CONCURRENT_REVIEWS = 6;
const REVIEW_PREFIX = "r2:";
const CACHE_PREFIX = "v2:";
const MAX_CACHE_ENTRIES = 5000;

const INSTRUCTIONS =
  "Fact-check state.sentence, a sentence taken from the web page described by " +
  "state.page_title and state.page_url. Use state.context (the surrounding text) " +
  "only to work out what the sentence refers to; judge the sentence itself against " +
  "well-established knowledge as of state.today. Always answer true or false. " +
  "Answer false only when the sentence asserts something factually wrong. Opinions, " +
  "questions, jokes, fiction, quotes of someone else's view, sentences with no " +
  "checkable claim, and claims you cannot verify all count as true.";

const CRITERIA = {
  false:
    "The sentence asserts a specific factual claim that is wrong or contradicted " +
    "by well-established evidence.",
  true:
    "Everything else: the sentence is accurate, or it is opinion or otherwise makes " +
    "no checkable factual claim, or its claim cannot be verified from general knowledge.",
};

// ---------- cache ----------

async function hashKey(model, sentence) {
  const bytes = new TextEncoder().encode(`${model}\n${sentence}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return CACHE_PREFIX + hex.slice(0, 32);
}

async function cacheGet(key) {
  const out = await chrome.storage.local.get(key);
  return out[key];
}

async function cacheSet(key, value) {
  await chrome.storage.local.set({ [key]: { ...value, t: Date.now() } });
  pruneCacheSoon();
}

let pruneTimer = null;
function pruneCacheSoon() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(async () => {
    pruneTimer = null;
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX) || k.startsWith(REVIEW_PREFIX));
    if (entries.length <= MAX_CACHE_ENTRIES) return;
    entries.sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
    const drop = entries.slice(0, entries.length - MAX_CACHE_ENTRIES).map(([k]) => k);
    await chrome.storage.local.remove(drop);
  }, 5000);
}

// ---------- Jev ----------

class JevError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function providerOf(settings) {
  return PROVIDERS[settings.provider] ?? PROVIDERS.typesafe;
}

function modelOf(settings) {
  return settings.model || providerOf(settings).model;
}

async function askJev(settings, item) {
  const provider = providerOf(settings);
  const headers = {
    Authorization: `Bearer ${settings.apiKey}`,
    "Content-Type": "application/json",
  };
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://truth-screen.com";
    headers["X-Title"] = "TruthScreen";
  }
  const body = {
    model: modelOf(settings),
    state: {
      today: new Date().toISOString().slice(0, 10),
      page_title: item.title || "",
      page_url: item.url || "",
      sentence: item.sentence,
      context: item.context || "",
    },
    questions: {
      verdict: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
    },
  };

  const res = await fetch(provider.url, { method: "POST", headers, body: JSON.stringify(body) });

  if (res.status === 401 || res.status === 403) throw new JevError(`${provider.label} rejected the API key.`, "auth");
  if (res.status === 402) throw new JevError(`${provider.label} account is out of credits.`, "credits");
  if (res.status === 429) throw new JevError(`Rate limited by ${provider.label}.`, "rate_limit");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JevError(`Jev request failed (${res.status}): ${text.slice(0, 200)}`, "http");
  }

  const json = await res.json();
  console.debug("[TruthScreen] Jev", modelOf(settings), json?.answers?.verdict?.choice, item.sentence);
  const verdict = json?.answers?.verdict;
  if (!verdict || typeof verdict.choice !== "string") {
    throw new JevError("Unexpected response shape from Jev.", "shape");
  }
  return {
    choice: verdict.choice,
    confidence: verdict.confidence ?? 0,
    probabilities: verdict.probabilities ?? {},
  };
}

// ---------- queue ----------

function limiter(max) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < max && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      pump();
    });
}

const runLimited = limiter(MAX_CONCURRENT);
const runReviewLimited = limiter(MAX_CONCURRENT_REVIEWS);
const inflight = new Map(); // cache key -> Promise

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.code !== "rate_limit" || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

async function checkSentence(item) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new JevError("Add your Jev API key in TruthScreen options.", "no_key");

  const key = await hashKey(modelOf(settings), item.sentence);
  const cached = await cacheGet(key);
  if (cached) return cached;

  if (!inflight.has(key)) {
    const p = runLimited(() => withRetry(() => askJev(settings, item)))
      .then(async (result) => {
        await cacheSet(key, result);
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

// ---------- Claude review (stage 2) ----------

async function reviewSentence(item, onProgress) {
  const settings = await getSettings();
  if (!settings.anthropicKey) throw Object.assign(new Error("Add your Anthropic API key in TruthScreen options."), { code: "no_key" });

  const key = REVIEW_PREFIX + (await hashKey(settings.claudeModel, item.sentence)).slice(CACHE_PREFIX.length);
  const cached = await cacheGet(key);
  if (cached) return cached;

  if (!inflight.has(key)) {
    const p = runReviewLimited(() =>
      reviewWithClaude({ apiKey: settings.anthropicKey, model: settings.claudeModel }, item, onProgress)
    )
      .then(async (review) => {
        await cacheSet(key, review);
        return review;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

// ---------- history (every sentence checked, for the log page) ----------

const HISTORY_KEY = "history";
const MAX_HISTORY = 2000;
let historyBuffer = [];
let historyTimer = null;

function logHistory(entry) {
  historyBuffer.push({ t: Date.now(), ...entry });
  if (historyTimer) return;
  historyTimer = setTimeout(async () => {
    historyTimer = null;
    const batch = historyBuffer;
    historyBuffer = [];
    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
    await chrome.storage.local.set({ [HISTORY_KEY]: history.concat(batch).slice(-MAX_HISTORY) });
  }, 500);
}

// ---------- status / badge ----------

async function setLastError(err) {
  await chrome.storage.local.set({ lastError: err ? { message: err.message, code: err.code, t: Date.now() } : null });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "check") {
    const { sentence, url, title } = msg.item;
    checkSentence(msg.item)
      .then(async (result) => {
        logHistory({ stage: "jev", sentence, url, title, choice: result.choice, probabilities: result.probabilities, cached: !!result.t });
        sendResponse({ ok: true, result });
      })
      .catch(async (e) => {
        logHistory({ stage: "jev", sentence, url, title, error: e.message });
        await setLastError(e);
        sendResponse({ ok: false, error: e.message, code: e.code || "unknown" });
      });
    return true; // async response
  }

  if (msg?.type === "review") {
    const { sentence, url, title } = msg.item;
    const tabId = sender.tab?.id;
    const onProgress = (note) => {
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "reviewProgress", sentence, note }).catch(() => {});
    };
    reviewSentence(msg.item, onProgress)
      .then((review) => {
        logHistory({ stage: "claude", sentence, url, title, review, cached: !!review.t });
        sendResponse({ ok: true, review });
      })
      .catch(async (e) => {
        logHistory({ stage: "claude", sentence, url, title, error: e.message });
        await setLastError(e);
        sendResponse({ ok: false, error: e.message, code: e.code || "unknown" });
      });
    return true;
  }

  if (msg?.type === "count" && sender.tab?.id != null) {
    const n = msg.count;
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#b45309" });
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: n > 0 ? String(n) : "" });
    return false;
  }

  if (msg?.type === "clearHistory") {
    historyBuffer = [];
    chrome.storage.local.remove(HISTORY_KEY);
    return false;
  }

  if (msg?.type === "clearError") {
    setLastError(null);
    return false;
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { claudeModel } = await chrome.storage.sync.get("claudeModel");
  if (claudeModel === "claude-opus-5-5") await chrome.storage.sync.set({ claudeModel: "claude-haiku-4-5" });

  // Drop verdicts cached under older question formats.
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(
    (k) => (/^v\d+:/.test(k) && !k.startsWith(CACHE_PREFIX)) || (/^r\d+:/.test(k) && !k.startsWith(REVIEW_PREFIX))
  );
  if (stale.length) await chrome.storage.local.remove(stale);

  if (reason === "install") {
    const { apiKey } = await getSettings();
    if (!apiKey) chrome.runtime.openOptionsPage();
  }
});

import { getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const FILTERS = [
  ["all", "All"],
  ["confirmed", "Confirmed by Claude"],
  ["reviewed", "Sent to Claude"],
  ["false", "Jev: false"],
  ["true", "Jev: true"],
  ["error", "Errors"],
];

let history = []; // Jev screening entries
let reviews = new Map(); // sentence -> latest Claude entry
let threshold = (await getSettings()).threshold;
let filter = new URLSearchParams(location.search).get("filter") || "all";
const pageFilter = new URLSearchParams(location.search).get("url");

// Anything other than "false" counts as true (older log entries may say unverifiable / not_a_claim).
const verdictOf = (h) => (h.error ? "error" : h.choice === "false" ? "false" : "true");
const pFalse = (h) => h.probabilities?.false ?? 0;
const reviewOf = (h) => reviews.get(h.sentence);
const isConfirmed = (h) => ["false", "misleading"].includes(reviewOf(h)?.review?.verdict);
const isUnderlined = isConfirmed;

function matches(h) {
  if (pageFilter && h.url !== pageFilter) return false;
  if (filter === "confirmed" && !isConfirmed(h)) return false;
  if (filter === "reviewed" && !reviewOf(h)) return false;
  if (filter === "error" && !h.error && !reviewOf(h)?.error) return false;
  if (["false", "true"].includes(filter) && verdictOf(h) !== filter) return false;
  const q = $("q").value.trim().toLowerCase();
  if (q && !`${h.sentence} ${h.url} ${h.title}`.toLowerCase().includes(q)) return false;
  return true;
}

function renderChips() {
  const scoped = pageFilter ? history.filter((h) => h.url === pageFilter) : history;
  const counts = {
    all: scoped.length,
    confirmed: scoped.filter(isConfirmed).length,
    reviewed: scoped.filter(reviewOf).length,
    error: scoped.filter((h) => h.error || reviewOf(h)?.error).length,
  };
  for (const h of scoped) if (!h.error) counts[verdictOf(h)] = (counts[verdictOf(h)] || 0) + 1;
  $("chips").replaceChildren(
    ...FILTERS.map(([id, label]) => {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = `${label} ${counts[id] || 0}`;
      b.setAttribute("aria-pressed", String(filter === id));
      b.onclick = () => {
        filter = id;
        render();
      };
      return b;
    })
  );
}

function cell(cls, ...children) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  td.append(...children);
  return td;
}

function claudeCell(h) {
  const c = reviewOf(h);
  if (!c) {
    const sent = !h.error && pFalse(h) >= threshold;
    return cell("muted small", sent ? "…" : "—");
  }
  const v = document.createElement("span");
  const verdict = c.error ? "error" : c.review.verdict;
  v.className = `v ${verdict === "misleading" ? "false" : verdict}`;
  v.textContent = verdict;
  const td = cell("", v);
  if (c.error) {
    td.title = c.error;
    return td;
  }
  const d = document.createElement("details");
  const s = document.createElement("summary");
  s.className = "tag";
  s.textContent = "explanation";
  d.append(s);
  for (const [label, text] of [
    ["False part", c.review.falseText],
    ["Why", c.review.whyFalse],
    ["Actually", c.review.actualTruth],
    ["Full picture", c.review.fullPicture],
  ]) {
    if (!text) continue;
    const p = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = `${label}: `;
    p.append(b, text);
    d.append(p);
  }
  for (const src of c.review.sources || []) {
    const link = document.createElement("a");
    link.href = /^https?:/.test(src.url) ? src.url : "#";
    link.target = "_blank";
    link.textContent = src.title || src.url;
    const p = document.createElement("p");
    p.append(link);
    d.append(p);
  }
  td.append(d);
  return td;
}

function render() {
  renderChips();
  const rows = history.filter(matches).reverse();
  $("rows").replaceChildren(
    ...rows.map((h) => {
      const tr = document.createElement("tr");
      if (isUnderlined(h)) tr.className = "underlined";

      const v = document.createElement("span");
      v.className = `v ${verdictOf(h)}`;
      v.textContent = verdictOf(h);
      const verdict = cell("", v);
      if (h.cached) {
        const tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = "cached";
        verdict.append(tag);
      }

      const sentence = cell("sentence", h.sentence);
      if (h.error) {
        const err = document.createElement("div");
        err.className = "tag";
        err.textContent = h.error;
        sentence.append(err);
      }

      let host = "";
      try {
        host = new URL(h.url).hostname || h.url;
      } catch {}
      const a = document.createElement("a");
      a.href = h.url;
      a.target = "_blank";
      a.title = h.title || h.url;
      a.textContent = h.title || host;

      tr.append(
        cell("time", new Date(h.t).toLocaleTimeString()),
        verdict,
        cell("num", h.error ? "—" : `${Math.round(pFalse(h) * 100)}%`),
        claudeCell(h),
        sentence,
        cell("page", a)
      );
      return tr;
    })
  );
  $("empty").hidden = rows.length > 0;
  const fresh = history.filter((h) => !h.error && !h.cached).length;
  $("summary").textContent =
    `${history.length} sentences screened (${fresh} sent to Jev, ${history.length - fresh} from cache or errors) · ` +
    `${reviews.size} reviewed by Claude · Claude reviews when Jev ≥ ${Math.round(threshold * 100)}%` +
    (pageFilter ? ` · showing one page: ${pageFilter}` : "");
}

async function load() {
  const { history: all = [] } = await chrome.storage.local.get("history");
  history = all.filter((h) => h.stage !== "claude");
  reviews = new Map(all.filter((h) => h.stage === "claude").map((h) => [h.sentence, h]));
  render();
}

$("q").oninput = render;
$("clear").onclick = () => {
  chrome.runtime.sendMessage({ type: "clearHistory" });
};
$("export").onclick = () => {
  const blob = new Blob([JSON.stringify({ screened: history, reviews: [...reviews.values()] }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `truthscreen-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "history" in changes) load();
  if (area === "sync" && "threshold" in changes) {
    threshold = changes.threshold.newValue;
    render();
  }
});

load();

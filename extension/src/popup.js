import { getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = "";
try {
  const url = new URL(tab.url);
  if (url.protocol.startsWith("http")) host = url.hostname;
} catch {}

const settings = await getSettings();
const { lastError } = await chrome.storage.local.get("lastError");

$("enabled").checked = settings.enabled;
$("host").textContent = host || "Not available on this page";
$("siteEnabled").checked = !!host && !settings.disabledHosts.includes(host);
$("siteEnabled").disabled = !host;

const err = $("error");
if (!settings.apiKey) {
  err.hidden = false;
  err.innerHTML = `Add your Jev API key to start. <a href="#" id="setup">Open settings</a>`;
  $("setup").onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
} else if (lastError && Date.now() - lastError.t < 10 * 60 * 1000) {
  err.hidden = false;
  err.textContent = lastError.message;
}

$("enabled").onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
$("siteEnabled").onchange = async (e) => {
  const { disabledHosts } = await getSettings();
  const next = new Set(disabledHosts);
  if (e.target.checked) next.delete(host);
  else next.add(host);
  await chrome.storage.sync.set({ disabledHosts: [...next] });
};
function openLog(e, params) {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/log.html${params}`) });
}
$("logPage").onclick = (e) => openLog(e, `?url=${encodeURIComponent(tab.url)}`);
$("logAll").onclick = (e) => openLog(e, "");

$("options").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

const STATUS_LABELS = {
  flagged: "Flagged by Jev",
  reviewing: "Jev flagged · Claude checking…",
  false: "False",
  misleading: "Misleading",
  error: "Claude review failed",
};

async function refresh() {
  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "listFlags" });
  } catch {}
  const flags = resp?.flags ?? [];
  $("stats").textContent = describeStats(resp);
  $("countLabel").textContent = settings.anthropicKey ? "false or misleading claims on this page" : "claims flagged by Jev on this page";
  $("count").textContent = flags.filter((f) => f.status === "flagged" || f.status === "false" || f.status === "misleading").length;
  const list = $("list");
  list.replaceChildren(
    ...flags.map((f, i) => {
      const li = document.createElement("li");
      const p = document.createElement("div");
      p.className = "p";
      p.textContent = STATUS_LABELS[f.status] || f.status;
      const s = document.createElement("div");
      s.textContent = f.clause || f.sentence;
      li.append(p, s);
      if (f.truth) {
        const t = document.createElement("div");
        t.className = "truth";
        t.textContent = `Actually: ${f.truth}`;
        li.append(t);
      }
      if (f.status === "flagged" || f.status === "reviewing" || f.status === "error") li.classList.add("pending");
      li.onclick = () => {
        chrome.tabs.sendMessage(tab.id, { type: "focusFlag", index: i });
        window.close();
      };
      return li;
    })
  );
}

function describeStats(resp) {
  if (!resp) return "Not running on this page (reload the tab after installing or changing settings).";
  if (!resp.running) return "Paused on this page.";
  const { sent, done, errors, lastError, reviews } = resp.stats;
  if (resp.halted) return `Stopped: ${lastError ?? "API error"}`;
  if (!sent) return "Waiting for checkable sentences to scroll into view…";
  let line = `Jev screened ${done - errors} of ${sent} sentences`;
  if (sent > done) line += ` (${sent - done} in flight)`;
  if (errors) line += `, ${errors} errors`;
  if (!settings.anthropicKey) return line + ".";
  line += `. ${reviews.sent} sent to Claude`;
  if (reviews.sent > reviews.done) line += ` (${reviews.sent - reviews.done} checking)`;
  const v = reviews.verdicts;
  const cleared = (v.true || 0) + (v.unverifiable || 0);
  if (reviews.done) line += `: ${(v.false || 0) + (v.misleading || 0)} confirmed, ${cleared} cleared`;
  if (reviews.errors) line += `, ${reviews.errors} failed`;
  return line + ".";
}

refresh();
setInterval(refresh, 1500);

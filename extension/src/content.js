(() => {
  if (window.__truthscreen || !document.body) return;
  window.__truthscreen = true;
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return; // needs Chrome 105+

  const SETTINGS_DEFAULTS = { enabled: true, threshold: 0.3, disabledHosts: [], apiKey: "", anthropicKey: "" };
  const HL_ACTIVE = "truthscreen-active";
  const MIN_LEN = 25;
  const MAX_LEN = 500;
  const CONTEXT_CHARS = 600;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE",
    "KBD", "SAMP", "SVG", "MATH", "CANVAS", "IFRAME", "BUTTON", "NAV", "TEMPLATE",
  ]);

  // One highlight per flag status: Jev suspects it and Claude is checking, or Claude confirmed it.
  const highlights = {
    reviewing: new Highlight(),
    false: new Highlight(),
    misleading: new Highlight(),
  };
  const activeHighlight = new Highlight();
  for (const [status, h] of Object.entries(highlights)) CSS.highlights.set(`truthscreen-${status}`, h);
  CSS.highlights.set(HL_ACTIVE, activeHighlight);

  const style = document.createElement("style");
  style.textContent = `
    ::highlight(truthscreen-reviewing) {
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: rgba(180, 83, 9, 0.55);
      text-decoration-thickness: 2px;
    }
    ::highlight(truthscreen-false) {
      text-decoration-line: underline;
      text-decoration-style: solid;
      text-decoration-color: #b45309;
      text-decoration-thickness: 2px;
    }
    ::highlight(truthscreen-misleading) {
      text-decoration-line: underline;
      text-decoration-style: dashed;
      text-decoration-color: #b45309;
      text-decoration-thickness: 2px;
    }
    ::highlight(${HL_ACTIVE}) {
      background-color: rgba(217, 119, 6, 0.18);
      text-decoration-line: underline;
      text-decoration-color: #b45309;
      text-decoration-thickness: 2px;
    }`;
  (document.head || document.documentElement).appendChild(style);

  let settings = { ...SETTINGS_DEFAULTS };
  let running = false;
  let halted = false; // stop sending after an unrecoverable error (bad key, no credits)
  const freshStats = () => ({
    sent: 0, done: 0, errors: 0, verdicts: {}, lastError: null,
    reviews: { sent: 0, done: 0, errors: 0, verdicts: {} },
  });
  const stats = freshStats();

  /**
   * A sentence Jev found suspicious. status: "reviewing" (Claude is checking), "false", "misleading", or "error".
   * `range` covers the whole sentence; `hlRange` is what's underlined (the false clause once Claude names it).
   * @type {{range: Range, hlRange: Range, findRange: (text: string) => Range|null, sentence: string, context: string,
   *         jev: any, status: string, review?: any, error?: string}[]}
   */
  const flagged = [];
  const sentenceResults = new Map(); // sentence -> Promise<Jev result|null>
  const reviewResults = new Map(); // sentence -> Promise<{review}|{error}>
  let blockText = new WeakMap(); // block element -> text last scanned
  let observedBlocks = new WeakSet();
  const displayCache = new WeakMap();

  const segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, {
    granularity: "sentence",
  });

  // ---------- DOM walking ----------

  function isInline(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    return d.startsWith("inline") || d === "contents";
  }

  function blockOf(el) {
    while (el && el !== document.body && isInline(el)) el = el.parentElement;
    return el || document.body;
  }

  function shouldSkip(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (SKIP_TAGS.has(n.tagName) || n.isContentEditable || n.id === "truthscreen-host") return true;
      if (n.getAttribute("aria-hidden") === "true" || n.hidden) return true;
    }
    return false;
  }

  function textNodesIn(block) {
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        // Only text that belongs to this block, not to a nested block.
        if (blockOf(parent) !== block) return NodeFilter.FILTER_REJECT;
        if (shouldSkip(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    return nodes;
  }

  function findBlocks(root) {
    const blocks = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.data.trim().length > 1 && node.parentElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (shouldSkip(n.parentElement)) continue;
      blocks.add(blockOf(n.parentElement));
    }
    return blocks;
  }

  // ---------- sentences ----------

  function looksCheckable(s) {
    if (s.length < MIN_LEN || s.length > MAX_LEN) return false;
    if (s.split(/\s+/).length < 5) return false;
    if (/[?]$/.test(s)) return false;
    if (!/[a-z]/i.test(s)) return false;
    if (/^(https?:\/\/|www\.)/i.test(s)) return false;
    return true;
  }

  // Map an offset in the block's concatenated text back to a DOM position.
  function positionAt(nodes, starts, offset) {
    let i = 0;
    while (i + 1 < nodes.length && starts[i + 1] <= offset) i++;
    return [nodes[i], Math.min(offset - starts[i], nodes[i].data.length)];
  }

  // The block's text nodes, their offsets in the concatenated text, and that text.
  function blockLayout(block) {
    const nodes = textNodesIn(block);
    const starts = [];
    let text = "";
    for (const n of nodes) {
      starts.push(text.length);
      text += n.data;
    }
    return { nodes, starts, text };
  }

  // Build the DOM range, context and clause finder for one Intl.Segmenter segment of a block.
  function sentenceInfo({ nodes, starts, text }, seg) {
    const raw = seg.segment;
    const lead = raw.length - raw.trimStart().length;
    const sentenceText = raw.trim();
    const sentence = sentenceText.replace(/\s+/g, " ");
    if (!sentence) return null;

    const startOff = seg.index + lead;
    const endOff = startOff + sentenceText.length;
    const range = document.createRange();
    try {
      range.setStart(...positionAt(nodes, starts, startOff));
      range.setEnd(...positionAt(nodes, starts, endOff));
    } catch {
      return null;
    }
    const ctxStart = Math.max(0, startOff - CONTEXT_CHARS / 2);
    const context = text.slice(ctxStart, ctxStart + CONTEXT_CHARS).replace(/\s+/g, " ").trim();
    // Locate a clause Claude quotes inside this sentence, tolerating whitespace differences.
    const findRange = (clause) => {
      const words = clause.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return null;
      const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
      const m = re.exec(sentenceText);
      if (!m) return null;
      const r = document.createRange();
      try {
        r.setStart(...positionAt(nodes, starts, startOff + m.index));
        r.setEnd(...positionAt(nodes, starts, startOff + m.index + m[0].length));
      } catch {
        return null;
      }
      return r;
    };
    return { sentence, range, findRange, context };
  }

  function scanBlock(block) {
    if (!block.isConnected) return;
    const layout = blockLayout(block);
    if (!layout.nodes.length) return;
    if (blockText.get(block) === layout.text) return;
    blockText.set(block, layout.text);

    for (const seg of segmenter.segment(layout.text)) {
      const info = sentenceInfo(layout, seg);
      if (!info || !looksCheckable(info.sentence)) continue;
      check(info.sentence, info.context).then((result) => {
        if (result && isSuspicious(result)) addFlag({ ...info, jev: result });
      });
    }
  }

  // The sentence under a screen point, for Ctrl + right-click inspection.
  function sentenceAtPoint(x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret[0].nodeType !== Node.TEXT_NODE) return null;
    const [node, offset] = caret;
    if (!node.parentElement || shouldSkip(node.parentElement)) return null;
    const layout = blockLayout(blockOf(node.parentElement));
    const i = layout.nodes.indexOf(node);
    if (i < 0) return null;
    const at = layout.starts[i] + offset;
    for (const seg of segmenter.segment(layout.text)) {
      if (at >= seg.index && at < seg.index + seg.segment.length) return sentenceInfo(layout, seg);
    }
    return null;
  }

  // Jev's probability that the sentence is false, whichever answer it picked.
  function jevPFalse(result) {
    if (typeof result.probabilities?.false === "number") return result.probabilities.false;
    return result.choice === "false" ? result.confidence : 1 - result.confidence;
  }

  // The threshold slider alone decides: a 60% true / 40% false sentence goes to Claude at a 15% threshold.
  function isSuspicious(result) {
    return jevPFalse(result) >= settings.threshold;
  }

  function check(sentence, context) {
    if (!sentenceResults.has(sentence)) {
      const p = new Promise((resolve) => {
        if (halted || !running) return resolve(null);
        stats.sent++;
        chrome.runtime.sendMessage(
          { type: "check", item: { sentence, context, title: document.title, url: location.href } },
          (resp) => {
            stats.done++;
            if (chrome.runtime.lastError || !resp) {
              stats.errors++;
              return resolve(null);
            }
            if (!resp.ok) {
              stats.errors++;
              stats.lastError = resp.error;
              if (["no_key", "auth", "credits"].includes(resp.code)) halted = true;
              sentenceResults.delete(sentence); // allow retry later
              return resolve(null);
            }
            stats.verdicts[resp.result.choice] = (stats.verdicts[resp.result.choice] || 0) + 1;
            console.debug("[TruthScreen]", resp.result.choice, resp.result.probabilities, sentence);
            resolve(resp.result);
          }
        );
      });
      sentenceResults.set(sentence, p);
    }
    return sentenceResults.get(sentence);
  }

  // ---------- flags ----------

  function setStatus(flag, status) {
    for (const h of Object.values(highlights)) h.delete(flag.hlRange);
    flag.status = status;
    if (highlights[status]) highlights[status].add(flag.hlRange);
    if (panelIndex >= 0 && liveFlags()[panelIndex] === flag) openPanel(panelIndex);
    reportCount();
  }

  function removeFlag(flag) {
    for (const h of Object.values(highlights)) h.delete(flag.hlRange);
    const i = liveFlags().indexOf(flag);
    if (i < 0) return;
    flagged.splice(i, 1);
    if (i === panelIndex) closePanel();
    else if (i < panelIndex) panelIndex--;
    reportCount();
  }

  function addFlag({ range, findRange, sentence, context, jev }) {
    if (!running || range.collapsed) return;
    if (flagged.some((f) => f.range === range)) return;
    const flag = { range, hlRange: range, findRange, sentence, context, jev, status: "" };
    flagged.push(flag);
    setStatus(flag, "reviewing");
    review(sentence, context).then((out) => {
      if (!flagged.includes(flag)) return;
      if (out.error) {
        flag.error = out.error;
        return setStatus(flag, "error");
      }
      flag.review = out.review;
      const { verdict, falseText } = out.review;
      if (verdict !== "false" && verdict !== "misleading") return removeFlag(flag);
      // Underline just the false clause when Claude pinpoints one.
      const clause = falseText && findRange(falseText);
      for (const h of Object.values(highlights)) h.delete(flag.hlRange);
      if (clause && !clause.collapsed) flag.hlRange = clause;
      setStatus(flag, verdict);
    });
  }

  function review(sentence, context) {
    if (!reviewResults.has(sentence)) {
      stats.reviews.sent++;
      const p = new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "review", item: { sentence, context, title: document.title, url: location.href } },
          (resp) => {
            stats.reviews.done++;
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              stats.reviews.errors++;
              reviewResults.delete(sentence); // allow retry on a later scan
              return resolve({ error: resp?.error || chrome.runtime.lastError?.message || "No response" });
            }
            const v = resp.review.verdict;
            stats.reviews.verdicts[v] = (stats.reviews.verdicts[v] || 0) + 1;
            console.debug("[TruthScreen] Claude", v, sentence, resp.review);
            resolve({ review: resp.review });
          }
        );
      });
      reviewResults.set(sentence, p);
    }
    return reviewResults.get(sentence);
  }

  function clearFlags() {
    flagged.length = 0;
    for (const h of Object.values(highlights)) h.clear();
    activeHighlight.clear();
    reportCount();
  }

  function liveFlags() {
    for (let i = flagged.length - 1; i >= 0; i--) {
      const f = flagged[i];
      if (f.range.collapsed || !f.range.startContainer.isConnected) {
        for (const h of Object.values(highlights)) h.delete(f.hlRange);
        flagged.splice(i, 1);
      }
    }
    flagged.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
    return flagged;
  }

  let countTimer = null;
  function reportCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const confirmed = liveFlags().filter((f) => f.status === "false" || f.status === "misleading").length;
      chrome.runtime.sendMessage({ type: "count", count: confirmed }).catch(() => {});
    }, 250);
  }

  // ---------- visibility-driven scanning ----------

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        observedBlocks.delete(e.target);
        scanBlock(e.target);
      }
    },
    { rootMargin: "400px 0px" }
  );

  function observeAll(root) {
    if (!running) return;
    for (const block of findBlocks(root)) {
      if (observedBlocks.has(block)) continue;
      observedBlocks.add(block);
      io.observe(block);
    }
  }

  let pendingRoots = new Set();
  let mutationTimer = null;
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const target = m.type === "characterData" ? m.target.parentElement : m.target;
      if (!target || target.closest?.("#truthscreen-host")) continue;
      pendingRoots.add(target);
    }
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const roots = pendingRoots;
      pendingRoots = new Set();
      for (const r of roots) {
        if (!r.isConnected) continue;
        // Re-scan blocks whose text changed.
        const b = blockOf(r);
        if (blockText.has(b)) blockText.delete(b);
        observeAll(r);
        if (!observedBlocks.has(b)) {
          observedBlocks.add(b);
          io.observe(b);
        }
      }
      reportCount();
    }, 700);
  });

  function start() {
    if (running) return;
    running = true;
    halted = false;
    observeAll(document.body);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stop() {
    running = false;
    mo.disconnect();
    io.disconnect();
    clearFlags();
    closePanel();
    sentenceResults.clear();
    Object.assign(stats, freshStats());
    reviewResults.clear();
    blockText = new WeakMap();
    observedBlocks = new WeakSet();
  }

  function shouldRun() {
    return (
      settings.enabled && !!settings.apiKey && !!settings.anthropicKey && !settings.disabledHosts.includes(location.hostname)
    );
  }

  function applySettings() {
    if (shouldRun()) {
      if (running) {
        // Threshold may have changed: re-evaluate everything already checked.
        stop();
      }
      // Fresh observers after stop().
      start();
    } else {
      stop();
    }
  }

  // ---------- side panel ----------

  let host = null;
  let shadow = null;
  let panelIndex = -1;

  function ensurePanel() {
    if (host) return;
    host = document.createElement("div");
    host.id = "truthscreen-host";
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; right: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          --ink: #1c1917; --muted: #78716c; --line: #e7e5e4; --bg: #fafaf9; --card: #ffffff;
          --amber: #b45309; --amber-soft: #fef3c7;
          position: fixed; top: 12px; right: 12px; bottom: 12px; width: 360px; max-width: calc(100vw - 24px);
          display: flex; flex-direction: column; box-sizing: border-box;
          background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 14px;
          box-shadow: 0 20px 50px rgba(28,25,23,.18), 0 2px 6px rgba(28,25,23,.08);
          font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
          transform: translateX(0); transition: transform .18s ease, opacity .18s ease;
        }
        .panel.hidden { transform: translateX(24px); opacity: 0; pointer-events: none; }
        @media (prefers-color-scheme: dark) {
          .panel { --ink: #f5f5f4; --muted: #a8a29e; --line: #3a3532; --bg: #1c1917; --card: #262220;
                   --amber: #f59e0b; --amber-soft: rgba(245,158,11,.14); }
        }
        header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
        .brand { font-weight: 650; letter-spacing: -.01em; }
        .brand i { font-style: normal; color: var(--amber); }
        .spacer { flex: 1; }
        button { font: inherit; color: inherit; background: none; border: 1px solid var(--line); border-radius: 8px;
                 padding: 5px 9px; cursor: pointer; }
        button:hover { border-color: var(--muted); }
        button:disabled { opacity: .5; cursor: default; }
        button.icon { border: none; padding: 4px 7px; color: var(--muted); }
        .body { padding: 16px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 16px; }
        .pill { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
                background: var(--amber-soft); color: var(--amber); font-weight: 600; font-size: 12px;
                text-transform: uppercase; letter-spacing: .04em; padding: 4px 10px; border-radius: 999px; }
        blockquote { margin: 0; padding: 12px 14px; background: var(--card); border: 1px solid var(--line);
                     border-left: 3px solid var(--amber); border-radius: 8px; font-size: 15px; }
        h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
        .pill.muted-pill { background: var(--line); color: var(--muted); }
        .spin { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent;
                border-radius: 50%; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        mark { background: var(--amber-soft); color: inherit; text-decoration: underline;
               text-decoration-color: var(--amber); text-decoration-thickness: 2px; padding: 0 1px; border-radius: 2px; }
        section p { margin: 0 0 8px; } section p:last-child { margin-bottom: 0; }
        section ul { margin: 0; padding-left: 18px; } section li { margin: 2px 0; }
        section.truth { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
        ul.sources { padding-left: 16px; font-size: 13px; }
        ul.sources a { color: var(--amber); text-decoration: none; } ul.sources a:hover { text-decoration: underline; }
        ul.sources .host { color: var(--muted); font-size: 12px; margin-left: 4px; }
        .bars { display: grid; gap: 8px; }
        .bar { display: grid; grid-template-columns: 96px 1fr 40px; align-items: center; gap: 8px; font-size: 13px; }
        .track { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; }
        .fill { height: 100%; background: var(--muted); border-radius: 999px; }
        .bar.false .fill { background: var(--amber); }
        .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
        .note { font-size: 12px; color: var(--muted); }
        .actions { display: flex; gap: 8px; flex-wrap: wrap; }
        a.btn { color: inherit; text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; }
        a.btn:hover { border-color: var(--muted); }
        footer { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line);
                 color: var(--muted); font-size: 12px; }
      </style>
      <div class="panel hidden" role="dialog" aria-label="TruthScreen claim details">
        <header>
          <span class="brand">Truth<i>Screen</i></span>
          <span class="spacer"></span>
          <button class="icon" data-act="prev" title="Previous claim">↑</button>
          <button class="icon" data-act="next" title="Next claim">↓</button>
          <button class="icon" data-act="close" title="Close (Esc)">✕</button>
        </header>
        <div class="body"></div>
        <footer><span class="pos"></span><span class="spacer"></span><span>Jev → Claude</span></footer>
      </div>`;
    shadow.addEventListener("click", (e) => {
      const act = e.target.closest?.("[data-act]")?.dataset.act;
      if (act === "close") closePanel();
      if (act === "prev") step(-1);
      if (act === "next") step(1);
      if (act === "dismiss") dismissCurrent();
      if (act === "askClaude") askClaude();
    });
    document.documentElement.appendChild(host);
  }

  function pct(x) {
    return `${Math.round((x || 0) * 100)}%`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Claude's prose fields: keep paragraphs and "- " bullet lines readable.
  function prose(text) {
    const blocks = escapeHtml(text || "").trim().split(/\n{2,}/);
    return blocks
      .map((block) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
          return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-•*]\s+/, "")}</li>`).join("")}</ul>`;
        }
        return `<p>${lines.join("<br>")}</p>`;
      })
      .join("");
  }

  function quoteWithClause(f) {
    const clause = f.review?.falseText?.trim();
    const sentence = escapeHtml(f.sentence);
    if (!clause || clause.length >= f.sentence.length) return sentence;
    const esc = escapeHtml(clause.replace(/\s+/g, " "));
    const i = sentence.indexOf(esc);
    return i < 0 ? sentence : `${sentence.slice(0, i)}<mark>${esc}</mark>${sentence.slice(i + esc.length)}`;
  }

  function safeUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function panelBody(f) {
    const q = encodeURIComponent(f.sentence);
    const jevLine = `Flagged by Jev (${pct(f.jev.probabilities?.false ?? f.jev.confidence)} likely false)`;
    const searchLinks = `
      <div class="actions">
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}">Search the web</a>
        <button data-act="dismiss">Hide</button>
      </div>`;

    if (f.status === "reviewing") {
      return `
        <span class="pill muted-pill"><span class="spin"></span> Claude is checking</span>
        <blockquote>${escapeHtml(f.sentence)}</blockquote>
        <p class="note">${jevLine}. Claude is researching it on the web and will explain what's wrong
          and what's actually true.</p>
        ${f.progress ? `<p class="note">${escapeHtml(f.progress)}</p>` : ""}
        ${searchLinks}`;
    }
    if (f.status === "error") {
      return `
        <span class="pill muted-pill">Couldn't verify</span>
        <blockquote>${escapeHtml(f.sentence)}</blockquote>
        <p class="note">${jevLine}, but the Claude review failed: ${escapeHtml(f.error || "unknown error")}</p>
        ${searchLinks}`;
    }

    return reviewHtml(f, `${jevLine} · verified by Claude with web search.`, searchLinks);
  }

  const VERDICT_TEXT = {
    false: { pill: "False", why: "Why it's false", truth: "What's actually true" },
    misleading: { pill: "Misleading", why: "Why it's misleading", truth: "What's actually true" },
    true: { pill: "True", why: "Why it holds up", truth: "The facts" },
    unverifiable: { pill: "Unverifiable", why: "Why it can't be checked", truth: "What is known" },
  };

  // Claude's full explanation, for any verdict. `f` needs sentence and review.
  function reviewHtml(f, credit, actions) {
    const r = f.review;
    const t = VERDICT_TEXT[r.verdict] || VERDICT_TEXT.false;
    const confirmed = r.verdict === "false" || r.verdict === "misleading";
    const sources = (r.sources || [])
      .map((s) => ({ ...s, href: safeUrl(s.url) }))
      .filter((s) => s.href)
      .map((s) => {
        let host = "";
        try {
          host = new URL(s.href).hostname.replace(/^www\./, "");
        } catch {}
        return `<li><a target="_blank" rel="noopener" href="${escapeHtml(s.href)}">${escapeHtml(s.title || host)}</a>
                  <span class="host">${escapeHtml(host)}</span></li>`;
      })
      .join("");

    return `
      <span class="pill ${confirmed ? "" : "muted-pill"}">${t.pill}</span>
      <blockquote>${confirmed ? quoteWithClause(f) : escapeHtml(f.sentence)}</blockquote>
      ${r.whyFalse ? `<section><h3>${t.why}</h3>${prose(r.whyFalse)}</section>` : ""}
      ${r.actualTruth ? `<section class="truth"><h3>${t.truth}</h3>${prose(r.actualTruth)}</section>` : ""}
      ${r.fullPicture ? `<section><h3>The full picture</h3>${prose(r.fullPicture)}</section>` : ""}
      ${sources ? `<section><h3>Sources</h3><ul class="sources">${sources}</ul></section>` : ""}
      <p class="note">${credit} Claude can be wrong too — check the sources.</p>
      ${actions}`;
  }

  // ---------- Ctrl + right-click inspection of any sentence ----------

  let inspected = null; // { sentence, context, range, findRange, jev?, jevFailed?, phase, review?, error?, progress? }

  function inspectBody(st) {
    const q = encodeURIComponent(st.sentence);
    const search = `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}">Search the web</a>`;
    const jevP = st.jev ? pct(st.jev.probabilities?.false ?? 0) : "";
    const jevLine = st.jev
      ? `Jev: ${st.jev.choice === "false" ? "likely false" : "likely true"} (${jevP} likely false)`
      : "";

    if (st.phase === "jev") {
      return `
        <span class="pill muted-pill"><span class="spin"></span> Asking Jev</span>
        <blockquote>${escapeHtml(st.sentence)}</blockquote>`;
    }
    if (st.phase === "reviewing") {
      return `
        <span class="pill muted-pill"><span class="spin"></span> Claude is checking</span>
        <blockquote>${escapeHtml(st.sentence)}</blockquote>
        <p class="note">${jevLine}. Claude is researching it on the web.</p>
        ${st.progress ? `<p class="note">${escapeHtml(st.progress)}</p>` : ""}`;
    }
    if (st.phase === "done" && st.review) {
      return reviewHtml(st, `${jevLine} · checked by Claude with web search.`, `<div class="actions">${search}</div>`);
    }

    // Jev's verdict only; Claude not asked yet (or failed).
    const verdict = st.jevFailed
      ? `<span class="pill muted-pill">Jev unavailable</span>`
      : `<span class="pill ${st.jev.choice === "false" ? "" : "muted-pill"}">Jev: ${st.jev.choice === "false" ? "likely false" : "likely true"}</span>`;
    const bars = st.jev
      ? `<section><h3>Jev's read</h3><div class="bars">${["false", "true"]
          .map(
            (k) => `
          <div class="bar ${k}">
            <span>${k === "false" ? "False" : "True"}</span>
            <span class="track"><span class="fill" style="width:${pct(st.jev.probabilities?.[k])}"></span></span>
            <span class="num">${pct(st.jev.probabilities?.[k])}</span>
          </div>`
          )
          .join("")}</div></section>`
      : "";
    const why = st.jevFailed
      ? `Jev couldn't check this sentence${settings.apiKey ? "" : " (no Jev key set)"}.`
      : isSuspicious(st.jev)
        ? `At or above your ${pct(settings.threshold)} threshold, so it's sent to Claude.`
        : `Below your ${pct(settings.threshold)} threshold for sending to Claude, so Claude hasn't checked it.`;
    return `
      ${verdict}
      <blockquote>${escapeHtml(st.sentence)}</blockquote>
      ${bars}
      <p class="note">${why}</p>
      ${st.error ? `<p class="note">Claude review failed: ${escapeHtml(st.error)}</p>` : ""}
      <div class="actions">
        <button data-act="askClaude" ${settings.anthropicKey ? "" : "disabled"}>Ask Claude</button>
        ${search}
      </div>`;
  }

  function renderInspect() {
    if (!inspected) return;
    ensurePanel();
    panelIndex = -1;
    const body = shadow.querySelector(".body");
    const same = body.dataset.sentence === inspected.sentence;
    const scroll = body.scrollTop;
    body.innerHTML = inspectBody(inspected);
    body.dataset.sentence = inspected.sentence;
    if (same) body.scrollTop = scroll;
    shadow.querySelector(".pos").textContent = "Inspected sentence";
    shadow.querySelector(".panel").classList.remove("hidden");
    activeHighlight.clear();
    activeHighlight.add(inspected.range);
  }

  function inspect(info) {
    const i = liveFlags().findIndex((f) => f.sentence === info.sentence);
    if (i >= 0) return openPanel(i); // already flagged: show its claim panel

    const st = { ...info, phase: "jev" };
    inspected = st;
    renderInspect();
    // check() reuses the answer if this sentence was already screened.
    const done = (result) => {
      if (inspected !== st) return;
      st.jev = result;
      st.jevFailed = !result;
      st.phase = "jev-done";
      renderInspect();
    };
    if (running) check(st.sentence, st.context).then(done);
    else done(null);
  }

  function askClaude() {
    const st = inspected;
    if (!st || st.phase === "reviewing") return;
    st.phase = "reviewing";
    st.error = null;
    renderInspect();
    review(st.sentence, st.context).then((out) => {
      if (out.error) {
        st.error = out.error;
        st.phase = "jev-done";
      } else {
        st.review = out.review;
        st.phase = "done";
        // Underline it like any other confirmed claim.
        const v = out.review.verdict;
        if ((v === "false" || v === "misleading") && running && !flagged.some((f) => f.sentence === st.sentence)) {
          addFlag({ ...st, jev: st.jev || { choice: "false", probabilities: {} } });
        }
      }
      if (inspected === st && panelIndex < 0) renderInspect();
    });
  }

  function openPanel(index) {
    const list = liveFlags();
    if (!list.length) return;
    inspected = null;
    panelIndex = (index + list.length) % list.length;
    const f = list[panelIndex];
    ensurePanel();

    const body = shadow.querySelector(".body");
    const sameFlag = body.dataset.sentence === f.sentence;
    const scroll = body.scrollTop;
    body.innerHTML = panelBody(f);
    body.dataset.sentence = f.sentence;
    if (sameFlag) body.scrollTop = scroll; // status update while open: don't jump

    shadow.querySelector(".pos").textContent = `Claim ${panelIndex + 1} of ${list.length}`;
    shadow.querySelector(".panel").classList.remove("hidden");

    activeHighlight.clear();
    activeHighlight.add(f.hlRange);
    if (!sameFlag) {
      const rect = f.range.getBoundingClientRect();
      if (rect.top < 60 || rect.bottom > innerHeight - 60) {
        f.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  function closePanel() {
    activeHighlight.clear();
    panelIndex = -1;
    inspected = null;
    shadow?.querySelector(".panel").classList.add("hidden");
  }

  function step(d) {
    if (panelIndex >= 0) openPanel(panelIndex + d);
    else if (inspected && flagged.length) openPanel(d > 0 ? 0 : -1);
  }

  function dismissCurrent() {
    const f = liveFlags()[panelIndex];
    if (!f) return;
    const at = panelIndex;
    // Hide every occurrence of this sentence on the page.
    for (const g of flagged.filter((g) => g.sentence === f.sentence)) removeFlag(g);
    if (flagged.length) openPanel(Math.min(at, flagged.length - 1));
    else closePanel();
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && [p.offsetNode, p.offset];
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r && [r.startContainer, r.startOffset];
  }

  function flagAtPoint(x, y) {
    if (!flagged.length) return -1;
    const caret = caretAt(x, y);
    if (!caret) return -1;
    const list = liveFlags();
    return list.findIndex((f) => {
      try {
        return f.range.isPointInRange(caret[0], caret[1]);
      } catch {
        return false;
      }
    });
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!running || e.button !== 0 || e.composedPath().includes(host)) return;
      if (!getSelection().isCollapsed) return; // user is selecting text
      if (e.target.closest?.("a[href], button, input, select, textarea, label, summary")) return;
      const i = flagAtPoint(e.clientX, e.clientY);
      if (i >= 0) openPanel(i);
    },
    true
  );

  // Ctrl + right-click any sentence to see its verdict instead of the context menu.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!e.ctrlKey || e.composedPath().includes(host)) return;
      const info = sentenceAtPoint(e.clientX, e.clientY);
      if (!info) return;
      e.preventDefault();
      inspect(info);
    },
    true
  );

  // Pointer cursor when hovering an underlined claim.
  let hoverRaf = 0;
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!flagged.length || hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const over = flagAtPoint(e.clientX, e.clientY) >= 0;
        document.documentElement.style.cursor = over ? "pointer" : "";
      });
    },
    { passive: true }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (panelIndex < 0 && !inspected) return;
      if (e.key === "Escape" || e.key === "ArrowRight") closePanel();
      else if (e.key === "ArrowDown" && e.altKey) step(1);
      else if (e.key === "ArrowUp" && e.altKey) step(-1);
    },
    true
  );

  // ---------- messages from popup ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "listFlags") {
      sendResponse({
        running,
        halted,
        stats,
        flags: liveFlags().map((f) => ({
          sentence: f.sentence,
          status: f.status,
          clause: f.review?.falseText || "",
          truth: f.review?.actualTruth || "",
        })),
      });
    } else if (msg?.type === "reviewProgress") {
      if (inspected?.sentence === msg.sentence && inspected.phase === "reviewing") {
        inspected.progress = msg.note;
        renderInspect();
      }
      for (const f of flagged) {
        if (f.sentence !== msg.sentence || f.status !== "reviewing") continue;
        f.progress = msg.note;
        if (panelIndex >= 0 && liveFlags()[panelIndex] === f) openPanel(panelIndex);
      }
    } else if (msg?.type === "focusFlag") {
      openPanel(msg.index);
      sendResponse({ ok: true });
    }
  });

  // ---------- boot ----------

  chrome.storage.sync.get(SETTINGS_DEFAULTS, (s) => {
    settings = { ...SETTINGS_DEFAULTS, ...s };
    if (shouldRun()) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in SETTINGS_DEFAULTS) settings[k] = newValue ?? SETTINGS_DEFAULTS[k];
    }
    applySettings();
  });
})();

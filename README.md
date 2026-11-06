# TruthScreen

A Chrome extension that underlines false claims on any website and explains them.

1. **Jev screens every sentence** you scroll past. Jev is TypeSafe's fast decision model. It's called directly on
   TypeSafe's API by default, or via OpenRouter.
2. **Claude verifies anything suspicious.** Claude (Haiku 4.5 by default; Opus 5.5 optional) researches the sentence with web search, pinpoints the
   false clause, and explains why it's false, what's actually true, and the full picture, with sources.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the **`extension/`** folder.
3. The settings page opens. Add:
   - a Jev key: TypeSafe from [console.typesafe.ai](https://console.typesafe.ai/settings/keys) (default), or
     OpenRouter from [openrouter.ai/keys](https://openrouter.ai/keys);
   - an Anthropic key from [platform.claude.com](https://platform.claude.com/settings/keys).
4. Click **Test Jev** and **Test Claude**.
5. Open any article, or `demo.html`. For the demo, first turn on "Allow access to file URLs" in the extension's details.

## How it works

- `extension/src/content.js` groups the page's text into blocks and splits them into sentences with `Intl.Segmenter`.
  It only checks blocks that scroll near the viewport. Questions, fragments and UI text are skipped.
- `extension/src/background.js` sends each sentence (plus the page title, URL and surrounding paragraph) to Jev as a
  true/false **choice** question. Opinions and unverifiable claims count as true.
- If Jev gives P(false) ≥ the threshold (default 30%), the sentence gets a faint **dotted** underline and goes to
  `extension/src/claude.js`. That module calls Claude with web search and a strict `report_verdict` tool, which
  returns `false` / `misleading` / `true` / `unverifiable`, the exact false clause, why it's false, what's actually
  true, the full picture, and sources.
- When Claude reviews a sentence:

  | Claude's verdict | Underline |
  |---|---|
  | `false` | solid underline on just the false clause |
  | `misleading` | dashed underline on the misleading clause |
  | `true` / `unverifiable` | removed |

- Underlines use the CSS Custom Highlight API, so the page DOM is never modified.
- Jev verdicts and Claude reviews are cached in `chrome.storage.local`, so each sentence is paid for once.
- **Ctrl + right-click any sentence** (on macOS, Ctrl+click also works) to see its verdict, even if it isn't underlined.
  The panel shows Jev's read, and you can click **Ask Claude** for a full check of any sentence.
- Click an underline to open the side panel with Claude's explanation. `Esc` / `→` closes it, and `Alt+↑/↓` moves
  between claims.

## Seeing what it checked

- **Toolbar popup:** a live status line, e.g. `Jev screened 40 of 42 sentences. 3 sent to Claude: 2 confirmed,
  1 cleared.`, plus a list of the claims on the page.
- **Checked sentences page** (`log.html`): every sentence with Jev's verdict and P(false), and Claude's verdict and
  explanation. You can filter it, search it, and export it as JSON.
- **Console:** each verdict is logged to the page console under `[TruthScreen]` (Verbose level).

## Development

The Anthropic TypeScript SDK is bundled into `extension/src/vendor/anthropic-sdk.js`, so the extension loads without a
build step. To update the SDK, run `npm install && npm run build`.

## Limits

- **Cost and speed:** a Claude review with web search costs far more than a Jev screen and takes a while (Haiku is fastest).
  Raise the threshold to send fewer sentences to Claude.
- **Keys:** API keys are stored in Chrome sync storage and used directly from the extension's service worker.
- **Browser:** requires Chrome 105+.

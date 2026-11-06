import Anthropic from "./vendor/anthropic-sdk.js";

// Second stage: Jev flagged a sentence as suspicious; Claude researches it and explains.

const SYSTEM = `You are the fact-checker inside TruthScreen, a browser extension that underlines false statements on web pages.

A fast screening model flagged one sentence from a page as possibly false. Your job is to check it carefully and explain it to the reader.

Work like this:
1. Work out exactly what the sentence claims, using the surrounding context to resolve references ("he", "the company", "last year"). Judge it as of today's date, given in the request.
2. Use web search to verify the claim against reliable, primary or authoritative sources. Search more than once if the first results are thin or conflicting.
3. Call report_verdict exactly once with your conclusion. Do not write a final answer outside the tool call.

Verdicts. Decide in this order and stop at the first that applies:
1. "false": any factual assertion in the sentence is wrong. This includes a wrong number, date, name, place, ranking, cause, attribution or quote, an event that didn't happen, or something that was true once but no longer is and the sentence states it as current. One wrong clause makes the verdict "false" even if the rest of the sentence is accurate; put that clause in false_text.
2. "misleading": every factual assertion in the sentence is literally accurate, yet a typical reader would come away believing something false, for example because of a cherry-picked statistic or an omitted fact that reverses the meaning. If you can name a specific statement in the sentence that is incorrect, the verdict is "false", not "misleading".
3. "true": the claim holds up. The screening model was wrong.
4. "unverifiable": you could not establish either way, or it is opinion rather than a factual claim.

Examples:
- "The Great Wall of China is visible from the Moon." → false (it is not visible from the Moon).
- "Einstein won the Nobel Prize for relativity." → false (it was for the photoelectric effect).
- "Crime rose 50% last year," when it rose 50% in one small district but fell nationally, in an article about national crime → misleading.
Use "misleading" sparingly; most errors are simply "false".

Writing for the reader: plain language, no hedging filler, specific numbers, dates and names. The reader sees why_false, actual_truth and full_picture in a narrow side panel, so keep each tight: a few sentences, or short bullet points when that reads better.

Tone: correct the claim, not the people. Never be crass, mocking, sarcastic or insulting toward anyone involved: the people the sentence is about, the author, or anyone who believes the claim. Don't call people liars, stupid, or gullible, or speculate about their motives. Describe what is wrong with the claim itself, neutrally and respectfully, the way a careful reference work would. Be direct about the facts without being harsh about people. Tone governs only how you word the explanation, never the verdict: a wrong claim is "false" however politely you explain it.`;

const REPORT_TOOL = {
  name: "report_verdict",
  description: "Report the fact-check result for the sentence. Call exactly once, after researching.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "false_text", "why_false", "actual_truth", "full_picture", "sources"],
    properties: {
      verdict: { type: "string", enum: ["false", "misleading", "true", "unverifiable"] },
      false_text: {
        type: "string",
        description:
          "The shortest exact substring of the sentence (copied character for character) that is false or misleading. " +
          "Use the whole sentence if the whole thing is wrong. Empty string if the verdict is true or unverifiable.",
      },
      why_false: {
        type: "string",
        description: "Why the claim is false or misleading. For true/unverifiable, briefly why it holds up or can't be checked.",
      },
      actual_truth: {
        type: "string",
        description: "What is actually true, stated as a direct correction of the claim.",
      },
      full_picture: {
        type: "string",
        description:
          "The broader context a reader needs: where the misconception comes from, nuance, what is still debated, and anything that changed over time.",
      },
      sources: {
        type: "array",
        description: "The most useful sources you relied on, best first (at most 5).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url"],
          properties: { title: { type: "string" }, url: { type: "string" } },
        },
      },
    },
  },
};

export class ClaudeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function userPrompt(item) {
  return [
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Page title: ${item.title || "(none)"}`,
    `Page URL: ${item.url || "(none)"}`,
    "",
    "Surrounding text:",
    `<context>\n${item.context || ""}\n</context>`,
    "",
    "Sentence flagged as possibly false:",
    `<sentence>\n${item.sentence}\n</sentence>`,
  ].join("\n");
}

// Server-side web search can pause long turns; resume up to this many times.
const MAX_CONTINUATIONS = 3;

// Request settings that differ by model family.
function modelParams(model) {
  if (model.startsWith("claude-haiku")) {
    // Haiku 4.5: basic web search, no effort control, no server-side fallback; skip thinking for speed.
    return {
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }, REPORT_TOOL],
    };
  }
  return {
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, REPORT_TOOL],
  };
}

/**
 * @param {(note: string) => void} [onProgress] called with short status notes, e.g. the web searches Claude runs.
 */
export async function reviewWithClaude({ apiKey, model }, item, onProgress = () => {}) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  const messages = [{ role: "user", content: userPrompt(item) }];

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    let response;
    try {
      // Streaming keeps bytes flowing, so Chrome doesn't kill the service worker on a slow response.
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tool_choice: { type: "auto" },
        messages,
        ...modelParams(model),
      });
      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
          onProgress(`Searching: ${block.input.query}`);
        } else if (block.type === "web_search_tool_result") {
          onProgress("Reading results…");
        }
      });
      response = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new ClaudeError("Anthropic rejected the API key.", "auth");
      if (e instanceof Anthropic.PermissionDeniedError) throw new ClaudeError("Anthropic API key lacks access to this model.", "auth");
      if (e instanceof Anthropic.RateLimitError) throw new ClaudeError("Rate limited by Anthropic.", "rate_limit");
      if (e instanceof Anthropic.BadRequestError) throw new ClaudeError(`Claude request rejected: ${e.message}`, "http");
      if (e instanceof Anthropic.APIError) throw new ClaudeError(`Claude API error ${e.status ?? ""}: ${e.message}`, "http");
      throw new ClaudeError(`Could not reach Claude: ${e.message}`, "network");
    }

    if (response.stop_reason === "refusal") {
      throw new ClaudeError("Claude declined to review this sentence.", "refusal");
    }

    const report = response.content.find((b) => b.type === "tool_use" && b.name === "report_verdict");
    if (report) {
      const input = typeof report.input === "string" ? JSON.parse(report.input) : report.input;
      return {
        verdict: input.verdict,
        falseText: input.false_text,
        whyFalse: input.why_false,
        actualTruth: input.actual_truth,
        fullPicture: input.full_picture,
        sources: (input.sources || []).slice(0, 5),
        model: response.model,
      };
    }

    // Append the assistant turn unchanged so a paused server-tool loop can resume.
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: "Call report_verdict now with your conclusion." });
    }
  }
  throw new ClaudeError("Claude did not return a verdict.", "shape");
}

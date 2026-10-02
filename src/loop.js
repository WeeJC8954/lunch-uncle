import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// OpenCode Go (https://opencode.ai/docs/go/). GPT Luna models are served on
// the OpenAI Responses API (/responses), not chat completions.
const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
const LLM_MODEL = "gpt-6-luna";

// Reasoning models like gpt-6-luna can take a while on multi-step questions.
const LLM_TIMEOUT_MS = 60_000;
const MAX_ROUNDS = 8;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";
const FOOD_WORDS = /\b(eat|lunch|food|makan|hungry|restaurant|hawker)\b/i;

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 */
export async function runLoop(history, message, env) {
  // If the Places key is missing, Uncle cannot search for food, so give a safe
  // answer. Rain and bus questions still work without it.
  if (!env.GOOGLE_PLACES_API_KEY && FOOD_WORDS.test(message)) {
    return FALLBACK_REPLY;
  }

  // The Responses API takes the system prompt as `instructions`, and the
  // conversation as `input` items. Plain {role, content} messages are valid
  // input items, so the browser's history passes through unchanged.
  const input = [...history, { role: "user", content: message }];

  // One session id per turn, shared by every model call in this loop run,
  // so the OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  let round = 0;
  while (round < MAX_ROUNDS) {
    const output = await callModel(input, env, sessionId);
    // Feed every output item (reasoning, function calls, messages) back in,
    // so the model sees its own previous turn on the next round.
    input.push(...output);

    const toolCalls = output.filter((item) => item.type === "function_call");
    if (toolCalls.length === 0) {
      return outputText(output);
    }

    for (const call of toolCalls) {
      const args = parseArgs(call.arguments);
      console.log(`round ${round}: ${call.name}`, args);
      const result = await executeTool(call.name, args, env);
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }

    round++;
  }

  return "Uncle tried too many times already. Ask something simpler.";
}

// The Responses API wants flat function tools ({type, name, description,
// parameters}) rather than the chat-completions {type, function: {...}} shape.
const responseTools = toolDefinitions.map((tool) => ({
  type: "function",
  ...tool.function,
}));

async function callModel(input, env, sessionId) {
  const res = await fetch(`${LLM_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      instructions: buildSystemPrompt(),
      input,
      tools: responseTools,
      // Stay stateless: nothing is stored server-side, so reasoning items must
      // carry their encrypted content to be replayed on the next round.
      store: false,
      include: ["reasoning.encrypted_content"],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.output;
}

function outputText(output) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

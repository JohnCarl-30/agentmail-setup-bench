import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import { createModelAgent, resolveModel } from "./model-agent.ts";
import { createToolBox } from "./tools.ts";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

type Content = Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: string }>;

/** A model that plays back a fixed list of turns, one per call. */
function scriptedModel(turns: Content[]) {
  let turn = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const content = turns[Math.min(turn, turns.length - 1)] ?? [];
      turn += 1;
      const calledTool = content.some((part) => part.type === "tool-call");
      return { content, finishReason: { unified: calledTool ? "tool-calls" : "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { model, prompts };
}

function toolBox() {
  const requests: string[] = [];
  const tools = createToolBox({
    allow: () => true,
    sleep: async () => {},
    fetch: (async (input: URL | RequestInfo) => {
      requests.push(String(input));
      return new Response('{"inbox_id":"inb_1"}', { status: 200 });
    }) as typeof fetch,
  });
  return { tools, requests };
}

describe("the model agent", () => {
  it("runs the model's tool calls through the recorded tools until the model stops", async () => {
    const { model, prompts } = scriptedModel([
      [
        { type: "text", text: "I will create the inbox first." },
        { type: "tool-call", toolCallId: "c1", toolName: "http_request", input: JSON.stringify({ method: "POST", url: "https://api.agentmail.to/v0/inboxes", body: "{}" }) },
      ],
      [{ type: "tool-call", toolCallId: "c2", toolName: "wait", input: JSON.stringify({ seconds: 2 }) }],
      [{ type: "text", text: "All four things are done." }],
    ]);
    const { tools, requests } = toolBox();

    const outcome = await createModelAgent({ model })("Set up AgentMail.", tools, new AbortController().signal);

    assert.deepEqual(requests, ["https://api.agentmail.to/v0/inboxes"]);
    assert.deepEqual(tools.trace.map((step) => step.tool), ["http_request", "wait"]);
    assert.equal(outcome.finishReason, "stop");
    assert.equal(outcome.text, "All four things are done.");
    assert.equal(outcome.steps, 3);
    assert.deepEqual(outcome.notes, ["I will create the inbox first.", "All four things are done."]);
    assert.deepEqual(outcome.usage, { inputTokens: 300, outputTokens: 60 });
    // The model saw the tool's result on its next turn.
    assert.match(JSON.stringify(prompts[1]), /inb_1/);
  });

  it("stops an agent that is still calling tools at the step limit, and says so", async () => {
    const { model } = scriptedModel([[{ type: "tool-call", toolCallId: "c", toolName: "wait", input: JSON.stringify({ seconds: 1 }) }]]);
    const { tools } = toolBox();

    const outcome = await createModelAgent({ model, maxSteps: 3 })("Wait forever.", tools, new AbortController().signal);

    assert.equal(outcome.finishReason, "step-limit");
    assert.equal(outcome.steps, 3);
    assert.equal(tools.trace.length, 3);
  });
});

describe("resolveModel", () => {
  it("rejects a name without a provider, and an unknown provider", async () => {
    await assert.rejects(resolveModel("claude-opus-5-5"), /provider:model/);
    await assert.rejects(resolveModel("mystery:model-1"), /Unknown provider "mystery"/);
  });
});

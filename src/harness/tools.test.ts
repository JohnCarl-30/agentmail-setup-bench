import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAllow } from "./run.ts";
import { score } from "./score.ts";
import { createToolBox, redact } from "./tools.ts";

const allow = createAllow(["https://referee.example", "https://docs.agentmail.to/llms.txt"]);

function toolBox(responses: Record<string, string> = {}) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const slept: number[] = [];
  const tools = createToolBox({
    allow,
    maxBodyChars: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body });
      return new Response(responses[String(input)] ?? "ok", { status: 200 });
    }) as typeof fetch,
  });
  return { tools, calls, slept };
}

describe("the agent's http_request tool", () => {
  it("makes the request and records it", async () => {
    const { tools, calls } = toolBox();

    const output = await tools.http({ method: "post", url: "https://api.agentmail.to/v0/inboxes", body: "{}" });

    assert.deepEqual(output, { status: 200, body: "ok" });
    assert.deepEqual(calls, [{ url: "https://api.agentmail.to/v0/inboxes", method: "POST", body: "{}" }]);
    assert.equal(tools.trace.length, 1);
    assert.equal(tools.trace[0]?.tool, "http_request");
  });

  it("refuses a host outside the task without calling it, and says why", async () => {
    const { tools, calls } = toolBox();

    const output = await tools.http({ method: "GET", url: "https://example.com/" });

    assert.match(output.error ?? "", /example\.com are not allowed/);
    assert.deepEqual(calls, []);
    // A refusal is part of what the agent did, so it is in the trace.
    assert.equal(tools.trace.length, 1);
  });

  it("explains a bad method or a partial URL instead of throwing", async () => {
    const { tools } = toolBox();

    assert.match((await tools.http({ method: "TRACE", url: "https://api.agentmail.to/" })).error ?? "", /Unsupported method/);
    assert.match((await tools.http({ method: "GET", url: "/v0/inboxes" })).error ?? "", /not a full URL/);
  });

  it("cuts a long response and says how much was cut", async () => {
    const { tools } = toolBox({ "https://docs.agentmail.to/llms.txt": "0123456789ABCDEFGHIJ" });

    const output = await tools.http({ method: "GET", url: "https://docs.agentmail.to/llms.txt" });

    assert.equal(output.body, "0123456789\n[cut: 10 more characters]");
  });

  it("turns a network failure into an error the agent can read", async () => {
    const tools = createToolBox({
      allow,
      fetch: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });

    assert.deepEqual(await tools.http({ method: "GET", url: "https://api.agentmail.to/v0/inboxes" }), { error: "The request failed: socket hang up" });
  });
});

describe("the agent's wait tool", () => {
  it("waits, up to a cap, and never a negative time", async () => {
    const { tools, slept } = toolBox();

    assert.deepEqual(await tools.wait(5), { waited: 5 });
    assert.deepEqual(await tools.wait(600), { waited: 30 });
    assert.deepEqual(await tools.wait(-3), { waited: 0 });
    assert.deepEqual(slept, [5_000, 30_000, 0]);
  });
});

describe("which addresses an agent may call", () => {
  it("allows AgentMail's sites and the named hosts over https only", () => {
    assert.equal(allow(new URL("https://api.agentmail.to/v0/inboxes")), true);
    assert.equal(allow(new URL("https://docs.agentmail.to/llms.txt")), true);
    assert.equal(allow(new URL("https://referee.example/runs/1/secret")), true);
    assert.equal(allow(new URL("http://api.agentmail.to/v0/inboxes")), false);
    assert.equal(allow(new URL("https://agentmail.to.evil.example/")), false);
    assert.equal(allow(new URL("https://notagentmail.to/")), false);
  });

  it("allows plain http only for a local address that was named", () => {
    const local = createAllow(["http://127.0.0.1:8787"]);

    assert.equal(local(new URL("http://127.0.0.1:8787/runs/1/webhook")), true);
    assert.equal(local(new URL("http://127.0.0.1:9999/")), false);
  });
});

describe("redact", () => {
  it("replaces the API key and any webhook secret wherever they sit", () => {
    const value = { headers: { authorization: "Bearer am_secret" }, nested: [{ body: '{"secret":"whsec_YWJj+/=="}' }], note: "am_secret again" };

    assert.deepEqual(redact(value, ["am_secret"]), {
      headers: { authorization: "Bearer [REDACTED_API_KEY]" },
      nested: [{ body: '{"secret":"[REDACTED_WEBHOOK_SECRET]"}' }],
      note: "[REDACTED_API_KEY] again",
    });
  });

  it("handles a key with characters JSON escapes", () => {
    assert.deepEqual(redact({ text: 'key "a\\b" here' }, ['"a\\b"']), { text: "key [REDACTED_API_KEY] here" });
  });
});

describe("score", () => {
  const all = { inboxCreated: true, webhookRegistered: true, secretReceived: true, testEmailDelivered: true, replied: true, repliedInThread: true };

  it("passes only when all four steps are confirmed", () => {
    assert.deepEqual(score(all), { passed: true, stepsReached: 4, steps: { inbox: true, webhook: true, secret: true, reply: true } });
  });

  it("counts steps in order and stops at the first miss", () => {
    assert.equal(score({ ...all, inboxCreated: false }).stepsReached, 0);
    assert.equal(score({ ...all, webhookRegistered: false }).stepsReached, 1);
    assert.equal(score({ ...all, testEmailDelivered: false }).stepsReached, 2);
    assert.equal(score({ ...all, repliedInThread: false }).stepsReached, 3);
  });

  // A later step done right does not rescue an earlier one that was missed.
  it("does not credit a reply when the webhook was never registered", () => {
    const result = score({ ...all, webhookRegistered: false });

    assert.equal(result.passed, false);
    assert.equal(result.steps.reply, true);
    assert.equal(result.stepsReached, 1);
  });

  it("does not count a secret that was received but never verified a delivery", () => {
    assert.equal(score({ ...all, testEmailDelivered: false }).steps.secret, false);
  });
});

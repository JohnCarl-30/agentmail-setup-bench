import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { createApp } from "../app.ts";
import { Store } from "../store.ts";
import { createAgentMail, type AgentMail } from "./agentmail.ts";
import { createAllow, createRefereeClient, runOnce, type Agent, type RunDeps, type RunResult } from "./run.ts";
import { startFakeAgentMail, type FakeAgentMail } from "./testing/fake-agentmail.ts";

const API_KEY = "am_test_key_that_must_never_be_saved";
const ADMIN = "an-admin-token-for-tests";

let referee: Server;
let refereeUrl: string;
let fake: FakeAgentMail;
let agentMail: AgentMail;
let seedInboxId: string;

before(async () => {
  referee = createServer(createApp({ store: new Store(":memory:"), adminToken: ADMIN }));
  await new Promise<void>((resolve) => referee.listen(0, resolve));
  refereeUrl = `http://127.0.0.1:${(referee.address() as AddressInfo).port}`;
  fake = await startFakeAgentMail({ apiKey: API_KEY });
  agentMail = createAgentMail({ apiKey: API_KEY, baseUrl: fake.url });
  seedInboxId = (await agentMail.createInbox({ client_id: "setup-bench-seed" })).inbox_id;
});

after(async () => {
  referee.close();
  await fake.close();
});

interface Behaviour {
  inbox?: boolean;
  /** Event types to register the webhook with, or null to register none. */
  eventTypes?: string[] | null;
  webhookUrl?: (given: string) => string;
  secret?: "right" | "wrong" | "none";
  reply?: "thread" | "new-email" | "none";
}

/** An agent that does exactly what it is told, so each way of failing can be tested on purpose. */
function scripted(behaviour: Behaviour = {}): Agent {
  return async (task, tools) => {
    const webhookUrl = /deliver to: (\S+)/.exec(task)?.[1] ?? "";
    const secretUrl = /secret to (\S+) as JSON/.exec(task)?.[1] ?? "";
    const key = /API key: (\S+)/.exec(task)?.[1] ?? "";
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const call = async (method: string, url: string, body?: unknown) => {
      const output = await tools.http({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return JSON.parse(output.body || "null") as Record<string, any>;
    };

    if (behaviour.inbox === false) {
      return { finishReason: "stop", text: "I could not find how to create an inbox." };
    }
    const inbox = await call("POST", `${fake.url}/inboxes`, {});
    const eventTypes = behaviour.eventTypes === undefined ? ["message.received"] : behaviour.eventTypes;
    if (eventTypes) {
      const url = behaviour.webhookUrl ? behaviour.webhookUrl(webhookUrl) : webhookUrl;
      const webhook = await call("POST", `${fake.url}/inboxes/${inbox.inbox_id}/webhooks`, { url, event_types: eventTypes });
      const secret = behaviour.secret ?? "right";
      if (secret !== "none") {
        await tools.http({ method: "POST", url: secretUrl, body: JSON.stringify({ secret: secret === "right" ? webhook.secret : "whsec_bm90LXRoZS1yZWFsLW9uZQ==" }) });
      }
    }

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await call("GET", `${fake.url}/inboxes/${inbox.inbox_id}/messages`);
      const received = (list.messages as Array<Record<string, any>>).find((message) => message.labels.includes("received"));
      if (received) {
        if (behaviour.reply === "new-email") {
          await call("POST", `${fake.url}/inboxes/${inbox.inbox_id}/messages/send`, { to: [received.from], subject: "About your test", text: "Got it." });
        } else if (behaviour.reply !== "none") {
          await call("POST", `${fake.url}/inboxes/${inbox.inbox_id}/messages/${received.message_id}/reply`, { text: "Got it." });
        }
        break;
      }
      await tools.wait(1);
    }
    return { finishReason: "stop", text: "All four things are done." };
  };
}

function run(agent: Agent, overrides: Partial<RunDeps> = {}): Promise<RunResult> {
  return runOnce({
    agentMail,
    referee: createRefereeClient({ url: refereeUrl, adminToken: ADMIN }),
    agent,
    model: "scripted",
    apiKey: API_KEY,
    seedInboxId,
    refereePublicUrl: refereeUrl,
    docsUrl: "https://docs.agentmail.to/llms.txt",
    allow: createAllow([refereeUrl, fake.url]),
    pollMs: 10,
    sendAfterMs: 80,
    graceMs: 400,
    // The test agent's "wait 1 second" becomes a few milliseconds.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15))),
    ...overrides,
  });
}

describe("a run, end to end against a fake AgentMail and the real referee", () => {
  it("passes an agent that does all four steps", async () => {
    const result = await run(scripted());

    assert.deepEqual(result.score, { passed: true, stepsReached: 4, steps: { inbox: true, webhook: true, secret: true, reply: true } });
    assert.equal(result.details.testEmailTrigger, "webhook-registered");
    assert.deepEqual(result.details.harnessErrors, []);
    assert.equal(result.details.referee?.result.testEmailDelivered, true);
    assert.equal(result.agent.finishReason, "stop");
    assert.ok(result.agent.toolCalls >= 5);
    assert.equal(result.trace.length, result.agent.toolCalls);
  });

  it("stops at step 0 for an agent that creates nothing", async () => {
    const result = await run(scripted({ inbox: false }));

    assert.equal(result.score.stepsReached, 0);
    assert.equal(result.score.passed, false);
    assert.equal(result.details.testEmailSent, false);
  });

  // The docs say event_types has no default; an agent that picks the wrong event gets no delivery.
  it("fails the webhook step when the webhook is for the wrong event", async () => {
    const result = await run(scripted({ eventTypes: ["message.sent"] }));

    assert.equal(result.score.stepsReached, 1);
    assert.equal(result.evidence.webhookRegistered, false);
    // The email still goes out after the wait, so the reply is judged on its own.
    assert.equal(result.details.testEmailTrigger, "waited");
    assert.equal(result.evidence.repliedInThread, true);
  });

  it("fails the webhook step when it points somewhere else", async () => {
    const result = await run(scripted({ webhookUrl: (given) => `${given}-typo` }));

    assert.equal(result.score.stepsReached, 1);
    assert.equal(result.evidence.webhookRegistered, false);
  });

  it("fails the secret step when no secret is handed over, though the delivery arrived", async () => {
    const result = await run(scripted({ secret: "none" }));

    assert.equal(result.score.stepsReached, 2);
    assert.equal(result.evidence.secretReceived, false);
    assert.equal(result.details.referee?.deliveries.length, 1);
  });

  it("fails the secret step when the wrong secret is handed over", async () => {
    const result = await run(scripted({ secret: "wrong" }));

    assert.equal(result.score.stepsReached, 2);
    assert.equal(result.evidence.secretReceived, true);
    assert.equal(result.evidence.testEmailDelivered, false);
  });

  it("fails the reply step when the agent sends a new email instead of replying", async () => {
    const result = await run(scripted({ reply: "new-email" }));

    assert.equal(result.score.stepsReached, 3);
    assert.equal(result.evidence.replied, true);
    assert.equal(result.evidence.repliedInThread, false);
  });

  it("fails the reply step when the agent never replies", async () => {
    const result = await run(scripted({ reply: "none" }));

    assert.equal(result.score.stepsReached, 3);
    assert.equal(result.evidence.replied, false);
  });
});

describe("what a run leaves behind", () => {
  it("never saves the API key or a webhook secret, even inside the agent's own requests", async () => {
    const result = await run(scripted());
    const saved = JSON.stringify(result);

    assert.ok(!saved.includes(API_KEY));
    assert.ok(!saved.includes("whsec_"));
    assert.ok(saved.includes("[REDACTED_API_KEY]"));
    assert.ok(saved.includes("[REDACTED_WEBHOOK_SECRET]"));
    // The task is saved too, so a reader can see exactly what the agent was told.
    assert.match(result.task, /Your AgentMail API key: \[REDACTED_API_KEY\]/);
  });

  it("deletes the inbox the agent made, and keeps the harness's own", async () => {
    await run(scripted());

    assert.deepEqual([...fake.inboxes.keys()], [seedInboxId]);
  });

  it("records an agent that crashes as a failed run, not a failed harness", async () => {
    const result = await run(async () => {
      throw new Error("the model provider is down");
    });

    assert.equal(result.agent.finishReason, "error");
    assert.equal(result.agent.error, "the model provider is down");
    assert.equal(result.score.stepsReached, 0);
  });

  it("stops an agent that runs past the time limit", async () => {
    const forever: Agent = (_task, _tools, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error)));

    const result = await run(forever, { maxMs: 60 });

    assert.equal(result.agent.finishReason, "error");
    assert.match(result.agent.error ?? "", /limit of 60 ms/);
  });

  // If the harness cannot see the outcome, the result must say so instead of blaming the agent.
  it("notes its own failures separately from the agent's", async () => {
    const brokenReferee = createRefereeClient({ url: refereeUrl, adminToken: ADMIN });
    const result = await run(scripted(), {
      referee: { createRun: brokenReferee.createRun, report: () => Promise.reject(new Error("referee unreachable")) },
      graceMs: 30,
    });

    assert.equal(result.details.referee, null);
    assert.ok(result.details.harnessErrors.some((error) => error.includes("referee unreachable")));
    assert.equal(result.score.passed, false);
  });
});

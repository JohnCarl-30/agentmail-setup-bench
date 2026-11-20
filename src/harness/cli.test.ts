import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMail, Inbox } from "./agentmail.ts";
import { findOrCreateSeed, parseArgs } from "./cli.ts";

describe("parseArgs", () => {
  it("reads the model, and defaults to one run saved under results", () => {
    assert.deepEqual(parseArgs(["--model", "anthropic:claude-opus-5-5"]), { model: "anthropic:claude-opus-5-5", runs: 1, out: "results" });
  });

  it("reads the number of runs and the output folder", () => {
    assert.deepEqual(parseArgs(["--runs", "10", "--out", "tmp", "--model", "openai:some-model"]), { model: "openai:some-model", runs: 10, out: "tmp" });
  });

  // Each run spends real tokens, so a mistyped count must stop the command, not start it.
  it("refuses a missing model, a bad run count and an unknown option", () => {
    assert.throws(() => parseArgs([]), /Say which model/);
    assert.throws(() => parseArgs(["--model", "a:b", "--runs", "0"]), /1 to 50/);
    assert.throws(() => parseArgs(["--model", "a:b", "--runs", "many"]), /1 to 50/);
    assert.throws(() => parseArgs(["--model", "a:b", "--runs", "500"]), /1 to 50/);
    assert.throws(() => parseArgs(["--modle", "a:b"]), /Unknown or incomplete option "--modle"/);
    assert.throws(() => parseArgs(["--model"]), /Unknown or incomplete option "--model"/);
  });
});

describe("findOrCreateSeed", () => {
  const inbox = (id: string, clientId?: string): Inbox => ({ inbox_id: id, email: `${id}@agentmail.to`, created_at: "2026-11-20T00:00:00Z", client_id: clientId });

  it("reuses the harness's inbox when it already exists", async () => {
    let created = 0;
    const agentMail = {
      listInboxes: async () => [inbox("other"), inbox("seed", "setup-bench-seed")],
      createInbox: async () => {
        created += 1;
        return inbox("new");
      },
    } as unknown as AgentMail;

    assert.equal((await findOrCreateSeed(agentMail)).inbox_id, "seed");
    assert.equal(created, 0);
  });

  it("creates it, tagged, when it does not exist", async () => {
    const bodies: unknown[] = [];
    const agentMail = {
      listInboxes: async () => [inbox("other")],
      createInbox: async (body: unknown) => {
        bodies.push(body);
        return inbox("new", "setup-bench-seed");
      },
    } as unknown as AgentMail;

    assert.equal((await findOrCreateSeed(agentMail)).inbox_id, "new");
    assert.deepEqual(bodies, [{ client_id: "setup-bench-seed", display_name: "Setup bench" }]);
  });

  it("uses an inbox the account already has when one is named, and creates nothing", async () => {
    let created = 0;
    const agentMail = {
      listInboxes: async () => [inbox("other"), inbox("seed", "setup-bench-seed")],
      createInbox: async () => {
        created += 1;
        return inbox("new");
      },
    } as unknown as AgentMail;

    assert.equal((await findOrCreateSeed(agentMail, "Other@agentmail.to")).inbox_id, "other");
    assert.equal(created, 0);
    // A mistyped name must stop the command instead of quietly making a new inbox.
    await assert.rejects(findOrCreateSeed(agentMail, "nobody@agentmail.to"), /no such inbox/);
    assert.equal(created, 0);
  });
});

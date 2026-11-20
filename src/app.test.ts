import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { createApp, type RunReport } from "./app.ts";
import { Store } from "./store.ts";
import { signSvix } from "./svix.ts";

const ADMIN = "an-admin-token-for-tests";
const SECRET = `whsec_${Buffer.from("the-webhook-signing-key").toString("base64")}`;
const WRONG_SECRET = `whsec_${Buffer.from("some-other-key").toString("base64")}`;
const NONCE = "bench-nonce-7f3a";

let server: Server;
let base: string;
let clock: Date;

before(async () => {
  // A cap of 3 deliveries per run and 2 KB per body, so the limits are cheap to hit.
  const app = createApp({ store: new Store(":memory:", 3), adminToken: ADMIN, now: () => clock, maxBodyBytes: 2_000 });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  clock = new Date("2026-11-20T12:00:00Z");
});

const admin = { authorization: `Bearer ${ADMIN}` };

async function createRun(nonce: string | undefined = NONCE): Promise<string> {
  const response = await fetch(`${base}/runs`, { method: "POST", headers: admin, body: nonce ? JSON.stringify({ nonce }) : "" });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}

function giveSecret(runId: string, secret: unknown): Promise<Response> {
  return fetch(`${base}/runs/${runId}/secret`, { method: "POST", body: JSON.stringify({ secret }) });
}

/** A delivery as Svix would send it: signed over the exact bytes, stamped with the current clock. */
function deliver(runId: string, options: { id?: string; body?: string; secret?: string; headers?: boolean; ageSeconds?: number } = {}) {
  const body = Buffer.from(options.body ?? JSON.stringify({ event_type: "message.received", message: { inbox_id: "inbox_1", message_id: "m_1", subject: NONCE } }));
  const id = options.id ?? "msg_1";
  const timestamp = String(Math.floor(clock.getTime() / 1000) - (options.ageSeconds ?? 0));
  const headers: Record<string, string> =
    options.headers === false
      ? {}
      : { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signSvix(options.secret ?? SECRET, id, timestamp, body) };
  return fetch(`${base}/runs/${runId}/webhook`, { method: "POST", headers, body });
}

async function report(runId: string): Promise<RunReport> {
  const response = await fetch(`${base}/runs/${runId}`, { headers: admin });
  assert.equal(response.status, 200);
  return (await response.json()) as RunReport;
}

describe("a run that does everything right", () => {
  it("passes: the secret arrives, then a signed delivery about the test email", async () => {
    const runId = await createRun();

    assert.equal((await giveSecret(runId, SECRET)).status, 200);
    assert.equal((await deliver(runId)).status, 200);

    const result = await report(runId);
    assert.equal(result.secretReceived, true);
    assert.deepEqual(result.result, { signedDelivery: true, testEmailDelivered: true });
    assert.deepEqual(result.deliveries, [
      {
        svixId: "msg_1",
        receivedAt: "2026-11-20T12:00:00.000Z",
        repeats: 0,
        verified: true,
        eventType: "message.received",
        inboxId: "inbox_1",
        messageId: "m_1",
        containsNonce: true,
      },
    ]);
  });

  // An agent may register the webhook and get mail before it hands the secret over.
  it("passes whichever comes first, the delivery or the secret", async () => {
    const runId = await createRun();

    await deliver(runId);
    assert.equal((await report(runId)).result.signedDelivery, false);
    await giveSecret(runId, SECRET);

    assert.deepEqual((await report(runId)).result, { signedDelivery: true, testEmailDelivered: true });
  });

  it("still passes when the report is read long after the delivery", async () => {
    const runId = await createRun();
    await giveSecret(runId, SECRET);
    await deliver(runId);

    clock = new Date("2026-11-21T12:00:00Z");

    assert.equal((await report(runId)).result.signedDelivery, true);
  });

  it("lets a corrected secret replace a wrong one", async () => {
    const runId = await createRun();
    await giveSecret(runId, WRONG_SECRET);
    await deliver(runId);
    assert.equal((await report(runId)).result.signedDelivery, false);

    await giveSecret(runId, SECRET);

    assert.equal((await report(runId)).result.signedDelivery, true);
  });
});

describe("a run that gets something wrong", () => {
  it("fails when the secret handed over is not the one the delivery was signed with", async () => {
    const runId = await createRun();
    await giveSecret(runId, WRONG_SECRET);
    await deliver(runId);

    const result = await report(runId);

    assert.deepEqual(result.result, { signedDelivery: false, testEmailDelivered: false });
    assert.equal(result.deliveries[0]?.verified, false);
  });

  it("fails when no secret was ever handed over", async () => {
    const runId = await createRun();
    await deliver(runId);

    const result = await report(runId);

    assert.equal(result.secretReceived, false);
    assert.equal(result.result.signedDelivery, false);
  });

  it("records an unsigned request as evidence, without counting it", async () => {
    const runId = await createRun();
    await giveSecret(runId, SECRET);

    assert.equal((await deliver(runId, { headers: false })).status, 200);

    const result = await report(runId);
    assert.equal(result.deliveries.length, 1);
    assert.match(result.deliveries[0]?.svixId ?? "", /^missing-id:/);
    assert.equal(result.result.signedDelivery, false);
  });

  it("refuses a correctly signed delivery that is more than five minutes old", async () => {
    const runId = await createRun();
    await giveSecret(runId, SECRET);
    await deliver(runId, { ageSeconds: 6 * 60 });

    assert.equal((await report(runId)).result.signedDelivery, false);
  });

  // Signed mail arrived, but not the harness's test email: the webhook works, the task is not done.
  it("separates a signed delivery from a delivery of the test email", async () => {
    const runId = await createRun();
    await giveSecret(runId, SECRET);
    await deliver(runId, { body: JSON.stringify({ event_type: "message.received", message: { subject: "something else" } }) });

    assert.deepEqual((await report(runId)).result, { signedDelivery: true, testEmailDelivered: false });
  });

  it("reports no verdict on the test email when the run has no nonce", async () => {
    const response = await fetch(`${base}/runs`, { method: "POST", headers: admin });
    const runId = ((await response.json()) as { id: string }).id;
    await giveSecret(runId, SECRET);
    await deliver(runId);

    const result = await report(runId);
    assert.deepEqual(result.result, { signedDelivery: true, testEmailDelivered: null });
    assert.equal(result.deliveries[0]?.containsNonce, null);
  });
});

describe("retries and limits", () => {
  it("counts a retried delivery once", async () => {
    const runId = await createRun();
    await giveSecret(runId, SECRET);

    const first = (await (await deliver(runId)).json()) as { duplicate: boolean };
    const second = (await (await deliver(runId)).json()) as { duplicate: boolean };
    await deliver(runId);

    assert.deepEqual([first.duplicate, second.duplicate], [false, true]);
    const result = await report(runId);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0]?.repeats, 2);
  });

  it("keeps runs apart: one run's delivery never shows in another's report", async () => {
    const first = await createRun();
    const second = await createRun();
    await giveSecret(first, SECRET);
    await giveSecret(second, SECRET);

    await deliver(first);

    assert.equal((await report(first)).deliveries.length, 1);
    assert.deepEqual((await report(second)).deliveries, []);
  });

  it("stops storing after the cap of deliveries for a run", async () => {
    const runId = await createRun();
    for (const id of ["a", "b", "c"]) {
      assert.equal((await deliver(runId, { id })).status, 200);
    }

    assert.equal((await deliver(runId, { id: "d" })).status, 429);
    // A retry of one already stored is still accepted.
    assert.equal((await deliver(runId, { id: "a" })).status, 200);
  });

  it("refuses a body over the size limit", async () => {
    const runId = await createRun();

    const response = await deliver(runId, { body: "x".repeat(3_000) }).catch(() => null);

    // The server answers 413, or drops the connection once the limit is passed.
    assert.ok(response === null || response.status === 413);
    assert.deepEqual((await report(runId)).deliveries, []);
  });
});

describe("who may do what", () => {
  it("needs the admin token to create a run or read a report", async () => {
    const runId = await createRun();

    assert.equal((await fetch(`${base}/runs`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/runs/${runId}`)).status, 401);
    assert.equal((await fetch(`${base}/runs/${runId}`, { headers: { authorization: "Bearer wrong-token-of-any-length" } })).status, 401);
  });

  // Without the token a real run id and a made-up one must look the same.
  it("does not reveal which run ids exist to someone without the token", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";

    assert.equal((await fetch(`${base}/runs/${unknown}`)).status, 401);
    assert.equal((await fetch(`${base}/runs/${unknown}`, { headers: admin })).status, 404);
  });

  it("answers 404 for an unknown run or route, and 405 for the wrong method", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const runId = await createRun();

    assert.equal((await giveSecret(unknown, SECRET)).status, 404);
    assert.equal((await deliver(unknown)).status, 404);
    assert.equal((await fetch(`${base}/runs/not-a-uuid/webhook`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/runs/${runId}/webhook`)).status, 405);
  });

  it("explains what to send when the secret is missing or malformed", async () => {
    const runId = await createRun();

    for (const secret of [undefined, "", 42, "x".repeat(201)]) {
      const response = await giveSecret(runId, secret);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /whsec_/);
    }
    const notJson = await fetch(`${base}/runs/${runId}/secret`, { method: "POST", body: "whsec_plain" });
    assert.equal(notJson.status, 400);
  });

  it("rejects a nonce that is not a short string", async () => {
    const response = await fetch(`${base}/runs`, { method: "POST", headers: admin, body: JSON.stringify({ nonce: 7 }) });

    assert.equal(response.status, 400);
  });

  it("answers the health check without a token", async () => {
    const response = await fetch(`${base}/health`);

    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

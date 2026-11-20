import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signSvix, verifySvixSignature } from "./svix.ts";

const SECRET = `whsec_${Buffer.from("a-test-signing-key-of-some-length").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("another key").toString("base64")}`;
const NOW = new Date("2026-11-20T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const BODY = Buffer.from('{"event_type":"message.received"}');

describe("verifySvixSignature", () => {
  it("accepts a correctly signed delivery", () => {
    const headers = { id: "msg_1", timestamp: TIMESTAMP, signature: signSvix(SECRET, "msg_1", TIMESTAMP, BODY) };

    assert.equal(verifySvixSignature(SECRET, headers, BODY, NOW), true);
  });

  it("accepts when any of several signatures matches (secret rotation)", () => {
    const signature = `v1,${Buffer.from("old").toString("base64")} ${signSvix(SECRET, "msg_1", TIMESTAMP, BODY)}`;

    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP, signature }, BODY, NOW), true);
  });

  it("rejects a changed body, id or key", () => {
    const signature = signSvix(SECRET, "msg_1", TIMESTAMP, BODY);
    const padded = Buffer.concat([BODY, Buffer.from(" ")]);

    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP, signature }, padded, NOW), false);
    assert.equal(verifySvixSignature(SECRET, { id: "msg_2", timestamp: TIMESTAMP, signature }, BODY, NOW), false);
    const forged = signSvix(OTHER_SECRET, "msg_1", TIMESTAMP, BODY);
    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP, signature: forged }, BODY, NOW), false);
  });

  // The bytes are signed, not the text: the same JSON re-serialised must not verify.
  it("rejects the same JSON with different bytes", () => {
    const signature = signSvix(SECRET, "msg_1", TIMESTAMP, BODY);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 1));

    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP, signature }, reserialised, NOW), false);
  });

  it("rejects a replay more than five minutes old, judged at arrival time", () => {
    const old = String(Number(TIMESTAMP) - 6 * 60);
    const headers = { id: "msg_1", timestamp: old, signature: signSvix(SECRET, "msg_1", old, BODY) };

    assert.equal(verifySvixSignature(SECRET, headers, BODY, NOW), false);
    assert.equal(verifySvixSignature(SECRET, headers, BODY, new Date(Number(old) * 1000)), true);
  });

  it("rejects missing headers, other signature versions and an empty secret", () => {
    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP }, BODY, NOW), false);
    const v2 = signSvix(SECRET, "msg_1", TIMESTAMP, BODY).replace("v1,", "v2,");
    assert.equal(verifySvixSignature(SECRET, { id: "msg_1", timestamp: TIMESTAMP, signature: v2 }, BODY, NOW), false);
    const unkeyed = signSvix("", "msg_1", TIMESTAMP, BODY);
    assert.equal(verifySvixSignature("", { id: "msg_1", timestamp: TIMESTAMP, signature: unkeyed }, BODY, NOW), false);
  });
});

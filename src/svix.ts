import { createHmac, timingSafeEqual } from "node:crypto";

/** Svix's default: a delivery more than five minutes old or new is refused, which stops replays. */
const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/**
 * Checks an AgentMail webhook the way the Svix library does
 * (https://docs.svix.com/receiving/verifying-payloads/how-manual): an
 * HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, keyed with the base64
 * secret after its `whsec_` prefix, matched against any `v1,<base64>` entry
 * of the space-separated signature header.
 *
 * `rawBody` must be the exact bytes received: re-serialised JSON can differ
 * and would never verify. `now` is when the delivery arrived, not when it is
 * checked, so a delivery stored earlier can still be verified later.
 */
export function verifySvixSignature(secret: string, headers: SvixHeaders, rawBody: Uint8Array, now: Date): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    return false;
  }

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  if (key.length === 0) {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();

  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) {
      return false;
    }
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Signs a body the way Svix does. Used by the tests and by anyone replaying a delivery by hand. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: Uint8Array): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest("base64")}`;
}

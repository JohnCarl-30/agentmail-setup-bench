import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Delivery, Run, Store } from "./store.ts";
import { verifySvixSignature } from "./svix.ts";

export interface AppOptions {
  store: Store;
  /** Guards creating runs and reading reports. The agent under test never gets it. */
  adminToken: string;
  now?: () => Date;
  maxBodyBytes?: number;
}

export interface DeliveryReport {
  svixId: string;
  receivedAt: string;
  repeats: number;
  /** Signed with the secret the agent handed over, and not a replay. */
  verified: boolean;
  eventType: string | null;
  inboxId: string | null;
  messageId: string | null;
  /** The body carries the run's nonce, so it is about the harness's test email. */
  containsNonce: boolean | null;
}

export interface RunReport {
  id: string;
  createdAt: string;
  secretReceived: boolean;
  secretReceivedAt: string | null;
  deliveries: DeliveryReport[];
  result: {
    /** At least one delivery verified against the agent's secret. */
    signedDelivery: boolean;
    /** A verified delivery carried the nonce. Null when the run was created without one. */
    testEmailDelivered: boolean | null;
  };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_ROUTE = new RegExp(`^/runs/(${UUID})(/secret|/webhook)?$`);
const MAX_SECRET_LENGTH = 200;
const MAX_NONCE_LENGTH = 200;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, `The body is larger than ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isAdmin(req: IncomingMessage, adminToken: string): boolean {
  const given = Buffer.from(header(req, "authorization") ?? "");
  const expected = Buffer.from(`Bearer ${adminToken}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

/** What one run looks like to the harness: every delivery, and whether the run's webhook steps passed. */
export function buildReport(run: Run, deliveries: Delivery[]): RunReport {
  const nonce = run.nonce ? Buffer.from(run.nonce) : null;
  const reports = deliveries.map((delivery): DeliveryReport => {
    const payload = parseJsonObject(Buffer.from(delivery.body));
    return {
      svixId: delivery.svixId,
      receivedAt: delivery.receivedAt,
      repeats: delivery.repeats,
      // Checked against arrival time: a report read an hour later must not turn a good delivery into a replay.
      verified:
        run.secret !== null &&
        verifySvixSignature(
          run.secret,
          { id: delivery.svixId, timestamp: delivery.timestamp ?? undefined, signature: delivery.signature ?? undefined },
          delivery.body,
          new Date(delivery.receivedAt),
        ),
      eventType: stringAt(payload, "event_type"),
      inboxId: stringAt(payload, "message", "inbox_id"),
      messageId: stringAt(payload, "message", "message_id"),
      containsNonce: nonce ? Buffer.from(delivery.body).includes(nonce) : null,
    };
  });

  return {
    id: run.id,
    createdAt: run.createdAt,
    secretReceived: run.secret !== null,
    secretReceivedAt: run.secretAt,
    deliveries: reports,
    result: {
      signedDelivery: reports.some((report) => report.verified),
      testEmailDelivered: nonce ? reports.some((report) => report.verified && report.containsNonce === true) : null,
    },
  };
}

/**
 * The referee's HTTP handler.
 *
 * Two callers with different trust. The harness holds the admin token: it
 * creates runs and reads reports. The agent under test holds only a run's
 * address: it can hand over a signing secret and receive webhooks, and it
 * can never read a report, so it cannot tell a pass from a fail by asking.
 */
export function createApp(options: AppOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, adminToken } = options;
  const now = options.now ?? (() => new Date());
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://referee").pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { status: "ok" });
    }

    if (path === "/runs") {
      if (req.method !== "POST") {
        throw new HttpError(405, "Use POST to create a run.");
      }
      if (!isAdmin(req, adminToken)) {
        throw new HttpError(401, "Creating a run needs the admin token.");
      }
      const body = await readBody(req, maxBodyBytes);
      const nonce = body.length > 0 ? parseJsonObject(body)?.nonce : undefined;
      if (nonce !== undefined && (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH)) {
        throw new HttpError(400, `"nonce" must be a string of 1 to ${MAX_NONCE_LENGTH} characters.`);
      }
      const id = randomUUID();
      store.createRun(id, nonce ?? null, now());
      return send(res, 201, { id, webhookPath: `/runs/${id}/webhook`, secretPath: `/runs/${id}/secret` });
    }

    const match = RUN_ROUTE.exec(path);
    if (!match) {
      throw new HttpError(404, "No such route.");
    }
    const [, runId = "", action] = match;

    if (action === undefined) {
      if (req.method !== "GET") {
        throw new HttpError(405, "Use GET to read a run's report.");
      }
      // Checked before the lookup, so an outsider cannot learn which run ids exist.
      if (!isAdmin(req, adminToken)) {
        throw new HttpError(401, "Reading a report needs the admin token.");
      }
      const run = store.getRun(runId);
      if (!run) {
        throw new HttpError(404, "No such run.");
      }
      return send(res, 200, buildReport(run, store.deliveries(runId)));
    }

    if (req.method !== "POST") {
      throw new HttpError(405, "Use POST.");
    }
    const run = store.getRun(runId);
    if (!run) {
      throw new HttpError(404, "No such run. Check the address you were given.");
    }
    const body = await readBody(req, maxBodyBytes);

    if (action === "/secret") {
      const secret = parseJsonObject(body)?.secret;
      if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
        throw new HttpError(400, 'Send JSON like {"secret":"whsec_..."}: the signing secret of the webhook you registered.');
      }
      store.setSecret(runId, secret, now());
      // Says only that it arrived, never whether it is the right one.
      return send(res, 200, { received: true });
    }

    // The webhook. Stored whether or not it verifies, and whether or not the
    // secret has arrived yet: the report decides, so the order of the agent's
    // steps does not matter and a bad delivery is still evidence.
    const result = store.addDelivery(runId, {
      svixId: header(req, "svix-id") ?? `missing-id:${randomUUID()}`,
      timestamp: header(req, "svix-timestamp") ?? null,
      signature: header(req, "svix-signature") ?? null,
      body,
      receivedAt: now().toISOString(),
    });
    if (result === "full") {
      throw new HttpError(429, "This run has received too many deliveries.");
    }
    return send(res, 200, { received: true, duplicate: result === "duplicate" });
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error(error);
        send(res, 500, { error: "The referee failed. This is not the agent's fault." });
      }
    });
  };
}

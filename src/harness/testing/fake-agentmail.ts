import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { signSvix } from "../../svix.ts";

/**
 * A stand-in for AgentMail's API, for tests: inboxes, webhooks, sending,
 * replying, and signed webhook deliveries. It follows the documented request
 * and response shapes for the calls the harness and a test agent make, and
 * nothing more. It is not evidence of how the real service behaves.
 */

interface FakeInbox {
  pod_id: string;
  inbox_id: string;
  email: string;
  created_at: string;
  updated_at: string;
  client_id?: string;
}

interface FakeWebhook {
  webhook_id: string;
  url: string;
  secret: string;
  enabled: boolean;
  event_types: string[];
  inbox_id?: string;
  inbox_ids?: string[];
  created_at: string;
  updated_at: string;
}

interface FakeMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  in_reply_to?: string;
  size: number;
  created_at: string;
  updated_at: string;
  /** Not part of the API: ties copies of one email, and its replies, together. */
  conversation: string;
}

export interface FakeAgentMail {
  /** The API base, ending in /v0. */
  url: string;
  inboxes: Map<string, FakeInbox>;
  webhooks: FakeWebhook[];
  /** Resolves once every webhook delivery started so far has finished. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "validation_error", "The body is not valid JSON.");
  }
}

export async function startFakeAgentMail(options: { apiKey: string }): Promise<FakeAgentMail> {
  const inboxes = new Map<string, FakeInbox>();
  const webhooks: FakeWebhook[] = [];
  const messages: FakeMessage[] = [];
  const threads = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${(counter += 1)}`;
  const stamp = () => new Date().toISOString();

  // Thread ids are per inbox: the sender's copy and the recipient's copy of one
  // email sit in different threads, and a reply joins the thread already there.
  function threadFor(inboxId: string, conversation: string): string {
    const key = `${inboxId}|${conversation}`;
    let thread = threads.get(key);
    if (!thread) {
      thread = next("thr");
      threads.set(key, thread);
    }
    return thread;
  }

  function inboxOr404(inboxId: string): FakeInbox {
    const inbox = inboxes.get(decodeURIComponent(inboxId));
    if (!inbox) {
      throw new ApiError(404, "not_found", "Inbox not found.");
    }
    return inbox;
  }

  function fire(message: FakeMessage): void {
    for (const webhook of webhooks) {
      const covers = webhook.inbox_id ? webhook.inbox_id === message.inbox_id : !webhook.inbox_ids?.length || webhook.inbox_ids.includes(message.inbox_id);
      if (!webhook.enabled || !covers || !webhook.event_types.includes("message.received")) {
        continue;
      }
      const { conversation: _conversation, ...publicMessage } = message;
      const body = Buffer.from(
        JSON.stringify({ type: "event", event_type: "message.received", event_id: next("evt"), message: publicMessage, thread: { thread_id: message.thread_id, inbox_id: message.inbox_id } }),
      );
      const id = next("msg_delivery");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const delivery = fetch(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signSvix(webhook.secret, id, timestamp, body) },
        body,
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => pending.delete(delivery));
      pending.add(delivery);
    }
  }

  function send(from: FakeInbox, input: Record<string, unknown>, replyTo?: FakeMessage): { message_id: string; thread_id: string } {
    const to = replyTo ? [replyTo.from] : Array.isArray(input.to) ? (input.to as string[]) : typeof input.to === "string" ? [input.to] : [];
    if (to.length === 0) {
      throw new ApiError(400, "validation_error", "At least one recipient is required.");
    }
    const conversation = replyTo?.conversation ?? next("conv");
    const subject = replyTo ? `Re: ${replyTo.subject}` : String(input.subject ?? "");
    const text = String(input.text ?? "");
    const base = { from: from.email, to, subject, text, size: text.length, timestamp: stamp(), created_at: stamp(), updated_at: stamp(), conversation };
    const own: FakeMessage = { ...base, inbox_id: from.inbox_id, thread_id: threadFor(from.inbox_id, conversation), message_id: next("msg"), labels: ["sent"], in_reply_to: replyTo?.message_id };
    messages.push(own);
    for (const address of to) {
      const recipient = [...inboxes.values()].find((inbox) => inbox.email.toLowerCase() === address.toLowerCase());
      if (!recipient) {
        continue;
      }
      const copy: FakeMessage = { ...base, inbox_id: recipient.inbox_id, thread_id: threadFor(recipient.inbox_id, conversation), message_id: next("msg"), labels: ["received"], in_reply_to: replyTo ? own.message_id : undefined };
      messages.push(copy);
      fire(copy);
    }
    return { message_id: own.message_id, thread_id: own.thread_id };
  }

  function createWebhook(body: Record<string, unknown>, inboxId?: string): FakeWebhook {
    if (typeof body.url !== "string" || !Array.isArray(body.event_types) || body.event_types.length === 0) {
      throw new ApiError(400, "validation_error", "url and a non-empty event_types are required.");
    }
    const webhook: FakeWebhook = {
      webhook_id: next("wh"),
      url: body.url,
      secret: `whsec_${Buffer.from(next("signing-key-for-webhook")).toString("base64")}`,
      enabled: true,
      event_types: body.event_types as string[],
      inbox_id: inboxId,
      inbox_ids: inboxId ? undefined : (body.inbox_ids as string[] | undefined),
      created_at: stamp(),
      updated_at: stamp(),
    };
    webhooks.push(webhook);
    return webhook;
  }

  async function route(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    if (req.headers.authorization !== `Bearer ${options.apiKey}`) {
      throw new ApiError(401, "unauthorized", "Unknown API key.");
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const parts = url.pathname.replace(/^\/v0\//, "").split("/");
    const method = req.method ?? "GET";
    const [root, inboxId, sub, itemId, action] = parts;

    if (root === "webhooks" && parts.length === 1) {
      if (method === "POST") {
        return { status: 200, body: createWebhook(await readJson(req)) };
      }
      const organization = webhooks.filter((webhook) => !webhook.inbox_id);
      return { status: 200, body: { count: organization.length, webhooks: organization } };
    }
    if (root !== "inboxes") {
      throw new ApiError(404, "not_found", "No such endpoint.");
    }
    if (parts.length === 1) {
      if (method === "POST") {
        const body = await readJson(req);
        const id = next("inb");
        const inbox: FakeInbox = { pod_id: "pod_1", inbox_id: id, email: `${String(body.username ?? id.replace("_", "-"))}@agentmail.to`, created_at: stamp(), updated_at: stamp(), client_id: body.client_id as string | undefined };
        inboxes.set(id, inbox);
        return { status: 200, body: inbox };
      }
      return { status: 200, body: { count: inboxes.size, inboxes: [...inboxes.values()] } };
    }

    const inbox = inboxOr404(inboxId ?? "");
    if (parts.length === 2) {
      if (method === "DELETE") {
        inboxes.delete(inbox.inbox_id);
        for (let index = webhooks.length - 1; index >= 0; index -= 1) {
          if (webhooks[index]?.inbox_id === inbox.inbox_id) {
            webhooks.splice(index, 1);
          }
        }
        return { status: 202 };
      }
      return { status: 200, body: inbox };
    }
    if (sub === "webhooks") {
      if (method === "POST") {
        return { status: 200, body: createWebhook(await readJson(req), inbox.inbox_id) };
      }
      const scoped = webhooks.filter((webhook) => webhook.inbox_id === inbox.inbox_id);
      return { status: 200, body: { count: scoped.length, webhooks: scoped } };
    }
    if (sub === "messages") {
      const own = messages.filter((message) => message.inbox_id === inbox.inbox_id);
      if (itemId === "send" && method === "POST") {
        return { status: 200, body: send(inbox, await readJson(req)) };
      }
      if (!itemId) {
        // The list leaves the body text out, as the real list does.
        const items = own.map(({ conversation: _conversation, text: _text, ...item }) => item);
        return { status: 200, body: { count: items.length, messages: items } };
      }
      const message = own.find((candidate) => candidate.message_id === itemId);
      if (!message) {
        throw new ApiError(404, "not_found", "Message not found.");
      }
      if (action === "reply" && method === "POST") {
        return { status: 200, body: send(inbox, await readJson(req), message) };
      }
      const { conversation: _conversation, ...publicMessage } = message;
      return { status: 200, body: publicMessage };
    }
    throw new ApiError(404, "not_found", "No such endpoint.");
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req)
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      })
      .catch((error: unknown) => {
        const status = error instanceof ApiError ? error.status : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Error", code: error instanceof ApiError ? error.code : "internal_error", message: error instanceof Error ? error.message : "failed" }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v0`,
    inboxes,
    webhooks,
    settle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import { randomUUID } from "node:crypto";

import type { RunReport } from "../app.ts";
import type { AgentMail, Inbox, SentMessage, Webhook } from "./agentmail.ts";
import { score, type Evidence, type Score } from "./score.ts";
import { buildTask } from "./task.ts";
import { createToolBox, redact, type ToolBox, type TraceStep } from "./tools.ts";

export interface AgentOutcome {
  /** Why the agent stopped: the model's own finish reason, or "error". */
  finishReason: string;
  /** What the agent said at the end. */
  text?: string;
  /** What the model wrote at each step, in order: its reasoning as far as it is visible. */
  notes?: string[];
  steps?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

/** Anything that can attempt the task with the two tools: a model, or a script in tests. */
export type Agent = (task: string, tools: ToolBox, signal: AbortSignal) => Promise<AgentOutcome>;

export interface RefereeClient {
  createRun(nonce: string): Promise<{ id: string; webhookPath: string; secretPath: string }>;
  report(runId: string): Promise<RunReport>;
}

export function createRefereeClient(options: { url: string; adminToken: string; fetch?: typeof fetch }): RefereeClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${options.adminToken}` };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`The referee answered ${response.status} to ${method} ${path}`);
    }
    return (await response.json()) as T;
  }

  return {
    createRun: (nonce) => call("POST", "/runs", { nonce }),
    report: (runId) => call("GET", `/runs/${runId}`),
  };
}

export interface RunDeps {
  agentMail: AgentMail;
  referee: RefereeClient;
  agent: Agent;
  /** A label for the result, such as "anthropic:claude-opus-5-5". */
  model: string;
  /** The key the agent is given. It is removed from everything that is saved. */
  apiKey: string;
  /** The harness's own inbox: it sends the test email and receives the reply. */
  seedInboxId: string;
  /** The referee's address as AgentMail and the agent reach it. */
  refereePublicUrl: string;
  docsUrl: string;
  /** Which addresses the agent may call. */
  allow: (url: URL) => boolean;
  /** How often the harness looks at AgentMail while the agent works. */
  pollMs?: number;
  /** How long to wait for the agent's webhook before sending the test email anyway. */
  sendAfterMs?: number;
  /** How long after the agent stops to keep looking for a late delivery or reply. */
  graceMs?: number;
  /** The most time one agent may take. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface RunResult {
  runId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  score: Score;
  evidence: Evidence;
  agent: AgentOutcome & { toolCalls: number };
  details: {
    inboxEmail: string | null;
    testEmailSent: boolean;
    /** Whether the test email went out because the webhook was seen, or because the wait ran out. */
    testEmailTrigger: "webhook-registered" | "waited" | null;
    referee: RunReport | null;
    /** Things the harness itself could not do. A run with entries here may not be the agent's fault. */
    harnessErrors: string[];
  };
  task: string;
  trace: TraceStep[];
}

const RECEIVED = "message.received";

function isRunWebhook(webhook: Webhook, webhookUrl: string, inboxId: string, scoped: boolean): boolean {
  return (
    webhook.url === webhookUrl &&
    webhook.enabled !== false &&
    (webhook.event_types ?? []).includes(RECEIVED) &&
    // An organization webhook with no inbox list covers every inbox.
    (scoped || !webhook.inbox_ids?.length || webhook.inbox_ids.includes(inboxId))
  );
}

/**
 * One run: give an agent the task, send it the test email once it is ready,
 * then work out from the outside what it actually did.
 */
export async function runOnce(deps: RunDeps): Promise<RunResult> {
  const { agentMail, referee } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 3_000;
  const sendAfterMs = deps.sendAfterMs ?? 60_000;
  const graceMs = deps.graceMs ?? 20_000;
  const maxMs = deps.maxMs ?? 10 * 60_000;
  const harnessErrors: string[] = [];
  const guard = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      harnessErrors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const nonce = `setup-bench-${randomUUID()}`;
  const run = await referee.createRun(nonce);
  const publicUrl = deps.refereePublicUrl.replace(/\/$/, "");
  const webhookUrl = `${publicUrl}${run.webhookPath}`;
  const task = buildTask({ apiKey: deps.apiKey, docsUrl: deps.docsUrl, webhookUrl, secretUrl: `${publicUrl}${run.secretPath}` });
  const before = new Set((await agentMail.listInboxes()).map((inbox) => inbox.inbox_id));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`The run passed its limit of ${maxMs} ms.`)), maxMs);
  const tools = createToolBox({ allow: deps.allow, signal: controller.signal, fetch: deps.fetch, sleep, now });
  const startedAt = now();

  let agentDone = false;
  const agentPromise: Promise<AgentOutcome> = deps
    .agent(task, tools, controller.signal)
    .catch((error: unknown) => ({ finishReason: "error", error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      agentDone = true;
    });

  async function newInboxes(): Promise<Inbox[]> {
    const inboxes = await agentMail.listInboxes();
    return inboxes
      .filter((inbox) => !before.has(inbox.inbox_id) && inbox.inbox_id !== deps.seedInboxId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async function webhookRegistered(inbox: Inbox): Promise<boolean> {
    const scoped = await agentMail.listInboxWebhooks(inbox.inbox_id);
    if (scoped.some((webhook) => isRunWebhook(webhook, webhookUrl, inbox.inbox_id, true))) {
      return true;
    }
    const organization = await agentMail.listOrgWebhooks();
    return organization.some((webhook) => isRunWebhook(webhook, webhookUrl, inbox.inbox_id, false));
  }

  // While the agent works: find its inbox, then send the test email once its
  // webhook is in place. Sending earlier would make a correct agent miss the
  // delivery through no fault of its own. If no webhook ever appears the email
  // still goes out, so the reply step can be judged on its own.
  let agentInbox: Inbox | null = null;
  let inboxSeenAt = 0;
  let sent: SentMessage | null = null;
  let sentAt: Date | null = null;
  let trigger: RunResult["details"]["testEmailTrigger"] = null;
  while (!agentDone && !sent) {
    await sleep(pollMs);
    await guard("watching the agent's setup", async () => {
      if (!agentInbox) {
        agentInbox = (await newInboxes())[0] ?? null;
        inboxSeenAt = now().getTime();
      }
      if (!agentInbox) {
        return;
      }
      const registered = await webhookRegistered(agentInbox);
      if (registered || now().getTime() - inboxSeenAt >= sendAfterMs) {
        sent = await agentMail.send(deps.seedInboxId, {
          to: [agentInbox.email],
          subject: `Setup bench test ${nonce}`,
          text: `This is the benchmark's test email. Reference: ${nonce}. Please reply in this thread.`,
        });
        sentAt = now();
        trigger = registered ? "webhook-registered" : "waited";
      }
    });
  }

  const outcome = await agentPromise;
  clearTimeout(timeout);

  let report: RunReport | null = null;
  async function collect(): Promise<Evidence> {
    const inbox = agentInbox ?? (agentInbox = (await guard("listing inboxes", newInboxes))?.[0] ?? null);
    const registered = inbox ? ((await guard("listing webhooks", () => webhookRegistered(inbox))) ?? false) : false;
    report = (await guard("reading the referee's report", () => referee.report(run.id))) ?? report;

    let replied = false;
    let repliedInThread = false;
    if (inbox && sent && sentAt) {
      const testEmail = sent;
      const from = inbox.email.toLowerCase();
      const since = sentAt.getTime() - 5_000;
      const messages = (await guard("listing the test inbox's messages", () => agentMail.listMessages(deps.seedInboxId))) ?? [];
      const replies = messages.filter(
        (message) =>
          message.message_id !== testEmail.message_id &&
          message.from.toLowerCase().includes(from) &&
          new Date(message.timestamp).getTime() >= since,
      );
      replied = replies.length > 0;
      repliedInThread = replies.some((message) => message.thread_id === testEmail.thread_id);
    }

    return {
      inboxCreated: inbox !== null,
      webhookRegistered: registered,
      secretReceived: report?.secretReceived ?? false,
      testEmailDelivered: report?.result.testEmailDelivered === true,
      replied,
      repliedInThread,
    };
  }

  // A webhook delivery or a reply can land a few seconds after the agent stops.
  let evidence = await collect();
  const graceEnds = now().getTime() + graceMs;
  while (!score(evidence).passed && now().getTime() < graceEnds) {
    await sleep(pollMs);
    evidence = await collect();
  }

  // Leave the account as it was: the free plan has room for only three inboxes.
  for (const inbox of (await guard("listing inboxes to clean up", newInboxes)) ?? []) {
    await guard(`deleting inbox ${inbox.inbox_id}`, () => agentMail.deleteInbox(inbox.inbox_id));
  }

  const endedAt = now();
  const inboxEmail = (agentInbox as Inbox | null)?.email ?? null;
  return redact(
    {
      runId: run.id,
      model: deps.model,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      score: score(evidence),
      evidence,
      agent: { ...outcome, toolCalls: tools.trace.length },
      details: { inboxEmail, testEmailSent: sent !== null, testEmailTrigger: trigger, referee: report, harnessErrors },
      task,
      trace: tools.trace,
    },
    [deps.apiKey],
  );
}

/**
 * The default rule for what an agent may call: AgentMail's own sites, the
 * referee, and whatever hosts the docs and API addresses name. Plain http is
 * allowed only for a machine-local address, which is what tests use.
 */
export function createAllow(urls: string[]): (url: URL) => boolean {
  const hosts = new Set(urls.map((url) => new URL(url).host));
  return (url) => {
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return false;
    }
    return hosts.has(url.host) || url.hostname === "agentmail.to" || url.hostname.endsWith(".agentmail.to");
  };
}

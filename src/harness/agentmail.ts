/**
 * The few AgentMail calls the harness itself makes: to find the inbox an agent
 * created, send the test email, and check what the agent set up. Shapes follow
 * the API reference at https://docs.agentmail.to/api-reference.
 */

export interface Inbox {
  inbox_id: string;
  email: string;
  created_at: string;
  client_id?: string;
}

export interface Webhook {
  webhook_id: string;
  url: string;
  enabled: boolean;
  event_types?: string[];
  inbox_ids?: string[];
}

export interface MessageItem {
  message_id: string;
  thread_id: string;
  from: string;
  to: string[];
  timestamp: string;
  labels: string[];
  subject?: string;
  in_reply_to?: string;
}

export interface SentMessage {
  message_id: string;
  thread_id: string;
}

export class AgentMailError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AgentMailOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type AgentMail = ReturnType<typeof createAgentMail>;

const MAX_PAGES = 20;

export function createAgentMail(options: AgentMailOptions) {
  const baseUrl = (options.baseUrl ?? "https://api.agentmail.to/v0").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body (a proxy's error page) is reported as the message below.
    }
    if (!response.ok) {
      const error = (parsed ?? {}) as { code?: string; message?: string };
      throw new AgentMailError(response.status, error.code ?? null, error.message ?? `AgentMail answered ${response.status} to ${method} ${path}`);
    }
    return parsed;
  }

  /** Follows next_page_token, so a list is never silently cut at the first page. */
  async function list<T>(path: string, key: string, query = ""): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const parameters = [query, pageToken ? `page_token=${encodeURIComponent(pageToken)}` : ""].filter(Boolean).join("&");
      const result = (await call("GET", parameters ? `${path}?${parameters}` : path)) as Record<string, unknown>;
      items.push(...((result[key] as T[] | undefined) ?? []));
      pageToken = typeof result.next_page_token === "string" ? result.next_page_token : undefined;
      if (!pageToken) {
        break;
      }
    }
    return items;
  }

  const inboxPath = (inboxId: string) => `/inboxes/${encodeURIComponent(inboxId)}`;

  return {
    listInboxes: () => list<Inbox>("/inboxes", "inboxes"),
    createInbox: (body: { client_id?: string; display_name?: string } = {}) => call("POST", "/inboxes", body) as Promise<Inbox>,
    /** Deletion runs in the background on AgentMail's side; this returns once it is accepted. */
    deleteInbox: async (inboxId: string): Promise<void> => {
      await call("DELETE", inboxPath(inboxId));
    },
    listInboxWebhooks: (inboxId: string) => list<Webhook>(`${inboxPath(inboxId)}/webhooks`, "webhooks"),
    listOrgWebhooks: () => list<Webhook>("/webhooks", "webhooks"),
    send: (inboxId: string, message: { to: string[]; subject: string; text: string }) =>
      call("POST", `${inboxPath(inboxId)}/messages/send`, message) as Promise<SentMessage>,
    // Spam and unauthenticated mail are left out of the default list, and a reply
    // filed there would otherwise look like no reply at all.
    listMessages: (inboxId: string) =>
      list<MessageItem>(`${inboxPath(inboxId)}/messages`, "messages", "include_spam=true&include_unauthenticated=true"),
  };
}

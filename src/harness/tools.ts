/**
 * The two tools an agent under test gets: make an HTTP request, and wait.
 * Every call is recorded, because the trace is what gets read afterwards.
 */

export interface HttpInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpOutput {
  status?: number;
  body?: string;
  /** Set instead of a status when the request was not made or did not complete. */
  error?: string;
}

export interface TraceStep {
  at: string;
  tool: "http_request" | "wait";
  input: unknown;
  output: unknown;
  ms: number;
}

export interface ToolBox {
  http(input: HttpInput): Promise<HttpOutput>;
  wait(seconds: number): Promise<{ waited: number }>;
  readonly trace: TraceStep[];
}

export interface ToolBoxOptions {
  /** Decides which addresses the agent may reach. Everything else is refused, not fetched. */
  allow: (url: URL) => boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxBodyChars?: number;
  requestTimeoutMs?: number;
  maxWaitSeconds?: number;
  signal?: AbortSignal;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function createToolBox(options: ToolBoxOptions): ToolBox {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const maxBodyChars = options.maxBodyChars ?? 20_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxWaitSeconds = options.maxWaitSeconds ?? 30;
  const trace: TraceStep[] = [];

  async function record<T>(tool: TraceStep["tool"], input: unknown, run: () => Promise<T>): Promise<T> {
    const started = now();
    const output = await run();
    trace.push({ at: started.toISOString(), tool, input, output, ms: now().getTime() - started.getTime() });
    return output;
  }

  async function request(input: HttpInput): Promise<HttpOutput> {
    const method = String(input.method ?? "").toUpperCase();
    if (!METHODS.has(method)) {
      return { error: `Unsupported method "${input.method}". Use GET, POST, PUT, PATCH or DELETE.` };
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { error: `"${input.url}" is not a full URL.` };
    }
    if (!options.allow(url)) {
      return { error: `Requests to ${url.host} are not allowed in this task.` };
    }
    try {
      const signals = [AbortSignal.timeout(requestTimeoutMs), ...(options.signal ? [options.signal] : [])];
      const response = await doFetch(url, {
        method,
        headers: input.headers,
        body: method === "GET" ? undefined : input.body,
        signal: AbortSignal.any(signals),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}\n[cut: ${text.length - maxBodyChars} more characters]` : text,
      };
    } catch (error) {
      return { error: `The request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    trace,
    http: (input) => record("http_request", input, () => request(input)),
    wait: (seconds) =>
      record("wait", { seconds }, async () => {
        const waited = Math.min(Math.max(Number(seconds) || 0, 0), maxWaitSeconds);
        await sleep(waited * 1000);
        return { waited };
      }),
  };
}

const WEBHOOK_SECRET = /whsec_[A-Za-z0-9+/=_-]+/g;

/**
 * Makes a result safe to publish: the API key and any webhook signing secret
 * are replaced wherever they appear, including inside the agent's own requests.
 */
export function redact<T>(value: T, secrets: string[]): T {
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) {
      text = text.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED_API_KEY]");
    }
  }
  return JSON.parse(text.replace(WEBHOOK_SECRET, "[REDACTED_WEBHOOK_SECRET]")) as T;
}

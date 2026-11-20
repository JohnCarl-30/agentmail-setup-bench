import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAgentMail, type AgentMail, type Inbox } from "./agentmail.ts";
import { createModelAgent, resolveModel } from "./model-agent.ts";
import { createAllow, createRefereeClient, runOnce } from "./run.ts";

export interface CliArgs {
  model: string;
  runs: number;
  out: string;
}

const SEED_CLIENT_ID = "setup-bench-seed";

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { model: "", runs: 1, out: "results" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--model" && value) {
      args.model = value;
    } else if (flag === "--runs" && value) {
      args.runs = Number(value);
    } else if (flag === "--out" && value) {
      args.out = value;
    } else {
      throw new Error(`Unknown or incomplete option "${flag}". Options: --model provider:model, --runs N, --out DIR.`);
    }
    index += 1;
  }
  if (!args.model) {
    throw new Error("Say which model to run: --model anthropic:claude-opus-5-5");
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 50) {
    throw new Error("--runs must be a whole number from 1 to 50.");
  }
  return args;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name}. See .env.example.`);
  }
  return value;
}

/** The harness's own inbox, reused across runs so it does not use up the plan's inbox limit. */
export async function findOrCreateSeed(agentMail: AgentMail, named?: string): Promise<Inbox> {
  const inboxes = await agentMail.listInboxes();
  if (named) {
    // An account near its inbox limit names one it already has, so the agent's inbox still fits.
    const chosen = inboxes.find((inbox) => inbox.inbox_id === named || inbox.email.toLowerCase() === named.toLowerCase());
    if (!chosen) {
      throw new Error(`SEED_INBOX is "${named}", but the account has no such inbox.`);
    }
    return chosen;
  }
  const existing = inboxes.find((inbox) => inbox.client_id === SEED_CLIENT_ID);
  return existing ?? agentMail.createInbox({ client_id: SEED_CLIENT_ID, display_name: "Setup bench" });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = required("AGENTMAIL_API_KEY");
  const refereePublicUrl = required("REFEREE_PUBLIC_URL");
  const refereeUrl = process.env.REFEREE_URL ?? refereePublicUrl;
  const docsUrl = process.env.AGENTMAIL_DOCS_URL ?? "https://docs.agentmail.to/llms.txt";
  const apiBaseUrl = process.env.AGENTMAIL_API_URL ?? "https://api.agentmail.to/v0";

  const agentMail = createAgentMail({ apiKey, baseUrl: apiBaseUrl });
  const referee = createRefereeClient({ url: refereeUrl, adminToken: required("REFEREE_ADMIN_TOKEN") });
  const agent = createModelAgent({ model: await resolveModel(args.model) });
  const seed = await findOrCreateSeed(agentMail, process.env.SEED_INBOX);
  mkdirSync(args.out, { recursive: true });

  console.log(`${args.runs} run(s) of ${args.model}. Each one calls the model, which costs tokens, and sends one email from ${seed.email}.`);

  let passed = 0;
  for (let index = 1; index <= args.runs; index += 1) {
    const result = await runOnce({
      agentMail,
      referee,
      agent,
      model: args.model,
      apiKey,
      seedInboxId: seed.inbox_id,
      refereePublicUrl,
      docsUrl,
      allow: createAllow([refereePublicUrl, docsUrl, apiBaseUrl]),
    });
    passed += result.score.passed ? 1 : 0;
    const file = join(args.out, `${result.startedAt.replace(/[:.]/g, "-")}-${args.model.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    const problems = result.details.harnessErrors.length > 0 ? `, ${result.details.harnessErrors.length} harness problem(s)` : "";
    console.log(
      `run ${index}/${args.runs}: ${result.score.passed ? "passed" : "failed"}, ${result.score.stepsReached}/4 steps, ` +
        `${result.agent.toolCalls} tool calls, ${Math.round(result.durationMs / 1000)} s, stopped on "${result.agent.finishReason}"${problems} -> ${file}`,
    );
  }
  console.log(`${passed} of ${args.runs} passed.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

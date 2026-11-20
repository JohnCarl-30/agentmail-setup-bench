# AgentMail setup bench

A benchmark of how well AI agents set [AgentMail](https://agentmail.to) up from its docs alone: create an inbox, register a webhook, hand over the signing secret, and reply to a test email.

AgentMail's own [evals](https://www.agentmail.to/evals) test what an agent does with an inbox that is already set up. This tests the step before. It is independent work and is not affiliated with AgentMail.

**Status:** the referee and the harness are built and tested against a local stand-in for AgentMail. No run against the real service has been made yet, so there are no results to report.

## The referee

A small HTTP service that receives AgentMail's webhooks and reports whether a run's webhook steps passed. An agent saying it succeeded does not count; a correctly signed delivery does.

It has no runtime dependencies. Node 24 or later runs the TypeScript directly, with SQLite and the test runner built in.

```bash
npm install
cp .env.example .env   # then set REFEREE_ADMIN_TOKEN
npm start
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `REFEREE_ADMIN_TOKEN` | Guards creating runs and reading reports. Required, at least 16 characters. | none |
| `PORT` | Port to listen on | `8787` |
| `REFEREE_DB` | SQLite file, or `:memory:` | `data/referee.db` |

AgentMail has to reach the referee, so for real runs it needs a public address, for example through a tunnel.

## Endpoints

Two callers with different trust. The harness holds the admin token. The agent under test is given only its run's two addresses, and can never read a report.

| Endpoint | Caller | What it does |
| --- | --- | --- |
| `POST /runs` | Harness | Creates a run. Optional body `{"nonce":"..."}`: a string the harness also puts in its test email. Returns the run's id and its two paths. |
| `POST /runs/{id}/secret` | Agent | Takes `{"secret":"whsec_..."}`, the signing secret of the webhook the agent registered. Says only that it arrived. |
| `POST /runs/{id}/webhook` | AgentMail | Stores the delivery: headers and exact bytes. A repeated delivery id is counted, not stored twice. |
| `GET /runs/{id}` | Harness | The report. |
| `GET /health` | Anyone | `{"status":"ok"}` |

## How a run is judged

The report's `result` has two fields:

- `signedDelivery`: at least one delivery verifies against the secret the agent handed over, using the Svix scheme AgentMail signs with (HMAC-SHA256 over `id.timestamp.body`), and was no more than five minutes old when it arrived.
- `testEmailDelivered`: a verified delivery also contains the run's nonce, so it is about the harness's test email and not some other message. `null` when the run has no nonce.

Three choices worth knowing:

- **Order does not matter.** Every delivery is stored whether or not it verifies, and it is checked when the report is read. An agent may get mail before it hands the secret over, and may correct a wrong secret.
- **Age is judged at arrival.** A report read an hour later does not turn a good delivery into a replay.
- **The bytes are signed, not the JSON.** The body is stored as received, because the same JSON re-serialised does not verify.

## What the referee does not check

- **The reply.** Whether the agent's reply reached the test address is the harness's job.
- **That AgentMail sent the delivery.** An agent that holds the real signing secret could sign a request itself. The harness covers this: it asks AgentMail whether a webhook for received mail is registered at the run's address.

`eventType`, `inboxId` and `messageId` in a report are read from `event_type`, `message.inbox_id` and `message.message_id`, the names in AgentMail's webhook reference. The pass or fail result does not depend on them.

Limits: 1 MB per request body and 100 deliveries per run.

## The harness

Runs one agent through the task and works out, from the outside, what it did.

```bash
npm run bench -- --model anthropic:claude-opus-5-5 --runs 10
```

It needs the referee running at a public address, an AgentMail key on a verified account, and a key for the model. See `.env.example`. **Each run calls the model, which costs tokens, and sends one email.**

### The task

The agent is told the goal and where things are, and nothing about how. The full text is in [`src/harness/task.ts`](src/harness/task.ts) and is saved with every result.

1. Create an inbox.
2. Register a webhook for received messages at the run's address.
3. Send that webhook's signing secret to the referee.
4. Reply, in the same thread, to the test email that then arrives.

Sign-up is left out: a new AgentMail account needs a code from a human's email before it can send.

### The agent

A plain loop with two tools: `http_request` and `wait`. The model calls a tool, sees the result, and continues until it stops calling tools, up to 40 model calls or 10 minutes.

- **Nothing is tuned.** Effort, thinking and sampling stay at each provider's defaults.
- **No fallback model.** A run answered by a different model would be scored under the wrong name.
- **A fixed set of reachable hosts:** AgentMail's own sites and the referee. A request anywhere else is refused, and the refusal is in the trace.

### How a run is scored

Each step is confirmed from outside the agent. What the agent says about its own work is recorded and never counted.

| Step | Confirmed by |
| --- | --- |
| 1. Inbox | A new inbox exists in the account |
| 2. Webhook | AgentMail lists a webhook for `message.received` at the run's address |
| 3. Secret | The referee verified the test email's delivery with the secret the agent sent |
| 4. Reply | A message from the agent's inbox is in the test email's thread |

A run passes with all four. `stepsReached` counts in order and stops at the first miss, so a correct reply does not rescue a missing webhook.

The test email goes out once the webhook is registered, so a correct agent cannot miss it. If no webhook appears within a minute it goes out anyway, and the reply is still judged.

### What a result holds

One JSON file per run, under `results/`: the score, the evidence for each step, the referee's report, token counts, the exact task text, and the full trace of every tool call with its response. The API key and every webhook secret are replaced before anything is written.

`details.harnessErrors` lists anything the harness itself could not do. A run with entries there may have failed for reasons that are not the agent's.

### Limits to know before reading results

- **It is a minimal harness, not a coding agent.** AgentMail's evals ran models inside products such as Codex and Claude Code. Results here are not comparable with theirs.
- **The agent holds the same API key as the harness.** It could read the harness's own inbox. Scoring only counts outcomes it cannot fake that way, but the setups are not isolated.
- **The thread check is untested against the real service.** It assumes a reply lands in the thread of the email it answers, as seen from the receiving inbox.
- **Organization-level webhooks are not cleaned up.** The run's inbox is deleted afterwards; a webhook an agent registered for the whole organization is left in place.
- **Small samples.** Ten runs per model is few. Report the count with every rate.

## Tests

```bash
npm test
npm run typecheck
```

61 tests, none of which call a model or AgentMail:

- the signature check, and the referee end to end with deliveries signed the way Svix signs them;
- whole runs through the harness and the real referee, against a stand-in for AgentMail's API, with scripted agents that fail each step on purpose;
- the model loop, driven by a mock model.

The stand-in follows AgentMail's documented request and response shapes. It is not evidence of how the real service behaves.

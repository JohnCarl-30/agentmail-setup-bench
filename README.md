# AgentMail setup bench

A benchmark of how well AI agents set [AgentMail](https://agentmail.to) up from its docs alone: create an inbox, register a webhook, hand over the signing secret, and reply to a test email.

AgentMail's own [evals](https://www.agentmail.to/evals) test what an agent does with an inbox that is already set up. This tests the step before. It is independent work and is not affiliated with AgentMail.

**Status:** the referee is built and tested. The harness that runs agents against it is next.

## The referee

A small HTTP service that receives AgentMail's webhooks and reports whether a run's webhook steps passed. An agent saying it succeeded does not count; a correctly signed delivery does.

It has no runtime dependencies. Node 24 or later runs the TypeScript directly, with SQLite and the test runner built in.

```bash
npm install
REFEREE_ADMIN_TOKEN=$(openssl rand -hex 16) npm start
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
- **That AgentMail sent the delivery.** An agent that holds the real signing secret could sign a request itself. The harness should also confirm, through AgentMail's API, that a webhook is registered at the run's address.
- **The payload's shape against a live delivery.** `eventType`, `inboxId` and `messageId` are read from `event_type`, `message.inbox_id` and `message.message_id`. Those names come from an earlier integration and have not been checked here against a real AgentMail delivery. The pass or fail result does not depend on them.

Limits: 1 MB per request body and 100 deliveries per run.

## Tests

```bash
npm test
npm run typecheck
```

26 tests: the signature check, and the HTTP service end to end with deliveries signed the way Svix signs them.

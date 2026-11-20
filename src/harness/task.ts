export interface TaskInput {
  apiKey: string;
  docsUrl: string;
  /** Where AgentMail should deliver this run's webhooks. */
  webhookUrl: string;
  /** Where the agent hands over the webhook's signing secret. */
  secretUrl: string;
}

/**
 * The whole task, as the agent reads it. It states the goal and where things
 * are, and nothing about how: no endpoint names, no field names, no sample
 * code. Finding those in the docs is what is being measured.
 */
export function buildTask(input: TaskInput): string {
  return [
    "Set up AgentMail so that incoming email triggers a webhook, then answer one email.",
    "",
    "Do these things:",
    "1. Create a new AgentMail inbox.",
    `2. Register a webhook on that inbox for received messages. It must deliver to: ${input.webhookUrl}`,
    `3. Send that webhook's signing secret to ${input.secretUrl} as JSON: {"secret": "<the secret>"}`,
    "4. Once the webhook is registered, a test email will arrive in your inbox within about a minute. Reply to it in the same thread. Any short reply will do.",
    "",
    `AgentMail documentation: ${input.docsUrl}`,
    `Your AgentMail API key: ${input.apiKey}`,
    "",
    "You have two tools: http_request, to call any of the addresses above, and wait, to pause while the email arrives.",
    "Work until all four things are done, then say so and stop. You will not be told whether each step worked.",
  ].join("\n");
}

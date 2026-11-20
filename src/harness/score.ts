/** What the harness could confirm from outside the agent, after a run. */
export interface Evidence {
  /** A new inbox exists that was not there before the run. */
  inboxCreated: boolean;
  /** A webhook for received messages points at this run's address, according to AgentMail. */
  webhookRegistered: boolean;
  /** The agent handed some secret to the referee. */
  secretReceived: boolean;
  /** The referee verified a delivery about the test email against that secret. */
  testEmailDelivered: boolean;
  /** A message from the agent's inbox reached the test address after the test email. */
  replied: boolean;
  /** That message is in the test email's thread. */
  repliedInThread: boolean;
}

export interface Score {
  passed: boolean;
  /** How many of the four steps were done, counting in order and stopping at the first miss. */
  stepsReached: 0 | 1 | 2 | 3 | 4;
  steps: { inbox: boolean; webhook: boolean; secret: boolean; reply: boolean };
}

/**
 * Step 3 passes only when the secret is the right one, and the only proof of
 * that is a delivery the referee verified with it. A secret merely received
 * may be the wrong string.
 */
export function score(evidence: Evidence): Score {
  const steps = {
    inbox: evidence.inboxCreated,
    webhook: evidence.webhookRegistered,
    secret: evidence.secretReceived && evidence.testEmailDelivered,
    reply: evidence.repliedInThread,
  };
  const ordered = [steps.inbox, steps.webhook, steps.secret, steps.reply];
  const firstMiss = ordered.indexOf(false);
  return {
    passed: firstMiss === -1,
    stepsReached: (firstMiss === -1 ? 4 : firstMiss) as Score["stepsReached"],
    steps,
  };
}

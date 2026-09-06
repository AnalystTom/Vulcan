import type { AutomationDefinition, AutomationRetryPolicy, BotTask } from "@vulcan/contracts";

export function botResponsibilities(
  tasks: readonly BotTask[],
  definitions: readonly AutomationDefinition[],
): AutomationDefinition[] {
  const threads = new Set(tasks.map((task) => task.threadId));
  return definitions.filter(
    (definition) =>
      !definition.archivedAt &&
      definition.mode === "heartbeat" &&
      definition.targetThreadId !== null &&
      threads.has(definition.targetThreadId),
  );
}

export function responsibilityRetryLabel(policy: AutomationRetryPolicy): string {
  switch (policy.type) {
    case "none":
      return "No automatic retries";
    case "fixed":
      return `Up to ${policy.maxAttempts} attempts · ${policy.delaySeconds}s delay`;
    case "exponential":
      return `Up to ${policy.maxAttempts} attempts · backoff ${policy.initialDelaySeconds}–${policy.maxDelaySeconds}s`;
  }
}

export const RESPONSIBILITY_EVIDENCE_INSTRUCTIONS = `

On every run, read your saved progress and check the source systems before taking action. Continue unfinished work without repeating completed actions. Keep a durable record of processed items, source identifiers, verified results, blockers, and the next action in the automation memory. Save detailed evidence in the task workspace and link it in your final response.
For external actions, check the destination and previous delivery receipts before sending. If a previous action's outcome is uncertain, reconcile it or request help; never blindly resend. Do not contact people or publish without explicit authorization covering that action. Stop for missing access or approval and identify exactly what is needed.
Report completed work separately from drafts and blocked work. Include source URLs, output paths, timestamps and delivery receipts where available. A finished agent turn is not proof of delivery. Notify the user only of meaningful outcomes, failures, or required decisions.`;

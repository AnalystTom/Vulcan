import type { BotCapability, BotControlPhase } from "@vulcan/contracts";

export type BotGatewayPolicyDecision =
  | { readonly decision: "allowed"; readonly capability: BotCapability }
  | {
      readonly decision: "denied";
      readonly capability: BotCapability;
      readonly reason: string;
    };

/** Bot-only peer comms tools registered by agentGateway/botTools.ts. */
export const BOT_PEER_TOOL_NAMES = {
  listBots: "list_bots",
  askBot: "ask_bot",
  delegateBot: "delegate_bot",
} as const;

export function botCapabilityForGatewayTool(toolName: string, readOnly: boolean): BotCapability {
  if (toolName === BOT_PEER_TOOL_NAMES.askBot || toolName === BOT_PEER_TOOL_NAMES.delegateBot) {
    return "peer.message";
  }
  if (toolName === BOT_PEER_TOOL_NAMES.listBots) return "thread.read";
  if (toolName.startsWith("browser_")) return readOnly ? "browser.read" : "browser.control";
  if (toolName.startsWith("vulcan_") && toolName.includes("automation")) {
    return readOnly ? "thread.read" : "automation.write";
  }
  return readOnly ? "thread.read" : "thread.write";
}

/** Pure policy decision. Persistence and audit ordering stay at the gateway boundary. */
export function evaluateBotGatewayToolPolicy(input: {
  readonly capabilityGrants: ReadonlyArray<BotCapability>;
  readonly controlPhase: BotControlPhase;
  readonly toolName: string;
  readonly readOnly: boolean;
}): BotGatewayPolicyDecision {
  const capability = botCapabilityForGatewayTool(input.toolName, input.readOnly);
  if (
    !input.readOnly &&
    (input.controlPhase === "takeover-requested" || input.controlPhase === "human-control")
  ) {
    return {
      decision: "denied",
      capability,
      reason:
        input.controlPhase === "human-control"
          ? "Bot actions are blocked during human control."
          : "Bot actions are blocked while takeover is waiting for a human.",
    };
  }
  if (!input.readOnly && input.controlPhase === "paused") {
    return { decision: "denied", capability, reason: "Bot actions are blocked while paused." };
  }
  if (!input.capabilityGrants.includes(capability)) {
    return {
      decision: "denied",
      capability,
      reason: `Bot policy does not grant ${capability}.`,
    };
  }
  return { decision: "allowed", capability };
}

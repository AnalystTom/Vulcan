import type { BotCapability, CanonicalRequestType } from "@vulcan/contracts";

/** Authority required before a provider-native approval may even reach a human. */
export function requiredBotCapabilitiesForProviderRequest(
  requestType: CanonicalRequestType,
): ReadonlyArray<BotCapability> {
  switch (requestType) {
    case "file_read_approval":
      return ["filesystem.read"];
    case "file_change_approval":
    case "apply_patch_approval":
      return ["filesystem.write"];
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return ["shell.execute"];
    case "auth_tokens_refresh":
      return ["network.external"];
    case "permissions_approval":
    case "unknown":
      // Broad/unknown escalations fail closed unless the operator deliberately
      // granted every authority they could plausibly cross.
      return ["shell.execute", "filesystem.write", "network.external"];
    case "tool_user_input":
      return [];
  }
}

// FILE: ompModels.ts
// Purpose: Parse OMP `omp models --json` output into Vulcan model descriptors.
// Layer: Server provider helper

import type { ProviderListModelsResult } from "@vulcan/contracts";

export interface OmpDiscoveredModel {
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly thinking?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOmpModelSlug(slug: string): { provider?: string; id: string } {
  const trimmed = slug.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { id: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  };
}

export function parseOmpModelsJson(stdout: string): ReadonlyArray<OmpDiscoveredModel> {
  const parsed: unknown = JSON.parse(stdout);
  const models = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  return models.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const provider = trimToUndefined(entry.provider);
    const id = trimToUndefined(entry.id);
    if (!provider || !id) return [];
    const selector = trimToUndefined(entry.selector) ?? `${provider}/${id}`;
    const name = trimToUndefined(entry.name) ?? id;
    const thinking = Array.isArray(entry.thinking)
      ? entry.thinking.filter((level): level is string => typeof level === "string")
      : undefined;
    return [
      {
        provider,
        id,
        selector,
        name,
        ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
        ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
        ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
        ...(thinking && thinking.length > 0 ? { thinking } : {}),
      },
    ];
  });
}

export function toOmpProviderModelDescriptor(
  model: OmpDiscoveredModel,
): ProviderListModelsResult["models"][number] {
  const thinkingLevels = (model.thinking ?? []).filter(
    (level) =>
      level === "off" ||
      level === "minimal" ||
      level === "low" ||
      level === "medium" ||
      level === "high" ||
      level === "xhigh",
  );
  return {
    slug: model.selector,
    name: model.name,
    upstreamProviderId: model.provider,
    upstreamProviderName: model.provider,
    ...(thinkingLevels.length > 0
      ? {
          supportedReasoningEfforts: thinkingLevels.map((level) => ({
            value: level,
            label: level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1),
          })),
        }
      : {}),
  };
}

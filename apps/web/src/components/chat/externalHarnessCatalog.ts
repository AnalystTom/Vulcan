// FILE: externalHarnessCatalog.ts
// Purpose: Describe known external agent harnesses that Vulcan can present without
// pretending they are executable providers before an adapter exists.
// Layer: Chat composer presentation

export type ExternalHarnessDescriptor = {
  readonly id: "exo" | "prime-agent";
  readonly name: string;
  readonly repositoryUrl: string;
  readonly availabilityLabel: string;
};

// These are intentionally separate from ProviderKind. A ProviderKind promises a
// session adapter that can start, stream, interrupt, and stop a turn; neither
// upstream harness exposes that adapter through Vulcan yet.
export const EXTERNAL_HARNESS_CATALOG: readonly ExternalHarnessDescriptor[] = [
  {
    id: "exo",
    name: "Exo",
    repositoryUrl: "https://github.com/exoharness/exo",
    availabilityLabel: "Adapter required",
  },
  {
    id: "prime-agent",
    name: "Prime Agent",
    repositoryUrl: "https://github.com/PrimeIntellect-ai/prime-agent",
    availabilityLabel: "Adapter required",
  },
];

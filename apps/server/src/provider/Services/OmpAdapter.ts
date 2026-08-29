/**
 * OmpAdapter - OMP CLI RPC implementation of the generic provider adapter contract.
 *
 * @module OmpAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "omp";
}

export class OmpAdapter extends ServiceMap.Service<OmpAdapter, OmpAdapterShape>()(
  "vulcan/provider/Services/OmpAdapter",
) {}

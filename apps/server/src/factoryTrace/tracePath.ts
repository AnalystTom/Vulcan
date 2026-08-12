// FILE: tracePath.ts
// Purpose: Give the SSSF reader and writer one trace-location contract.
// Layer: Server factory trace

import { isAbsolute, resolve } from "node:path";

export const DEFAULT_TRACE_DB_RELATIVE = "adws/adw_data/sssf.db";
export const TRACE_DB_PATH_ENVIRONMENT_VARIABLE = "VULCAN_FACTORY_TRACE_DB";

export const resolveTraceDatabasePath = (workspacePath: string): string => {
  const override = process.env[TRACE_DB_PATH_ENVIRONMENT_VARIABLE]?.trim();
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return resolve(workspacePath, DEFAULT_TRACE_DB_RELATIVE);
};

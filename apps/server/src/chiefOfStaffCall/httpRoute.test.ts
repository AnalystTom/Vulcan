import { describe, expect, it } from "vitest";

import type { ServerConfigShape } from "../config";
import { resolveChiefOfStaffCallCorsHeaders } from "./httpRoute";

const config = {
  devUrl: new URL("http://localhost:8891/"),
} as ServerConfigShape;

describe("resolveChiefOfStaffCallCorsHeaders", () => {
  it("allows the configured dev UI to call the loopback server", () => {
    expect(
      resolveChiefOfStaffCallCorsHeaders({
        rawOrigin: "http://localhost:8891",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toMatchObject({
      "Access-Control-Allow-Origin": "http://localhost:8891",
      "Access-Control-Allow-Credentials": "true",
    });
  });

  it("does not expose call controls to unrelated browser origins", () => {
    expect(
      resolveChiefOfStaffCallCorsHeaders({
        rawOrigin: "https://untrusted.example",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBeNull();
  });
});

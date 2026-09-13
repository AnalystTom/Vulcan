import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { readMcpJsonBody } from "../agentGateway/httpRoute";
import { HermesBotRuntime } from "./hermesBotRuntime";

// Native workers authenticate with profile capabilities, independently of browser sessions.
export const hermesSharedAccountsRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "POST",
    "/mcp/hermes",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const runtime = yield* HermesBotRuntime;
      const body = yield* readMcpJsonBody(request);
      if (body.kind !== "ok") {
        return HttpServerResponse.jsonUnsafe(
          { error: "Invalid or oversized MCP request." },
          {
            status: body.kind === "too-large" ? 413 : 400,
          },
        );
      }
      const response = yield* runtime.handleAccountMcpPost(
        request.headers.authorization,
        body.body,
      );
      return response.body === undefined
        ? HttpServerResponse.empty({ status: response.status })
        : HttpServerResponse.jsonUnsafe(response.body, {
            status: response.status,
            headers: { "Cache-Control": "no-store" },
          });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "Shared account request could not be confirmed." },
            { status: 503 },
          ),
        ),
      ),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/mcp/hermes",
    Effect.succeed(HttpServerResponse.empty({ status: 405, headers: { Allow: "POST" } })),
  ),
  HttpRouter.add(
    "DELETE",
    "/mcp/hermes",
    Effect.succeed(HttpServerResponse.empty({ status: 405 })),
  ),
);

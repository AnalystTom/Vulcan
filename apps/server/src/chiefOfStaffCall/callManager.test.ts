import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildChiefOfStaffBriefing,
  buildTwilioTwiMl,
  callRequestIdFromSipHeaders,
  ChiefOfStaffCallManager,
  resolveCallConfiguration,
  validateTwilioSignature,
} from "./callManager";

const completeEnvironment = {
  OPENAI_API_KEY: "openai-key",
  OPENAI_WEBHOOK_SECRET: "whsec_test",
  OPENAI_PROJECT_ID: "proj_123",
  VULCAN_CALL_ME_OPENAI_WEBHOOK_CONFIGURED: "true",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+442079460001",
  VULCAN_CALL_ME_NUMBER: "+447700900001",
} satisfies NodeJS.ProcessEnv;

describe("Chief of Staff call configuration", () => {
  it("fails closed and names every missing setup step", () => {
    const result = resolveCallConfiguration({ env: {}, publicUrl: undefined });

    expect(result.configuration).toBeNull();
    expect(result.setupSteps.filter((step) => !step.configured).map((step) => step.id)).toEqual([
      "public-url",
      "openai-key",
      "openai-project",
      "openai-webhook-secret",
      "openai-webhook-registered",
      "twilio-credentials",
      "phone-numbers",
    ]);
  });

  it("accepts a complete server-only configuration", () => {
    const result = resolveCallConfiguration({
      env: completeEnvironment,
      publicUrl: new URL("https://vulcan.example.com"),
    });

    expect(result.configuration).toMatchObject({
      openAiProjectId: "proj_123",
      openAiSipHost: "sip.api.openai.com",
      publicOrigin: "https://vulcan.example.com",
    });
    expect(result.setupSteps.every((step) => step.configured)).toBe(true);
  });
});

describe("Chief of Staff call briefing", () => {
  it("uses real orchestration state without leaking workspace paths", () => {
    const briefing = buildChiefOfStaffBriefing({
      chiefOfStaff: {
        name: "Maus",
        title: "Chief of Staff",
        archivedAt: null,
        chiefOfStaff: true,
      },
      bots: [
        {
          name: "Maus",
          title: "Chief of Staff",
          archivedAt: null,
          chiefOfStaff: true,
        },
        {
          name: "Scout",
          title: "Researcher",
          archivedAt: null,
          chiefOfStaff: false,
        },
      ],
      snapshot: {
        updatedAt: "2026-08-23T10:00:00.000Z",
        projects: [{ id: "project-1", title: "Agent panel" }],
        threads: [
          {
            projectId: "project-1",
            title: "Ship calls",
            updatedAt: "2026-08-23T09:00:00.000Z",
            branch: "feat/call-me",
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            latestTurn: { state: "completed" },
            session: null,
            lastKnownPr: {
              number: 42,
              state: "open",
              isDraft: false,
              mergeability: "conflicting",
            },
          },
          {
            projectId: "project-1",
            title: "Private provider failure",
            updatedAt: "2026-08-23T08:00:00.000Z",
            branch: null,
            latestTurn: null,
            session: {
              status: "error",
              lastError: "failed under /Users/tom/private with token secret-value",
            },
            lastKnownPr: null,
          },
          {
            projectId: "project-1",
            title: "Closed without merge",
            updatedAt: "2026-08-23T07:00:00.000Z",
            branch: "feat/closed",
            latestTurn: { state: "completed" },
            session: null,
            lastKnownPr: { number: 41, state: "closed" },
          },
          {
            projectId: "project-1",
            title: "Archived stale work",
            updatedAt: "2026-08-23T06:00:00.000Z",
            archivedAt: "2026-08-23T06:30:00.000Z",
            branch: "feat/archived",
            latestTurn: { state: "error" },
            session: null,
            lastKnownPr: null,
          },
        ],
      },
      topic: "What is blocked?",
    });

    expect(briefing).toContain("Agent panel / Ship calls: open PR has conflicts; PR #42 open");
    expect(briefing).toContain("Scout: Researcher");
    expect(briefing).toContain("Tom requested this call about: What is blocked?");
    expect(briefing).toContain("PR was closed without merging; PR #41 closed");
    expect(briefing).not.toContain("Archived stale work");
    expect(briefing).not.toContain("workspaceRoot");
    expect(briefing).not.toContain("/Users/tom/private");
    expect(briefing).not.toContain("secret-value");
  });

  it("bounds oversized user and bot context while preserving safety and status", () => {
    const briefing = buildChiefOfStaffBriefing({
      chiefOfStaff: {
        name: "Maus",
        title: "Chief of Staff",
        archivedAt: null,
        chiefOfStaff: true,
      },
      bots: [],
      snapshot: { updatedAt: "2026-08-23T10:00:00.000Z", projects: [], threads: [] },
      topic: "x".repeat(20_000),
      botContext: "memory ".repeat(5_000),
    });

    expect(briefing.length).toBeLessThanOrEqual(16_000);
    expect(briefing).toContain("[Bot memory truncated for this call.]");
    expect(briefing).toContain("[topic truncated]");
    expect(briefing).toContain("This call is read-only.");
    expect(briefing).toContain("Snapshot time: 2026-08-23T10:00:00.000Z");
  });
});

describe("Chief of Staff telephony boundaries", () => {
  it("builds a Twilio bridge to the OpenAI SIP endpoint", () => {
    expect(
      buildTwilioTwiMl(
        {
          openAiProjectId: "proj_123",
          openAiSipHost: "sip-eu.api.openai.com",
        },
        "call-request-123",
      ),
    ).toBe(
      '<Response><Dial answerOnBridge="true"><Sip>sip:proj_123@sip-eu.api.openai.com;transport=tls?X-Vulcan-Call-Request=call-request-123</Sip></Dial></Response>',
    );
  });

  it("correlates an OpenAI SIP webhook only through the per-request header", () => {
    expect(
      callRequestIdFromSipHeaders([
        { name: "From", value: "sip:+15551234567@example.com" },
        { name: "x-vulcan-call-request", value: "request-456" },
      ]),
    ).toBe("request-456");
    expect(callRequestIdFromSipHeaders([{ name: "Call-ID", value: "unrelated" }])).toBeNull();
  });

  it("verifies Twilio callbacks against their exact public URL and form body", () => {
    const url = "https://vulcan.example.com/api/chief-of-staff/call-me/twilio-status?requestId=1";
    const params = new URLSearchParams({ CallSid: "CA123", CallStatus: "ringing" });
    const payload = `${url}CallSidCA123CallStatusringing`;
    const signature = createHmac("sha1", "twilio-token").update(payload).digest("base64");

    expect(validateTwilioSignature({ authToken: "twilio-token", signature, url, params })).toBe(
      true,
    );
    expect(
      validateTwilioSignature({ authToken: "wrong-token", signature, url, params }),
    ).toBe(false);
  });

  it("recovers an interrupted active call as failed after a server restart", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "vulcan-call-state-")), "call.json");
    const manager = new ChiefOfStaffCallManager();
    await manager.requestCall({
      env: completeEnvironment,
      publicUrl: new URL("https://vulcan.example.com"),
      chiefOfStaff: {
        id: "bot-chief",
        name: "Maus",
        title: "Chief of Staff",
        archivedAt: null,
        chiefOfStaff: true,
      } as never,
      bots: [],
      snapshot: {
        updatedAt: "2026-08-23T10:00:00.000Z",
        projects: [],
        threads: [],
      } as never,
      topic: null,
      statePath,
      fetch: async () =>
        new Response(JSON.stringify({}), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const restarted = new ChiefOfStaffCallManager();
    await restarted.recover({
      env: completeEnvironment,
      publicUrl: new URL("https://vulcan.example.com"),
      statePath,
    });
    const status = restarted.status({
      env: {},
      publicUrl: new URL("https://vulcan.example.com"),
      chiefOfStaff: null,
      statePath,
    });

    expect(status.latestCall).toMatchObject({
      phase: "failed",
      error: "Vulcan restarted before the call completed.",
    });
  });
});

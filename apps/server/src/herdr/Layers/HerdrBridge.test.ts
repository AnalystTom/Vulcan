import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { __herdrBridgeTesting } from "./HerdrBridge.ts";

const binaryPath = "/usr/bin/herdr";

function statusJson(running: boolean): string {
  return JSON.stringify({
    client: { version: "0.7.4", protocol: 16 },
    server: {
      running,
      compatible: true,
      socket: running ? "/tmp/herdr.sock" : null,
    },
  });
}

function outcome(stdout: string): { ok: boolean; stdout: string; stderr: string } {
  return { ok: true, stdout, stderr: "" };
}

function unavailable(): { ok: boolean; stdout: string; stderr: string } {
  return outcome(statusJson(false));
}

function busctlFor(sessionName: string, cwd: string) {
  return async (args: string[]) =>
    args.includes("call")
      ? outcome(JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/test"] }))
      : outcome(
          JSON.stringify({
            type: "as",
            data: [`HERDR_SESSION=${sessionName}`, `HERDR_STARTUP_CWD=${cwd}`],
          }),
        );
}

function supervisedProperties(
  serviceName: string,
  sessionName: string,
  cwd: string,
  transient = false,
): string {
  return `LoadState=loaded
ActiveState=active
SubState=running
MainPID=1234
ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/${serviceName}
FragmentPath=${transient ? `/run/user/1000/systemd/transient/${serviceName}` : `/home/russki/.config/systemd/user/${serviceName}`}
ExecStart={ path=${binaryPath} ; argv[]=${binaryPath} server ; ignore_errors=no ; }
Environment=HERDR_SESSION=${sessionName} HERDR_STARTUP_CWD=${cwd}
WorkingDirectory=${cwd}
Transient=${transient ? "yes" : ""}
`;
}

describe("HerdrBridge named session supervision", () => {
  it("creates a service, starts it, and waits for the named socket", async () => {
    let namedRunning = false;
    let startedUnit: string | null = null;
    const systemctlCalls: string[][] = [];
    const systemdRunCalls: string[][] = [];
    const bridge = __herdrBridgeTesting.make({
      platform: "linux",
      resolveExecutable: () => binaryPath,
      runHerdr: async (_binary, args) =>
        args[0] === "status" || args[0] === "--session"
          ? outcome(statusJson(args[0] === "--session" && namedRunning))
          : outcome(JSON.stringify({ sessions: [] })),
      runSystemctl: async (args) => {
        systemctlCalls.push(args);
        if (args[1] === "show") {
          return startedUnit
            ? outcome(supervisedProperties(startedUnit, "pane-create", "/workspaces/create", true))
            : outcome("LoadState=not-found\n");
        }
        return outcome("");
      },
      runSystemdRun: async (args) => {
        systemdRunCalls.push(args);
        startedUnit = args[2] ?? null;
        namedRunning = true;
        return outcome("");
      },
      runBusctl: busctlFor("pane-create", "/workspaces/create"),
    });

    await expect(
      Effect.runPromise(bridge.resolveAttachCommand("pane-create", "/workspaces/create")),
    ).resolves.toEqual({ shell: binaryPath, args: ["session", "attach", "pane-create"] });

    expect(systemdRunCalls[0]).toEqual([
      "--user",
      "--unit",
      expect.stringMatching(/^vulcan-herdr-session-[0-9a-f]{32}\.service$/),
      "--collect",
      "--no-block",
      "--property",
      "Restart=on-failure",
      "--working-directory",
      "/workspaces/create",
      "--setenv",
      "HERDR_SESSION=pane-create",
      "--setenv",
      "HERDR_STARTUP_CWD=/workspaces/create",
      binaryPath,
      "server",
    ]);
    expect(systemctlCalls).toHaveLength(2);
  });

  it("reuses a running legacy session only when its user service proves ownership and cwd", async () => {
    const sessionName = "pane-legacy";
    const cwd = "/workspaces/legacy pane";
    const legacyService = `herdr-session-${sessionName}.service`;
    const calls: string[][] = [];
    const bridge = __herdrBridgeTesting.make({
      platform: "linux",
      resolveExecutable: () => binaryPath,
      runHerdr: async (_binary, args) =>
        args[0] === "--session" ? outcome(statusJson(true)) : unavailable(),
      runSystemctl: async (args) => {
        calls.push(args);
        if (args[1] === "show") {
          return args[2]?.startsWith("vulcan-herdr-session-")
            ? outcome("LoadState=not-found\n")
            : outcome(supervisedProperties(legacyService, sessionName, cwd));
        }
        return outcome("");
      },
      runBusctl: busctlFor(sessionName, cwd),
    });
    await expect(Effect.runPromise(bridge.resolveAttachCommand(sessionName, cwd))).resolves.toEqual(
      { shell: binaryPath, args: ["session", "attach", sessionName] },
    );
    expect(calls.some((args) => args.includes("start"))).toBe(false);
  });

  it("rejects an active named socket when its service has mismatched ownership or cwd", async () => {
    const sessionName = "pane-unsafe";
    const calls: string[][] = [];
    const bridge = __herdrBridgeTesting.make({
      platform: "linux",
      resolveExecutable: () => binaryPath,
      runHerdr: async (_binary, args) =>
        args[0] === "--session" ? outcome(statusJson(true)) : unavailable(),
      runSystemctl: async (args) => {
        calls.push(args);
        if (args[1] === "show") {
          return args[2]?.startsWith("vulcan-herdr-session-")
            ? outcome("LoadState=not-found\n")
            : outcome(
                supervisedProperties(
                  `herdr-session-${sessionName}.service`,
                  sessionName,
                  "/workspaces/other",
                ),
              );
        }
        return outcome("");
      },
      runBusctl: busctlFor(sessionName, "/workspaces/other"),
    });

    await expect(
      Effect.runPromise(bridge.resolveAttachCommand(sessionName, "/workspaces/requested")),
    ).rejects.toThrow(/unknown or mismatched service/);
    expect(calls.some((args) => args.includes("start"))).toBe(false);
  });

  it("coalesces concurrent cold named probes before starting one transient unit", async () => {
    const sessionName = "pane-cold-race";
    const cwd = "/workspaces/cold";
    let namedRunning = false;
    let startedUnit: string | null = null;
    let probeEntered!: () => void;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeSeen = new Promise<void>((resolve) => {
      probeEntered = resolve;
    });
    let namedProbeCount = 0;
    let coldProbeCount = 0;
    let systemdRunCount = 0;
    const bridge = __herdrBridgeTesting.make({
      platform: "linux",
      resolveExecutable: () => binaryPath,
      runHerdr: async (_binary, args) => {
        if (args[0] === "--session") {
          namedProbeCount += 1;
          if (!namedRunning) {
            coldProbeCount += 1;
            probeEntered();
            await probeGate;
          }
          return outcome(statusJson(namedRunning));
        }
        return unavailable();
      },
      runSystemctl: async (args) => {
        if (args[1] === "show") {
          return startedUnit
            ? outcome(supervisedProperties(startedUnit, sessionName, cwd, true))
            : outcome("LoadState=not-found\n");
        }
        return outcome("");
      },
      runSystemdRun: async (args) => {
        systemdRunCount += 1;
        startedUnit = args[2] ?? null;
        namedRunning = true;
        return outcome("");
      },
      runBusctl: busctlFor(sessionName, cwd),
    });

    const first = Effect.runPromise(bridge.resolveAttachCommand(sessionName, cwd));
    await probeSeen;
    const second = Effect.runPromise(bridge.resolveAttachCommand(sessionName, cwd));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProbe();
    await expect(first).resolves.toEqual({
      shell: binaryPath,
      args: ["session", "attach", sessionName],
    });
    await expect(second).resolves.toEqual({
      shell: binaryPath,
      args: ["session", "attach", sessionName],
    });
    expect(namedProbeCount).toBe(3);
    expect(coldProbeCount).toBe(1);
    expect(systemdRunCount).toBe(1);
  });

  it("rejects a second concurrent start with a different cwd", async () => {
    const sessionName = "pane-concurrent";
    let namedRunning = false;
    let startedUnit: string | null = null;
    let startEntered!: () => void;
    let releaseStart!: () => void;
    const startSeen = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const bridge = __herdrBridgeTesting.make({
      platform: "linux",
      resolveExecutable: () => binaryPath,
      runHerdr: async (_binary, args) =>
        args[0] === "status" || args[0] === "--session"
          ? outcome(statusJson(args[0] === "--session" && namedRunning))
          : outcome(JSON.stringify({ sessions: [] })),
      runSystemctl: async (args) => {
        if (args[1] === "show") {
          return startedUnit
            ? outcome(supervisedProperties(startedUnit, sessionName, "/workspaces/first", true))
            : outcome("LoadState=not-found\n");
        }
        return outcome("");
      },
      runSystemdRun: async (args) => {
        startEntered();
        await startGate;
        namedRunning = true;
        startedUnit = args[2] ?? null;
        return outcome("");
      },
      runBusctl: busctlFor(sessionName, "/workspaces/first"),
    });

    const first = Effect.runPromise(bridge.resolveAttachCommand(sessionName, "/workspaces/first"));
    await startSeen;
    await expect(
      Effect.runPromise(bridge.resolveAttachCommand(sessionName, "/workspaces/second")),
    ).rejects.toThrow(/different working directory/);
    releaseStart();
    await expect(first).resolves.toEqual({
      shell: binaryPath,
      args: ["session", "attach", sessionName],
    });
  });
});

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { HerdrAvailability, HerdrStatus } from "@vulcan/contracts";
import { Effect, Layer } from "effect";

import { resolveExecutable } from "../../executableLookup.ts";
import {
  evaluateHerdrAvailability,
  type HerdrCommandOutcome,
  herdrAttachCommand,
  parseHerdrSessions,
} from "../herdrStatusParsing.ts";
import { HerdrBridge, type HerdrBridgeShape } from "../Services/HerdrBridge.ts";

const execFileAsync = promisify(execFile);

/**
 * Probing spawns two short-lived subprocesses. Panes ask for availability on
 * every render and every reconnect, so the verdict is cached for long enough to
 * keep that free while still noticing an operator who has just started Herdr in
 * another window.
 */
const STATUS_CACHE_MS = 5_000;

/** Herdr answers status locally over a unix socket; anything slower is wedged. */
const COMMAND_TIMEOUT_MS = 5_000;
const SESSION_START_TIMEOUT_MS = 10_000;
const SESSION_START_POLL_MS = 100;
const HERDR_SESSION_SERVICE_PREFIX = "vulcan-herdr-session-";

type HerdrCommandRunner = (binaryPath: string, args: string[]) => Promise<HerdrCommandOutcome>;
type SystemctlCommandRunner = (args: string[]) => Promise<HerdrCommandOutcome>;
type BusctlCommandRunner = (args: string[]) => Promise<HerdrCommandOutcome>;
type HerdrAttachCommand = { readonly shell: string; readonly args: string[] };

export interface HerdrBridgeOptions {
  readonly runHerdr?: HerdrCommandRunner;
  readonly runSystemctl?: SystemctlCommandRunner;
  readonly runSystemdRun?: SystemctlCommandRunner;
  readonly runBusctl?: BusctlCommandRunner;
  readonly resolveExecutable?: () => string | null;
  readonly platform?: NodeJS.Platform;
}

interface HerdrBridgeCommands {
  readonly runHerdr: HerdrCommandRunner;
  readonly runSystemctl: SystemctlCommandRunner;
  readonly runSystemdRun: SystemctlCommandRunner;
  readonly runBusctl: BusctlCommandRunner;
}

async function runCommand(
  command: string,
  args: string[],
  options: { readonly windowsHide?: boolean; readonly fallbackError: string },
): Promise<HerdrCommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1_000_000,
      ...(options.windowsHide === undefined ? {} : { windowsHide: options.windowsHide }),
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? options.fallbackError,
    };
  }
}

const runHerdr = (binaryPath: string, args: string[]): Promise<HerdrCommandOutcome> =>
  runCommand(binaryPath, args, { windowsHide: true, fallbackError: "herdr invocation failed" });

const runSystemctl = (args: string[]): Promise<HerdrCommandOutcome> =>
  runCommand("systemctl", args, { fallbackError: "systemctl invocation failed" });

const runSystemdRun = (args: string[]): Promise<HerdrCommandOutcome> =>
  runCommand("systemd-run", args, { fallbackError: "systemd-run invocation failed" });

const runBusctl = (args: string[]): Promise<HerdrCommandOutcome> =>
  runCommand("busctl", args, { fallbackError: "busctl invocation failed" });

function herdrSessionServiceName(sessionName: string): string {
  const digest = createHash("sha256").update(sessionName, "utf8").digest("hex").slice(0, 32);
  return `${HERDR_SESSION_SERVICE_PREFIX}${digest}.service`;
}

const legacyHerdrSessionServiceName = (sessionName: string): string =>
  `herdr-session-${sessionName}.service`;

function parseSystemdProperties(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

async function readUnitEnvironment(
  commands: HerdrBridgeCommands,
  serviceName: string,
): Promise<string[] | null> {
  const loaded = await commands.runBusctl([
    "--user",
    "--json=short",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "LoadUnit",
    "s",
    serviceName,
  ]);
  if (!loaded.ok) return null;
  let objectPath: unknown;
  try {
    objectPath = (JSON.parse(loaded.stdout) as { readonly data?: unknown }).data;
  } catch {
    return null;
  }
  const unitPath =
    Array.isArray(objectPath) && typeof objectPath[0] === "string" ? objectPath[0] : null;
  if (unitPath === null) return null;
  const environment = await commands.runBusctl([
    "--user",
    "--json=short",
    "get-property",
    "org.freedesktop.systemd1",
    unitPath,
    "org.freedesktop.systemd1.Service",
    "Environment",
  ]);
  if (!environment.ok) return null;
  try {
    const data = (JSON.parse(environment.stdout) as { readonly data?: unknown }).data;
    return Array.isArray(data) && data.every((entry) => typeof entry === "string") ? data : null;
  } catch {
    return null;
  }
}

async function inspectSupervisedSession(
  commands: HerdrBridgeCommands,
  serviceName: string,
  binaryPath: string,
  sessionName: string,
  cwd: string,
  kind: "legacy" | "transient",
): Promise<"missing" | "safe" | "unsafe" | "unavailable"> {
  const shown = await commands.runSystemctl([
    "--user",
    "show",
    serviceName,
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,FragmentPath,ExecStart,WorkingDirectory,Transient",
  ]);
  if (!shown.ok) return "unavailable";
  const properties = parseSystemdProperties(shown.stdout);
  if (properties.get("LoadState") === "not-found") return "missing";
  const mainPid = Number(properties.get("MainPID"));
  if (
    properties.get("ActiveState") !== "active" ||
    properties.get("SubState") !== "running" ||
    !Number.isInteger(mainPid) ||
    mainPid <= 0
  ) {
    return "unsafe";
  }
  if (
    !properties.get("ControlGroup")?.endsWith(`/${serviceName}`) ||
    (kind === "transient" && properties.get("WorkingDirectory") !== cwd)
  ) {
    return "unsafe";
  }
  const fragmentPath = properties.get("FragmentPath") ?? "";
  if (
    kind === "transient"
      ? properties.get("Transient") !== "yes" ||
        !/^\/run\/user\/\d+\/systemd\/transient\/.+\.service$/.test(fragmentPath)
      : properties.get("Transient") === "yes" ||
        !fragmentPath.endsWith(`/systemd/user/${serviceName}`)
  ) {
    return "unsafe";
  }
  const execStart = properties.get("ExecStart") ?? "";
  const argv = execStart.match(/argv\[\]=([^;]*) ;/)?.[1]?.trim();
  if (!execStart.includes(`path=${binaryPath} ;`) || argv !== `${binaryPath} server`) {
    return "unsafe";
  }
  const environment = await readUnitEnvironment(commands, serviceName);
  if (
    environment === null ||
    !environment.includes(`HERDR_SESSION=${sessionName}`) ||
    !environment.includes(`HERDR_STARTUP_CWD=${cwd}`) ||
    environment.length !== 2
  ) {
    return "unsafe";
  }
  return "safe";
}

async function requireSupervisedExistingSession(
  commands: HerdrBridgeCommands,
  binaryPath: string,
  sessionName: string,
  cwd: string,
): Promise<void> {
  let foundUnsafeService = false;
  let managerUnavailable = false;
  for (const [serviceName, kind] of [
    [herdrSessionServiceName(sessionName), "transient"] as const,
    [legacyHerdrSessionServiceName(sessionName), "legacy"] as const,
  ]) {
    const ownership = await inspectSupervisedSession(
      commands,
      serviceName,
      binaryPath,
      sessionName,
      cwd,
      kind,
    );
    if (ownership === "safe") return;
    foundUnsafeService ||= ownership === "unsafe";
    managerUnavailable ||= ownership === "unavailable";
  }
  if (managerUnavailable) {
    throw new Error(
      "Linux named Herdr panes require a reachable systemd user manager; Vulcan did not adopt or restart the existing session.",
    );
  }
  if (foundUnsafeService) {
    throw new Error(
      `Existing Herdr session "${sessionName}" is running under an unknown or mismatched service. Vulcan did not adopt or restart it; supervise it with the Vulcan named-session service or choose another session.`,
    );
  }
  throw new Error(
    `Existing Herdr session "${sessionName}" is not independently supervised. Vulcan did not adopt or restart it; supervise it with the Vulcan named-session service or choose another session.`,
  );
}

async function waitForNamedSession(
  commands: HerdrBridgeCommands,
  binaryPath: string,
  sessionName: string,
): Promise<void> {
  const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusOutcome = await commands.runHerdr(binaryPath, [
      "--session",
      sessionName,
      "status",
      "--json",
    ]);
    const availability = evaluateHerdrAvailability(binaryPath, statusOutcome);
    if (availability.status === "available") return;
    await new Promise((resolve) => setTimeout(resolve, SESSION_START_POLL_MS));
  }
  throw new Error(
    `Named Herdr session "${sessionName}" did not become ready under its Vulcan systemd user service. Check the service status and retry.`,
  );
}

async function startSupervisedNamedSession(
  commands: HerdrBridgeCommands,
  binaryPath: string,
  sessionName: string,
  cwd: string,
): Promise<void> {
  const serviceName = herdrSessionServiceName(sessionName);
  const existing = await inspectSupervisedSession(
    commands,
    serviceName,
    binaryPath,
    sessionName,
    cwd,
    "transient",
  );
  if (existing === "unavailable") {
    throw new Error(
      "Linux named Herdr panes require a reachable systemd user manager; Vulcan did not start a fallback shell.",
    );
  }
  if (existing === "unsafe") {
    throw new Error(
      `A named Herdr service already exists for "${sessionName}" but is not owned by Vulcan. Vulcan did not adopt or restart it; retry after checking the named user service.`,
    );
  }
  if (existing === "safe") {
    const started = await commands.runSystemctl(["--user", "start", serviceName]);
    if (!started.ok) {
      throw new Error(
        `Vulcan could not start the supervised Herdr session "${sessionName}". Check the named user service and retry.`,
      );
    }
  } else {
    const started = await commands.runSystemdRun([
      "--user",
      "--unit",
      serviceName,
      "--collect",
      "--no-block",
      "--property",
      "Restart=on-failure",
      "--working-directory",
      cwd,
      "--setenv",
      `HERDR_SESSION=${sessionName}`,
      "--setenv",
      `HERDR_STARTUP_CWD=${cwd}`,
      binaryPath,
      "server",
    ]);
    if (!started.ok) {
      throw new Error(
        `Vulcan could not start the supervised Herdr session "${sessionName}". Check the named user service and retry.`,
      );
    }
  }

  await waitForNamedSession(commands, binaryPath, sessionName);
}

const makeHerdrBridge = (options: HerdrBridgeOptions = {}): HerdrBridgeShape => {
  const commands: HerdrBridgeCommands = {
    runHerdr: options.runHerdr ?? runHerdr,
    runSystemctl: options.runSystemctl ?? runSystemctl,
    runSystemdRun: options.runSystemdRun ?? runSystemdRun,
    runBusctl: options.runBusctl ?? runBusctl,
  };
  const executable = options.resolveExecutable ?? (() => resolveExecutable("herdr"));
  const platform = options.platform ?? process.platform;
  let cached: { readonly status: HerdrStatus; readonly probedAt: number } | null = null;
  // Concurrent panes mounting at once must not each spawn their own probe.
  let inFlight: Promise<HerdrStatus> | null = null;
  const namedSessionStarts = new Map<
    string,
    { readonly cwd: string; readonly promise: Promise<HerdrAttachCommand | null> }
  >();

  const probe = async (): Promise<HerdrStatus> => {
    const binaryPath = executable();
    const statusOutcome =
      binaryPath === null ? null : await commands.runHerdr(binaryPath, ["status", "--json"]);
    const availability = evaluateHerdrAvailability(binaryPath, statusOutcome);

    // Only ask for sessions once Herdr is known good. Listing sessions from a
    // broken install would produce noise the operator cannot act on.
    const sessions =
      availability.status === "available"
        ? parseHerdrSessions(
            await commands.runHerdr(availability.binaryPath, ["session", "list", "--json"]),
          )
        : [];

    return { availability, sessions, checkedAt: new Date().toISOString() };
  };

  const readStatus = (options?: { readonly refresh?: boolean }): Effect.Effect<HerdrStatus> =>
    Effect.promise(() => {
      const now = Date.now();
      if (!options?.refresh && cached && now - cached.probedAt < STATUS_CACHE_MS) {
        return Promise.resolve(cached.status);
      }
      if (inFlight) return inFlight;
      inFlight = probe()
        .then((status) => {
          cached = { status, probedAt: Date.now() };
          return status;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    });

  const availability = (options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<HerdrAvailability> =>
    readStatus(options).pipe(Effect.map((status) => status.availability));

  const resolveAttachCommand: HerdrBridgeShape["resolveAttachCommand"] = (sessionName, cwd) =>
    Effect.promise(async () => {
      if (sessionName === "default" || platform !== "linux") {
        const current = await Effect.runPromise(readStatus({ refresh: true }));
        return herdrAttachCommand(current.availability, sessionName);
      }
      if (!cwd) {
        throw new Error(
          `A working directory is required before Vulcan can supervise named Herdr session "${sessionName}".`,
        );
      }
      const binaryPath = executable();
      if (binaryPath === null) return null;

      const pending = namedSessionStarts.get(sessionName);
      if (pending) {
        if (pending.cwd !== cwd) {
          throw new Error(
            `Named Herdr session "${sessionName}" is already starting for a different working directory. Wait for it to finish, then retry with the original directory.`,
          );
        }
        return pending.promise;
      }

      // Register before the first named-session await. Concurrent cold probes
      // must share this entire read/start/verify sequence.
      const promise = (async (): Promise<HerdrAttachCommand | null> => {
        const current = await Effect.runPromise(readStatus({ refresh: true }));
        const existing = evaluateHerdrAvailability(
          binaryPath,
          await commands.runHerdr(binaryPath, ["--session", sessionName, "status", "--json"]),
        );
        const existingCommand = herdrAttachCommand(existing, sessionName);
        if (existingCommand) {
          await requireSupervisedExistingSession(commands, binaryPath, sessionName, cwd);
          return existingCommand;
        }
        if (
          current.availability.status !== "available" &&
          current.availability.reason !== "server-not-running"
        ) {
          return null;
        }
        await startSupervisedNamedSession(commands, binaryPath, sessionName, cwd);
        const ready = evaluateHerdrAvailability(
          binaryPath,
          await commands.runHerdr(binaryPath, ["--session", sessionName, "status", "--json"]),
        );
        const command = herdrAttachCommand(ready, sessionName);
        if (!command) {
          throw new Error(
            `Named Herdr session "${sessionName}" was supervised but is not attachable. Check the named user service and retry.`,
          );
        }
        await requireSupervisedExistingSession(commands, binaryPath, sessionName, cwd);
        return command;
      })().finally(() => {
        if (namedSessionStarts.get(sessionName)?.promise === promise)
          namedSessionStarts.delete(sessionName);
      });
      namedSessionStarts.set(sessionName, { cwd, promise });
      return promise;
    });

  return { status: readStatus, availability, resolveAttachCommand };
};

export const __herdrBridgeTesting = { make: makeHerdrBridge };

export const HerdrBridgeLive = Layer.effect(
  HerdrBridge,
  Effect.sync(() => makeHerdrBridge()),
);

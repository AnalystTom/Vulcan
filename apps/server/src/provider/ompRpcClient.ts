// FILE: ompRpcClient.ts
// Purpose: NDJSON stdin/stdout client for `omp --mode rpc`.
// Layer: Server provider helper

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type OmpRpcFrame = Record<string, unknown>;

export interface OmpRpcClientOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess?: typeof spawn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class OmpRpcCommandError extends Error {
  readonly command: string;
  readonly code: string | undefined;

  constructor(message: string, command: string, code?: string) {
    super(message);
    this.name = "OmpRpcCommandError";
    this.command = command;
    this.code = code;
  }
}

export class OmpRpcClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stderr = "";
  private ready = false;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: OmpRpcFrame) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly listeners = new Set<(frame: OmpRpcFrame) => void>();

  constructor(private readonly options: OmpRpcClientOptions) {}

  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStderr(): string {
    return this.stderr;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(this.options.executable, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 64_000) {
        this.stderr = this.stderr.slice(-32_000);
      }
    });
    const stdout = child.stdout;
    if (!stdout) {
      throw new Error("OMP RPC process did not expose stdout.");
    }
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => {
      this.handleLine(line);
    });
    child.once("error", (error) => {
      this.failAll(error);
    });
    child.once("exit", (code, signal) => {
      this.failAll(
        new Error(
          `OMP RPC process exited${code !== null ? ` with code ${code}` : ""}${
            signal ? ` (${signal})` : ""
          }.${this.stderr.trim() ? ` ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
    await this.waitForReady();
    await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
  }

  async request(command: Record<string, unknown>): Promise<OmpRpcFrame> {
    const id = String(this.nextId++);
    return await new Promise<OmpRpcFrame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ ...command, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAll(new Error("OMP RPC client stopped."));
    if (!child || child.exitCode !== null || child.signalCode) {
      return;
    }
    child.stdin?.end();
    child.kill("SIGTERM");
  }

  private waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("OMP RPC process did not emit a ready frame."));
      }, 15_000);
      const unsubscribe = this.onFrame((frame) => {
        if (frame.type === "ready") {
          this.ready = true;
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  private write(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin) {
      throw new Error("OMP RPC process is not running.");
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    if (frame.type === "response") {
      const id = typeof frame.id === "string" ? frame.id : undefined;
      const pending = id ? this.pending.get(id) : undefined;
      if (pending && id) {
        this.pending.delete(id);
        if (frame.success === false) {
          pending.reject(
            new OmpRpcCommandError(
              typeof frame.error === "string" ? frame.error : "OMP RPC command failed.",
              typeof frame.command === "string" ? frame.command : "unknown",
              typeof frame.code === "string" ? frame.code : undefined,
            ),
          );
          return;
        }
        pending.resolve(frame);
      }
    }
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

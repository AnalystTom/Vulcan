import { describe, expect, it } from "vitest";
import {
  deriveFriendlyCommandTarget,
  deriveInlineCommandCall,
  deriveReadableCommandDisplay,
  deriveReadableToolTitle,
  deriveVulcanMcpToolTitle,
  extractWebFetchUrl,
  isInspectCommand,
  isVulcanBrowserToolCall,
  normalizeCompactToolLabel,
  resolveCommandVisualKind,
  sanitizeVulcanMcpToolPreview,
} from "./toolCallLabel";

describe("extractWebFetchUrl", () => {
  it("pulls the url out of a WebFetch argument summary", () => {
    expect(
      extractWebFetchUrl({
        toolName: "WebFetch",
        detail: 'WebFetch: {"url":"https://ui.shadcn.com/docs/components","prompt":"List EVER..."}',
      }),
    ).toBe("https://ui.shadcn.com/docs/components");
  });

  it("recognizes alternate fetch tool names and the uri field", () => {
    expect(
      extractWebFetchUrl({
        toolName: "web_fetch",
        detail: '{"uri":"https://example.com/path"}',
      }),
    ).toBe("https://example.com/path");
  });

  it("falls back to a bare URL token when there is no json field", () => {
    expect(extractWebFetchUrl({ toolName: "fetch", detail: "Fetching https://example.com." })).toBe(
      "https://example.com",
    );
  });

  it("ignores non-fetch tools", () => {
    expect(
      extractWebFetchUrl({ toolName: "Read", detail: '{"url":"https://example.com"}' }),
    ).toBeNull();
  });

  it("ignores non-http(s) and missing urls", () => {
    expect(
      extractWebFetchUrl({ toolName: "WebFetch", detail: '{"url":"ftp://example.com"}' }),
    ).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: '{"prompt":"hi"}' })).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: undefined })).toBeNull();
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording", () => {
    expect(normalizeCompactToolLabel("Tool call completed")).toBe("Tool call");
    expect(normalizeCompactToolLabel("Ran command done")).toBe("Ran command");
    expect(normalizeCompactToolLabel("Ran command started")).toBe("Ran command");
  });
});

describe("deriveVulcanMcpToolTitle", () => {
  it("uses stable action-first names for Vulcan browser tools", () => {
    for (const status of ["running", "completed", "failed"] as const) {
      expect(
        deriveVulcanMcpToolTitle({
          toolName: "mcp__vulcan__browser_open",
          status,
        }),
      ).toBe("Open browser tab");
    }

    expect(
      deriveVulcanMcpToolTitle({
        title: "Vulcan: Browser Snapshot",
        status: "completed",
      }),
    ).toBe("Snapshot browser page");
  });

  it("has intentional running and completed copy for every Vulcan gateway action", () => {
    const cases = [
      ["vulcan_context", "Vulcan is checking its context", "Vulcan checked its context"],
      [
        "vulcan_capabilities",
        "Vulcan is checking available agents",
        "Vulcan checked available agents",
      ],
      ["vulcan_list_projects", "Vulcan is listing projects", "Vulcan listed projects"],
      ["vulcan_list_threads", "Vulcan is listing threads", "Vulcan listed threads"],
      ["vulcan_read_thread", "Vulcan is reading a thread", "Vulcan read a thread"],
      [
        "vulcan_read_thread_activity",
        "Vulcan is reading thread activity",
        "Vulcan read thread activity",
      ],
      ["vulcan_read_thread_events", "Vulcan is reading thread events", "Vulcan read thread events"],
      [
        "vulcan_read_thread_runtime_events",
        "Vulcan is reading thread runtime events",
        "Vulcan read thread runtime events",
      ],
      ["vulcan_diagnose_thread", "Vulcan is diagnosing a thread", "Vulcan diagnosed a thread"],
      ["vulcan_create_thread", "Vulcan is creating a thread", "Vulcan created a thread"],
      ["vulcan_create_threads", "Vulcan is creating threads", "Vulcan created threads"],
      [
        "vulcan_wait_for_threads",
        "Vulcan is waiting for threads",
        "Vulcan finished waiting for threads",
      ],
      ["vulcan_send_message", "Vulcan is sending a message", "Vulcan sent a message"],
      ["vulcan_interrupt_thread", "Vulcan is interrupting a thread", "Vulcan interrupted a thread"],
      ["vulcan_set_thread_title", "Vulcan is renaming a thread", "Vulcan renamed a thread"],
      ["vulcan_set_thread_archived", "Vulcan is updating a thread", "Vulcan updated a thread"],
      [
        "vulcan_create_automation",
        "Vulcan is creating an automation",
        "Vulcan created an automation",
      ],
      ["vulcan_list_automations", "Vulcan is listing automations", "Vulcan listed automations"],
      [
        "vulcan_cancel_automation",
        "Vulcan is stopping an automation",
        "Vulcan stopped an automation",
      ],
      ["vulcan_overview", "Vulcan is gathering an overview", "Vulcan gathered an overview"],
      [
        "vulcan_list_allowed_projects",
        "Vulcan is listing allowed projects",
        "Vulcan listed allowed projects",
      ],
      ["vulcan_create_task", "Vulcan is creating a task", "Vulcan created a task"],
      [
        "vulcan_wait_for_task",
        "Vulcan is waiting for a task",
        "Vulcan finished waiting for a task",
      ],
      ["vulcan_read_task", "Vulcan is reading a task", "Vulcan read a task"],
    ] as const;

    for (const [toolName, running, completed] of cases) {
      expect(deriveVulcanMcpToolTitle({ toolName, status: "running" })).toBe(running);
      expect(deriveVulcanMcpToolTitle({ toolName, status: "completed" })).toBe(completed);
    }

    expect(
      deriveVulcanMcpToolTitle({
        toolName: "vulcan_create_threads",
        status: "failed",
      }),
    ).toBe("Vulcan couldn't create threads");
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "vulcan_create_thread",
        status: "cancelled",
      }),
    ).toBe("Vulcan stopped creating a thread");
  });

  it("turns provider-specific create-thread identifiers into activity sentences", () => {
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "Vulcan__vulcan_create_thread",
        status: "running",
      }),
    ).toBe("Vulcan is creating a thread");
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "mcp__vulcan__vulcan_create_thread",
        status: "completed",
      }),
    ).toBe("Vulcan created a thread");
  });

  it("recognizes bare and already-humanized Vulcan tool names", () => {
    expect(deriveVulcanMcpToolTitle({ toolName: "vulcan_send_message", status: "running" })).toBe(
      "Vulcan is sending a message",
    );
    expect(
      deriveVulcanMcpToolTitle({ title: "Vulcan: Vulcan List Threads", status: "completed" }),
    ).toBe("Vulcan listed threads");
  });

  it("ignores tools from other MCP servers", () => {
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "mcp__codex_apps__github_fetch_pr",
        status: "running",
      }),
    ).toBeNull();
  });

  it("keeps future Vulcan actions branded without exposing raw identifiers", () => {
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "mcp__vulcan__vulcan_delete_project",
        status: "running",
      }),
    ).toBe("Vulcan is handling delete project");
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "Vulcan__vulcan_delete_project",
        status: "completed",
      }),
    ).toBe("Vulcan handled delete project");
    expect(
      deriveVulcanMcpToolTitle({
        toolName: "vulcan_is_handling_delete_project",
        status: "completed",
      }),
    ).toBe("Vulcan handled delete project");
  });

  it("does not reinterpret free text beginning with fallback status copy", () => {
    expect(
      deriveVulcanMcpToolTitle({
        title: "Vulcan is handling delete project after recovery",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveVulcanMcpToolTitle({
        title: "Vulcan handled delete project after recovery",
        status: "running",
      }),
    ).toBeNull();
    expect(
      deriveVulcanMcpToolTitle({
        title: "Vulcan couldn't handle delete project after recovery",
        status: "failed",
      }),
    ).toBeNull();
  });

  it("leaves free-text activity summaries starting with Vulcan untouched", () => {
    expect(
      deriveVulcanMcpToolTitle({
        title: "Vulcan recovered a stale running state",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveVulcanMcpToolTitle({
        fallbackLabel: "Vulcan restarted the provider session",
        status: "running",
      }),
    ).toBeNull();
  });

  it("removes transport identifiers without hiding meaningful Vulcan details", () => {
    expect(
      sanitizeVulcanMcpToolPreview({
        preview: "Vulcan__vulcan_create_threads",
        heading: "Vulcan created threads",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      sanitizeVulcanMcpToolPreview({
        preview: 'Unexpected key "reasoningEffort" for Claude Agent',
        heading: "Vulcan couldn't create threads",
        status: "failed",
      }),
    ).toBe('Unexpected key "reasoningEffort" for Claude Agent');
  });
});

describe("isVulcanBrowserToolCall", () => {
  it("recognizes canonical presentation titles without a tool identifier", () => {
    expect(isVulcanBrowserToolCall({ title: "Open browser tab" })).toBe(true);
    expect(isVulcanBrowserToolCall({ fallbackLabel: "Snapshot browser page" })).toBe(true);
    expect(isVulcanBrowserToolCall({ title: "Vulcan listed threads" })).toBe(false);
  });
});

describe("deriveReadableToolTitle", () => {
  it("humanizes search commands even when wrapped in shell -lc", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        requestKind: "command",
        command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
      }),
    ).toBe("Searched");
  });

  it("humanizes file read commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "sed -n '520,550p' apps/web/src/session-logic.ts",
      }),
    ).toBe("Read");
  });

  it("humanizes git status commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "git status --short",
      }),
    ).toBe("Checked");
  });

  it("keeps explicit non-generic titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "Bash",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "echo hello",
      }),
    ).toBe("Bash");
  });

  it("extracts a descriptor from payload when the title is generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Tool call",
        fallbackLabel: "Tool call",
        itemType: "dynamic_tool_call",
        payload: {
          data: {
            item: {
              toolName: "mcp__xcodebuildmcp__list_sims",
            },
          },
        },
      }),
    ).toBe("Xcodebuildmcp: List Sims");
  });

  it("treats Cursor placeholder titles as generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Find",
        fallbackLabel: "Find",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "search" } },
      }),
    ).toBe("Search");

    expect(
      deriveReadableToolTitle({
        title: "Read File",
        fallbackLabel: "Read File",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "read" } },
      }),
    ).toBe("Read");
  });

  it("formats MCP identifiers into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            toolName: "mcp__codex_apps__github_fetch_pr",
          },
        },
      }),
    ).toBe("Codex Apps: Github Fetch Pr");
  });

  it("formats structured MCP server/tool payloads into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            item: {
              type: "mcpToolCall",
              server: "computer-use",
              tool: "get_app_state",
            },
          },
        },
      }),
    ).toBe("Computer Use: Get App State");
  });
});

describe("deriveReadableCommandDisplay", () => {
  it("extracts search targets without leaking the full shell wrapper inline", () => {
    expect(deriveReadableCommandDisplay(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toEqual({
      verb: "Searched",
      target: "for tool call in web/src",
      fullCommand: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
    });
  });

  it("compacts file paths for read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
      ),
    ).toEqual({
      verb: "Read",
      target: "chat/MessagesTimeline.tsx",
      fullCommand: "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
    });
  });

  it("unwraps zsh shell wrappers around read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "components/provider-card.tsx",
      fullCommand: `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
    });
  });

  it("keeps quoted paths intact when shell wrappers include cd chaining", () => {
    expect(
      deriveReadableCommandDisplay(
        `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "pages/overview.tsx",
      fullCommand: `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
    });
  });

  it("does not discard real chained commands after a shell wrapper", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
      ),
    ).toEqual({
      verb: "Removed",
      target: "/tmp/test.log",
      fullCommand: `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
    });
  });

  it("removes env and timeout wrappers from inline command summaries", () => {
    expect(
      deriveReadableCommandDisplay(
        "env -u VULCAN_AUTH_TOKEN VULCAN_PORT_OFFSET=3158 timeout 180s bun run dev",
        true,
      ),
    ).toEqual({
      verb: "Running",
      target: "bun run dev",
      fullCommand: "env -u VULCAN_AUTH_TOKEN VULCAN_PORT_OFFSET=3158 timeout 180s bun run dev",
    });
  });

  it("summarizes inline script commands without leaking the script body", () => {
    expect(
      deriveReadableCommandDisplay(`node -e "const fs = require('fs'); console.log(fs.cwd)"`, true),
    ).toEqual({
      verb: "Running",
      target: "node script",
      fullCommand: `node -e "const fs = require('fs'); console.log(fs.cwd)"`,
    });

    expect(deriveReadableCommandDisplay("python3 - <<'PY'\nprint('hi')\nPY", true)).toEqual({
      verb: "Running",
      target: "python script",
      fullCommand: "python3 - <<'PY'\nprint('hi')\nPY",
    });
  });

  it("humanizes current-directory searches without leaking placeholder dots", () => {
    expect(deriveReadableCommandDisplay(`rg -n "model(s)?" .`)).toEqual({
      verb: "Searched",
      target: "for model(s)? in current directory",
      fullCommand: `rg -n "model(s)?" .`,
    });
  });

  it("falls back to a directory summary when the search token is only punctuation", () => {
    expect(deriveReadableCommandDisplay(`rg -n . src/lib`)).toEqual({
      verb: "Searched",
      target: "in src/lib",
      fullCommand: `rg -n . src/lib`,
    });
  });
});

describe("deriveFriendlyCommandTarget", () => {
  it("uses a friendly shell name instead of leaking the full wrapper command", () => {
    expect(
      deriveFriendlyCommandTarget(
        '"C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "powershell -NoProfile -Command \\"1..8\\""',
      ),
    ).toBe("PowerShell");
  });

  it("reads as the object of the row's sentence", () => {
    expect(deriveFriendlyCommandTarget(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      "for tool call in web/src",
    );
  });

  it("keeps long targets short enough to sit inline", () => {
    const target = deriveFriendlyCommandTarget(`echo ${"a".repeat(200)}`);
    expect(target.length).toBeLessThanOrEqual(72);
    expect(target.endsWith("…")).toBe(true);
  });
});

describe("deriveInlineCommandCall", () => {
  it("shows the actual command call without the shell wrapper", () => {
    expect(deriveInlineCommandCall(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      `rg -n "tool call" apps/web/src`,
    );
  });
});

describe("isInspectCommand", () => {
  it("detects read-only inspection commands (read/search/find/list)", () => {
    expect(isInspectCommand("cat package.json")).toBe(true);
    expect(isInspectCommand("sed -n 1,40p src/app.ts")).toBe(true);
    expect(isInspectCommand("head -n 20 README.md")).toBe(true);
    expect(isInspectCommand(`rg -n "tool call" apps/web/src`)).toBe(true);
    expect(isInspectCommand("grep -R foo .")).toBe(true);
    expect(isInspectCommand("find . -name '*.ts'")).toBe(true);
    expect(isInspectCommand("ls -la src")).toBe(true);
    expect(isInspectCommand(`/bin/zsh -lc 'rg -n "x" src'`)).toBe(true);
  });

  it("does not treat mutating or executing commands as inspections", () => {
    expect(isInspectCommand("git status")).toBe(false);
    expect(isInspectCommand("node build.js")).toBe(false);
    expect(isInspectCommand("rm -rf dist")).toBe(false);
    expect(isInspectCommand("mkdir foo")).toBe(false);
  });
});

describe("resolveCommandVisualKind", () => {
  it("classifies git commands through shell and global-option wrappers", () => {
    expect(resolveCommandVisualKind("git status --short")).toBe("git");
    expect(resolveCommandVisualKind("git -C apps/web status --short")).toBe("git");
    expect(resolveCommandVisualKind(`/bin/zsh -lc "cd repo && git branch -vv"`)).toBe("git");
  });

  it("classifies GitHub CLI commands through env wrappers", () => {
    expect(resolveCommandVisualKind("gh pr view 274 --repo owner/repo")).toBe("github");
    expect(resolveCommandVisualKind("env -u GH_TOKEN gh pr status")).toBe("github");
    expect(resolveCommandVisualKind("hub pull-request -m test")).toBe("github");
  });

  it("keeps inspections and ordinary commands distinct", () => {
    expect(resolveCommandVisualKind(`rg -n "tool call" apps/web/src`)).toBe("inspect");
    expect(resolveCommandVisualKind("bun run build")).toBe("terminal");
  });
});

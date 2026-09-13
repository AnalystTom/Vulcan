import { expect, it, vi } from "vitest";

it("returns the OAuth response privately and waits for its matching receipt", async () => {
  const state = crypto.randomUUID();
  const channel = new BroadcastChannel(`vulcan-hermes-mcp-oauth:${state}`);
  const received = vi.fn();
  channel.onmessage = ({ data }) => received(data);
  const frame = document.createElement("iframe");
  frame.src = `/hermes-mcp-callback.html?state=${state}&code=test-authorization-code`;
  document.body.append(frame);
  try {
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith({
        type: "hermes-mcp-oauth-callback",
        state,
        code: "test-authorization-code",
        error: null,
      }),
    );
    expect(frame.contentWindow?.location.search).toBe("");
    expect(frame.contentDocument?.body.textContent).not.toContain("test-authorization-code");
    channel.postMessage({
      type: "hermes-mcp-oauth-result",
      state: "another-flow",
      accepted: false,
    });
    expect(frame.contentDocument?.getElementById("status")?.textContent).toContain("Returning");
    channel.postMessage({ type: "hermes-mcp-oauth-result", state, accepted: true });
    await vi.waitFor(() =>
      expect(frame.contentDocument?.getElementById("status")?.textContent).toContain(
        "check whether the connection succeeded",
      ),
    );
  } finally {
    frame.remove();
    channel.close();
  }
});

import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useHermesMcpMutations } from "~/hooks/useHermesConnections";

type SignInFlow = { sessionId: string; authUrl: string; state: string };

export function HermesMcpSignIn({
  profile,
  name,
  disabled = false,
  onBusyChange,
}: {
  profile: string;
  name: string;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const actions = useHermesMcpMutations(profile);
  const [flow, setFlow] = useState<SignInFlow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const finished = useRef<string | null>(null);
  const checkStatus = useRef<(() => Promise<void>) | null>(null);
  const { mutateAsync: start } = actions.oauthStart;
  const { mutateAsync: poll } = actions.oauthPoll;
  const { mutateAsync: cancel } = actions.oauthCancel;
  const { mutateAsync: callback, reset: resetCallback } = actions.oauthCallback;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(flow !== null || actions.oauthStart.isPending);
  }, [flow, actions.oauthStart.isPending, onBusyChange]);

  useEffect(() => {
    if (!flow) return;
    let disposed = false;
    let polling = false;
    let returning = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = new BroadcastChannel(`vulcan-hermes-mcp-oauth:${flow.state}`);
    const check = async () => {
      if (disposed || polling) return;
      clearTimeout(timer);
      polling = true;
      try {
        const result = await poll({ name, sessionId: flow.sessionId });
        if (disposed) return;
        if ((result.ok && result.status === "approved") || result.status === "error") {
          finished.current = flow.sessionId;
          setNotice(
            result.status === "approved"
              ? "Sign-in completed and the connection was checked."
              : "Sign-in did not complete. You can start again.",
          );
          setFlow(null);
        } else if (result.ok && result.status === "pending") {
          timer = setTimeout(() => void check(), 2000);
        } else {
          setNotice("The sign-in status is unavailable. Check again or cancel.");
        }
      } catch {
        if (!disposed) setNotice("Could not check sign-in. Check again or cancel.");
      } finally {
        polling = false;
      }
    };
    checkStatus.current = check;
    channel.onmessage = async ({ data }) => {
      if (
        disposed ||
        returning ||
        data?.type !== "hermes-mcp-oauth-callback" ||
        data.state !== flow.state ||
        (typeof data.code !== "string" && typeof data.error !== "string")
      )
        return;
      if (
        (typeof data.code === "string" && data.code.length > 8192) ||
        (typeof data.error === "string" && data.error.length > 2048)
      )
        return;
      returning = true;
      let accepted: boolean | null = null;
      try {
        const result = await callback({
          name,
          sessionId: flow.sessionId,
          state: flow.state,
          ...(typeof data.code === "string" ? { code: data.code } : {}),
          ...(typeof data.error === "string" ? { error: data.error } : {}),
        });
        accepted = result.ok;
      } catch {
        if (!disposed)
          setNotice(
            "The sign-in response could not be confirmed. Check its status before retrying.",
          );
      } finally {
        resetCallback();
      }
      if (!disposed) {
        if (accepted !== null)
          channel.postMessage({ type: "hermes-mcp-oauth-result", state: flow.state, accepted });
        await check();
      }
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
      channel.close();
      checkStatus.current = null;
      if (finished.current !== flow.sessionId) {
        void cancel({ name, sessionId: flow.sessionId }).catch(() => undefined);
      }
    };
  }, [flow, name, poll, cancel, callback, resetCallback]);

  const begin = async () => {
    setNotice(null);
    const origin = new URL(window.location.origin);
    if (
      origin.protocol !== "http:" ||
      !origin.port ||
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
      typeof BroadcastChannel === "undefined"
    ) {
      setNotice("Open Vulcan through its local forwarded address to use this sign-in callback.");
      return;
    }
    try {
      const result = await start({
        name,
        clientRedirectUri: `${origin.origin}/hermes-mcp-callback.html`,
      });
      const state = result.authUrl ? new URL(result.authUrl).searchParams.get("state") : null;
      if (
        !alive.current ||
        !result.ok ||
        !result.sessionId ||
        !result.authUrl ||
        !state ||
        state.length > 4096
      ) {
        if (result.sessionId) await cancel({ name, sessionId: result.sessionId });
        if (alive.current) setNotice("Hermes did not provide a usable sign-in flow.");
        return;
      }
      setFlow({ sessionId: result.sessionId, authUrl: result.authUrl, state });
    } catch {
      if (alive.current)
        setNotice("Could not start sign-in. Check the connection setup and try again.");
    }
  };
  const stop = async () => {
    if (!flow) return;
    try {
      await cancel({ name, sessionId: flow.sessionId });
      finished.current = flow.sessionId;
      setFlow(null);
      setNotice("Sign-in cancelled.");
    } catch {
      setNotice("Cancellation was not confirmed. Check the status or retry cancellation.");
    }
  };
  return (
    <div className="space-y-2">
      {flow ? (
        <div className="flex flex-wrap items-center gap-2">
          <a
            className="text-sm underline"
            href={flow.authUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open sign-in
          </a>
          <Button size="sm" variant="outline" onClick={() => void checkStatus.current?.()}>
            Check status
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={actions.oauthCancel.isPending}
            onClick={() => void stop()}
          >
            Cancel sign-in
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || actions.oauthStart.isPending}
          onClick={() => void begin()}
        >
          {actions.oauthStart.isPending ? "Starting sign-in…" : "Sign in"}
        </Button>
      )}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

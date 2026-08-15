// FILE: authClient.ts
// Purpose: Browser-side helpers for reading auth session state and exchanging pairing credentials.
// Layer: Web transport / auth
// Exports: probeAuthenticated, extractPairingCredential, exchangePairingCredential, path constants.

export const AUTH_SESSION_PATH = "/api/auth/session";
export const AUTH_BOOTSTRAP_PATH = "/api/auth/bootstrap";

/**
 * Reads the server's view of this browser's auth session. Returns the boolean
 * `authenticated` flag, or `null` when the request itself could not be
 * completed or parsed (network outage, unreadable body). A `null` is an
 * explicit "unknown" the caller MUST NOT collapse into "signed out": a server
 * that is merely unreachable is a reconnect case, not a re-pair case.
 */
export async function probeAuthenticated(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetchImpl(AUTH_SESSION_PATH, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { authenticated?: unknown }).authenticated !== "boolean"
  ) {
    return null;
  }
  return (body as { authenticated: boolean }).authenticated;
}

/**
 * Pulls a bare pairing credential out of whatever the user pasted: the token
 * itself, a full `/pair#token=...` link, or a bare `token=...` fragment. Returns
 * the trimmed credential, or null when nothing usable is present. A paste that
 * still contains whitespace after failing the token-param match is rejected — a
 * stray sentence is not a credential.
 */
export function extractPairingCredential(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tokenMatch = /(?:[?#&]|^)token=([^&\s]+)/u.exec(trimmed);
  if (tokenMatch?.[1]) {
    try {
      return decodeURIComponent(tokenMatch[1]);
    } catch {
      return tokenMatch[1];
    }
  }
  return /\s/u.test(trimmed) ? null : trimmed;
}

export type PairingExchangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

async function readErrorReason(response: Response): Promise<string> {
  const fallback =
    response.status === 401 || response.status === 400
      ? "This pairing token is invalid, expired, or already used. Generate a fresh one and try again."
      : "The server rejected the pairing token. Generate a fresh one and try again.";
  const body: unknown =
    typeof response.json === "function" ? await response.json().catch(() => null) : null;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim().length > 0 ? error : fallback;
}

/**
 * Exchanges a one-time pairing credential for a session cookie via the auth
 * bootstrap endpoint. Shared by the remote `/pair` deep link and the in-app
 * sign-in surface so both go through exactly one request shape.
 */
export async function exchangePairingCredential(
  credential: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PairingExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(AUTH_BOOTSTRAP_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
  } catch {
    return {
      ok: false,
      reason: "Could not reach the Vulcan server. Check the connection and try again.",
    };
  }
  if (response.ok) return { ok: true };
  return { ok: false, reason: await readErrorReason(response) };
}

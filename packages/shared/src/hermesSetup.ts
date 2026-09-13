/** Keep native sign-in links usable without exposing account credentials in URLs. */
export function hermesSetupUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
    if (
      keys.some((key) =>
        /^(access_token|refresh_token|client_secret|api_?key|password|authorization)$/i.test(key),
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

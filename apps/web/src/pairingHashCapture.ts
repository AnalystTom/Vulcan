// FILE: pairingHashCapture.ts
// Purpose: Snapshot the one-time pairing fragment at the earliest possible instant,
//   before any other renderer module can normalize the URL and drop the token.
// Layer: Web boot
// Exports: capturedPairingHash (the raw location.hash as seen at document load).
//
// Why a dedicated module evaluated first: ES module imports run in source order,
// depth-first, BEFORE the importing module's body executes. Importing this module
// as the very first line of bootstrap.ts guarantees the raw `location.hash` is read
// before storageOriginMigration, the signed-out screen, the pairing exchange, or —
// once the app chunk loads — the router's `createBrowserHistory()` construction can
// touch the URL. A one-time `/pair#token=…` credential lives only in the fragment,
// so anything that rewrites history (even a stray `replaceState`) before we read it
// silently destroys the token and strands the user on the pairing-failed screen.
// Capturing once, synchronously, at import time removes that race entirely.

function readInitialHash(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.hash ?? "";
  } catch {
    return "";
  }
}

// Evaluated at import time — capturing here, and only here, is the whole point of
// this module. The value is fixed for the lifetime of the document.
export const capturedPairingHash: string = readInitialHash();

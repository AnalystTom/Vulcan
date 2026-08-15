// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

// MUST be first: captures the one-time /pair fragment synchronously at import time,
// before any other module (storage migration, the signed-out screen, or the later
// router history construction) can normalize the URL and destroy the token.
import "./pairingHashCapture";

import "./storageOriginMigration";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then((result) => {
    if (result === "not-pairing") {
      return import("./main");
    }
  });
}

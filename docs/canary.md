# Vulcan Canary

Vulcan Canary is a frozen local build of a chosen remote Git ref. It is intentionally separate
from both Vulcan Stable and the HMR development process.

## Isolation

- App name: `Vulcan Canary`
- Bundle ID: `com.vulcanapp.vulcan.canary`
- Desktop origin: `vulcan-canary://app`
- Vulcan data: `~/.vulcan-canary`
- Electron profile: `vulcan-canary`
- Managed source: `~/.cache/vulcan-canary/source`
- Runtime log: `~/.vulcan-canary/canary.log`
- Updates: only through the Canary scripts; the production updater is disabled

Canary starts with an empty data directory. It never copies or shares Stable data.

## Install and update

After the Canary tooling has landed on `main`:

```bash
bun run canary:setup
bun run canary:update
```

Both commands fetch `origin/main`, install from the lockfile, build static desktop/server assets,
run the release smoke test, and start the resulting commit. Source edits in another worktree do not
affect the running Canary.

While this change is still a stacked PR, it can be tested explicitly from its remote branch:

```bash
bun run canary:setup -- --ref codex/vulcan-canary
```

Later `canary:update` calls keep using that tracked ref automatically. After this PR lands on `main`,
switch the installation to the normal channel once:

```bash
bun run canary:update -- --ref main
```

## Operations

```bash
bun run canary:start
bun run canary:stop
bun run canary:status
bun run canary:rollback
```

`canary:rollback` rebuilds and starts the previous successful commit. An update refuses to overwrite
tracked edits in the managed source checkout. If a new build fails, the script restores and rebuilds
the previous commit before restarting Canary.

Paths can be overridden without touching Stable:

```bash
VULCAN_CANARY_HOME=/path/to/data \
VULCAN_CANARY_SOURCE=/path/to/source \
bun run canary:update
```

## Running Dev beside Canary

Use a named dev instance and a separate home:

```bash
env -u VULCAN_AUTH_TOKEN \
  VULCAN_DEV_INSTANCE=my-feature \
  bun run dev -- --home-dir ./.vulcan/dev-my-feature
```

Canary remains pinned to its compiled commit while the development instance continues to use HMR.

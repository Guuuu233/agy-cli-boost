# magpie-agy-cli-boost

Persistent external daemon and multi-branch session-resume plugin for Antigravity CLI (`agy acp`) in [Magpie](https://github.com/magpie-community) and OpenCode.

## Why this plugin exists

Long agentic sessions using the stock `@magpie-community/opencode-agy-cli-auth` bridge suffered repeated mid-session context drops and `history` resets. Root-cause forensics against live Magpie logs and `agy` traces showed four distinct failure modes:

1. **In-host child pool wiped on plugin-host GC restarts**: Magpie's plugin host spawns a new Bun host whenever RSS crosses 512 MiB (`watchHeavy`) and drains/exits the old one. Keeping `agy acp` children inside the plugin host killed live sessions (`reapOnExit`), while eager `unpark()`/`takeParked()` deleted checkpoints as soon as a turn ran.
2. **Side-call (`memory_extraction` / `artifact_provenance_extraction`) collisions**: Background extraction requests share the main conversation's opening message and `workDir`, hashing to the same `convKey`. In the stock bridge, a single-slot pool caused the side-call to collide with the live primary thread, trigger `forceNew`, overwrite `sessions.json`, clip history to 112 KiB, and break the next primary turn (`reason="history"`).
3. **Host-injected `[System] Showing lines ...` pagination notices**: Read pagination companion blocks next to `tool_result` were misclassified as user steering, setting `userSteered = true` and tearing down the live `agy` process (`reason="no_live"`).
4. **Destructive checkpointing & `toolsGrew` teardowns**: Historical `tool_result` blocks triggered `forceNew` (blocking `session/resume`), and dynamic tool additions (`ToolSearch`) dropped the process instead of steering/updating tools in-session.

## Architecture (inspired by `claude-tui-boost`)

- **Detached persistent HTTP daemon (`src/daemon.mjs`)**: Runs outside Magpie's plugin host (`127.0.0.1`, `0600` bearer token in `~/.local/state/magpie-agy-cli-boost/daemon.key`) so `agy acp` processes, in-memory tool calls, and prompt caches survive Magpie 512 MiB host restarts and idle plugin reloads.
- **Thin plugin adapter (`src/plugin.mjs`)**: Low-RSS shim implementing OpenCode 1.x/Magpie (`opencode.mjs`) and OpenCode 2.x (`opencode2.mjs`) hooks, including `chat.headers` (`x-agy-hook-session`) and idle-safe daemon auto-upgrade.
- **Non-destructive multi-branch `CheckpointStore` (`src/session-store.mjs`)**: Persists checkpoints keyed by `sessionId` (`checkpoints.json` v2) without deleting on read or turn start, separating `primary` and `branch` roles so side-calls never overwrite or evict the primary session.
- **Protocol & tool fixes (`src/protocol.mjs`, `src/bridge.mjs`)**:
  - Recognizes `[System] Showing lines ...` and related companion notices without triggering `userSteered`.
  - Allows `session/resume` even when history contains completed `tool_result` turns.
  - Updates dynamically added tools (`toolsGrew`) in-session via `steerInSession` + `updateTools`.
  - Deduplicates identical completed-turn HTTP retries via `CompletedTurnCache`.
  - Expands initial prompt budget to `136 KiB` on `agy >= 1.5.8` and extends idle/detached eviction windows (`IDLE_MS=30m`, `DETACHED_EVICT_MS=15m`, `TOOL_RESULT_TIMEOUT_MS=30m`).

## Installation in Magpie

Install directly from GitHub in Magpie Plugin Settings or `~/.config/magpie/plugins.json`:

```json
{
  "plugins": [
    "github:Guuuu233/agy-cli-boost"
  ]
}
```

Ensure `agy` CLI (`>= 1.4.12`, recommended `>= 1.5.8`) is installed and signed in (`agy` or Magpie's OAuth flow).

## Configuration (Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `AGY_BOOST_STATE_DIR` | `~/.local/state/magpie-agy-cli-boost` | Private (`0700`) state directory for `daemon.json`, `daemon.key`, `checkpoints.json`, and `models.json` |
| `AGY_BOOST_IDLE_MS` | `1800000` (30m) | Idle `agy acp` process retention timeout |
| `AGY_BOOST_DETACHED_EVICT_MS` | `900000` (15m) | Minimum detached tool-turn age before LRU eviction under pool pressure |
| `AGY_BOOST_TOOL_TIMEOUT_MS` | `1800000` (30m) | Timeout waiting for client `tool_result` |
| `AGY_BOOST_MAX_PROCS` | `24` | Maximum concurrent `agy acp` child processes in daemon pool |
| `AGY_BOOST_RESUME_TTL_MS` | `86400000` (24h) | Checkpoint retention window for `session/resume` |
| `AGY_BOOST_DAEMON_IDLE_MS` | `14400000` (4h) | Daemon auto-exit delay when pool is empty and idle |

## Development & Tests

```sh
bun test
```

## License

MIT — see [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).

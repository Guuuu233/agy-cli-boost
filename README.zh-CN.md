# magpie-agy-cli-boost

面向 [Magpie](https://github.com/magpie-community) 与 OpenCode 的 Antigravity CLI（`agy acp`）持久化守护进程与多分支会话恢复插件。

## 背景与根因

原版 `@magpie-community/opencode-agy-cli-auth` 在长对话或高并发场景下会频繁出现上下文丢失与回退重建（`reason="no_live"` / `reason="history"` / `reason="forced"`）。结合 Magpie 宿主机源码与运行日志，根因来自四处叠加：

1. **宿主重启清零进程池**：Magpie 插件宿主在 Bun RSS 超过 512 MiB（`watchHeavy`）时会拉起新宿主并退出旧宿主。原插件将 `agy acp` 子进程养在宿主进程内，`reapOnExit` 会在退出时强杀子进程；同时 `unpark()` / `takeParked()` 会在每轮请求开始或读取时删掉检查点。
2. **旁路提取请求（`memory_extraction` / `artifact_provenance_extraction`）碰撞主会话**：旁路提取请求与主对话共享开场消息和工作目录，计算出的 `convKey` 完全一致。原插件单槽位模型导致旁路请求触发 `forceNew`、强杀主进程、覆盖 `sessions.json` 并按 112 KiB 截断历史，紧接着主对话下一轮命中 `reason="history"` 彻底断线。
3. **文件分页系统提示误判为 `userSteered`**：`[System] Showing lines ...` 等伴随提示紧邻 `tool_result` 时未被识别为非打断型系统提示，导致原插件误判用户打断并主动销毁活进程。
4. **破坏性重建策略**：历史中存在已完成的 `tool_result` 时原插件强制 `forceNew` 而跳过 `session/resume`；动态加载新工具（`toolsGrew`）也会直接杀进程重建。

## 核心架构（借鉴 `claude-tui-boost`）

- **独立常驻守护进程（`src/daemon.mjs`）**：脱离 Magpie 插件宿主独立运行，监听 `127.0.0.1` 并通过 `~/.local/state/magpie-agy-cli-boost/daemon.key`（`0600`）进行 Bearer 鉴权。宿主因 512 MiB 内存重启或重载插件时，`agy acp` 子进程、等待中的 MCP 调用和 Prompt 缓存均保持存活。
- **轻量插件适配器（`src/plugin.mjs`）**：极低内存占用，完整兼容 OpenCode 1.x / Magpie（`opencode.mjs`）与 OpenCode 2.x（`opencode2.mjs`），通过 `chat.headers` 注入 `x-agy-hook-session`，并在无活跃回合时平滑热替换旧版 daemon。
- **非破坏性多分支检查点（`src/session-store.mjs`）**：`CheckpointStore`（`checkpoints.json` v2）按 `sessionId` 持久化存储，读取和开轮均不删除；区分 `primary` 与 `branch` 角色，旁路提取请求自动隔离到 `branch` 槽位，绝不覆盖或驱逐主会话。检查点同时记下会话的工作文件夹，续接时在同一文件夹重开：agy 会把文件夹路径写进提示词，换了文件夹，续接后第一轮就命中不了模型的提示词缓存。
- **协议与调度修复（`src/protocol.mjs`、`src/bridge.mjs`）**：
  - 将 `[System] Showing lines ...` 等分页/状态提示识别为非打断型 companion notice。
  - 允许在包含历史 `tool_result` 的对话中通过 `session/resume` 恢复完整上下文。
  - 客户端后来把较早的图片换成文字说明时（Claude Code 和 Magpie 为避免超出请求大小限制会这样做），继续沿用正在用的会话：agy 已经有这些图片，仍是同一段对话，提示词缓存照样能命中。
  - 客户端声明的工具一个不丢。agy 交给模型的工具定义最多约 60 KB，超出时会悄悄去掉最大的那几个工具；工具超限时，插件从最长的说明开始缩短直到放得下，被缩短部分的全文放进会话的系统提示（会话中途新加的工具则随下一条消息给出）。
  - 工具列表在回合中增长（`toolsGrew`）时通过 `steerInSession` + `updateTools` 会话内热更新。
  - 通过 `CompletedTurnCache` 对已完成回合的 HTTP 重试直接去重返回。
  - `agy >= 1.5.8` 初始提示词预算提升至 `136 KiB`，并放宽空闲与脱离连接的回收窗口（`IDLE_MS=30m`、`DETACHED_EVICT_MS=15m`、`TOOL_RESULT_TIMEOUT_MS=30m`）。

## 安装方法

在 Magpie 插件配置（`~/.config/magpie/plugins.json`）中添加：

```json
{
  "plugins": [
    "github:Guuuu233/agy-cli-boost"
  ]
}
```

使用前请确保本机已安装 `agy` CLI（`>= 1.4.12`，推荐 `>= 1.5.8`）并完成账号登录。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_BOOST_STATE_DIR` | `~/.local/state/magpie-agy-cli-boost` | 私有状态目录（`0700`），存放 `daemon.json`、`daemon.key`、`checkpoints.json`、`models.json` |
| `AGY_BOOST_IDLE_MS` | `1800000`（30 分钟） | 空闲 `agy acp` 进程保留时长 |
| `AGY_BOOST_DETACHED_EVICT_MS` | `900000`（15 分钟） | 进程池满时可驱逐断连工具回合的最短保留时长 |
| `AGY_BOOST_TOOL_TIMEOUT_MS` | `1800000`（30 分钟） | 等待客户端回传 `tool_result` 的超时时间 |
| `AGY_BOOST_MAX_PROCS` | `24` | 守护进程池最大并发 `agy acp` 进程数 |
| `AGY_BOOST_MAX_IDLE_PROCS` | `6` | 为下一轮保留的空闲 `agy acp` 进程数；超出后先结束重建成本最低的，之后从检查点恢复（正在回答的进程不计） |
| `AGY_BOOST_USER_MCP` | 不设置 | 设为 `1` 时 `agy acp` 照常启动 `~/.gemini/config/mcp_config.json` 里的 MCP。默认情况下，桥接用 `--gemini-dir` 指向 `~/.gemini` 的私有副本（全部链接回原目录，只有 `mcp_config.json` 为空）运行 agy：桥接的 agent 从不使用这些 MCP，但 agy 会为每个会话全部启动一遍。Windows 不启用 |
| `AGY_BOOST_ERROR_PEEK_MS` | `20000`（20 秒） | 流式回复发出响应头前等待第一个事件的最长时间。若第一个事件是错误（包括 agy 当作回答文字转来的额度提示），直接以对应 HTTP 状态（如 429）返回，客户端可据此切换线路 |
| `AGY_BOOST_SUPERSEDED_CHECK_MS` | `60000`（1 分钟） | 后台多久检查一次状态目录是否已被另一个后台接管；被替换且空闲的后台会自行退出 |
| `AGY_BOOST_TOOL_BUDGET_BYTES` | `50000` | 交给 agy 的工具定义总大小上限（agy 自身上限约 60,000 字节）；超出时缩短较长的说明，全文通过系统提示交给模型 |
| `AGY_BOOST_RESUME_TTL_MS` | `86400000`（24 小时） | `session/resume` 检查点有效期 |
| `AGY_BOOST_DAEMON_IDLE_MS` | `14400000`（4 小时） | 进程池全空且无请求后守护进程自动退出的空闲时长 |

## 测试

```sh
bun test
```

## 许可证

MIT，详见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。

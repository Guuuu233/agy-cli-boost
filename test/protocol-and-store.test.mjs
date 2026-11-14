import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  collapsedHistoryKey,
  conversationKey,
  historyKey,
  inspectToolTurn,
  maxInitialPromptBytes,
  renderHistoryDeltaParts,
  SCIENCE_SYSTEM_COMPANION_RE,
  stripToolUseInputs,
  toolsSignature,
  toolUseIdentitiesKey,
} from "../src/protocol.mjs"
import { CheckpointStore, CompletedTurnCache } from "../src/session-store.mjs"
import { digest } from "../src/protocol.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const createdDirs = []

function makeTempDir(prefix) {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length) {
    const dir = createdDirs.pop()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe("protocol companion notices & budgets", () => {
  it("recognizes Claude Science read_file pagination notices as non-steering companions", () => {
    const notice = "[System] Showing lines 1320-1469 of 1761. Use offset=1320 to continue reading."
    expect(SCIENCE_SYSTEM_COMPANION_RE.test(notice)).toBe(true)

    const rawResults = [{
      block: { type: "tool_result", tool_use_id: "toolu_1", content: "file content..." },
      call: { id: "toolu_1", name: "read_file" },
      result: { content: [{ type: "text", text: "file content..." }], isError: false },
    }]
    const body = {
      messages: [
        { role: "user", content: "Inspect index.mjs" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "index.mjs" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file content..." },
            { type: "text", text: notice },
          ],
        },
      ],
    }

    const inspected = inspectToolTurn(rawResults, body)
    expect(inspected.userSteered).toBe(false)
    const joined = inspected.results[0].result.content.map((c) => c.text).join("\n")
    expect(joined).toContain("file content...")
    expect(joined).toContain(notice)
  })

  it("still detects genuine user steering beside tool_result", () => {
    const rawResults = [{
      block: { type: "tool_result", tool_use_id: "toolu_2", content: "ok" },
      call: { id: "toolu_2", name: "read_file" },
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    }]
    const body = {
      messages: [
        { role: "user", content: "Inspect index.mjs" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "index.mjs" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_2", content: "ok" },
            { type: "text", text: "Stop reading that and check package.json instead." },
          ],
        },
      ],
    }
    const inspected = inspectToolTurn(rawResults, body)
    expect(inspected.userSteered).toBe(true)
  })

  it("uses larger initial prompt budget on agy >= 1.5.8", () => {
    expect(maxInitialPromptBytes("1.5.8")).toBe(136 * 1024)
    expect(maxInitialPromptBytes("1.5.7")).toBe(112 * 1024)
    expect(maxInitialPromptBytes(null)).toBe(112 * 1024)
  })

  it("canonicalizes gateway-collapsed server_tool_use / web_search_tool_result turns identically", () => {
    const rawExpected = [
      { role: "user", content: "Compare NegPy and FilmColor" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_ws1", name: "web_search", input: { query: "NegPy github" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ws1", content: "{\"results\":[]}" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash1", name: "bash", input: { command: "uname -m" } }] },
    ]
    const clientCollapsed = [
      { role: "user", content: "Compare NegPy and FilmColor" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Searching...", signature: "agyb1.abc" },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "NegPy github" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://github.com/marcinz606/NegPy", title: "NegPy" }] },
          { type: "tool_use", id: "toolu_bash1", name: "bash", input: { command: "uname -m" } },
        ],
      },
    ]
    expect(collapsedHistoryKey(rawExpected)).toBe(collapsedHistoryKey(clientCollapsed))
  })

  it("canonicalizes tool signatures regardless of tool order or nested schema key order", () => {
    const toolsA = [
      { name: "bash", description: "Run shell", inputSchema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" } } } },
      { name: "read_file", description: "Read file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ]
    const toolsB = [
      { name: "read_file", description: "Read file", inputSchema: { properties: { path: { type: "string" } }, type: "object" } },
      { name: "bash", description: "Run shell", inputSchema: { properties: { cmd: { type: "string" } }, required: ["cmd"], type: "object" } },
    ]
    expect(toolsSignature(toolsA)).toBe(toolsSignature(toolsB))
  })

  it("renders delta history checkpoints cleanly before the current turn", () => {
    const parts = renderHistoryDeltaParts(
      [
        { role: "user", content: "Turn 2 question" },
        { role: "assistant", content: [{ type: "text", text: "Turn 2 answer" }] },
      ],
      [{ role: "user", content: "Turn 3 question" }],
    )
    const text = parts.map((p) => p.text).join("")
    expect(text).toContain("<continued_history_since_checkpoint>")
    expect(text).toContain("Human: Turn 2 question")
    expect(text).toContain("Assistant: Turn 2 answer")
    expect(text).toContain("Turn 3 question")
  })
})

describe("CheckpointStore & CompletedTurnCache", () => {
  it("persists non-destructively across reloads and isolates primary vs branch", () => {
    const dir = makeTempDir("ckpt-")
    const file = path.join(dir, "checkpoints.json")
    const store1 = new CheckpointStore(file)

    const primaryHistory = [
      { role: "user", content: "Start long task" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "bash", input: { cmd: "ls" } }] },
    ]
    const branchHistory = [
      { role: "user", content: "Start long task" },
    ]
    const convKey = conversationKey({ messages: primaryHistory })
    const instructionsHash = digest("system:main")

    store1.upsert({
      sessionId: "sess_primary",
      convKey,
      outerSession: "outer-1",
      historyHash: digest(historyKey(primaryHistory)),
      historyHashSansInputs: digest(historyKey(stripToolUseInputs(primaryHistory))),
      toolUseIdentitiesHash: digest(toolUseIdentitiesKey(primaryHistory) ?? ""),
      historyLength: primaryHistory.length,
      instructionsHash,
      workDir: "/tmp/proj",
      model: "claude-opus-4-6-thinking",
      role: "primary",
    })
    store1.upsert({
      sessionId: "sess_branch",
      convKey,
      outerSession: "outer-1",
      historyHash: digest(historyKey(branchHistory)),
      historyHashSansInputs: digest(historyKey(stripToolUseInputs(branchHistory))),
      toolUseIdentitiesHash: digest(toolUseIdentitiesKey(branchHistory) ?? ""),
      historyLength: branchHistory.length,
      instructionsHash,
      workDir: "/tmp/proj",
      model: "claude-opus-4-6-thinking",
      role: "branch",
    })

    // Reload from disk in a second CheckpointStore instance.
    const store2 = new CheckpointStore(file)
    const primaryMatches1 = store2.findMatches({
      convKey,
      outerSession: "outer-1",
      workDir: "/tmp/proj",
      instructionsHash,
      historyHash: digest(historyKey(primaryHistory)),
      historyHashSansInputs: digest(historyKey(stripToolUseInputs(primaryHistory))),
      toolUseIdentitiesHash: digest(toolUseIdentitiesKey(primaryHistory) ?? ""),
    })
    expect(primaryMatches1.map((m) => m.sessionId)).toEqual(["sess_primary"])

    // Non-destructive: calling findMatches again still finds sess_primary!
    const primaryMatches2 = store2.findMatches({
      convKey,
      outerSession: "outer-1",
      workDir: "/tmp/proj",
      instructionsHash,
      historyHash: digest(historyKey(primaryHistory)),
      historyHashSansInputs: digest(historyKey(stripToolUseInputs(primaryHistory))),
      toolUseIdentitiesHash: digest(toolUseIdentitiesKey(primaryHistory) ?? ""),
    })
    expect(primaryMatches2.map((m) => m.sessionId)).toEqual(["sess_primary"])
    expect(store2.hasPrimary(convKey, "outer-1")).toBe(true)

    store2.invalidate("sess_primary")
    expect(store2.hasPrimary(convKey, "outer-1")).toBe(false)
  })

  it("caches and deduplicates completed turns within TTL", () => {
    const cache = new CompletedTurnCache(4, 10_000)
    cache.set("k1", { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
    expect(cache.get("k1")?.content?.[0]?.text).toBe("done")
    expect(cache.get("missing")).toBeNull()
  })

  it("finds verified shorter prefix candidates ordered by role and length", () => {
    const dir = makeTempDir("prefix-ckpt-")
    const file = path.join(dir, "checkpoints.json")
    const store = new CheckpointStore(file)
    const h2 = [
      { role: "user", content: "Start" },
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
    ]
    const h4 = [
      ...h2,
      { role: "user", content: "Step 2" },
      { role: "assistant", content: [{ type: "text", text: "A2" }] },
    ]
    const convKey = conversationKey({ messages: h2 })
    const instructionsHash = digest("sys")

    store.upsert({
      sessionId: "sess_len2",
      convKey,
      historyHash: digest(historyKey(h2)),
      historyLength: h2.length,
      instructionsHash,
      workDir: "/tmp/proj",
      role: "primary",
    })
    store.upsert({
      sessionId: "sess_len4",
      convKey,
      historyHash: digest(historyKey(h4)),
      historyLength: h4.length,
      instructionsHash,
      workDir: "/tmp/proj",
      role: "primary",
    })

    const candidates = store.findPrefixCandidates({
      convKey,
      workDir: "/tmp/proj",
      instructionsHash,
      historyLength: 6,
      excludeSessionIds: new Set(),
    })
    expect(candidates.map((c) => c.sessionId)).toEqual(["sess_len4", "sess_len2"])
  })
})

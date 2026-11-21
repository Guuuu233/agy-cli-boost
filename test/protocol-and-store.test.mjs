import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  collapsedHistoryKey,
  conversationKey,
  elideImagesLike,
  historyKey,
  historyShapeDiff,
  inspectToolTurn,
  maxInitialPromptBytes,
  renderHistoryDeltaParts,
  SCIENCE_SYSTEM_COMPANION_RE,
  stripToolUseInputs,
  stripOrphanedToolUse,
  toolsSignature,
  toolUseIdentitiesKey,
} from "../src/protocol.mjs"
import { modelLimits } from "../src/catalog.mjs"
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

  it("recognizes Claude Science read_file attached image notices as non-steering companions", () => {
    const notice = "[System] Attached file: t8_top_losses.jpg"
    expect(SCIENCE_SYSTEM_COMPANION_RE.test(notice)).toBe(true)

    const rawResults = [{
      block: { type: "tool_result", tool_use_id: "toolu_vis1", content: "{\"status\":\"queued_for_vision\"}" },
      call: { id: "toolu_vis1", name: "read_file" },
      result: { content: [{ type: "text", text: "{\"status\":\"queued_for_vision\"}" }], isError: false },
    }]
    const body = {
      messages: [
        { role: "user", content: "Inspect t8_top_losses.jpg" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_vis1", name: "read_file", input: { path: "t8_top_losses.jpg" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_vis1", content: "{\"status\":\"queued_for_vision\"}" },
            { type: "text", text: notice },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZmFrZWpwZw==" } },
          ],
        },
      ],
    }

    const inspected = inspectToolTurn(rawResults, body)
    expect(inspected.userSteered).toBe(false)
    expect(inspected.results[0].result.content.some((c) => c.type === "image" && c.mimeType === "image/jpeg")).toBe(true)
    expect(inspected.results[0].result.content.map((c) => c.text || "").join("\n")).toContain(notice)
    expect(modelLimits("gemini-4-hydrogen-medium")).toEqual({ context: 1048576, output: 65536 })
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

  it("matches raw web_search turns against the history Magpie forwards with the search blocks removed", () => {
    const opening = { role: "user", content: "Search, then record a note" }
    const noteUse = { type: "tool_use", id: "toolu_note1", name: "record_note", input: { note: "Bun" } }
    const rawExpected = [
      opening,
      { role: "assistant", content: [{ type: "thinking", thinking: "search first", signature: "agyb1.a" }, { type: "tool_use", id: "toolu_ws1", name: "web_search", input: { query: "Bun release" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ws1", content: "hits 1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_ws2", name: "web_search", input: { query: "Bun changelog" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ws2", content: "hits 2" }] },
      { role: "assistant", content: [noteUse] },
    ]
    const gatewayForwarded = [
      opening,
      { role: "assistant", content: [{ type: "thinking", thinking: "search first", signature: "agyb1.a" }, noteUse] },
    ]
    expect(historyKey(rawExpected)).not.toBe(historyKey(gatewayForwarded))
    expect(collapsedHistoryKey(rawExpected)).toBe(collapsedHistoryKey(gatewayForwarded))

    const differentNote = [opening, { role: "assistant", content: [{ ...noteUse, input: { note: "Deno" } }] }]
    expect(collapsedHistoryKey(rawExpected)).not.toBe(collapsedHistoryKey(differentNote))

    const diff = historyShapeDiff(rawExpected, gatewayForwarded)
    expect(diff.common).toBe(1)
    expect(diff.expected.length).toBe(5)
    expect(diff.incoming.length).toBe(1)
    expect(JSON.stringify(diff)).not.toContain("Bun")
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

describe("elideImagesLike", () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
  const note = { type: "text", text: "[image omitted]" }
  const history = (block) => [
    { role: "user", content: "read it" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { p: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "p1" }, block] }] },
  ]

  it("swaps an image the client replaced with text, so the histories match", () => {
    const expected = history(img)
    const incoming = history(note)
    expect(historyKey(expected)).not.toBe(historyKey(incoming))
    const elided = elideImagesLike(expected, incoming)
    expect(historyKey(elided)).toBe(historyKey(incoming))
    expect(expected[2].content[0].content[1]).toBe(img) // input left as it was
  })

  it("returns the same history when nothing was replaced", () => {
    const expected = history(img)
    expect(elideImagesLike(expected, history(img))).toBe(expected)
  })

  it("leaves other differences in place", () => {
    const expected = history(img)
    const incoming = history(note)
    incoming[0] = { role: "user", content: "read something else" }
    expect(historyKey(elideImagesLike(expected, incoming))).not.toBe(historyKey(incoming))
    const fewer = history(img)
    fewer[2].content[0].content = [{ type: "text", text: "p1" }]
    expect(elideImagesLike(expected, fewer)).toBe(expected)
  })
})

describe("stripOrphanedToolUse", () => {
  it("strips orphaned tool_use from the last assistant message, keeping text", () => {
    const body = {
      messages: [
        { role: "user", content: "create file" },
        { role: "assistant", content: [
          { type: "text", text: "creating scripts/run_r2_p1_matrix.py now" },
          { type: "tool_use", id: "tu_1", name: "Write", input: { path: "scripts/run_r2_p1_matrix.py" } },
        ]},
      ],
    }
    const result = stripOrphanedToolUse(body)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toEqual([
      { type: "text", text: "creating scripts/run_r2_p1_matrix.py now" },
    ])
  })

  it("removes the entire assistant message when only tool_use remains", () => {
    const body = {
      messages: [
        { role: "user", content: "create file" },
        { role: "assistant", content: [
          { type: "tool_use", id: "tu_1", name: "Write", input: {} },
        ]},
      ],
    }
    const result = stripOrphanedToolUse(body)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe("user")
  })

  it("does not strip tool_use that has a matching tool_result", () => {
    const body = {
      messages: [
        { role: "user", content: "create file" },
        { role: "assistant", content: [
          { type: "text", text: "creating now" },
          { type: "tool_use", id: "tu_1", name: "Write", input: {} },
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "done" },
        ]},
      ],
    }
    const result = stripOrphanedToolUse(body)
    expect(result).toBe(body) // unchanged — same reference
  })

  it("passes through requests without trailing assistant messages", () => {
    const body = { messages: [{ role: "user", content: "hello" }] }
    expect(stripOrphanedToolUse(body)).toBe(body)
  })

  it("passes through assistant messages with no tool_use", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    }
    expect(stripOrphanedToolUse(body)).toBe(body)
  })

  it("keeps non-tool_use non-text blocks (e.g. thinking) alongside text", () => {
    const body = {
      messages: [
        { role: "user", content: "plan" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "let me think..." },
          { type: "text", text: "here is my plan" },
          { type: "tool_use", id: "tu_x", name: "Bash", input: {} },
        ]},
      ],
    }
    const result = stripOrphanedToolUse(body)
    expect(result.messages[1].content).toEqual([
      { type: "thinking", thinking: "let me think..." },
      { type: "text", text: "here is my plan" },
    ])
  })
})

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { createDaemonClient } from "../src/plugin.mjs"
import { default as pluginV1 } from "../opencode.mjs"
import { default as pluginV2 } from "../opencode2.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const MOCK_AGY = path.resolve(import.meta.dir, "mock-agy.mjs")
chmodSync(MOCK_AGY, 0o755)

const cleanups = []

function makeTempDir(prefix) {
  mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, prefix))
  cleanups.push(async () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return dir
}

function readMockEvents(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function parseSseToJson(res) {
  const text = await res.text()
  const blocks = text.split("\n\n").filter(Boolean)
  const content = []
  const open = new Map()
  let stopReason = null
  let usage = null
  for (const raw of blocks) {
    let ev = ""
    let data = ""
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim()
      else if (line.startsWith("data:")) data += line.slice(5).trim()
    }
    if (!data) continue
    const payload = JSON.parse(data)
    if (ev === "content_block_start") {
      open.set(payload.index, { ...payload.content_block, _json: "" })
    } else if (ev === "content_block_delta") {
      const b = open.get(payload.index)
      if (!b) continue
      if (payload.delta.type === "text_delta") b.text = (b.text || "") + payload.delta.text
      else if (payload.delta.type === "input_json_delta") b._json += payload.delta.partial_json
    } else if (ev === "content_block_stop") {
      const b = open.get(payload.index)
      if (!b) continue
      open.delete(payload.index)
      if (b.type === "tool_use" && b._json) b.input = JSON.parse(b._json)
      delete b._json
      content.push(b)
    } else if (ev === "message_delta") {
      stopReason = payload.delta?.stop_reason || stopReason
      usage = payload.usage || usage
    }
  }
  return { content, stop_reason: stopReason, usage }
}

afterEach(async () => {
  delete process.env.MOCK_AGY_EVENTS_FILE
  while (cleanups.length) {
    const fn = cleanups.pop()
    await fn().catch(() => {})
  }
})

describe("AgyBridge integration (mock agy ACP + daemon)", () => {
  it("isolates memory_extraction/prefix side-calls without killing or overwriting primary session", async () => {
    const dir = makeTempDir("sidecall-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_main_1",
      "x-cwd": "/tmp/demo-repo",
    }

    // Turn 1: primary user message
    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        system: "You are the main coding agent.",
        messages: [{ role: "user", content: "Hello primary turn 1" }],
      }),
    })
    expect(r1.status).toBe(200)
    const j1 = await r1.json()
    const primarySid = /MAIN_REPLY:([^:]+):/.exec(j1.content[0].text)?.[1]
    expect(primarySid).toBeTruthy()

    // Turn 2: advance primary conversation
    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        system: "You are the main coding agent.",
        messages: [
          { role: "user", content: "Hello primary turn 1" },
          { role: "assistant", content: j1.content },
          { role: "user", content: "Continue primary turn 2" },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const j2 = await r2.json()
    expect(j2.content[0].text).toContain(`MAIN_REPLY:${primarySid}:`)

    // Side-call: memory_extraction branches off earlier prefix [0..1] with different system prompt
    const rSide = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        system: "Extract episodic memories from the transcript.",
        messages: [
          { role: "user", content: "Hello primary turn 1" },
          { role: "assistant", content: j1.content },
          { role: "user", content: "SIDE_CALL extract memories" },
        ],
      }),
    })
    expect(rSide.status).toBe(200)
    const jSide = await rSide.json()
    const sideSid = /SIDE_REPLY:([^:]+):/.exec(jSide.content[0].text)?.[1]
    expect(sideSid).toBeTruthy()
    expect(sideSid).not.toBe(primarySid)

    // Turn 3: main conversation resumes on the EXACT SAME primary session!
    const r3 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        system: "You are the main coding agent.",
        messages: [
          { role: "user", content: "Hello primary turn 1" },
          { role: "assistant", content: j1.content },
          { role: "user", content: "Continue primary turn 2" },
          { role: "assistant", content: j2.content },
          { role: "user", content: "Primary turn 3 after side-call" },
        ],
      }),
    })
    expect(r3.status).toBe(200)
    const j3 = await r3.json()
    expect(j3.content[0].text).toContain(`MAIN_REPLY:${primarySid}:`)

    const health = await (await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${daemon.authKey}` },
    })).json()
    expect(health.stats.branchIsolatedCount).toBe(1)
    expect(health.stats.reusedCount).toBeGreaterThanOrEqual(2)
  })

  it("resumes durable session with historical tool_results after full daemon restart (no forceNew loss)", async () => {
    const dir = makeTempDir("resume-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon1 = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      exitOnShutdown: false,
    })

    const headers1 = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon1.authKey}`,
      "x-agy-hook-session": "ses_resume_1",
      "x-cwd": "/tmp/demo-repo",
    }

    const tools = [{
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }]

    // Turn 1 triggers a real MCP tool_use
    const r1 = await fetch(`http://127.0.0.1:${daemon1.port}/v1/messages`, {
      method: "POST",
      headers: headers1,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [{ role: "user", content: "Please CALL_TOOL:read_file" }],
      }),
    })
    expect(r1.status).toBe(200)
    const msg1 = await parseSseToJson(r1)
    expect(msg1.stop_reason).toBe("tool_use")
    const toolUse = msg1.content.find((b) => b.type === "tool_use")
    expect(toolUse?.name).toBe("read_file")

    // Complete turn 1 with tool_result (including Claude Science pagination notice!)
    const r2 = await fetch(`http://127.0.0.1:${daemon1.port}/v1/messages`, {
      method: "POST",
      headers: headers1,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:read_file" },
          { role: "assistant", content: msg1.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "line1\nline2" },
              { type: "text", text: "[System] Showing lines 1-2 of 100. Use offset=3 to continue reading." },
            ],
          },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const msg2 = await r2.json()
    expect(msg2.content[0].text).toContain("TOOL_OK:read_file:line1\nline2")

    const eventsBefore = readMockEvents(eventsFile)
    const firstSessionId = eventsBefore.find((e) => e.event === "session/new")?.sessionId
    expect(firstSessionId).toBeTruthy()
    expect(eventsBefore.filter((e) => e.event === "session/new").length).toBe(1)

    // Simulate full daemon restart!
    await daemon1.shutdown()

    const daemon2 = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon2.shutdown())

    const headers2 = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon2.authKey}`,
      "x-agy-hook-session": "ses_resume_1",
      "x-cwd": "/tmp/demo-repo",
    }

    // Turn 2 after daemon restart: history contains prior tool_use + tool_result!
    // Old plugin forced session/new and clipped history to 112 KiB; Boost MUST session/resume!
    const r3 = await fetch(`http://127.0.0.1:${daemon2.port}/v1/messages`, {
      method: "POST",
      headers: headers2,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:read_file" },
          { role: "assistant", content: msg1.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "line1\nline2" },
              { type: "text", text: "[System] Showing lines 1-2 of 100. Use offset=3 to continue reading." },
            ],
          },
          { role: "assistant", content: msg2.content },
          { role: "user", content: "Follow up after daemon restart" },
        ],
      }),
    })
    expect(r3.status).toBe(200)
    const msg3 = await r3.json()
    expect(msg3.content[0].text).toContain(`MAIN_REPLY:${firstSessionId}:Follow up after daemon restart`)

    const eventsAfter = readMockEvents(eventsFile)
    expect(eventsAfter.some((e) => e.event === "session/resume" && e.sessionId === firstSessionId)).toBe(true)
    expect(eventsAfter.filter((e) => e.event === "session/new").length).toBe(1)
    // agy writes its folder into the prompt: resuming in the original folder keeps the prompt cache.
    const newCwd = eventsAfter.find((e) => e.event === "session/new")?.cwd
    expect(newCwd).toBeTruthy()
    expect(eventsAfter.find((e) => e.event === "session/resume" && e.sessionId === firstSessionId)?.cwd).toBe(newCwd)

    // Completed-turn replay dedup: resending the exact same request hits CompletedTurnCache without touching agy!
    const promptCountBefore = eventsAfter.filter((e) => e.event === "session/prompt").length
    const r3Replay = await fetch(`http://127.0.0.1:${daemon2.port}/v1/messages`, {
      method: "POST",
      headers: headers2,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:read_file" },
          { role: "assistant", content: msg1.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "line1\nline2" },
              { type: "text", text: "[System] Showing lines 1-2 of 100. Use offset=3 to continue reading." },
            ],
          },
          { role: "assistant", content: msg2.content },
          { role: "user", content: "Follow up after daemon restart" },
        ],
      }),
    })
    expect(r3Replay.status).toBe(200)
    const msg3Replay = await r3Replay.json()
    expect(msg3Replay.content[0].text).toBe(msg3.content[0].text)
    const eventsAfterReplay = readMockEvents(eventsFile)
    expect(eventsAfterReplay.filter((e) => e.event === "session/prompt").length).toBe(promptCountBefore)
  })

  it("keeps the live agy session when the client later swaps an older image for text", async () => {
    const dir = makeTempDir("image-elided-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile
    const daemon = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, exitOnShutdown: false })
    cleanups.push(() => daemon.shutdown())
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_image_elided",
      "x-cwd": "/tmp/demo-repo",
    }
    const tools = [{
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }]
    const post = (messages) => fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "claude-opus-4-6-thinking", max_tokens: 1024, stream: false, tools, messages }),
    })
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

    const r1 = await post([{ role: "user", content: "Please CALL_TOOL:read_file" }])
    expect(r1.status).toBe(200)
    const msg1 = await r1.json()
    const toolUse = msg1.content.find((b) => b.type === "tool_use")
    expect(toolUse?.name).toBe("read_file")

    const withImage = [
      { role: "user", content: "Please CALL_TOOL:read_file" },
      { role: "assistant", content: msg1.content },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [{ type: "text", text: "page 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }],
        }],
      },
    ]
    const r2 = await post(withImage)
    expect(r2.status).toBe(200)
    const msg2 = await r2.json()
    const firstSessionId = readMockEvents(eventsFile).find((e) => e.event === "session/new")?.sessionId
    expect(firstSessionId).toBeTruthy()

    // The client now sends the same conversation with that image replaced by a note.
    const elided = structuredClone(withImage)
    elided[2].content[0].content[1] = { type: "text", text: "[image omitted to stay under the request limit]" }
    const r3 = await post([...elided, { role: "assistant", content: msg2.content }, { role: "user", content: "Follow up after image elided" }])
    expect(r3.status).toBe(200)
    const msg3 = await r3.json()
    const reply3 = msg3.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    expect(reply3).toContain(`MAIN_REPLY:${firstSessionId}:Follow up after image elided`)

    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
    expect(events.some((e) => e.event === "session/resume")).toBe(false)
  })

  it("keeps every tool when the tools are over agy's size limit and gives the model their full text", async () => {
    const dir = makeTempDir("tool-budget-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile
    const daemon = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, exitOnShutdown: false })
    cleanups.push(() => daemon.shutdown())
    const post = (session, messages, tools) => fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemon.authKey}`,
        "x-agy-hook-session": session,
        "x-cwd": "/tmp/demo-repo",
      },
      body: JSON.stringify({ model: "claude-opus-4-6-thinking", max_tokens: 1024, stream: false, system: "You are a test assistant.", tools, messages }),
    })
    const tool = (name, secret, repeat = 300) => ({
      name,
      description: `Tool ${name}. ` + "Long guidance sentence for testing. ".repeat(repeat) + ` SECRET-${secret}`,
      input_schema: { type: "object", properties: { code: { type: "string", description: "input" } }, required: ["code"] },
    })
    const waitFor = async (pred) => {
      for (let i = 0; i < 50; i++) {
        const hit = readMockEvents(eventsFile).find(pred)
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 20))
      }
      return null
    }

    // 27 tools of ~11 KB each: agy itself would keep only 5 of them.
    const tools = Array.from({ length: 27 }, (_, i) => tool(`t${String(i).padStart(2, "0")}`, `T${i}`))
    const m1 = [{ role: "user", content: "hello" }]
    const r1 = await post("ses_tool_budget", m1, tools)
    expect(r1.status).toBe(200)
    const msg1 = await r1.json()

    const listed = await waitFor((e) => e.event === "mcp/list-at-start")
    expect(listed.tools).toEqual(tools.map((t) => t.name))
    expect(listed.bytes).toBeLessThanOrEqual(50_000)
    const started = readMockEvents(eventsFile).find((e) => e.event === "session/new")
    expect(started.systemAppend).toContain("You are a test assistant.")
    expect(started.systemAppend).toContain("# Full tool descriptions")
    expect(started.systemAppend).toContain("SECRET-T0")
    expect(started.systemAppend).toContain("SECRET-T26")

    // A tool added later in the same conversation: its full text comes with the next prompt, once.
    const r2 = await post("ses_tool_budget", [...m1, { role: "assistant", content: msg1.content }, { role: "user", content: "again" }],
      [...tools, tool("t27", "NEW")])
    expect(r2.status).toBe(200)
    await r2.json()
    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
    const prompts = events.filter((e) => e.event === "session/prompt")
    expect(prompts.at(-1).markers).toEqual(["SECRET-NEW"])

    // Tools well under the limit are passed on unchanged, with no extra system text.
    const r3 = await post("ses_tool_budget_small", [{ role: "user", content: "small" }], [tool("s1", "S1", 5)])
    expect(r3.status).toBe(200)
    await r3.json()
    const small = readMockEvents(eventsFile).filter((e) => e.event === "session/new").at(-1)
    expect(small.systemAppend).not.toContain("Full tool descriptions")
    expect(small.systemAppend).toContain("You are a test assistant.")
  })

  it("handles mid-turn toolsGrew in-session without killing the agy process", async () => {
    const dir = makeTempDir("toolsgrew-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_grow_1",
      "x-cwd": "/tmp/demo-repo",
    }
    const baseTools = [{
      name: "tool_search",
      description: "Search tools",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    }]
    const expandedTools = [
      ...baseTools,
      {
        name: "deferred_bash",
        description: "Run bash",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]

    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools: baseTools,
        messages: [{ role: "user", content: "Please CALL_TOOL:tool_search" }],
      }),
    })
    const msg1 = await parseSseToJson(r1)
    const toolUse = msg1.content.find((b) => b.type === "tool_use")
    expect(toolUse?.name).toBe("tool_search")

    // Client answers tool_search AND adds deferred_bash to tools in the same turn!
    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools: expandedTools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:tool_search" },
          { role: "assistant", content: msg1.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "loaded deferred_bash" },
            ],
          },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const msg2 = await r2.json()
    const events = readMockEvents(eventsFile)
    // Must stay in the single session (never spawn a second session/new)!
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
    expect(msg2.content[0].text).toContain("MAIN_REPLY:")
  })

  it("exports valid OpenCode 1.x / Magpie and OpenCode 2.x plugin contracts", async () => {
    expect(pluginV1.id).toBe("agy-cli")
    expect(typeof pluginV1.server).toBe("function")
    expect(pluginV2.id).toBe("magpie-agy-cli-boost")
    expect(typeof pluginV2.setup).toBe("function")

    const dir = makeTempDir("plugin-contract-")
    const prevStateDir = process.env.AGY_BOOST_STATE_DIR
    process.env.AGY_BOOST_STATE_DIR = dir
    try {
      const hooks = await pluginV1.server()
      expect(typeof hooks["chat.headers"]).toBe("function")
      expect(hooks.auth.provider).toBe("agy-cli")
      expect(typeof hooks.auth.usage).toBe("function")
      expect(typeof hooks.auth.loader).toBe("function")
      expect(typeof hooks.provider.models).toBe("function")
      expect(typeof hooks.provider.warming).toBe("function")

      const out = { headers: {} }
      await hooks["chat.headers"]({ sessionID: "ses_test_hdr" }, out)
      expect(out.headers["x-agy-hook-session"]).toBe("ses_test_hdr")
    } finally {
      if (prevStateDir === undefined) delete process.env.AGY_BOOST_STATE_DIR
      else process.env.AGY_BOOST_STATE_DIR = prevStateDir
    }
  })

  it("keeps the same external daemon alive across multiple plugin host clients", async () => {
    const dir = makeTempDir("multi-host-")
    const clientA = createDaemonClient({ stateDir: dir, codeFingerprint: "v1-test" })
    const ep1 = await clientA.ensure()
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${ep1.port}/admin/shutdown?force=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ep1.authKey}` },
      }).catch(() => {})
    })

    // Simulate a fresh Magpie plugin host spinning up after 512 MiB GC restart
    const clientB = createDaemonClient({ stateDir: dir, codeFingerprint: "v1-test" })
    const ep2 = await clientB.ensure()
    expect(ep2.pid).toBe(ep1.pid)
    expect(ep2.port).toBe(ep1.port)
  })

  it("isolates a non-streaming side-call even when history & instructions match a streaming primary", async () => {
    const dir = makeTempDir("nonstream-branch-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_stream_1",
      "x-cwd": "/tmp/demo-repo",
    }

    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        system: "Main prompt",
        messages: [{ role: "user", content: "Streaming turn 1" }],
      }),
    })
    expect(r1.status).toBe(200)
    const j1 = await parseSseToJson(r1)
    const primarySid = /MAIN_REPLY:([^:]+):/.exec(j1.content[0].text)?.[1]
    expect(primarySid).toBeTruthy()

    // Non-streaming side-call with same system & history prefix [u1, a1]
    const rSide = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        system: "Main prompt",
        messages: [
          { role: "user", content: "Streaming turn 1" },
          { role: "assistant", content: j1.content },
          { role: "user", content: "SIDE_CALL summary" },
        ],
      }),
    })
    expect(rSide.status).toBe(200)
    const jSide = await rSide.json()
    const sideSid = /SIDE_REPLY:([^:]+):/.exec(jSide.content[0].text)?.[1]
    expect(sideSid).toBeTruthy()
    expect(sideSid).not.toBe(primarySid)

    // Streaming primary turn 2 still hits the untouched primary session!
    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        system: "Main prompt",
        messages: [
          { role: "user", content: "Streaming turn 1" },
          { role: "assistant", content: j1.content },
          { role: "user", content: "Streaming turn 2" },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const j2 = await parseSseToJson(r2)
    expect(j2.content[0].text).toContain(`MAIN_REPLY:${primarySid}:Streaming turn 2`)
  })

  it("keeps live session when gateway collapses web_search into server_tool_use + web_search_tool_result", async () => {
    const dir = makeTempDir("websearch-collapse-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_ws_1",
      "x-cwd": "/tmp/demo-repo",
    }
    const tools = [
      { name: "web_search", description: "Search", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]

    // Step 1: agy emits web_search tool_use
    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [{ role: "user", content: "Please CALL_TOOL:web_search" }],
      }),
    })
    const m1 = await parseSseToJson(r1)
    const wsUse = m1.content.find((b) => b.name === "web_search")
    expect(wsUse).toBeTruthy()

    // Step 2: gateway feeds web_search tool_result, agy replies with bash tool_use
    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:web_search" },
          { role: "assistant", content: m1.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: wsUse.id, content: "search hits" }] },
          // In mock-agy, tool_result feeds back into the same turn which then finishes or calls another tool.
        ],
      }),
    })
    // Wait: mock-agy finishes with text after TOOL_OK, so verify collapsed history matches on the next user turn!
    const m2 = await parseSseToJson(r2)
    expect(m2.content[0].text).toContain("TOOL_OK:web_search:search hits")

    // Step 3: Client sends gateway-collapsed history (server_tool_use + web_search_tool_result)
    const r3 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:web_search" },
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srvtoolu_999", name: "web_search", input: wsUse.input },
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_999", content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }] },
              ...m2.content,
            ],
          },
          { role: "user", content: "Follow up after collapsed web_search" },
        ],
      }),
    })
    expect(r3.status).toBe(200)
    const j3 = await parseSseToJson(r3)
    expect(j3.content[0].text).toContain("MAIN_REPLY:")
    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
  })

  it("continues the pending tool turn when Magpie forwards history with the web_search blocks removed", async () => {
    const dir = makeTempDir("websearch-stripped-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const post = (messages) => fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemon.authKey}`,
        "x-agy-hook-session": "ses_ws_stripped",
        "x-cwd": "/tmp/demo-repo",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools: [
          { name: "web_search", description: "Search", input_schema: { type: "object", properties: { path: { type: "string" } } } },
          { name: "bash", description: "Bash", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        ],
        messages,
      }),
    })
    const opening = { role: "user", content: "Please CALL_TOOL:web_search THEN_TOOL:bash" }

    // agy asks for the search; the gateway runs it and feeds the result back.
    const m1 = await parseSseToJson(await post([opening]))
    const wsUse = m1.content.find((b) => b.name === "web_search")
    expect(wsUse).toBeTruthy()
    const m2 = await parseSseToJson(await post([
      opening,
      { role: "assistant", content: m1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: wsUse.id, content: "search hits" }] },
    ]))
    const bashUse = m2.content.find((b) => b.name === "bash")
    expect(bashUse).toBeTruthy()

    // The client answers bash; Magpie forwards the assistant turn without any trace of the search.
    const r3 = await post([
      opening,
      { role: "assistant", content: m2.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: bashUse.id, content: "bash out" }] },
    ])
    expect(r3.status).toBe(200)
    const m3 = await parseSseToJson(r3)
    expect(m3.content.map((b) => b.text || "").join("")).toContain("TOOL_OK:web_search:search hits+bash out")

    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
    expect(events.filter((e) => e.event === "session/prompt").length).toBe(1)
  })

  it("keeps stepUsageTrusted alive across transient missed steps and avoids 0.5x scale inflation on compacted sessions", async () => {
    const dir = makeTempDir("compacted-usage-")
    const convDir = path.join(dir, "conversations")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    const prevConvDir = process.env.AGY_BRIDGE_CONVERSATIONS_DIR
    const prevGenDir = process.env.MOCK_AGY_GEN_DB_DIR
    process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
    process.env.MOCK_AGY_GEN_DB_DIR = convDir
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile
    cleanups.push(async () => {
      if (prevConvDir === undefined) delete process.env.AGY_BRIDGE_CONVERSATIONS_DIR
      else process.env.AGY_BRIDGE_CONVERSATIONS_DIR = prevConvDir
      if (prevGenDir === undefined) delete process.env.MOCK_AGY_GEN_DB_DIR
      else process.env.MOCK_AGY_GEN_DB_DIR = prevGenDir
    })

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_compact_1",
      "x-cwd": "/tmp/demo-repo",
    }
    const tools = [
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]
    // Large ~25K-token history to simulate a session that agy internally compacted down to 5K tokens.
    const bigPad = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(1800)

    // Turn 1: measured via gen_metadata -> 5,000 tokens (scale ≈ 0.20, well below old 0.50 clamp).
    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [{ role: "user", content: `${bigPad}\nGEN_USAGE:500:4500:50 ACP_USAGE:5000:4500:50` }],
      }),
    })
    const m1 = await parseSseToJson(r1)
    expect(m1.usage.input_tokens + m1.usage.cache_read_input_tokens).toBe(5000)

    // Turn 2: transient tool step misses gen_metadata -> falls back to #responseUsage.
    // Must stay near calibrated ~5K (not spike to 0.5 * 25K = 12.5K!) and NOT poison stepUsageTrusted.
    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [
          { role: "user", content: `${bigPad}\nGEN_USAGE:500:4500:50 ACP_USAGE:5000:4500:50` },
          { role: "assistant", content: m1.content },
          { role: "user", content: "CALL_TOOL:bash SKIP_GEN_USAGE" },
        ],
      }),
    })
    const m2 = await parseSseToJson(r2)
    const fallbackCtx = m2.usage.input_tokens + m2.usage.cache_read_input_tokens + m2.usage.cache_creation_input_tokens
    expect(fallbackCtx).toBeLessThan(7500)

    // Finish the tool turn (without GEN_USAGE -> fallback on end_turn too), then verify Turn 3 recovers!
    const bashUse = m2.content.find((b) => b.name === "bash")
    const r2b = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [
          { role: "user", content: `${bigPad}\nGEN_USAGE:500:4500:50 ACP_USAGE:5000:4500:50` },
          { role: "assistant", content: m1.content },
          { role: "user", content: "CALL_TOOL:bash SKIP_GEN_USAGE" },
          { role: "assistant", content: m2.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: bashUse.id, content: "ok" }] },
        ],
      }),
    })
    const m2b = await parseSseToJson(r2b)
    expect(m2b.content[0].text).toContain("TOOL_OK:bash:ok")

    // Turn 3 on the SAME proc: gen_metadata MUST still work (stepUsageTrusted stayed true)!
    const r3 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [
          { role: "user", content: `${bigPad}\nGEN_USAGE:500:4500:50 ACP_USAGE:5000:4500:50` },
          { role: "assistant", content: m1.content },
          { role: "user", content: "CALL_TOOL:bash SKIP_GEN_USAGE" },
          { role: "assistant", content: m2.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: bashUse.id, content: "ok" }] },
          { role: "assistant", content: m2b.content },
          { role: "user", content: "GEN_USAGE:600:5400:60 ACP_USAGE:6000:5400:60" },
        ],
      }),
    })
    const m3 = await parseSseToJson(r3)
    expect(m3.usage.input_tokens).toBe(600)
    expect(m3.usage.cache_read_input_tokens).toBe(5400)
    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
  })

  it("canonicalizes tool order/schema keys without emitting tools_changed", async () => {
    const dir = makeTempDir("tools-canon-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_tools_canon",
      "x-cwd": "/tmp/demo-repo",
    }
    const toolsA = [
      { name: "bash", description: "Run shell", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { name: "read_file", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]
    const toolsB = [
      { name: "read_file", description: "Read", input_schema: { properties: { path: { type: "string" } }, type: "object" } },
      { name: "bash", description: "Run shell", input_schema: { properties: { path: { type: "string" } }, required: ["path"], type: "object" } },
    ]

    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools: toolsA,
        messages: [{ role: "user", content: "Please CALL_TOOL:bash" }],
      }),
    })
    const m1 = await parseSseToJson(r1)
    const bashUse = m1.content.find((b) => b.name === "bash")

    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools: toolsB,
        messages: [
          { role: "user", content: "Please CALL_TOOL:bash" },
          { role: "assistant", content: m1.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: bashUse.id, content: "done" }] },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const events = readMockEvents(eventsFile)
    // Only the initial session/new mcp/list fires; tools_changed must NOT re-trigger mcp/list!
    expect(events.filter((e) => e.event === "mcp/list").length).toBe(1)
  })

  it("rejects oversized requests with HTTP 413 request_too_large and x-should-retry: false", async () => {
    const dir = makeTempDir("req-limit-")
    const prevMax = process.env.AGY_BOOST_MAX_REQUEST_BYTES
    process.env.AGY_BOOST_MAX_REQUEST_BYTES = "2048"
    cleanups.push(async () => {
      if (prevMax === undefined) delete process.env.AGY_BOOST_MAX_REQUEST_BYTES
      else process.env.AGY_BOOST_MAX_REQUEST_BYTES = prevMax
    })

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const r = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemon.authKey}`,
      },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        messages: [{ role: "user", content: "x".repeat(4096) }],
      }),
    })
    expect(r.status).toBe(413)
    expect(r.headers.get("x-should-retry")).toBe("false")
    const err = await r.json()
    expect(err.error?.type).toBe("invalid_request_error")
    expect(err.error?.code).toBe("request_too_large")
  })

  it("resumes from a verified prefix checkpoint across restart when later turns diverge", async () => {
    const dir = makeTempDir("prefix-resume-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon1 = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      exitOnShutdown: false,
    })
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon1.authKey}`,
      "x-agy-hook-session": "ses_prefix_1",
      "x-cwd": "/tmp/demo-repo",
    }

    const r1 = await fetch(`http://127.0.0.1:${daemon1.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "Turn 1 hello" }],
      }),
    })
    expect(r1.status).toBe(200)
    const m1 = await r1.json()
    const firstSid = /MAIN_REPLY:([^:]+):/.exec(m1.content[0].text)?.[1]
    expect(firstSid).toBeTruthy()
    await daemon1.shutdown()

    // Restart daemon; client now sends an extra locally-appended turn in history after the checkpointed Turn 1.
    const daemon2 = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon2.shutdown())

    const r2 = await fetch(`http://127.0.0.1:${daemon2.port}/v1/messages`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${daemon2.authKey}` },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "Turn 1 hello" },
          { role: "assistant", content: m1.content },
          { role: "user", content: "Turn 2 edited offline" },
          { role: "assistant", content: [{ type: "text", text: "Turn 2 offline reply" }] },
          { role: "user", content: "Turn 3 after prefix" },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const m2 = await r2.json()
    expect(m2.content[0].text).toContain(`MAIN_REPLY:${firstSid}:`)

    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
    expect(events.some((e) => e.event === "session/resume" && e.sessionId === firstSid)).toBe(true)
    const lastPrompt = events.filter((e) => e.event === "session/prompt").at(-1)?.promptText || ""
    expect(lastPrompt).toContain("<continued_history_since_checkpoint>")
    expect(lastPrompt).toContain("Turn 2 edited offline")
  })

  it("evicts 1-turn fresh procs before long-context primary procs under pool pressure", async () => {
    const dir = makeTempDir("tiered-lru-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    const prevMaxProcs = process.env.AGY_BOOST_MAX_PROCS
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile
    process.env.AGY_BOOST_MAX_PROCS = "2"
    cleanups.push(async () => {
      if (prevMaxProcs === undefined) delete process.env.AGY_BOOST_MAX_PROCS
      else process.env.AGY_BOOST_MAX_PROCS = prevMaxProcs
    })

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const authHeader = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.authKey}` }

    // 1. Create a long-context primary proc (20+ messages) as oldest in the pool.
    const longHistory = []
    for (let i = 0; i < 10; i++) {
      longHistory.push({ role: "user", content: `Long msg ${i}` })
      longHistory.push({ role: "assistant", content: [{ type: "text", text: `Long reply ${i}` }] })
    }
    const rLong = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: { ...authHeader, "x-agy-hook-session": "ses_long_1" },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [...longHistory, { role: "user", content: "Long turn 1" }],
      }),
    })
    expect(rLong.status).toBe(200)
    const jLong = await rLong.json()
    const longSid = /MAIN_REPLY:([^:]+):/.exec(jLong.content[0].text)?.[1]

    // 2. Create a newer 1-turn fresh proc (pool now full at 2).
    const rFresh = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: { ...authHeader, "x-agy-hook-session": "ses_fresh_1" },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "Fresh 1-turn ping" }],
      }),
    })
    expect(rFresh.status).toBe(200)

    // 3. Create a 3rd conversation -> must evict the 1-turn fresh proc, NOT the older long-context primary!
    const rThird = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: { ...authHeader, "x-agy-hook-session": "ses_third_1" },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "Third conversation" }],
      }),
    })
    expect(rThird.status).toBe(200)

    // 4. Follow-up on the long-context primary MUST still reuse its live session without session/new or session/resume!
    const resumesBefore = readMockEvents(eventsFile).filter((e) => e.event === "session/resume").length
    const rLong2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers: { ...authHeader, "x-agy-hook-session": "ses_long_1" },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        messages: [
          ...longHistory,
          { role: "user", content: "Long turn 1" },
          { role: "assistant", content: jLong.content },
          { role: "user", content: "Long turn 2" },
        ],
      }),
    })
    expect(rLong2.status).toBe(200)
    const jLong2 = await rLong2.json()
    expect(jLong2.content[0].text).toContain(`MAIN_REPLY:${longSid}:Long turn 2`)
    const resumesAfter = readMockEvents(eventsFile).filter((e) => e.event === "session/resume").length
    expect(resumesAfter).toBe(resumesBefore)
  })

  it("retires obsolete 1-turn fresh procs instead of piling up duplicate slots", async () => {
    const dir = makeTempDir("fresh-cleanup-")
    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_fresh_pileup",
    }

    // Repeated fresh requests with the same convKey (varying tools so CompletedTurnCache misses)
    // must retire the obsolete 1-turn proc instead of keeping multiple slots for the same convKey.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-opus-4-6-thinking",
          max_tokens: 1024,
          stream: false,
          tools: [{ name: `tool_${i}`, description: "t", input_schema: { type: "object", properties: {} } }],
          messages: [{ role: "user", content: "Same fresh convKey ping" }],
        }),
      })
      expect(res.status).toBe(200)
    }

    let healthRes = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${daemon.authKey}` },
    })
    let health = await healthRes.json()
    expect(health.poolSize).toBe(1)

    // Multiple distinct fresh conversations in the same outerSession are capped rather than piling up unboundedly.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-opus-4-6-thinking",
          max_tokens: 1024,
          stream: false,
          messages: [{ role: "user", content: `Distinct fresh ping ${i}` }],
        }),
      })
      expect(res.status).toBe(200)
    }

    healthRes = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${daemon.authKey}` },
    })
    health = await healthRes.json()
    expect(health.poolSize).toBeLessThanOrEqual(3)
  })

  it("delivers queued_for_vision read_file image + Attached file notice in-place without dropping tool turn", async () => {
    const dir = makeTempDir("vision-attach-")
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile

    const daemon = await startDaemon({
      stateDir: dir,
      findAgy: () => MOCK_AGY,
      skipSignInCheck: true,
      skipInfoFile: true,
      exitOnShutdown: false,
    })
    cleanups.push(() => daemon.shutdown())

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemon.authKey}`,
      "x-agy-hook-session": "ses_vision_1",
      "x-cwd": "/tmp/demo-repo",
    }
    const tools = [{
      name: "read_file",
      description: "Read file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    }]

    const r1 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: true,
        tools,
        messages: [{ role: "user", content: "Please CALL_TOOL:read_file" }],
      }),
    })
    const m1 = await parseSseToJson(r1)
    const toolUse = m1.content.find((b) => b.name === "read_file")
    expect(toolUse).toBeTruthy()

    const r2 = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        max_tokens: 1024,
        stream: false,
        tools,
        messages: [
          { role: "user", content: "Please CALL_TOOL:read_file" },
          { role: "assistant", content: m1.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "{\"status\":\"queued_for_vision\"}" },
              { type: "text", text: "[System] Attached file: demo.jpg" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZmFrZWpwZw==" } },
            ],
          },
        ],
      }),
    })
    expect(r2.status).toBe(200)
    const m2 = await r2.json()
    expect(m2.content[0].text).toContain("TOOL_OK:read_file:")
    const events = readMockEvents(eventsFile)
    expect(events.filter((e) => e.event === "session/new").length).toBe(1)
  })
})

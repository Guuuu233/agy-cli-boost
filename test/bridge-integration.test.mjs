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
    }
  }
  return { content, stop_reason: stopReason }
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
})

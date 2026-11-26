#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const args = process.argv.slice(2)
const logFile = process.env.MOCK_AGY_EVENTS_FILE || ""
const genDbDir = process.env.MOCK_AGY_GEN_DB_DIR || ""

function varintBytes(n) {
  const out = []
  let v = Math.max(0, Math.floor(n))
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v & 0x7f)
  return out
}

function lenField(fieldNum, bytes) {
  return [...varintBytes((fieldNum << 3) | 2), ...varintBytes(bytes.length), ...bytes]
}

function intField(fieldNum, val) {
  if (!val) return []
  return [...varintBytes((fieldNum << 3) | 0), ...varintBytes(val)]
}

function encodeGenMetadata({ input = 0, output = 0, write = 0, read = 0, thinking = 0 }) {
  const usage = [
    ...intField(2, input),
    ...intField(3, output),
    ...intField(4, write),
    ...intField(5, read),
    ...intField(9, thinking),
  ]
  const chat = lenField(4, usage)
  return Uint8Array.from(lenField(1, chat))
}

const genCounters = new Map()
function writeGenMetadata(sid, usage) {
  if (!genDbDir || !sid) return
  fs.mkdirSync(genDbDir, { recursive: true })
  const dbPath = path.join(genDbDir, `${sid}.db`)
  const db = new Database(dbPath)
  db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
  db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)")
  const nextIdx = (genCounters.get(sid) ?? -1) + 1
  genCounters.set(sid, nextIdx)
  db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(nextIdx, encodeGenMetadata(usage))
  db.close()
}

function record(event) {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, JSON.stringify({ ts: Date.now(), ...event }) + "\n")
  } catch {}
}

if (args[0] === "--version") {
  console.log("agy 1.5.8")
  process.exit(0)
}

if (args[0] === "models") {
  console.log("claude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)")
  console.log("gemini-3-pro-high          Gemini 3 Pro High")
  process.exit(0)
}

if (args[0] !== "acp") {
  console.error("unsupported mock command:", args)
  process.exit(1)
}
record({ event: "acp_start", args, home: process.env.HOME })

const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT || 0)
const token = process.env.AGY_BRIDGE_TOKEN || ""
let sessionCounter = 0
let currentSessionId = null
let currentModel = "claude-opus-4-6-thinking"
const activePrompts = new Map() // sessionId -> { cancelled: false }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function controlCall(kind, extra = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, kind, ...extra }) + "\n")
    })
    sock.setEncoding("utf8")
    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk
      const idx = buf.indexOf("\n")
      if (idx >= 0) {
        sock.end()
        try {
          resolve(JSON.parse(buf.slice(0, idx)))
        } catch (err) {
          reject(err)
        }
      }
    })
    sock.on("error", reject)
  })
}

async function handlePrompt(id, params) {
  const sid = params.sessionId
  const state = { cancelled: false }
  activePrompts.set(sid, state)
  const promptText = (params.prompt || [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text)
    .join("\n")

  record({
    event: "session/prompt",
    sessionId: sid,
    promptText: promptText.slice(0, 300),
    markers: promptText.match(/SECRET-[A-Z0-9]+/g) || [],
  })

  try {
    // Trigger an MCP tool call if prompt asks for CALL_TOOL:<name>
    const genMatch = /GEN_USAGE:(\d+):(\d+):(\d+)/.exec(promptText)
    const acpUsageMatch = /ACP_USAGE:(\d+):(\d+):(\d+)/.exec(promptText)
    const acpUsage = acpUsageMatch
      ? { inputTokens: Number(acpUsageMatch[1]), cachedReadTokens: Number(acpUsageMatch[2]), outputTokens: Number(acpUsageMatch[3]) }
      : { inputTokens: 50, cachedReadTokens: 40, outputTokens: 10 }
    const toolMatch = /CALL_TOOL:([A-Za-z0-9_:-]+)/.exec(promptText)
    if (toolMatch) {
      const toolName = toolMatch[1]
      const listRes = await controlCall("list")
      const toolNames = (listRes?.result?.tools || []).map((t) => t.name)
      record({ event: "mcp/list", sessionId: sid, tools: toolNames })
      if (genMatch && !promptText.includes("SKIP_GEN_USAGE")) {
        writeGenMetadata(sid, {
          input: Number(genMatch[1]),
          read: Number(genMatch[2]),
          output: Number(genMatch[3]),
        })
      }
      const callRes = await controlCall("call", {
        name: toolName,
        arguments: { path: "demo.txt" },
      })
      if (state.cancelled) {
        send({
          jsonrpc: "2.0",
          id,
          result: { stopReason: "cancelled", usage: { inputTokens: 10, outputTokens: 2 } },
        })
        return
      }
      let toolOutput = (callRes?.result?.content || []).map((c) => c.text).join("\n")
      // THEN_TOOL:<name> chains a second MCP call inside the same agy turn.
      const thenMatch = /THEN_TOOL:([A-Za-z0-9_:-]+)/.exec(promptText)
      if (thenMatch) {
        const thenRes = await controlCall("call", { name: thenMatch[1], arguments: { path: "then.txt" } })
        toolOutput += "+" + (thenRes?.result?.content || []).map((c) => c.text).join("\n")
      }
      if (acpUsageMatch && !promptText.includes("SKIP_GEN_USAGE")) {
        writeGenMetadata(sid, {
          input: 120,
          read: Number(genMatch?.[1] || 0) + Number(genMatch?.[2] || 0),
          output: 20,
        })
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `TOOL_OK:${toolName}:${toolOutput}:TOOLS=${toolNames.join(",")}` },
          },
        },
      })
      send({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: "end_turn",
          usage: acpUsageMatch ? acpUsage : { inputTokens: 100, cachedReadTokens: 80, outputTokens: 20 },
        },
      })
      return
    }

    // REPLY_TEXT:<text> answers with exactly <text>, a few characters at a
    // time (agy passes some upstream errors on as the reply's text).
    const replyText = /REPLY_TEXT:(.+)$/s.exec(promptText)
    if (replyText) {
      const text = replyText[1].trim()
      for (let i = 0; i < text.length; i += 7) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(i, i + 7) } } },
        })
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: acpUsage } })
      return
    }

    const replyPrefix = promptText.includes("SIDE_CALL") ? "SIDE_REPLY" : "MAIN_REPLY"
    if (genMatch && !promptText.includes("SKIP_GEN_USAGE")) {
      writeGenMetadata(sid, {
        input: Number(genMatch[1]),
        read: Number(genMatch[2]),
        output: Number(genMatch[3]),
      })
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${replyPrefix}:${sid}:${promptText.slice(0, 80)}` },
        },
      },
    })
    send({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        usage: acpUsage,
      },
    })
  } finally {
    activePrompts.delete(sid)
  }
}

function startWatch() {
  if (!port || !token) return
  try {
    const watchSock = net.connect({ host: "127.0.0.1", port }, () => {
      watchSock.write(JSON.stringify({ token, kind: "watch" }) + "\n")
    })
    watchSock.setEncoding("utf8")
    let buf = ""
    watchSock.on("data", (chunk) => {
      buf += chunk
      for (;;) {
        const idx = buf.indexOf("\n")
        if (idx < 0) break
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev?.event === "tools_changed") controlCall("list").catch(() => {})
        } catch {}
      }
    })
    watchSock.on("error", () => {})
  } catch {}
}

process.stdin.setEncoding("utf8")
let stdinBuf = ""
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk
  for (;;) {
    const idx = stdinBuf.indexOf("\n")
    if (idx < 0) break
    const line = stdinBuf.slice(0, idx).trim()
    stdinBuf = stdinBuf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.method === "session/cancel") {
      const state = activePrompts.get(msg.params?.sessionId)
      if (state) state.cancelled = true
      record({ event: "session/cancel", sessionId: msg.params?.sessionId })
      continue
    }

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "mock-agy", version: "1.5.8" },
          agentCapabilities: {
            promptCapabilities: { image: true },
            sessionCapabilities: { resume: true },
            _meta: { antigravity: { systemPrompt: { append: true } } },
          },
        },
      })
      continue
    }

    if (msg.method === "session/new") {
      sessionCounter++
      currentSessionId = `mock-sess-${process.pid}-${sessionCounter}`
      const newSid = currentSessionId
      record({
        event: "session/new",
        sessionId: newSid,
        cwd: msg.params?.cwd,
        systemAppend: msg.params?._meta?.antigravity?.systemPrompt?.append ?? null,
      })
      startWatch()
      controlCall("list").then((res) => {
        const tools = res?.result?.tools || []
        const plain = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        record({
          event: "mcp/list-at-start",
          sessionId: newSid,
          tools: tools.map((t) => t.name),
          bytes: plain.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t), "utf8"), 0),
        })
      }).catch(() => {})
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: currentSessionId,
          models: {
            currentModelId: currentModel,
            availableModels: [{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }],
          },
          configOptions: [],
        },
      })
      continue
    }

    if (msg.method === "session/resume") {
      const sid = msg.params?.sessionId
      currentSessionId = sid
      record({ event: "session/resume", sessionId: sid, cwd: msg.params?.cwd })
      startWatch()
      controlCall("list").catch(() => {})
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: sid,
          models: {
            currentModelId: currentModel,
            availableModels: [{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }],
          },
          configOptions: [],
        },
      })
      continue
    }

    if (msg.method === "session/set_model") {
      if (/retired/.test(msg.params?.modelId || "")) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown model ID: ${msg.params.modelId}` } })
        continue
      }
      currentModel = msg.params?.modelId || currentModel
      send({ jsonrpc: "2.0", id: msg.id, result: {} })
      continue
    }

    if (msg.method === "session/prompt") {
      handlePrompt(msg.id, msg.params).catch((err) => {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } })
      })
      continue
    }

    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})

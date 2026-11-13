#!/usr/bin/env bun
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const args = process.argv.slice(2)
const logFile = process.env.MOCK_AGY_EVENTS_FILE || ""

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

  record({ event: "session/prompt", sessionId: sid, promptText: promptText.slice(0, 300) })

  try {
    // Trigger an MCP tool call if prompt asks for CALL_TOOL:<name>
    const toolMatch = /CALL_TOOL:([A-Za-z0-9_:-]+)/.exec(promptText)
    if (toolMatch) {
      const toolName = toolMatch[1]
      const listRes = await controlCall("list")
      const toolNames = (listRes?.result?.tools || []).map((t) => t.name)
      record({ event: "mcp/list", sessionId: sid, tools: toolNames })
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
      const toolOutput = (callRes?.result?.content || []).map((c) => c.text).join("\n")
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
          usage: { inputTokens: 100, cachedReadTokens: 80, outputTokens: 20 },
        },
      })
      return
    }

    const replyPrefix = promptText.includes("SIDE_CALL") ? "SIDE_REPLY" : "MAIN_REPLY"
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
        usage: { inputTokens: 50, cachedReadTokens: 40, outputTokens: 10 },
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
      record({ event: "session/new", sessionId: currentSessionId })
      startWatch()
      controlCall("list").catch(() => {})
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
      record({ event: "session/resume", sessionId: sid })
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

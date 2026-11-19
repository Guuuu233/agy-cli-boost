import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { buildGeminiShadow } from "../src/helper/gemini-shadow.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const MOCK_AGY = path.resolve(import.meta.dir, "mock-agy.mjs")
const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

function tempDir(prefix) {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A gemini dir like ~/.gemini: sign-in and conversations beside config/
// with one MCP server.
function fakeGemini(servers = { colab: { command: "uv", args: ["run", "colab"] } }) {
  const source = tempDir("gemini-src-")
  fs.mkdirSync(path.join(source, "antigravity-cli", "conversations"), { recursive: true })
  fs.writeFileSync(path.join(source, ".env"), "X=1\n")
  fs.writeFileSync(path.join(source, "settings.json"), "{}\n")
  fs.mkdirSync(path.join(source, "config"))
  fs.writeFileSync(path.join(source, "config", "config.json"), "{\"a\":1}\n")
  fs.writeFileSync(path.join(source, "config", "mcp_config.json"), JSON.stringify({ mcpServers: servers }))
  return source
}

const mac = { env: {}, platform: "darwin" }

describe("gemini shadow dir", () => {
  it("links everything back to the real dir except an empty MCP list", () => {
    const source = fakeGemini()
    const state = tempDir("state-")
    const dir = buildGeminiShadow(state, { source, ...mac })
    expect(dir).toBe(path.join(state, "gemini-shadow"))
    for (const name of [".env", "settings.json", "antigravity-cli"]) {
      expect(fs.readlinkSync(path.join(dir, name))).toBe(path.join(source, name))
    }
    expect(fs.lstatSync(path.join(dir, "config")).isSymbolicLink()).toBe(false)
    expect(fs.readlinkSync(path.join(dir, "config", "config.json"))).toBe(path.join(source, "config", "config.json"))
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config", "mcp_config.json"), "utf8"))).toEqual({ mcpServers: {} })
    // the real list is untouched
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(source, "config", "mcp_config.json"), "utf8")).mcpServers)).toEqual(["colab"])
  })

  it("is rebuilt per daemon, so entries added to the real dir appear and copies agy left are dropped", () => {
    const source = fakeGemini()
    const state = tempDir("state-")
    const dir = buildGeminiShadow(state, { source, ...mac })
    fs.rmSync(path.join(dir, "settings.json"))
    fs.writeFileSync(path.join(dir, "settings.json"), "{\"stale\":true}\n")
    fs.writeFileSync(path.join(source, "projects.json"), "{}\n")
    buildGeminiShadow(state, { source, ...mac })
    expect(fs.readlinkSync(path.join(dir, "settings.json"))).toBe(path.join(source, "settings.json"))
    expect(fs.readlinkSync(path.join(dir, "projects.json"))).toBe(path.join(source, "projects.json"))
  })

  it("never removes a directory it did not build", () => {
    const source = fakeGemini()
    const state = tempDir("state-")
    fs.mkdirSync(path.join(state, "gemini-shadow"))
    fs.writeFileSync(path.join(state, "gemini-shadow", "keep"), "x")
    expect(() => buildGeminiShadow(state, { source, ...mac })).toThrow(/not an agy-boost shadow/)
    expect(fs.existsSync(path.join(state, "gemini-shadow", "keep"))).toBe(true)
  })

  it("keeps agy's own dir when there is nothing to leave out, on Windows, or when asked to", () => {
    const state = tempDir("state-")
    expect(buildGeminiShadow(state, { source: fakeGemini({}), ...mac })).toBeNull()
    expect(buildGeminiShadow(state, { source: tempDir("empty-"), ...mac })).toBeNull()
    expect(buildGeminiShadow(state, { source: fakeGemini(), env: {}, platform: "win32" })).toBeNull()
    expect(buildGeminiShadow(state, { source: fakeGemini(), env: { AGY_BOOST_USER_MCP: "1" }, platform: "darwin" })).toBeNull()
  })
})

function readEvents(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function ask(daemon, session, text) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.authKey}`, "x-agy-hook-session": session },
    body: JSON.stringify({ model: "claude-opus-4-6-thinking", max_tokens: 64, stream: false, messages: [{ role: "user", content: text }] }),
  })
  expect(res.status).toBe(200)
  return res.json()
}

describe("daemon pool", () => {
  function env(name, value) {
    const prev = process.env[name]
    process.env[name] = value
    cleanups.push(() => {
      if (prev === undefined) delete process.env[name]
      else process.env[name] = prev
    })
  }

  async function daemonIn(dir) {
    const daemon = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, skipInfoFile: true, exitOnShutdown: false })
    cleanups.push(() => daemon.shutdown())
    return daemon
  }

  it("starts agy with the shadow dir when the bridge has one", async () => {
    const dir = tempDir("spawn-shadow-")
    const events = path.join(dir, "mock-agy.jsonl")
    env("MOCK_AGY_EVENTS_FILE", events)
    const daemon = await daemonIn(dir)
    daemon.bridge.geminiDir = buildGeminiShadow(dir, { source: fakeGemini(), ...mac })
    await ask(daemon, "ses_shadow", "hello")
    const args = readEvents(events).find((e) => e.event === "acp_start").args
    expect(args.slice(args.indexOf("--gemini-dir"), args.indexOf("--gemini-dir") + 2)).toEqual(["--gemini-dir", path.join(dir, "gemini-shadow")])
  })

  it("starts agy without --gemini-dir when there is no shadow", async () => {
    const dir = tempDir("spawn-plain-")
    const events = path.join(dir, "mock-agy.jsonl")
    env("MOCK_AGY_EVENTS_FILE", events)
    const daemon = await daemonIn(dir)
    daemon.bridge.geminiDir = null
    await ask(daemon, "ses_plain", "hello")
    expect(readEvents(events).find((e) => e.event === "acp_start").args).not.toContain("--gemini-dir")
  })

  it("lets idle agy go past AGY_BOOST_MAX_IDLE_PROCS, the cheapest first", async () => {
    const dir = tempDir("idle-cap-")
    env("AGY_BOOST_MAX_IDLE_PROCS", "2")
    const daemon = await daemonIn(dir)
    daemon.bridge.geminiDir = null
    for (const n of [1, 2, 3, 4]) await ask(daemon, `ses_idle_${n}`, `conversation ${n}`)
    expect(daemon.bridge.pool.size).toBeGreaterThan(2)
    const latest = [...daemon.bridge.pool.values()].map((proc) => proc.lastUsed).sort((a, b) => b - a).slice(0, 2)
    await daemon.bridge.evictIdle()
    expect(daemon.bridge.pool.size).toBe(2)
    // same tier (1-turn fresh): the two used last are kept
    expect([...daemon.bridge.pool.values()].map((proc) => proc.lastUsed).sort((a, b) => b - a)).toEqual(latest)
  })
})

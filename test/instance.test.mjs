import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { childEnv } from "../src/helper/platform.mjs"
import { conversationsDir } from "../src/helper/step-usage.mjs"
import { DEFAULT_ID, readInstance } from "../src/instance.mjs"
import { defaultStateDir } from "../src/state-security.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const CHILD = path.resolve(import.meta.dir, "daemon-child.mjs")
const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

function tempDir(prefix) {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix))
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeInstance(dir, value) {
  const file = path.join(dir, "instance.json")
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
  return file
}

describe("instance.json", () => {
  it("is the default agy-cli instance when there is none", () => {
    const own = readInstance(path.join(tempDir("inst-none-"), "instance.json"))
    expect(own).toMatchObject({ id: DEFAULT_ID, name: null, agyHome: null, isDefault: true })
  })

  it("gives an id, a name and a HOME of its own, and makes the HOME", () => {
    const dir = tempDir("inst-ok-")
    const home = path.join(dir, "accounts", "2")
    const own = readInstance(writeInstance(dir, { id: "agy-cli-2", name: "Antigravity 2", agyHome: home }))
    expect(own).toMatchObject({ id: "agy-cli-2", name: "Antigravity 2", agyHome: home, isDefault: false })
    expect(fs.statSync(home).isDirectory()).toBe(true)
  })

  it("refuses a file that would put a copy on another's provider or account", () => {
    const dir = tempDir("inst-bad-")
    for (const bad of [
      "{ not json",
      "[]",
      { id: "Agy CLI 2" },
      { id: "" },
      { id: "agy-cli-2", agyHome: "relative/home" },
      { id: "agy-cli-2", agyHome: 42 },
    ]) {
      expect(() => readInstance(writeInstance(dir, bad))).toThrow(/agy-cli-boost/)
    }
  })

  it("moves the state dir, agy's HOME and its conversations, and only for that instance", () => {
    const dir = tempDir("inst-paths-")
    const home = path.join(dir, "home2")
    const env = { AGY_BOOST_INSTANCE_FILE: writeInstance(dir, { id: "agy-cli-2", agyHome: home }), HOME: "/home/user", PATH: "/usr/bin" }
    expect(path.basename(defaultStateDir(env))).toBe("magpie-agy-cli-boost-agy-cli-2")
    expect(childEnv(env, {}, "linux").HOME).toBe(home)
    expect(childEnv(env, { HOME: "/elsewhere" }, "linux").HOME).toBe(home)
    expect(conversationsDir(env)).toBe(path.join(home, ".gemini", "antigravity-cli", "conversations"))

    const plain = { AGY_BOOST_INSTANCE_FILE: path.join(dir, "missing.json"), HOME: "/home/user", PATH: "/usr/bin" }
    expect(path.basename(defaultStateDir(plain))).toBe("magpie-agy-cli-boost")
    expect(childEnv(plain, {}, "linux").HOME).toBe("/home/user")
  })
})

// Starts daemon-child.mjs with its own instance file and events file.
async function child(stateDir, env) {
  const proc = spawn(process.execPath, [CHILD, stateDir], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
  cleanups.push(async () => {
    proc.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve() }, 5_000)
      proc.on("exit", () => { clearTimeout(timer); resolve() })
    })
  })
  let out = ""
  const info = await new Promise((resolve, reject) => {
    proc.stdout.on("data", (data) => {
      out += data
      const line = out.split("\n").find((l) => l.startsWith("{"))
      if (line) resolve(JSON.parse(line))
    })
    proc.on("exit", (code) => reject(new Error(`daemon child exited ${code}: ${out}`)))
  })
  return info
}

async function ask(d, session) {
  const res = await fetch(`http://127.0.0.1:${d.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.authKey}`, "x-agy-hook-session": session },
    body: JSON.stringify({ model: "claude-opus-4-6-thinking", max_tokens: 64, stream: false, messages: [{ role: "user", content: `hello ${session}` }] }),
  })
  expect(res.status).toBe(200)
  return await res.json()
}

function starts(eventsFile) {
  return fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((event) => event.event === "acp_start")
}

describe("two instances side by side", () => {
  it("each run their own daemon, with agy under their own HOME", async () => {
    const dir = tempDir("inst-two-")
    const home2 = path.join(dir, "accounts", "2")
    const first = { state: path.join(dir, "state1"), events: path.join(dir, "events1.jsonl") }
    const second = { state: path.join(dir, "state2"), events: path.join(dir, "events2.jsonl") }
    const a = await child(first.state, {
      AGY_BOOST_INSTANCE_FILE: path.join(dir, "no-instance.json"),
      MOCK_AGY_EVENTS_FILE: first.events,
    })
    const b = await child(second.state, {
      AGY_BOOST_INSTANCE_FILE: writeInstance(dir, { id: "agy-cli-2", name: "Antigravity 2", agyHome: home2 }),
      MOCK_AGY_EVENTS_FILE: second.events,
    })

    expect(a.providerId).toBe("agy-cli")
    expect(b.providerId).toBe("agy-cli-2")
    expect(path.basename(a.defaultStateDir)).toBe("magpie-agy-cli-boost")
    expect(path.basename(b.defaultStateDir)).toBe("magpie-agy-cli-boost-agy-cli-2")
    expect(a.port).not.toBe(b.port)
    expect(a.authKey).not.toBe(b.authKey)

    // both at once
    const [ra, rb] = await Promise.all([ask(a, "ses_first"), ask(b, "ses_second")])
    expect(ra.content[0].text).toContain("MAIN_REPLY")
    expect(rb.content[0].text).toContain("MAIN_REPLY")

    expect(starts(first.events).map((s) => s.home)).toEqual([os.homedir()])
    expect(starts(second.events).map((s) => s.home)).toEqual([home2])
    expect(fs.existsSync(path.join(first.state, "daemon.key"))).toBe(true)
    expect(fs.existsSync(path.join(second.state, "daemon.key"))).toBe(true)
  })
})

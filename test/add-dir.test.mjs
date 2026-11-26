import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { holdsHome } from "../src/helper/platform.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const MOCK_AGY = path.resolve(import.meta.dir, "mock-agy.mjs")
const cleanups = []

afterEach(async () => {
  delete process.env.MOCK_AGY_EVENTS_FILE
  while (cleanups.length) await cleanups.pop()()
})

describe("holdsHome", () => {
  it("is true for the home folder and the folders above it only", () => {
    expect(holdsHome("/Users/me", "/Users/me", "darwin")).toBe(true)
    expect(holdsHome("/Users/me/", "/Users/me", "darwin")).toBe(true)
    expect(holdsHome("/Users", "/Users/me", "darwin")).toBe(true)
    expect(holdsHome("/", "/Users/me", "darwin")).toBe(true)
    expect(holdsHome("/Users/me/project", "/Users/me", "darwin")).toBe(false)
    expect(holdsHome("/Users/meow", "/Users/me", "darwin")).toBe(false)
    expect(holdsHome("/tmp/demo", "/Users/me", "darwin")).toBe(false)
    expect(holdsHome("c:\\users\\ME", "C:\\Users\\me", "win32")).toBe(true)
    expect(holdsHome("C:\\Users\\me\\repo", "C:\\Users\\me", "win32")).toBe(false)
    expect(holdsHome("", "/Users/me", "darwin")).toBe(false)
  })
})

describe("the caller's folder as agy's workspace", () => {
  it("is added with --add-dir, except when it is the home folder", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
    const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "add-dir-"))
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
    const eventsFile = path.join(dir, "mock-agy.jsonl")
    process.env.MOCK_AGY_EVENTS_FILE = eventsFile
    const d = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, skipInfoFile: true, exitOnShutdown: false })
    d.bridge.geminiDir = null
    cleanups.push(() => d.shutdown())

    const project = path.join(dir, "project")
    fs.mkdirSync(project)
    for (const [session, cwd] of [["ses_home", os.homedir()], ["ses_project", project]]) {
      const res = await fetch(`http://127.0.0.1:${d.port}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${d.authKey}`,
          "x-agy-hook-session": session,
          "x-magpie-work-dir": encodeURIComponent(cwd),
        },
        body: JSON.stringify({ model: "claude-opus-4-6-thinking", max_tokens: 64, stream: false, messages: [{ role: "user", content: `hello from ${session}` }] }),
      })
      expect(res.status).toBe(200)
      await res.text()
    }

    const starts = fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.event === "acp_start").map((event) => event.args)
    expect(starts.length).toBe(2)
    const addDirs = starts.map((args) => {
      const at = args.indexOf("--add-dir")
      return at >= 0 ? args[at + 1] : null
    })
    expect(addDirs).toContain(project)
    expect(addDirs.filter((value) => value === null).length).toBe(1)
    expect(addDirs).not.toContain(os.homedir())
  })
})

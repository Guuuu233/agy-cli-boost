import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { daemonPaths, ensureDaemonKey, startDaemon } from "../src/daemon.mjs"
import { createDaemonClient } from "../src/plugin.mjs"
import { isProcessAlive } from "../src/state-security.mjs"

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function answers(port, authKey) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${authKey}` },
      signal: AbortSignal.timeout(1_000),
    })
    return res.ok
  } catch {
    return false
  }
}

describe("daemon lifecycle", () => {
  it("an idle daemon whose state dir now names another daemon stops by itself", async () => {
    const dir = tempDir("superseded-")
    const prev = process.env.AGY_BOOST_SUPERSEDED_CHECK_MS
    process.env.AGY_BOOST_SUPERSEDED_CHECK_MS = "100"
    let d
    try {
      d = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, exitOnShutdown: false })
    } finally {
      if (prev === undefined) delete process.env.AGY_BOOST_SUPERSEDED_CHECK_MS
      else process.env.AGY_BOOST_SUPERSEDED_CHECK_MS = prev
    }
    cleanups.push(() => d.shutdown())
    expect(await answers(d.port, d.authKey)).toBe(true)

    await sleep(300)
    expect(await answers(d.port, d.authKey)).toBe(true) // still the named daemon: keeps running

    const { infoFile } = daemonPaths(dir)
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"))
    fs.writeFileSync(infoFile, JSON.stringify({ ...info, pid: info.pid + 100_000, port: 1 }))
    await sleep(400)
    expect(await answers(d.port, d.authKey)).toBe(false)
  })

  it("stops a daemon that is alive but not answering before starting a new one", async () => {
    const dir = tempDir("hung-")
    const key = ensureDaemonKey(dir)
    // A stand-in for a stuck daemon: accepts connections, never answers.
    const hung = spawn(process.execPath, ["-e", `
      const net = require("node:net")
      const s = net.createServer(() => {}).listen(0, "127.0.0.1", () => console.log(s.address().port))
      setInterval(() => {}, 1 << 30)
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    cleanups.push(() => { try { process.kill(-hung.pid, "SIGKILL") } catch {} })
    const port = await new Promise((resolve) => hung.stdout.once("data", (b) => resolve(Number(String(b).trim()))))
    const { infoFile } = daemonPaths(dir)
    fs.writeFileSync(infoFile, JSON.stringify({ pid: hung.pid, port, protocolVersion: 1 }), { mode: 0o600 })
    expect(isProcessAlive(hung.pid)).toBe(true)

    const client = createDaemonClient({ stateDir: dir, codeFingerprint: "hung-test" })
    const ep = await client.ensure()
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${ep.port}/admin/shutdown?force=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      }).catch(() => {})
    })

    expect(ep.pid).not.toBe(hung.pid)
    expect(await answers(ep.port, key)).toBe(true)
    expect(isProcessAlive(hung.pid)).toBe(false)
  }, 30_000)
})

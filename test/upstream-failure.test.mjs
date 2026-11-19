import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { classifyUpstreamFailure, couldBeUpstreamFailure } from "../src/helper/upstream-failure.mjs"

const TEST_TMP_ROOT = path.resolve(import.meta.dir, "..", ".tmp-tests")
const MOCK_AGY = path.resolve(import.meta.dir, "mock-agy.mjs")
const cleanups = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()()
})

async function daemon() {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "upstream-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const d = await startDaemon({ stateDir: dir, findAgy: () => MOCK_AGY, skipSignInCheck: true, skipInfoFile: true, exitOnShutdown: false })
  d.bridge.geminiDir = null
  cleanups.push(() => d.shutdown())
  return d
}

function ask(d, session, text, { stream = true, tools } = {}) {
  return fetch(`http://127.0.0.1:${d.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.authKey}`, "x-agy-hook-session": session },
    body: JSON.stringify({
      model: "claude-opus-4-6-thinking",
      max_tokens: 64,
      stream,
      ...(tools ? { tools } : {}),
      messages: [{ role: "user", content: text }],
    }),
  })
}

function streamedText(sse) {
  return sse.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    .filter((ev) => ev.type === "content_block_delta" && ev.delta.type === "text_delta").map((ev) => ev.delta.text).join("")
}

const QUOTA = "⚠ Individual quota reached. Your quota resets in 3h 12m."

describe("upstream failure helper", () => {
  it("knows agy's quota text and leaves ordinary replies alone", () => {
    expect(classifyUpstreamFailure(QUOTA)).toMatchObject({ kind: "rate_limit_error", status: 429 })
    expect(classifyUpstreamFailure("Your code looks fine; the quota check in limits.js is reached only once.")).toBeNull()
    for (const notice of [
      "You have reached your quota limit. Try again after 5 minutes.",
      "Your quota has been exhausted.",
      "You've hit the rate limit. Please wait.",
      "Rate limit exceeded, try again later",
    ]) expect(classifyUpstreamFailure(notice)).toMatchObject({ kind: "rate_limit_error", status: 429 })
    expect(couldBeUpstreamFailure("You")).toBe(true)
    expect(couldBeUpstreamFailure("Sure, here is")).toBe(false)
  })
})

describe("a quota error agy passes on as the reply", () => {
  it("is answered with HTTP 429 before any stream starts, so the client can fail over", async () => {
    const d = await daemon()
    const res = await ask(d, "ses_quota_stream", `REPLY_TEXT:${QUOTA}`)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("Individual quota reached")
    // the agy session that recorded it is not kept for the next turn
    expect(d.bridge.pool.size).toBe(0)
  })

  it("is a 429 without streaming too", async () => {
    const d = await daemon()
    const res = await ask(d, "ses_quota_json", `REPLY_TEXT:${QUOTA}`, { stream: false })
    expect(res.status).toBe(429)
    expect((await res.json()).error.type).toBe("rate_limit_error")
  })

  it("does not hold back or change an ordinary reply that only starts the same way", async () => {
    const d = await daemon()
    const reply = "Your code looks fine; the quota check in limits.js is reached only once."
    const res = await ask(d, "ses_ordinary", `REPLY_TEXT:${reply}`)
    expect(res.status).toBe(200)
    expect(streamedText(await res.text())).toBe(reply)
  })

  it("streams a normal reply unchanged", async () => {
    const d = await daemon()
    const res = await ask(d, "ses_normal", "hello there")
    expect(res.status).toBe(200)
    expect(streamedText(await res.text())).toContain("MAIN_REPLY:")
  })
})

import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { classifyUpstreamFailure, couldBeUpstreamFailure, verifyLinkIn } from "../src/helper/upstream-failure.mjs"

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
// agy's endings, as the official opencode-agy-cli-auth records them
const BANNED_159 = "⚠ PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
const BANNED_1510 = "⚠ This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
const VERIFY = "⚠ Verification Required"
const BUSY = "⚠ Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)"
const THIRD_PARTY = "⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h22m19s."

describe("agy's account and capacity endings", () => {
  it("are classified, and a reply that only quotes one is not", () => {
    for (const ban of [BANNED_159, BANNED_1510]) {
      expect(classifyUpstreamFailure(ban)).toMatchObject({ kind: "permission_error", status: 403, noRetry: true })
    }
    expect(classifyUpstreamFailure(VERIFY)).toMatchObject({ kind: "permission_error", status: 403, noRetry: true })
    expect(classifyUpstreamFailure(VERIFY).message).toContain("this Google account needs to be verified")
    expect(classifyUpstreamFailure(BUSY)).toMatchObject({ kind: "overloaded_error", status: 503 })
    expect(classifyUpstreamFailure(BUSY).noRetry).toBeUndefined()
    expect(classifyUpstreamFailure(THIRD_PARTY)).toMatchObject({ kind: "rate_limit_error", status: 429 })
    expect(classifyUpstreamFailure(`${BANNED_1510}\nThat is what agy prints when Google bans an account.`)).toBeNull()
    expect(classifyUpstreamFailure(`${VERIFY}\nmeans Google wants the account verified.`)).toBeNull()
    expect(verifyLinkIn('{"error":{"details":[{"validation_url":"https://accounts.google.com/signin/continue?x=1"}]}}'))
      .toBe("https://accounts.google.com/signin/continue?x=1")
    expect(verifyLinkIn("no link here")).toBe("")
  })

  for (const [name, text, status, type, noRetry] of [
    ["a banned account (agy 1.5.9)", BANNED_159, 403, "permission_error", true],
    ["a banned account (agy 1.5.10)", BANNED_1510, 403, "permission_error", true],
    ["an account Google wants verified", VERIFY, 403, "permission_error", true],
    ["a model with no capacity", BUSY, 503, "overloaded_error", false],
    ["a used-up third-party quota", THIRD_PARTY, 429, "rate_limit_error", false],
  ]) {
    it(`fails the request for ${name} instead of answering with the notice`, async () => {
      const d = await daemon()
      for (const stream of [true, false]) {
        const res = await ask(d, `ses_ending_${status}_${stream}_${text.length}`, `REPLY_TEXT:${text}`, { stream })
        expect(res.status).toBe(status)
        expect(res.headers.get("x-should-retry")).toBe(noRetry ? "false" : null)
        const body = await res.json()
        expect(body.error.type).toBe(type)
      }
    })
  }

  it("fails the turn when the ending comes after the model's own text", async () => {
    const d = await daemon()
    const reply = `Here is the first part of my answer.\n${BANNED_1510}`
    const streamed = await ask(d, "ses_after_text_stream", `REPLY_TEXT:${reply}`)
    expect(streamed.status).toBe(200)
    const sse = await streamed.text()
    expect(streamedText(sse)).toBe("Here is the first part of my answer.")
    const error = sse.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
      .find((ev) => ev.type === "error")
    expect(error.error).toMatchObject({ type: "permission_error", status: 403, noRetry: true })

    const json = await ask(d, "ses_after_text_json", `REPLY_TEXT:${reply}`, { stream: false })
    expect(json.status).toBe(403)
    expect(json.headers.get("x-should-retry")).toBe("false")
  })

  it("leaves a reply alone that quotes an ending mid-line or goes on after it", async () => {
    const d = await daemon()
    for (const [i, reply] of [
      `agy then prints ${VERIFY} and stops.`,
      `${VERIFY}\nmeans Google wants the account verified.`,
      `Answer first.\n${BANNED_1510}\nThat line is what a banned account gets.`,
    ].entries()) {
      const res = await ask(d, `ses_quote_${i}`, `REPLY_TEXT:${reply}`)
      expect(res.status).toBe(200)
      expect(streamedText(await res.text())).toBe(reply)
    }
  })
})

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

  it("answers a model agy no longer knows with 503 so the client fails over", async () => {
    const d = await daemon()
    const res = await fetch(`http://127.0.0.1:${d.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.authKey}`, "x-agy-hook-session": "ses_retired" },
      body: JSON.stringify({ model: "gemini-retired-model", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(503)
  })

  it("streams a normal reply unchanged", async () => {
    const d = await daemon()
    const res = await ask(d, "ses_normal", "hello there")
    expect(res.status).toBe(200)
    expect(streamedText(await res.text())).toContain("MAIN_REPLY:")
  })
})

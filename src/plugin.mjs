import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { findAgy, ModelCatalogService } from "./catalog.mjs"
import { computeCodeFingerprint, daemonPaths, ensureDaemonKey, PROTOCOL_VERSION } from "./daemon.mjs"
import { startLogin } from "./helper/login.mjs"
import { forgetStoredSignIn } from "./helper/signin.mjs"
import { createUsageReader } from "./helper/usage.mjs"
import { sanitizeInputSchema } from "./protocol.mjs"
import {
  defaultStateDir,
  ensurePrivateDirSync,
  isProcessAlive,
  readPrivateFileSync,
} from "./state-security.mjs"

export const PROVIDER_ID = "agy-cli"
export const NPM_ANTHROPIC = "@ai-sdk/anthropic"

const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.mjs", import.meta.url))
const DAEMON_BOOT_TIMEOUT_MS = 10_000
const DAEMON_PROBE_TIMEOUT_MS = 1_500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readPrivateFileSync(filePath))
  } catch {
    return null
  }
}

async function probeDaemonHealth(port, authKey, timeoutMs = DAEMON_PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${authKey}` },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function requestDaemonShutdown(port, authKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  timer.unref?.()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authKey}` },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function withAsyncLock(lockPath, fn, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let handle = null
  while (Date.now() < deadline) {
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        const st = await fs.promises.stat(lockPath)
        if (Date.now() - st.mtimeMs > 5_000) {
          const raw = JSON.parse(await fs.promises.readFile(lockPath, "utf8"))
          if (Number.isSafeInteger(raw?.pid) && raw.pid > 0 && !isProcessAlive(raw.pid)) {
            await fs.promises.unlink(lockPath).catch(() => {})
            continue
          }
          if (Date.now() - st.mtimeMs > 15_000) {
            await fs.promises.unlink(lockPath).catch(() => {})
            continue
          }
        }
      } catch {}
      await sleep(30)
    }
  }
  if (!handle) throw new Error("agy-cli-boost: timed out acquiring daemon startup lock")
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await fs.promises.unlink(lockPath).catch(() => {})
  }
}

function spawnDetachedDaemon(stateDir, codeFingerprint = "") {
  const { logFile } = daemonPaths(stateDir)
  let logFd = null
  try {
    const st = fs.statSync(logFile, { throwIfNoEntry: false })
    if (st && st.size > 5 * 1024 * 1024) {
      fs.renameSync(logFile, `${logFile}.1`)
    }
    logFd = fs.openSync(logFile, "a", 0o600)
  } catch {}
  const stdio = logFd !== null ? ["ignore", logFd, logFd] : ["ignore", "ignore", "ignore"]
  const env = {
    ...process.env,
    AGY_BOOST_STATE_DIR: stateDir,
    ...(codeFingerprint ? { AGY_BOOST_CODE_FINGERPRINT: codeFingerprint } : {}),
  }
  try {
    if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
      const child = Bun.spawn([process.execPath, DAEMON_ENTRY], {
        cwd: stateDir,
        detached: true,
        env,
        stdio,
      })
      child.unref?.()
    } else {
      const child = spawn(process.execPath, [DAEMON_ENTRY], {
        cwd: stateDir,
        detached: true,
        windowsHide: true,
        env,
        stdio,
      })
      child.unref?.()
    }
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd) } catch {}
    }
  }
}

export function createDaemonClient(opts = {}) {
  const stateDir = ensurePrivateDirSync(opts.stateDir || defaultStateDir())
  const { infoFile } = daemonPaths(stateDir)
  const lockFile = path.join(stateDir, "daemon.spawn.lock")
  const localFingerprint = opts.codeFingerprint || computeCodeFingerprint()
  let cached = null
  let inFlight = null

  async function ensure({ forceProbe = false } = {}) {
    if (!forceProbe && cached) {
      const health = await probeDaemonHealth(cached.port, cached.authKey, 800)
      if (health?.ok && health.protocolVersion === PROTOCOL_VERSION &&
        (health.codeFingerprint === localFingerprint || health.activeTurns > 0)) {
        return cached
      }
      cached = null
    }
    if (inFlight) return inFlight
    inFlight = (async () => {
      const authKey = ensureDaemonKey(stateDir)
      // Fast probe without lock first.
      const quickInfo = readJsonSafe(infoFile)
      if (quickInfo?.port && isProcessAlive(quickInfo.pid)) {
        const health = await probeDaemonHealth(quickInfo.port, authKey)
        if (health?.ok && health.protocolVersion === PROTOCOL_VERSION &&
          (health.codeFingerprint === localFingerprint || health.activeTurns > 0)) {
          cached = { port: quickInfo.port, authKey, pid: quickInfo.pid }
          return cached
        }
      }

      return withAsyncLock(lockFile, async () => {
        const key = ensureDaemonKey(stateDir)
        const existing = readJsonSafe(infoFile)
        if (existing?.port && isProcessAlive(existing.pid)) {
          const health = await probeDaemonHealth(existing.port, key)
          if (health?.ok && health.protocolVersion === PROTOCOL_VERSION) {
            if (health.codeFingerprint === localFingerprint || health.activeTurns > 0) {
              cached = { port: existing.port, authKey: key, pid: existing.pid }
              return cached
            }
            // Idle outdated daemon -> ask it to shut down cleanly before spawning new one.
            if (await requestDaemonShutdown(existing.port, key)) {
              const stopDeadline = Date.now() + 2_500
              while (Date.now() < stopDeadline && isProcessAlive(existing.pid)) {
                await sleep(40)
              }
            }
          }
        }

        const prevPid = existing?.pid || 0
        spawnDetachedDaemon(stateDir, opts.codeFingerprint || "")
        const bootDeadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS
        while (Date.now() < bootDeadline) {
          const info = readJsonSafe(infoFile)
          if (info?.port && info.pid && (info.pid !== prevPid || !isProcessAlive(prevPid))) {
            const health = await probeDaemonHealth(info.port, key, 600)
            if (health?.ok) {
              cached = { port: info.port, authKey: key, pid: info.pid }
              return cached
            }
          }
          await sleep(40)
        }
        throw new Error("agy-cli-boost: daemon failed to start within 10s (check daemon.log)")
      })
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function request(pathname, init = {}) {
    let endpoint = await ensure()
    const buildHeaders = (authKey) => {
      const headers = new Headers(init.headers || {})
      headers.delete("host")
      headers.set("authorization", `Bearer ${authKey}`)
      return headers
    }
    try {
      return await fetch(`http://127.0.0.1:${endpoint.port}${pathname}`, {
        method: init.method || "GET",
        headers: buildHeaders(endpoint.authKey),
        body: init.body,
        signal: init.signal,
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      // Connection failed (e.g. daemon restarted externally): re-ensure once and retry.
      cached = null
      endpoint = await ensure({ forceProbe: true })
      return fetch(`http://127.0.0.1:${endpoint.port}${pathname}`, {
        method: init.method || "GET",
        headers: buildHeaders(endpoint.authKey),
        body: init.body,
        signal: init.signal,
      })
    }
  }

  return {
    stateDir,
    ensure,
    request,
    invalidate: () => { cached = null },
  }
}

export const AntigravityBridgePlugin = async () => {
  const stateDir = ensurePrivateDirSync(defaultStateDir())
  const daemon = createDaemonClient({ stateDir })
  const localCatalog = new ModelCatalogService(stateDir, { name: "agy-cli-boost", version: "0.1.0" })
  const readUsage = createUsageReader(findAgy)
  let warmPromise = null

  const triggerWarm = () => {
    if (!warmPromise) {
      warmPromise = daemon.ensure().catch(() => null).finally(() => {
        warmPromise = null
      })
    }
    return warmPromise
  }

  return {
    "chat.headers": async (input, output) => {
      if (input?.sessionID && output?.headers && typeof output.headers === "object") {
        output.headers["x-agy-hook-session"] = String(input.sessionID)
      }
    },
    auth: {
      provider: PROVIDER_ID,
      single: true,
      usage: async () => readUsage(),
      methods: [
        {
          type: "oauth",
          label: "Sign in with Google",
          authorize: async () => {
            const agy = findAgy()
            if (!agy) {
              return {
                type: "failed",
                error: "agy CLI not found. Install Antigravity CLI first: https://antigravity.google/docs/cli",
              }
            }
            if ((await localCatalog.probeSignedIn(agy)).ok) {
              return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "success", key: "agy" }) }
            }
            const login = await startLogin(agy)
            if (login.error) return { type: "failed", error: login.error }
            return {
              url: login.url,
              instructions: "",
              method: "code",
              callback: async (code, opts = {}) => {
                const done = await login.finish(code, { signal: opts.signal })
                if (done.error) return { type: "failed", error: done.error }
                forgetStoredSignIn({ dead: true })
                localCatalog.forgetOffered()
                await daemon.request("/admin/reset-auth", { method: "POST" }).catch(() => {})
                const probe = await localCatalog.probeSignedIn(agy)
                if (!probe.ok) return { type: "failed", error: `agy signed in, but ${probe.why}` }
                return { type: "success", key: "agy" }
              },
            }
          },
        },
      ],
      loader: async () => {
        return {
          baseURL: "agy://local",
          apiKey: "agy",
          fetch: async (fetchInput, init = {}) => {
            const requestUrl = typeof fetchInput === "string"
              ? fetchInput
              : fetchInput instanceof URL
                ? fetchInput.href
                : fetchInput?.url || ""
            const pathname = /\/count[_-]tokens(?:$|[/?#])/i.test(requestUrl)
              ? "/v1/messages/count_tokens"
              : "/v1/messages"
            const rawBody = init.body != null
              ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
              : (typeof fetchInput?.text === "function" ? await fetchInput.text() : "")
            return daemon.request(pathname, {
              method: "POST",
              headers: init.headers,
              body: rawBody,
              signal: init.signal,
            })
          },
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      warming: () => triggerWarm(),
      models: async () => {
        try {
          const res = await daemon.request("/models", {
            method: "GET",
            signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(1_800) : undefined,
          })
          if (res.ok) return await res.json()
        } catch {}
        const agy = findAgy()
        const catalog = await localCatalog.loadModelCatalog(agy, { probeOffered: true })
        const { formatProviderModels } = await import("./catalog.mjs")
        return formatProviderModels(catalog)
      },
    },
  }
}

export { sanitizeInputSchema }
export default { id: PROVIDER_ID, server: AntigravityBridgePlugin }

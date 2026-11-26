import { timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { AgyBridge, jsonError } from "./bridge.mjs"
import { maxRequestBytes, NO_RETRY_HEADERS } from "./protocol.mjs"
import { forgetStoredSignIn } from "./helper/signin.mjs"
import {
  defaultStateDir,
  ensurePrivateDirSync,
  newTokenHex,
  readPrivateFileSync,
  writePrivateAtomicSync,
} from "./state-security.mjs"

export const PROTOCOL_VERSION = 1

function positiveMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const DAEMON_IDLE_EXIT_MS = () => positiveMs(process.env.AGY_BOOST_DAEMON_IDLE_MS, 4 * 60 * 60 * 1000)
const SUPERSEDED_CHECK_MS = () => positiveMs(process.env.AGY_BOOST_SUPERSEDED_CHECK_MS, 60_000)

export function computeCodeFingerprint(rootDir = path.resolve(import.meta.dir || path.dirname(new URL(import.meta.url).pathname), "..")) {
  if (process.env.AGY_BOOST_CODE_FINGERPRINT) return process.env.AGY_BOOST_CODE_FINGERPRINT
  try {
    const pkgRaw = fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
    const pkg = JSON.parse(pkgRaw)
    const srcDir = path.join(rootDir, "src")
    const entries = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && entry.name.endsWith(".mjs")) {
          const st = fs.statSync(full)
          entries.push(`${path.relative(rootDir, full)}:${st.size}:${Math.trunc(st.mtimeMs)}`)
        }
      }
    }
    walk(srcDir)
    // a changed instance.json (another HOME) needs a new daemon too
    const own = fs.statSync(path.join(rootDir, "instance.json"), { throwIfNoEntry: false })
    if (own) entries.push(`instance.json:${own.size}:${Math.trunc(own.mtimeMs)}`)
    entries.sort()
    return `${pkg.version || "0.0.0"}:${entries.join("|")}`
  } catch {
    return "unknown"
  }
}

export function daemonPaths(stateDir) {
  return {
    stateDir,
    keyFile: path.join(stateDir, "daemon.key"),
    infoFile: path.join(stateDir, "daemon.json"),
    logFile: path.join(stateDir, "daemon.log"),
  }
}

export function ensureDaemonKey(stateDir) {
  ensurePrivateDirSync(stateDir)
  const { keyFile } = daemonPaths(stateDir)
  try {
    const existing = readPrivateFileSync(keyFile).trim()
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing
  } catch {}
  const fresh = newTokenHex(32)
  writePrivateAtomicSync(keyFile, fresh + "\n")
  return fresh
}

function bearerMatches(authHeader, expectedKey) {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return false
  const token = authHeader.slice(7).trim()
  if (token.length !== expectedKey.length) return false
  try {
    return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(expectedKey, "utf8"))
  } catch {
    return false
  }
}

function writeDaemonInfo(infoFile, info) {
  writePrivateAtomicSync(infoFile, JSON.stringify(info, null, 2) + "\n")
}

function removeOwnInfo(infoFile, pid) {
  try {
    const raw = JSON.parse(fs.readFileSync(infoFile, "utf8"))
    if (raw?.pid === pid) fs.rmSync(infoFile, { force: true })
  } catch {}
}

export async function startDaemon(opts = {}) {
  const stateDir = ensurePrivateDirSync(opts.stateDir || defaultStateDir())
  const { infoFile } = daemonPaths(stateDir)
  const authKey = opts.authKey || ensureDaemonKey(stateDir)
  const pkgVersion = opts.packageVersion || (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      return pkg.version || "0.1.0"
    } catch {
      return "0.1.0"
    }
  })()
  const codeFingerprint = opts.codeFingerprint || computeCodeFingerprint()
  const bridge = new AgyBridge({
    stateDir,
    findAgy: opts.findAgy,
    skipSignInCheck: opts.skipSignInCheck,
    resumeTtlMs: opts.resumeTtlMs,
  })

  let lastRequestAt = Date.now()
  let shuttingDown = false
  let server = null

  const shutdown = async (exitAfter = false) => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(idleSweep)
    try { await bridge.shutdown() } catch {}
    try { server?.stop?.(true) } catch {}
    try { server?.close?.() } catch {}
    removeOwnInfo(infoFile, process.pid)
    if (exitAfter) process.exit(0)
  }

  const handleRequest = async (req) => {
    lastRequestAt = Date.now()
    const auth = req.headers.get("authorization") || ""
    if (!bearerMatches(auth, authKey)) {
      return new Response(JSON.stringify({ error: { type: "authentication_error", message: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const url = new URL(req.url)
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({
        ...bridge.statusSnapshot(),
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION,
        packageVersion: pkgVersion,
        codeFingerprint,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (req.method === "GET" && url.pathname === "/models") {
      try {
        const models = await bridge.getModels()
        return new Response(JSON.stringify(models), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      } catch (error) {
        return jsonError(502, error?.message || "failed to list agy models")
      }
    }

    const readBoundedBody = async () => {
      const limit = maxRequestBytes()
      const contentLength = Number(req.headers.get("content-length"))
      if (Number.isFinite(contentLength) && contentLength > limit) {
        return {
          tooLarge: jsonError(
            413,
            `agy bridge: request size (${contentLength} bytes) exceeds ${limit} byte limit; compact the conversation and retry`,
            "request_too_large",
            { headers: NO_RETRY_HEADERS, noRetry: true },
          ),
        }
      }
      const rawBody = await req.text()
      const actualBytes = Buffer.byteLength(rawBody, "utf8")
      if (actualBytes > limit) {
        return {
          tooLarge: jsonError(
            413,
            `agy bridge: request size (${actualBytes} bytes) exceeds ${limit} byte limit; compact the conversation and retry`,
            "request_too_large",
            { headers: NO_RETRY_HEADERS, noRetry: true },
          ),
        }
      }
      return { rawBody }
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const { rawBody, tooLarge } = await readBoundedBody()
      if (tooLarge) return tooLarge
      return bridge.handleCountTokens(rawBody)
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const { rawBody, tooLarge } = await readBoundedBody()
      if (tooLarge) return tooLarge
      const outerSession = req.headers.get("x-agy-hook-session") || ""
      return bridge.handleMessages(rawBody, req.headers, req.signal, outerSession)
    }

    if (req.method === "POST" && url.pathname === "/admin/reset-auth") {
      forgetStoredSignIn({ dead: true })
      bridge.catalog.forgetOffered()
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (req.method === "POST" && url.pathname === "/admin/shutdown") {
      const force = url.searchParams.get("force") === "1"
      if (!force && bridge.activeTurnCount() > 0) {
        return new Response(JSON.stringify({
          ok: false,
          busy: true,
          activeTurns: bridge.activeTurnCount(),
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      }
      setTimeout(() => { shutdown(opts.exitOnShutdown !== false).catch(() => {}) }, 25)
      return new Response(JSON.stringify({ ok: true, shuttingDown: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ error: { type: "not_found_error", message: "not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  let port
  if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: opts.port ?? 0,
      idleTimeout: 0,
      fetch: handleRequest,
    })
    port = server.port
  } else {
    server = http.createServer(async (nodeReq, nodeRes) => {
      const controller = new AbortController()
      nodeReq.on("close", () => {
        if (!nodeRes.writableEnded) controller.abort()
      })
      try {
        const chunks = []
        for await (const chunk of nodeReq) chunks.push(chunk)
        const body = Buffer.concat(chunks)
        const headers = new Headers()
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) headers.set(k, v.join(", "))
          else if (typeof v === "string") headers.set(k, v)
        }
        const webReq = new Request(`http://127.0.0.1:${port}${nodeReq.url || "/"}`, {
          method: nodeReq.method,
          headers,
          body: nodeReq.method === "GET" || nodeReq.method === "HEAD" ? undefined : body,
          signal: controller.signal,
        })
        const webRes = await handleRequest(webReq)
        nodeRes.statusCode = webRes.status
        webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value))
        if (!webRes.body) {
          nodeRes.end()
          return
        }
        const reader = webRes.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (nodeRes.destroyed) break
          nodeRes.write(value)
        }
        nodeRes.end()
      } catch (error) {
        if (!nodeRes.headersSent) {
          nodeRes.statusCode = 500
          nodeRes.setHeader("Content-Type", "application/json")
          nodeRes.end(JSON.stringify({ error: { type: "api_error", message: String(error?.message ?? error) } }))
        } else {
          nodeRes.destroy()
        }
      }
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(opts.port ?? 0, "127.0.0.1", resolve)
    })
    port = server.address().port
  }

  const info = {
    pid: process.pid,
    port,
    protocolVersion: PROTOCOL_VERSION,
    packageVersion: pkgVersion,
    codeFingerprint,
    startedAt: Date.now(),
    stateDir,
  }
  if (!opts.skipInfoFile) writeDaemonInfo(infoFile, info)

  const idleSweep = setInterval(() => {
    if (shuttingDown) return
    if (bridge.activeTurnCount() === 0 && supersededBy() !== null) {
      // Another daemon took over this state dir: finish here instead of
      // keeping a second pool of agy processes alive.
      shutdown(opts.exitOnShutdown !== false).catch(() => {})
      return
    }
    if (bridge.pool.size === 0 && bridge.activeTurnCount() === 0 && Date.now() - lastRequestAt > DAEMON_IDLE_EXIT_MS()) {
      shutdown(opts.exitOnShutdown !== false).catch(() => {})
    }
  }, SUPERSEDED_CHECK_MS())

  function supersededBy() {
    if (opts.skipInfoFile) return null
    try {
      const raw = JSON.parse(fs.readFileSync(infoFile, "utf8"))
      return Number.isSafeInteger(raw?.pid) && raw.pid > 0 && raw.pid !== process.pid ? raw.pid : null
    } catch {
      return null
    }
  }
  idleSweep.unref?.()

  return {
    port,
    info,
    bridge,
    authKey,
    shutdown: () => shutdown(false),
  }
}

const isEntrypoint = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isEntrypoint) {
  try { process.on("SIGHUP", () => {}) } catch {}
  const stateDir = process.env.AGY_BOOST_STATE_DIR || defaultStateDir()
  const running = await startDaemon({ stateDir, exitOnShutdown: true })
  const onSignal = () => { running.shutdown().finally(() => process.exit(0)) }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

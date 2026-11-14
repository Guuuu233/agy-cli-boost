import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agyCandidates, spawnAgy } from "./helper/platform.mjs"
import { backgroundBlocked } from "./helper/signin.mjs"
import { withStateLockSync, writePrivateAtomicSync } from "./state-security.mjs"

export const MIN_AGY_VERSION = "1.4.12"
export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const MODEL_CATALOG_FAST_WAIT_MS = 500
const MODEL_CATALOG_RETRY_MS = 5_000
const OFFERED_PROBE_TIMEOUT_MS = 30_000
const OFFERED_PROBE_RETRY_MS = 60_000
const SAVED_CATALOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const ACP_LINE_LIMIT = 64 * 1024 * 1024

export const FALLBACK_MODELS = [
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", effort: "medium" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low" },
]

export function agyTooOld(version) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim())
    return match ? match.slice(1).map(Number) : null
  }
  const have = parse(version)
  if (!have) return null
  const need = parse(MIN_AGY_VERSION)
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return null
    if (have[i] < need[i]) {
      return `agy ${version} is older than ${MIN_AGY_VERSION}, the oldest version this plugin was checked on. Update agy.`
    }
  }
  return null
}

let cachedAgyPath = null
let cachedAgySearchKey = ""

export function findAgy() {
  const home = os.homedir()
  const env = process.env
  const searchKey = JSON.stringify([env.AGY_PATH, env.PATH, env.Path, env.LOCALAPPDATA, home])
  if (cachedAgyPath && cachedAgySearchKey === searchKey) return cachedAgyPath
  cachedAgyPath = null
  cachedAgySearchKey = searchKey
  for (const candidate of agyCandidates(env, home)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      cachedAgyPath = candidate
      return candidate
    } catch {}
  }
  return null
}

export function execOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      const launch = file === "taskkill" ? spawn : spawnAgy
      const { unrefTimer: _unrefTimer, ...spawnOpts } = opts
      child = launch(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...spawnOpts,
        windowsHide: true,
      })
    } catch (err) {
      resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
      resolve({ err: null, stdout, stderr, code: null, timedOut })
    }, opts.timeoutMs ?? 30_000)
    if (opts.unrefTimer) timer.unref?.()
    try {
      child.stdout.on("data", (data) => { stdout += data })
      child.stderr.on("data", (data) => { stderr += data })
      child.on("error", (err) => {
        clearTimeout(timer)
        resolve({ err, stdout, stderr, code: null, timedOut })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ err: null, stdout, stderr, code, timedOut })
      })
    } catch (err) {
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch {}
      resolve({ err, stdout, stderr, code: null, timedOut })
    }
  })
}

export function selectValues(options) {
  return (Array.isArray(options) ? options : []).flatMap(option =>
    Array.isArray(option?.options) ? selectValues(option.options)
      : typeof option?.value === "string" ? [option] : [])
}

export function configSelect(options, category) {
  return options.find(option => option?.type === "select" && option.category === category)
    || options.find(option => option?.type === "select" && option.id === category)
}

export function configModelSelection(options, model, selection) {
  const config = configSelect(options, "model")
  if (!config) return null
  const values = selectValues(config.options)
  const requested = selection?.model || model
  const target = values.find(option => option.value === requested)
    || values.filter(option => model.startsWith(option.value + "-") &&
      EFFORT_ORDER.includes(model.slice(option.value.length + 1)))
      .sort((a, b) => b.value.length - a.value.length)[0]
  if (!target) return null
  const suffix = model.startsWith(target.value + "-") ? model.slice(target.value.length + 1) : ""
  return {
    config,
    value: target.value,
    effort: requested === target.value ? selection?.effort || suffix : suffix,
  }
}

export function modelLimits(id) {
  const family = id.replace(/\[1m\]$/i, "").replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, "")
  if (/^(?:gemini-4-(?:argon|hydrogen)|gemini-3\.8-flash)$/i.test(family)) return { context: 1048576, output: 65536 }
  if (/^gemini-4-carbon$/i.test(family)) return { context: 1048576, output: 262144 }
  if (/^claude-(?:opus|sonnet)-5-5$/i.test(family)) return { context: 1000000, output: 64000 }
  if (/^gpt-oss-120b$/i.test(family)) return { context: 131072, output: 32768 }
  return undefined
}

function normalizeEffort(value) {
  const direct = String(value || "").trim().toLowerCase()
  if (direct === "ultra") return "max"
  return EFFORT_ORDER.includes(direct) ? direct : ""
}

export function requestedEffort(body) {
  const forced = normalizeEffort(process.env.AGY_BOOST_EFFORT || process.env.AGY_BRIDGE_EFFORT)
  if (forced) return forced
  const thinking = body.thinking?.type
  if (thinking === "disabled") return ""
  const generic = [body.reasoning_effort, body.reasoningEffort, body.reasoning?.effort,
    body.generationConfig?.thinkingConfig?.thinkingLevel].map(normalizeEffort).find(Boolean)
  if (generic) return generic
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const direct = normalizeEffort(body.output_config?.effort)
  if (direct) return direct
  const budget = Number(body.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return ""
  if (budget <= 4096) return "low"
  if (budget <= 12000) return "medium"
  if (budget <= 24000) return "high"
  return "xhigh"
}

export function closestEffort(effort, efforts) {
  const target = EFFORT_ORDER.indexOf(effort)
  let best = efforts[0]
  for (const candidate of efforts.slice(1)) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    const bestDistance = Math.abs(EFFORT_ORDER.indexOf(best) - target)
    if (distance < bestDistance || (distance === bestDistance && EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best))) {
      best = candidate
    }
  }
  return best
}

function modelFamilyId(model) {
  if (!model.effort) return ""
  return model.id.slice(0, -(model.effort.length + 1))
}

function buildModelCatalog(list) {
  const rawIds = new Set(list.map(model => model.id))
  const families = new Map()
  for (const model of list) {
    const id = modelFamilyId(model)
    if (!id) continue
    if (!families.has(id)) families.set(id, [])
    families.get(id).push(model)
  }
  for (const [id, variants] of families) {
    const efforts = new Set(variants.map(model => model.effort))
    if (variants.length < 2 || efforts.size !== variants.length || rawIds.has(id)) {
      families.delete(id)
    }
  }
  const models = []
  const routes = new Map()
  const added = new Set()
  for (const model of list) {
    const id = modelFamilyId(model)
    const family = families.get(id)
    if (!family) {
      models.push(model)
      continue
    }
    if (added.has(id)) continue
    added.add(id)
    const sorted = [...family].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort))
    const efforts = sorted.map(variant => variant.effort)
    const byEffort = new Map(sorted.map(variant => [variant.effort, variant.id]))
    const defaultEffort = byEffort.has("high") ? "high" : efforts[efforts.length - 1]
    const defaultModel = sorted.find(variant => variant.effort === defaultEffort)
    const baseName = defaultModel.name.replace(/\s+\((?:minimal|low|medium|high|xhigh|max)\)$/i, "").trim()
    models.push({
      id,
      name: baseName && baseName !== defaultModel.id ? baseName : id,
      variants: efforts,
    })
    routes.set(id, { byEffort, efforts, defaultEffort })
  }
  if (rawIds.has("gpt-oss-120b-medium") && !rawIds.has("gpt-oss-120b") && !routes.has("gpt-oss-120b")) {
    models.push({ id: "gpt-oss-120b", name: "GPT-OSS 120B" })
    routes.set("gpt-oss-120b", {
      byEffort: new Map([["medium", "gpt-oss-120b-medium"]]),
      efforts: ["medium"],
      defaultEffort: "medium",
    })
  }
  return { models, routes, rawIds }
}

function resolveCatalogAlias(catalog, model) {
  if (!model || catalog.routes.has(model) || catalog.rawIds?.has(model)) {
    return { id: model, inlineEffort: "" }
  }
  const undated = model.replace(/-\d{8}$/, "")
  if (catalog.routes.has(undated) || catalog.rawIds?.has(undated)) {
    return { id: undated, inlineEffort: "" }
  }
  const effortMatch = /^(.*)-(minimal|low|medium|high|xhigh|max)$/i.exec(undated)
  const base = effortMatch ? effortMatch[1] : undated
  const inlineEffort = effortMatch ? effortMatch[2].toLowerCase() : ""
  if (catalog.routes.has(base) || catalog.rawIds?.has(base)) {
    return { id: base, inlineEffort }
  }
  const routeKeys = [...catalog.routes.keys()]
  if (/^(?:gemini-[0-9.]+-flash(?:-lite)?|claude-(?:[0-9.-]+-)?haiku(?:-[0-9.-]+)?)$/i.test(base)) {
    const flashFamily = routeKeys.find((id) => /flash/i.test(id)) ||
      catalog.models.find((item) => /flash/i.test(item.id))?.id
    if (flashFamily) return { id: flashFamily, inlineEffort }
    const fallbackGemini = routeKeys.find((id) => /^gemini-/i.test(id))
    if (fallbackGemini) return { id: fallbackGemini, inlineEffort: inlineEffort || "low" }
  }
  if (/^gemini-[0-9.]+-(?:pro|ultra)(?:-[a-z0-9.]+)?$/i.test(base)) {
    const proFamily = (catalog.routes.has("gemini-4-argon") ? "gemini-4-argon" : null) ||
      routeKeys.find((id) => /^gemini-/i.test(id) && !/flash/i.test(id)) ||
      catalog.models.find((item) => /^gemini-/i.test(item.id) && !/flash/i.test(item.id))?.id
    if (proFamily) return { id: proFamily, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?sonnet(?:-[0-9.-]+)?$/i.test(base)) {
    const sonnet = routeKeys.find((id) => /^claude-.*sonnet/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*sonnet/i.test(item.id))?.id
    if (sonnet) return { id: sonnet, inlineEffort }
  }
  if (/^claude-(?:[0-9.-]+-)?opus(?:-[0-9.-]+)?(?:-thinking)?$/i.test(base)) {
    const opus = routeKeys.find((id) => /^claude-.*opus/i.test(id)) ||
      catalog.models.find((item) => /^claude-.*opus/i.test(item.id))?.id
    if (opus) return { id: opus, inlineEffort }
  }
  return { id: model, inlineEffort: "" }
}

export function resolveAgyModel(listed, model, body) {
  const catalog = listed.routing ?? listed
  const { id: resolvedId, inlineEffort } = resolveCatalogAlias(catalog, model)
  const family = catalog.routes.get(resolvedId)
  if (!family) return resolvedId
  const requested = requestedEffort(body) || inlineEffort
  const effort = requested ? closestEffort(requested, family.efforts) : family.defaultEffort
  return family.byEffort.get(effort)
}

export function parseAgyModels(stdout) {
  const out = []
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const id = match[1]
    const name = match[2].trim()
    const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase()
    out.push({ id, name, effort })
  }
  return out.length ? out : null
}

function briefly(promise, ms) {
  if (!promise) return Promise.resolve()
  let timer
  return Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, ms) }),
  ]).finally(() => clearTimeout(timer))
}

class ProbeConnection {
  constructor(child) {
    this.child = child
    this.nextId = 0
    this.pending = new Map()
    this.buffer = ""
    this.closed = false
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (data) => this.#onData(data))
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("probe closed"))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  close(error) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  #onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > ACP_LINE_LIMIT) {
      this.close(new Error("probe message exceeded limit"))
      return
    }
    for (;;) {
      const nl = this.buffer.indexOf("\n")
      if (nl < 0) return
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (Object.hasOwn(msg, "id") && !Object.hasOwn(msg, "method")) {
        const entry = this.pending.get(msg.id)
        if (!entry) continue
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message || "probe error"))
        else entry.resolve(msg.result ?? null)
      } else if (Object.hasOwn(msg, "id") && typeof msg.method === "string") {
        try {
          this.child.stdin?.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          }) + "\n")
        } catch {}
      }
    }
  }
}

export class ModelCatalogService {
  constructor(stateDir, clientInfo = { name: "agy-cli-boost", version: "0.1.0" }) {
    this.modelsFile = path.join(stateDir, "models.json")
    this.clientInfo = clientInfo
    this.cachedModelCatalog = { agyPath: null, list: FALLBACK_MODELS, catalog: null, offeredKey: null, isFallback: true, fetchedAt: 0, lastAttemptAt: null }
    this.modelCatalogRefreshPromise = null
    this.wantOfferedProbe = false
    this.acpOfferedModels = null
    this.acpOfferedKey = ""
    this.offeredProbePromise = null
    this.offeredProbeAt = null
    this.offeredGen = 0
  }

  #validModelRow(row) {
    return row && typeof row.id === "string" && /^\S+$/.test(row.id) && typeof row.name === "string" &&
      (row.effort === undefined || EFFORT_ORDER.includes(row.effort))
  }

  #savedRow({ id, name, effort }) {
    return effort ? { id, name, effort } : { id, name }
  }

  #readSavedCatalog(agyPath) {
    if (!agyPath) return null
    try {
      const data = JSON.parse(fs.readFileSync(this.modelsFile, "utf8"))
      const entry = data?.version === 1 && data.byAgy && Object.hasOwn(data.byAgy, agyPath) ? data.byAgy[agyPath] : null
      if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > SAVED_CATALOG_MAX_AGE_MS) return null
      if (!Array.isArray(entry.list) || !entry.list.length || !entry.list.every((r) => this.#validModelRow(r))) return null
      const offered = Array.isArray(entry.offered) && entry.offered.length &&
        entry.offered.every(row => this.#validModelRow(row) && row.effort === undefined)
        ? entry.offered
        : null
      return {
        list: entry.list.map((r) => this.#savedRow(r)),
        offered: offered && offered.map(({ id, name }) => ({ id, name })),
      }
    } catch {
      return null
    }
  }

  #saveCatalog(agyPath, change) {
    if (!agyPath) return
    try {
      withStateLockSync(this.modelsFile, () => {
        let byAgy = {}
        try {
          const data = JSON.parse(fs.readFileSync(this.modelsFile, "utf8"))
          if (data?.version === 1 && data.byAgy && typeof data.byAgy === "object") byAgy = data.byAgy
        } catch {}
        const entry = { ...(byAgy[agyPath] || {}), at: Date.now() }
        if (change.list) entry.list = change.list.map((r) => this.#savedRow(r))
        if (change.offered) entry.offered = change.offered
        if (!Array.isArray(entry.list)) return
        byAgy[agyPath] = entry
        writePrivateAtomicSync(this.modelsFile, JSON.stringify({ version: 1, byAgy }) + "\n")
      })
    } catch {}
  }

  forgetOffered() {
    this.acpOfferedModels = null
    this.acpOfferedKey = ""
    this.offeredProbePromise = null
    this.offeredProbeAt = null
    this.offeredGen++
  }

  useAgyPath(agyPath) {
    if (this.cachedModelCatalog.agyPath === agyPath) return
    if (this.cachedModelCatalog.agyPath !== null) this.forgetOffered()
    const saved = this.#readSavedCatalog(agyPath)
    if (saved) {
      if (saved.offered && !this.acpOfferedModels) {
        this.acpOfferedModels = new Map(saved.offered.map(({ id, name }) => [id, name]))
        this.acpOfferedKey = [...this.acpOfferedModels.keys()].sort().join("\n")
      }
      this.cachedModelCatalog = { agyPath, list: saved.list, catalog: null, offeredKey: null, isFallback: false, fetchedAt: 0, lastAttemptAt: null }
    } else {
      this.cachedModelCatalog = { agyPath, list: FALLBACK_MODELS, catalog: null, offeredKey: null, isFallback: true, fetchedAt: 0, lastAttemptAt: null }
    }
    this.modelCatalogRefreshPromise = null
  }

  storeListedCatalog(agyPath, list, lastAttemptAt) {
    this.#saveCatalog(agyPath, { list })
    this.cachedModelCatalog = {
      agyPath,
      list,
      catalog: null,
      offeredKey: null,
      isFallback: false,
      fetchedAt: Date.now(),
      lastAttemptAt,
    }
  }

  noteOfferedModels(configOptions, models) {
    const out = []
    const option = configSelect(Array.isArray(configOptions) ? configOptions : [], "model")
    for (const value of selectValues(option?.options)) out.push({ id: value.value, name: value.name })
    for (const model of Array.isArray(models?.availableModels) ? models.availableModels : []) {
      const id = model?.modelId ?? model?.id
      if (typeof id === "string" && id) out.push({ id, name: model.name })
    }
    if (!out.length) return
    const names = new Map(out.map(model => [model.id, typeof model.name === "string" && model.name ? model.name : model.id]))
    const key = [...names.keys()].sort().join("\n")
    if (key === this.acpOfferedKey) return
    this.acpOfferedModels = names
    this.acpOfferedKey = key
    if (this.cachedModelCatalog?.agyPath) {
      this.#saveCatalog(this.cachedModelCatalog.agyPath, { offered: [...names].map(([id, name]) => ({ id, name })) })
    }
  }

  #withOffered(list) {
    if (!this.acpOfferedModels) return list
    const covered = new Set(list.flatMap(model => [model.id, modelFamilyId(model)]))
    return [...list, ...[...this.acpOfferedModels].filter(([id]) => !covered.has(id)).map(([id, name]) => ({ id, name }))]
  }

  #offeredFilter(list) {
    if (!this.acpOfferedModels) return list.filter(model => /^gemini-/i.test(model.id))
    return this.#withOffered(list.filter(model => this.acpOfferedModels.has(model.id) ||
      (modelFamilyId(model) && this.acpOfferedModels.has(modelFamilyId(model)))))
  }

  #catalogOf(entry) {
    if (entry.offeredKey !== this.acpOfferedKey || !entry.catalog) {
      entry.catalog = buildModelCatalog(this.#offeredFilter(entry.list))
      entry.catalog.routing = buildModelCatalog(this.#withOffered(entry.list))
      entry.offeredKey = this.acpOfferedKey
    }
    return entry.catalog
  }

  async #probeOfferedModels(agyPath) {
    const gen = this.offeredGen
    let workspace = null
    let child = null
    let conn = null
    let timer
    try {
      workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magpie-agy-models-"))
      child = spawnAgy(agyPath, ["acp"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      child.on("error", () => conn?.close(new Error("agy acp failed to start")))
      child.on("close", () => conn?.close(new Error("agy acp exited")))
      child.stdin?.on("error", () => {})
      child.stderr?.resume?.()
      conn = new ProbeConnection(child)
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("agy acp model probe timed out")), OFFERED_PROBE_TIMEOUT_MS)
        timer.unref?.()
      })
      await Promise.race([deadline, (async () => {
        const init = await conn.request("initialize", {
          protocolVersion: 1,
          clientInfo: this.clientInfo,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        })
        if (agyTooOld(init?.agentInfo?.version ?? null)) return
        const session = await conn.request("session/new", { cwd: workspace, mcpServers: [] })
        if (gen === this.offeredGen) this.noteOfferedModels(session?.configOptions, session?.models)
        const caps = init?.agentCapabilities ?? {}
        if (session?.sessionId && (caps.sessionCapabilities?.close ?? caps.session_capabilities?.close)) {
          await conn.request("session/close", { sessionId: session.sessionId }).catch(() => {})
        }
      })()])
    } catch {
    } finally {
      clearTimeout(timer)
      conn?.close(new Error("probe done"))
      if (child) {
        try { child.stdin?.end() } catch {}
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32" && child.pid) {
            execOnce("taskkill", ["/T", "/F", "/PID", String(child.pid)], { timeoutMs: 3_000, unrefTimer: true }).catch(() => {})
          } else {
            try { child.kill("SIGTERM") } catch {}
          }
        }
      }
      if (workspace) fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => {})
    }
  }

  probeOfferedOnce(agyPath) {
    if (this.acpOfferedModels || this.offeredProbePromise) return this.offeredProbePromise
    const now = Date.now()
    if (this.offeredProbeAt !== null && now - this.offeredProbeAt < OFFERED_PROBE_RETRY_MS) return null
    this.offeredProbeAt = now
    const probe = this.#probeOfferedModels(agyPath).finally(() => {
      if (this.offeredProbePromise === probe) this.offeredProbePromise = null
    })
    this.offeredProbePromise = probe
    return probe
  }

  async #listAgyModels(agyPath) {
    if (await backgroundBlocked()) return null
    const { err, stdout, code, timedOut } = await execOnce(agyPath, ["models"], { timeoutMs: 15_000, unrefTimer: true })
    if (err || timedOut || code !== 0) return null
    return parseAgyModels(stdout)
  }

  async probeSignedIn(agyPath) {
    const blocked = await backgroundBlocked({ fresh: true })
    if (blocked) return { ok: false, why: blocked }
    const probe = await execOnce(agyPath, ["models"], { timeoutMs: 15_000 })
    const listed = !probe.err && !probe.timedOut && probe.code === 0 &&
      probe.stdout.split("\n").some(line => /^\S+\s+\S/.test(line.trim()))
    if (listed) {
      const list = parseAgyModels(probe.stdout)
      if (list) {
        this.useAgyPath(agyPath)
        this.storeListedCatalog(agyPath, list, Date.now())
        this.wantOfferedProbe = true
        await briefly(this.probeOfferedOnce(agyPath), 3_000)
      }
      return { ok: true }
    }
    const why = probe.timedOut
      ? "`agy models` timed out after 15s"
      : `\`agy models\` says: ${(probe.stderr || probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || probe.err?.message || `exit ${probe.code}`}`
    return { ok: false, why }
  }

  catalogWarming() {
    if (!this.modelCatalogRefreshPromise && !this.offeredProbePromise) return null
    return (async () => {
      if (this.modelCatalogRefreshPromise) await this.modelCatalogRefreshPromise.catch(() => {})
      if (this.offeredProbePromise) await this.offeredProbePromise.catch(() => {})
      return true
    })()
  }

  async loadModelCatalog(agyPath, { probeOffered = false } = {}) {
    this.useAgyPath(agyPath)
    if (probeOffered) this.wantOfferedProbe = true
    const current = this.cachedModelCatalog
    if (!agyPath) return this.#catalogOf(current)
    const now = Date.now()
    if (!current.isFallback && now - current.fetchedAt < MODEL_CATALOG_TTL_MS) {
      if (probeOffered) this.probeOfferedOnce(agyPath)
      return this.#catalogOf(current)
    }
    if (!this.modelCatalogRefreshPromise &&
      (current.lastAttemptAt === null || now - current.lastAttemptAt >= MODEL_CATALOG_RETRY_MS)) {
      current.lastAttemptAt = now
      const refresh = this.#listAgyModels(agyPath).then((list) => {
        if (list?.length && this.cachedModelCatalog === current) {
          this.storeListedCatalog(agyPath, list, current.lastAttemptAt)
          if (this.wantOfferedProbe) this.probeOfferedOnce(agyPath)
        }
      }).catch(() => {}).finally(() => {
        if (this.modelCatalogRefreshPromise === refresh) this.modelCatalogRefreshPromise = null
      })
      this.modelCatalogRefreshPromise = refresh
    }
    if (this.modelCatalogRefreshPromise) {
      await briefly(this.modelCatalogRefreshPromise, MODEL_CATALOG_FAST_WAIT_MS)
    }
    const probe = probeOffered && !this.cachedModelCatalog.isFallback && this.cachedModelCatalog.fetchedAt > 0
      ? this.probeOfferedOnce(agyPath)
      : null
    if (probe) await briefly(probe, MODEL_CATALOG_FAST_WAIT_MS)
    return this.#catalogOf(this.cachedModelCatalog)
  }
}

export function formatProviderModels(catalog) {
  const out = {}
  for (const model of catalog.models) {
    const imageModel = /^(?:gemini-|claude-)/.test(model.id)
    out[model.id] = {
      id: model.id,
      name: model.name,
      npm: "@ai-sdk/anthropic",
      limit: modelLimits(model.id),
      api: { id: model.id, url: "agy://local", npm: "@ai-sdk/anthropic" },
      capabilities: {
        ...(imageModel ? { attachment: true, input: { text: true, image: true }, output: { text: true } } : {}),
        ...(model.variants ? { reasoning: true } : {}),
      },
      ...(model.variants ? {
        reasoning: true,
        variants: Object.fromEntries(model.variants.map(effort => [effort, {}])),
      } : {}),
    }
  }
  return out
}

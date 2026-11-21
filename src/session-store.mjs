import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { withStateLockSync, writePrivateAtomicSync } from "./state-security.mjs"

const DEFAULT_MAX_CHECKPOINTS = 128
const DEFAULT_MAX_PER_CONV = 8
const DEFAULT_RESUME_TTL_MS = 24 * 60 * 60 * 1000

export function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex")
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// Durable checkpoint store keyed by agy sessionId (never deleted on read or
// turn start). Allows multiple concurrent branches per convKey so side-calls
// (memory extraction, artifact provenance, title generation) never overwrite
// the primary conversation's checkpoint.
export class CheckpointStore {
  constructor(filePath, opts = {}) {
    this.filePath = filePath
    this.maxCheckpoints = positiveInt(opts.maxCheckpoints, DEFAULT_MAX_CHECKPOINTS)
    this.maxPerConv = positiveInt(opts.maxPerConv, DEFAULT_MAX_PER_CONV)
    this.resumeTtlMs = positiveInt(opts.resumeTtlMs, DEFAULT_RESUME_TTL_MS)
    this.entries = new Map() // sessionId -> entry
    this.loaded = false
  }

  #validEntry(entry, now = Date.now()) {
    return Boolean(
      entry &&
      typeof entry.sessionId === "string" && entry.sessionId &&
      typeof entry.convKey === "string" && entry.convKey &&
      typeof entry.historyHash === "string" &&
      typeof entry.instructionsHash === "string" &&
      Number.isFinite(entry.at) &&
      now - entry.at <= this.resumeTtlMs,
    )
  }

  #readDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"))
      if (raw?.version !== 2 || !Array.isArray(raw.entries)) return []
      return raw.entries
    } catch {
      return []
    }
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    const now = Date.now()
    for (const entry of this.#readDisk()) {
      if (!this.#validEntry(entry, now)) continue
      const prev = this.entries.get(entry.sessionId)
      if (!prev || prev.at < entry.at) this.entries.set(entry.sessionId, entry)
    }
  }

  #pruneMap(map, now = Date.now()) {
    for (const [id, entry] of map) {
      if (!this.#validEntry(entry, now)) map.delete(id)
    }
    // Enforce per-convKey cap, preferring primary entries and newest timestamps.
    const byConv = new Map()
    for (const entry of map.values()) {
      let list = byConv.get(entry.convKey)
      if (!list) {
        list = []
        byConv.set(entry.convKey, list)
      }
      list.push(entry)
    }
    for (const list of byConv.values()) {
      if (list.length <= this.maxPerConv) continue
      list.sort((a, b) => {
        if (a.role !== b.role) return a.role === "primary" ? -1 : 1
        return b.at - a.at
      })
      for (const drop of list.slice(this.maxPerConv)) {
        map.delete(drop.sessionId)
      }
    }
    if (map.size <= this.maxCheckpoints) return
    const ordered = [...map.values()].sort((a, b) => {
      if (a.role !== b.role) return a.role === "primary" ? -1 : 1
      return b.at - a.at
    })
    for (const drop of ordered.slice(this.maxCheckpoints)) {
      map.delete(drop.sessionId)
    }
  }

  #flush() {
    try {
      withStateLockSync(this.filePath, () => {
        const now = Date.now()
        const merged = new Map()
        for (const entry of this.#readDisk()) {
          if (this.#validEntry(entry, now)) merged.set(entry.sessionId, entry)
        }
        for (const [id, entry] of this.entries) {
          if (!this.#validEntry(entry, now)) continue
          const prev = merged.get(id)
          if (!prev || prev.at <= entry.at) merged.set(id, entry)
        }
        this.#pruneMap(merged, now)
        const out = [...merged.values()].sort((a, b) => a.at - b.at)
        writePrivateAtomicSync(this.filePath, JSON.stringify({ version: 2, entries: out }) + "\n")
        this.entries = merged
      })
    } catch {}
  }

  upsert(record) {
    if (!record?.sessionId || !record?.convKey || !record?.historyHash) return
    this.load()
    const now = Date.now()
    const prev = this.entries.get(record.sessionId)
    const entry = {
      sessionId: record.sessionId,
      convKey: record.convKey,
      outerSession: record.outerSession || prev?.outerSession || "",
      historyHash: record.historyHash,
      historyHashSansInputs: record.historyHashSansInputs || "",
      collapsedHistoryHash: record.collapsedHistoryHash || "",
      collapsedHistoryHashSansInputs: record.collapsedHistoryHashSansInputs || "",
      toolUseIdentitiesHash: record.toolUseIdentitiesHash || "",
      historyLength: Number.isFinite(record.historyLength) ? record.historyLength : 0,
      instructionsHash: record.instructionsHash,
      workDir: record.workDir ?? null,
      workspace: typeof record.workspace === "string" && record.workspace ? record.workspace : null,
      model: record.model || prev?.model || "",
      role: record.role === "branch" ? "branch" : "primary",
      createdAt: prev?.createdAt || now,
      at: now,
    }
    this.entries.set(entry.sessionId, entry)
    this.#pruneMap(this.entries, now)
    this.#flush()
  }

  invalidate(sessionId) {
    if (!sessionId) return
    this.load()
    if (!this.entries.has(sessionId)) return
    this.entries.delete(sessionId)
    try {
      withStateLockSync(this.filePath, () => {
        const now = Date.now()
        const merged = new Map()
        for (const entry of this.#readDisk()) {
          if (entry.sessionId !== sessionId && this.#validEntry(entry, now)) {
            merged.set(entry.sessionId, entry)
          }
        }
        for (const [id, entry] of this.entries) {
          if (id !== sessionId && this.#validEntry(entry, now)) {
            const prev = merged.get(id)
            if (!prev || prev.at <= entry.at) merged.set(id, entry)
          }
        }
        this.#pruneMap(merged, now)
        writePrivateAtomicSync(this.filePath, JSON.stringify({ version: 2, entries: [...merged.values()] }) + "\n")
        this.entries = merged
      })
    } catch {}
  }

  findMatches(query) {
    this.load()
    const now = Date.now()
    const out = []
    for (const entry of this.entries.values()) {
      if (!this.#validEntry(entry, now)) continue
      if (query.excludeSessionIds?.has(entry.sessionId)) continue
      const keyMatch = entry.convKey === query.convKey ||
        (query.outerSession && entry.outerSession && entry.outerSession === query.outerSession)
      if (!keyMatch) continue
      if ((entry.workDir ?? null) !== (query.workDir ?? null)) continue
      if (entry.instructionsHash !== query.instructionsHash) continue
      const exact = entry.historyHash === query.historyHash ||
        (Boolean(query.collapsedHistoryHash) && Boolean(entry.collapsedHistoryHash) &&
          entry.collapsedHistoryHash === query.collapsedHistoryHash)
      const sans = !exact && Boolean(query.toolUseIdentitiesHash) &&
        entry.toolUseIdentitiesHash === query.toolUseIdentitiesHash &&
        (entry.historyHashSansInputs === query.historyHashSansInputs ||
          (Boolean(query.collapsedHistoryHashSansInputs) && Boolean(entry.collapsedHistoryHashSansInputs) &&
            entry.collapsedHistoryHashSansInputs === query.collapsedHistoryHashSansInputs))
      if (!exact && !sans) continue
      out.push({ entry, exact })
    }
    out.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1
      if (a.entry.role !== b.entry.role) return a.entry.role === "primary" ? -1 : 1
      return b.entry.at - a.entry.at
    })
    return out.map((item) => item.entry)
  }

  findPrefixCandidates(query) {
    this.load()
    const now = Date.now()
    const out = []
    const maxLen = Number(query.historyLength) || 0
    if (maxLen <= 1) return out
    for (const entry of this.entries.values()) {
      if (!this.#validEntry(entry, now)) continue
      if (query.excludeSessionIds?.has(entry.sessionId)) continue
      const keyMatch = entry.convKey === query.convKey ||
        (query.outerSession && entry.outerSession && entry.outerSession === query.outerSession)
      if (!keyMatch) continue
      if ((entry.workDir ?? null) !== (query.workDir ?? null)) continue
      if (entry.instructionsHash !== query.instructionsHash) continue
      if (!(entry.historyLength > 0 && entry.historyLength < maxLen)) continue
      out.push(entry)
    }
    out.sort((a, b) => {
      if (a.role !== b.role) return a.role === "primary" ? -1 : 1
      if (a.historyLength !== b.historyLength) return b.historyLength - a.historyLength
      return b.at - a.at
    })
    return out
  }

  // Returns true when any active/stored primary checkpoint exists for convKey/outerSession
  // at a different history state (so an incoming diverging non-tool or side-call query
  // should isolate itself in a branch slot rather than stealing/mutating the primary).
  hasPrimary(convKey, outerSession = "") {
    this.load()
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (!this.#validEntry(entry, now) || entry.role !== "primary") continue
      if (entry.convKey === convKey || (outerSession && entry.outerSession === outerSession)) return true
    }
    return false
  }

  size() {
    this.load()
    return this.entries.size
  }
}

// Completed-turn response cache (dedupes exact client/gateway HTTP retries
// after a final reply already delivered, preventing duplicate runs/tool loops).
export class CompletedTurnCache {
  constructor(maxEntries = 128, ttlMs = 5 * 60 * 1000, maxReplyBytes = 512 * 1024) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.maxReplyBytes = maxReplyBytes
    this.map = new Map()
  }

  get(key) {
    const item = this.map.get(key)
    if (!item) return null
    if (Date.now() - item.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    this.map.delete(key)
    this.map.set(key, item)
    return item
  }

  set(key, payload) {
    if (!key || !payload) return
    const bytes = Buffer.byteLength(JSON.stringify(payload.content ?? ""), "utf8")
    if (bytes > this.maxReplyBytes) return
    this.map.delete(key)
    this.map.set(key, { ...payload, at: Date.now() })
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value)
    }
  }
}

export function checkpointPathForStateDir(stateDir) {
  return path.join(stateDir, "checkpoints.json")
}

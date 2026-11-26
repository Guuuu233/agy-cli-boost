import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { instance } from "./instance.mjs"

// The default instance keeps its old dir; another instance (instance.mjs)
// gets its own, so it never shares a daemon, key or checkpoints with it.
export function defaultStateDir(env = process.env) {
  if (env.AGY_BOOST_STATE_DIR) return path.resolve(env.AGY_BOOST_STATE_DIR)
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  const own = instance(env)
  return path.join(base, own.isDefault ? "magpie-agy-cli-boost" : `magpie-agy-cli-boost-${own.id}`)
}

export function assertNoSymlinkPath(targetPath, finalKind = "any") {
  const target = path.resolve(targetPath)
  const drive = target.match(/^[A-Za-z]:\\/)
  let current = drive ? drive[0] : path.sep
  const rest = drive ? target.slice(drive[0].length) : target
  for (const part of rest.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let st
    try {
      st = fs.lstatSync(current)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    if (st.isSymbolicLink()) {
      throw new Error(`agy-cli-boost state path contains a symlink: ${current}`)
    }
    const isFinal = current === target
    if (!isFinal && !st.isDirectory()) {
      throw new Error(`agy-cli-boost state path ancestor is not a directory: ${current}`)
    }
    if (isFinal && finalKind === "directory" && !st.isDirectory()) {
      throw new Error(`agy-cli-boost state path is not a directory: ${current}`)
    }
    if (isFinal && finalKind === "file" && !st.isFile()) {
      throw new Error(`agy-cli-boost state path is not a regular file: ${current}`)
    }
  }
}

export function ensurePrivateDirSync(dirPath) {
  assertNoSymlinkPath(dirPath, "directory")
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(dirPath, "directory")
  try {
    fs.chmodSync(dirPath, 0o700)
  } catch {}
  return dirPath
}

export function readPrivateFileSync(filePath) {
  assertNoSymlinkPath(filePath, "file")
  const st = fs.lstatSync(filePath)
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`state file must be a regular file: ${filePath}`)
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`state file must be private (0600): ${filePath}`)
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`state file is not owned by the current user: ${filePath}`)
  }
  return fs.readFileSync(filePath, "utf8")
}

export function writePrivateAtomicSync(filePath, content) {
  ensurePrivateDirSync(path.dirname(filePath))
  assertNoSymlinkPath(filePath, "file")
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  assertNoSymlinkPath(temp, "file")
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 })
    fs.renameSync(temp, filePath)
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== "ESRCH"
  }
}

// Short-lived exclusive lockfile for state mutations across concurrent processes.
export function withStateLockSync(targetFile, fn) {
  const lock = `${targetFile}.lock`
  ensurePrivateDirSync(path.dirname(targetFile))
  let fd = null
  const waitBuf = typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        fd = fs.openSync(lock, "wx", 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
        break
      } catch (error) {
        if (error?.code !== "EEXIST") break
        try {
          const stat = fs.statSync(lock)
          if (Date.now() - stat.mtimeMs > 5_000) {
            const owner = JSON.parse(fs.readFileSync(lock, "utf8"))
            if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && !isProcessAlive(owner.pid)) {
              fs.unlinkSync(lock)
              continue
            }
            if (Date.now() - stat.mtimeMs > 15_000) {
              fs.unlinkSync(lock)
              continue
            }
          }
        } catch {}
        if (waitBuf) Atomics.wait(waitBuf, 0, 0, 10)
      }
    }
    if (fd === null) return undefined
    return fn()
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lock) } catch {}
    }
  }
}

export function newTokenHex(bytes = 32) {
  return randomBytes(bytes).toString("hex")
}

export function newShortId(prefix = "id") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

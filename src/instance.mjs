import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// One copy of this plugin is one instance: the provider id magpie lists it
// under, and the HOME its agy runs with. agy keeps its Google sign-in, its
// sessions and its caches under $HOME/.gemini (on Linux the sign-in is the
// file .gemini/antigravity-cli/antigravity-oauth-token), so a second copy
// with its own id and HOME is a second account, with its own daemon and
// state dir, that shares nothing with the first.
//
// instance.json next to package.json sets it:
//   { "id": "agy-cli-2", "name": "Antigravity 2 (agy CLI)", "agyHome": "/home/me/agy-accounts/2" }
// Without the file this is the "agy-cli" instance, as before: same id, same
// state dir, agy with the user's own HOME.
//
// On macOS and Windows agy keeps the sign-in in the system keyring, which a
// HOME of its own doesn't change: there two instances share one account.

export const DEFAULT_ID = "agy-cli"
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const cache = new Map()

export function instanceFile(env = process.env, root = PACKAGE_ROOT) {
  return env.AGY_BOOST_INSTANCE_FILE || path.join(root, "instance.json")
}

// { id, name, agyHome, isDefault, file }. A file that is there but wrong
// throws: going on as "agy-cli" would put a second copy on the first one's
// provider, state dir and account.
export function readInstance(file = instanceFile()) {
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return { id: DEFAULT_ID, name: null, agyHome: null, isDefault: true, file: null }
    throw new Error(`agy-cli-boost: can't read ${file}: ${error.message}`)
  }
  let value
  try { value = JSON.parse(raw) } catch (error) {
    throw new Error(`agy-cli-boost: ${file} is not JSON: ${error.message}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`agy-cli-boost: ${file} must hold a JSON object`)
  const id = value.id ?? DEFAULT_ID
  if (typeof id !== "string" || !ID.test(id)) {
    throw new Error(`agy-cli-boost: ${file}: "id" must be lowercase letters, digits and "-" (at most 40), like "agy-cli-2"`)
  }
  const name = value.name == null ? null : String(value.name).trim() || null
  let agyHome = null
  if (value.agyHome != null) {
    if (typeof value.agyHome !== "string" || !path.isAbsolute(value.agyHome)) {
      throw new Error(`agy-cli-boost: ${file}: "agyHome" must be an absolute path`)
    }
    agyHome = path.resolve(value.agyHome)
    fs.mkdirSync(agyHome, { recursive: true, mode: 0o700 })
  }
  return { id, name, agyHome, isDefault: id === DEFAULT_ID && !agyHome, file }
}

// This copy's instance, read once per file.
export function instance(env = process.env) {
  const file = instanceFile(env)
  if (!cache.has(file)) cache.set(file, readInstance(file))
  return cache.get(file)
}

// The HOME agy runs with: the instance's own, else the user's.
export function agyHomeOf(fallback, env = process.env) {
  return instance(env).agyHome || fallback
}

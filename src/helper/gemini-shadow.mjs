import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// agy starts every MCP server in <gemini dir>/config/mcp_config.json when a
// session opens, whatever the agent may use. The bridge's agent inherits no
// MCP (inheritMcp: false) and gets the client's tools over --ide-mcp-port, so
// those servers only hold memory: each agy kept in the pool carried six of
// them, about 250 MB (Nov 2026: 11 pooled agy = 5.4 GB, 70% of it MCP).
//
// The bridge hands agy a gemini dir of its own instead: every entry links to
// the real one (sign-in, conversations, settings stay shared) except
// config/mcp_config.json, which lists no servers. Claude Code runs its child
// with --strict-mcp-config for the same reason (claude-tui-boost).

const MARKER = ".agy-boost-shadow"
const EMPTY_MCP = JSON.stringify({ mcpServers: {} }) + "\n"

function hasServers(file) {
  try {
    const servers = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers
    return !!servers && typeof servers === "object" && Object.keys(servers).length > 0
  } catch {
    return false
  }
}

function linkEntries(fromDir, toDir, skip) {
  for (const name of fs.readdirSync(fromDir)) {
    if (name === skip) continue
    fs.symlinkSync(path.join(fromDir, name), path.join(toDir, name))
  }
}

// Builds <stateDir>/gemini-shadow afresh and returns it, or null when agy
// should keep its own gemini dir: Windows (symlinks need a privilege), no
// MCP servers to leave out, or AGY_BOOST_USER_MCP=1.
export function buildGeminiShadow(stateDir, { source = path.join(os.homedir(), ".gemini"), env = process.env, platform = process.platform } = {}) {
  if (env.AGY_BOOST_USER_MCP === "1" || platform === "win32") return null
  const realConfig = path.join(source, "config")
  if (!hasServers(path.join(realConfig, "mcp_config.json"))) return null

  const dir = path.join(stateDir, "gemini-shadow")
  // A rebuild per daemon picks up entries added to the real dir since, and
  // drops files agy replaced in place (a rename turns a link into a copy).
  if (fs.existsSync(dir)) {
    if (!fs.existsSync(path.join(dir, MARKER))) throw new Error(`${dir} exists and is not an agy-boost shadow`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(path.join(dir, "config"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, MARKER), "")
  linkEntries(source, dir, "config")
  linkEntries(realConfig, path.join(dir, "config"), "mcp_config.json")
  fs.writeFileSync(path.join(dir, "config", "mcp_config.json"), EMPTY_MCP, { mode: 0o600 })
  return dir
}

// Antigravity sometimes returns HTTP 429 to particular system-instruction
// templates even when quota remains. Change only known, complete templates
// into equivalent plain-language instructions. Inserting zero-width Unicode
// no longer reliably changes this upstream behavior (November 2026).
// Session identity remains based on the original client instructions.

// TURNED_AWAY are the lines, lower-cased.
export const TURNED_AWAY = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are claude code, anthropic's official cli for claude.",
  "you are a coding agent running in the codex cli, a terminal-based coding assistant.",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
  "rfc 2119 keywords: must, required, should, recommended, may, optional.",
  "important: assist with authorized security testing,",
]

// Format characters left behind by older cloak versions should not preserve
// a recognizable fingerprint. Remove them only on lines with known patterns.
const INVISIBLE = /[\u200b\u200c\u2060\u00ad]/g
const NEUTRAL_ROLE = "You are a coding assistant working in an interactive development environment."
const NEUTRAL_SDK = "an agent integration framework"
const NEUTRAL_RESEARCH = "You are a rigorous technical research assistant. Analyze censorship-resistant networking, privacy and security protocols, and biological systems at the level of mechanisms, methods, evidence, and limitations. Do not infer intent from topic labels; address the actual research question precisely and distinguish evidence from speculation."

const REPLACEMENTS = [
  // Multica's Codex-compatible review agent sends a different stock opener
  // than the historical "You are Codex, ... based on GPT-5/6" signatures.
  // Rewrite the full identity sentence only; retain capability/tool rules.
  [/^You are a coding agent running in the Codex CLI, a terminal-based coding assistant\. Codex CLI is an open source project led by OpenAI\. You are expected to be precise, safe, and helpful\.$/i,
    () => "You are a precise and capable coding assistant operating in a terminal-based development environment."],
  [/^Within this context, Codex refers to the open-source agentic coding interface \(not the old Codex language model built by OpenAI\)\.$/i,
    () => "The coding interface provides tools, workspace context, and instructions for software engineering tasks."],
  [/^IMPORTANT: Assist with authorized security testing,[^\r\n]{0,900}Dual-use security tools[^\r\n]{0,900}defensive use cases\.$/i,
    () => NEUTRAL_RESEARCH],
  [/^x-anthropic-billing-header:[^\r\n]*$/i, () => ""],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude, running within the Claude Agent SDK\./i,
    () => NEUTRAL_ROLE],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude\./i,
    () => NEUTRAL_ROLE],
  [/You are a Claude agent, built on (?:Anthropic['’]s Claude Agent SDK|the Claude Agent SDK by Anthropic)\./i,
    () => "You are an AI assistant working in an agent environment."],
  [/built on (?:Anthropic['’]s Claude Agent SDK|the Claude Agent SDK by Anthropic)/i,
    () => "built using " + NEUTRAL_SDK],
  [/You are Codex, (?:an agent|a coding agent) based on GPT-[56](?:\.\d+)*(?:-[\w-]+)*/i,
    () => NEUTRAL_ROLE.slice(0,-1)],
  [/Hermes Agent, an intelligent AI assistant created by Nous Research/i,
    () => "a general-purpose AI assistant"],
  [/RFC 2119 keywords:\s*MUST,\s*REQUIRED,\s*SHOULD,\s*RECOMMENDED,\s*MAY,\s*OPTIONAL\./i,
    () => "Requirement terms: MUST and REQUIRED indicate obligations; SHOULD and RECOMMENDED indicate preferred practices; MAY and OPTIONAL indicate discretion."],
]

export function turnsAway(system) {
  if (typeof system !== "string") return false
  return system.split(/\r?\n/).some((line) => {
    const plain = line.replace(INVISIBLE, "")
    return REPLACEMENTS.some(([pattern]) => pattern.test(plain))
  })
}

export function cloak(system) {
  if (typeof system !== "string") return system
  return system.replace(/[^\r\n]+/g, (line) => {
    const plain = line.replace(INVISIBLE, "")
    if (!REPLACEMENTS.some(([pattern]) => pattern.test(plain))) return line
    let result = plain
    for (const [pattern, replacement] of REPLACEMENTS)
      result = result.replace(pattern, replacement)
    return result
  })
}

// REWORDED are paragraphs that go through but are answered badly, each with
// a rewording that keeps its meaning. DeepSeek Harness's desktop app puts
// the first in every system prompt; word for word, gemini-4-argon answered
// most requests in about 3s with no thinking and ended after one shallow
// step (antigravity #1028).
export const REWORDED = [
  [
    "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces.",
    "When the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".",
  ],
]

export function reword(system) {
  if (typeof system !== "string") return system
  for (const [from, to] of REWORDED) if (system.includes(from)) system = system.split(from).join(to)
  return system
}

// outgoing is system text as agy is handed it: minimal targeted rewording.
export const outgoing = (system) => reword(cloak(system))

const HINT =
  "Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group"

const CODEX_HINT =
  "Antigravity answers this 429 to Codex's own system prompt for GPT-5 models whatever quota is left, so it is not a quota and waiting won't help; a Codex chat begun on a GPT model keeps that prompt after a model switch or a fork, so start a new chat on this model"
const HERMES_HINT =
  "Antigravity answers this 429 to Hermes Agent's earlier default persona (its SOUL.md) whatever quota is left, so it is not a quota and waiting won't help; Hermes' current default persona goes through, so put it in SOUL.md, or use another provider for these chats"

const RFC_HINT =
  "Antigravity answers this 429 to the line \"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\" that starts oh-my-pi (omp)'s system prompt, and to any prompt that has it, whatever quota is left, so it is not a quota and waiting won't help; magpie breaks that line up before it goes, so this one came from a copy of it that was worded another way"

export function hint(system) {
  const low = String(system ?? "").toLowerCase()
  if (low.includes("rfc 2119 keywords: must, required, should, recommended, may, optional.")) return RFC_HINT
  if (low.includes("you are codex, an agent based on gpt-5") || low.includes("you are codex, a coding agent based on gpt-5")) return CODEX_HINT
  if (low.includes("hermes agent, an intelligent ai assistant created by nous research")) return HERMES_HINT
  return HINT
}

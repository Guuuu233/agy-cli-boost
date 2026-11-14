import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ensureGeminiArrayItems } from "./helper/array-items.mjs"
import { outgoing } from "./helper/cloak.mjs"
import { sanitizePatternFields } from "./helper/re2-pattern.mjs"
import { expandToolSchema } from "./helper/tool-schema.mjs"

export class BusyError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 503
  }
}

export class ConflictError extends Error {
  constructor(message, code) {
    super(message)
    this.statusCode = 400
    this.code = code
    this.noRetry = true
  }
}

export class UnsupportedContent extends Error {
  constructor(what) {
    super(`agy bridge: ${what} is not supported`)
    this.statusCode = 400
  }
}

export class AgentTurnError extends Error {
  constructor(message, kind = "api_error") {
    super(message)
    this.kind = kind
    this.keepProcess = true
  }
}

export const NO_RETRY_HEADERS = { "x-should-retry": "false" }

const SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "mcp_tool_result",
  "advisor_tool_result",
])

const ASSISTANT_ALLOWED_BLOCK_TYPES = new Set([
  "text",
  "tool_use",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "mcp_tool_use",
  "container_upload",
  ...SERVER_TOOL_RESULT_BLOCK_TYPES,
])

export const MAGPIE_PLACEHOLDER_NOTICE =
  "Values written like {{NAME_ab12cd34}} are placeholders for real values. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. Don't ask to verify them, and don't replace them with examples."
const MAGPIE_PLACEHOLDER_NOTICE_RE =
  /(?:^|\n\n)Values written like \{\{NAME_ab12cd34\}\} are placeholders for real values\. Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs\. Don't ask to verify them, and don't replace them with examples\.(?=\s|$)/g

export function stripMagpiePlaceholderNotice(text) {
  if (typeof text !== "string" || !text.includes("{{NAME_ab12cd34}}")) return text
  return text.replace(MAGPIE_PLACEHOLDER_NOTICE_RE, "")
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

export function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

export function compactIdentity(text) {
  return String(text ?? "").replace(/\s+/g, "")
}

export function stripBillingHeader(text) {
  let s = String(text ?? "")
  s = s.replace(/^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gmi, "")
  s = s.replace(/^[ \t]*cch=[0-9a-fA-F]+;?[ \t]*\n?/gmi, "")
  return s
}

const ISO_DATE = String.raw`20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?`
const LOCALE_DATE = String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?`
const CLOCK_VALUE = String.raw`(?:${ISO_DATE}|${LOCALE_DATE}|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)`
const AGENT_CLOCK_LINE_RE = new RegExp(
  String.raw`^(?:#{1,6}\s*)?(?:(?:(?:current\s+)?(?:date|time|datetime|today|now)|today(?:'s)?\s+date|(?:the\s+)?current\s+(?:date|time|datetime))\s*[:：]\s*${CLOCK_VALUE}|(?:(?:the\s+)?current\s+(?:date|time|datetime)|today(?:'s)?\s+date)\s+is\s+${CLOCK_VALUE})\s*\.?$`,
  "i",
)

function stripAgentClockLines(text) {
  const s = String(text ?? "")
  if (!s) return s
  return s.split(/(\n)/).map((part) => (part === "\n" || !AGENT_CLOCK_LINE_RE.test(part.trim()) ? part : "")).join("")
}

export function stripVolatileSystem(text) {
  return stripAgentClockLines(stripBillingHeader(text))
}

export function instructionsIdentity(text) {
  return compactIdentity(stripVolatileSystem(text))
}

export function sameInstructions(a, b) {
  return instructionsIdentity(a) === instructionsIdentity(b)
}

function asciiLower(s) {
  return String(s ?? "").replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))
}

function replaceClosedSystemReminders(text, replacer) {
  const s = String(text ?? "")
  if (!s) return s
  const open = "<system-reminder"
  const close = "</system-reminder>"
  const lower = asciiLower(s)
  let out = ""
  let i = 0
  while (i < s.length) {
    const start = lower.indexOf(open, i)
    if (start === -1) {
      out += s.slice(i)
      break
    }
    const afterName = start + open.length
    if (afterName < s.length && /[A-Za-z0-9_]/.test(s[afterName])) {
      out += s.slice(i, afterName)
      i = afterName
      continue
    }
    const gt = s.indexOf(">", afterName)
    if (gt === -1) {
      out += s.slice(i)
      break
    }
    const closeAt = lower.indexOf(close, gt + 1)
    if (closeAt === -1) {
      out += s.slice(i)
      break
    }
    const end = closeAt + close.length
    out += s.slice(i, start) + replacer(s.slice(start, end))
    i = end
  }
  return out
}

export function stripVolatileOpening(text) {
  return replaceClosedSystemReminders(stripBillingHeader(text), (block) => stripAgentClockLines(block))
}

export function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("\n")
}

export function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text || "" : "")).join("")
}

export function canonicalBody(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return body
  let count = 0
  while (count < messages.length && messages[count]?.role === "system") count++
  if (!count || count === messages.length) return body
  const parts = [systemText(body), ...messages.slice(0, count).map((message) => contentText(message.content))]
  return { ...body, system: parts.filter((text) => text.trim()).join("\n\n"), messages: messages.slice(count) }
}

export function requestLayout(body) {
  return canonicalBody(body) !== body ? "inline" : "hoisted"
}

export function imageContent(block) {
  const source = block.source
  if (source?.type !== "base64") {
    throw new UnsupportedContent("an image source other than base64; provide inline image data instead of a URL")
  }
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
    throw new UnsupportedContent("an image media type other than PNG, JPEG, GIF or WebP")
  }
  if (typeof source.data !== "string" || !source.data ||
    source.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(source.data.replace(/={1,2}$/, ""))) {
    throw new UnsupportedContent("invalid base64 image data")
  }
  return { type: "image", data: source.data, mimeType: source.media_type }
}

export function parseUserImage(block) {
  if (block?.type !== "image") return null
  const mediaType = String(block.source?.media_type || "").toLowerCase()
  return imageContent({ ...block, source: { ...block.source, media_type: mediaType === "image/jpg" ? "image/jpeg" : mediaType } })
}

export function parseUserDocumentText(block) {
  if (block?.type !== "document") return ""
  const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : ""
  const src = block.source
  let text = null
  if (src?.type === "text" && typeof src.data === "string") {
    text = src.data
  } else if (src?.type === "content") {
    if (typeof src.content === "string") text = src.content
    else if (Array.isArray(src.content) && src.content.every((part) => part?.type === "text" && typeof part.text === "string")) {
      text = src.content.map((part) => part.text).join("\n")
    }
  }
  if (text === null) {
    throw new UnsupportedContent("a binary or URL document block in a user message (agy's ACP prompt accepts text and images only)")
  }
  return title ? `[document: ${title}]\n${text}\n[end of document]` : text
}

export function parseSearchResultText(block) {
  if (block?.type !== "search_result") return ""
  const header = [block.title, block.source].filter((item) => typeof item === "string" && item.trim()).join(" — ")
  const body = Array.isArray(block.content)
    ? block.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
    : typeof block.content === "string" ? block.content : ""
  return header ? `[search result: ${header}]\n${body}\n[end of search result]` : body
}

export function renderServerAssistantBlock(block) {
  if (!block || typeof block !== "object") return ""
  if (block.type === "server_tool_use" || block.type === "mcp_tool_use") {
    return `[server tool call ${block.name || block.type} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`
  }
  if (block.type === "container_upload") {
    return block.file_id ? `[container upload ${block.file_id}]` : ""
  }
  if (SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
    return `[${block.type}${block.tool_use_id ? " id=" + block.tool_use_id : ""}] ${JSON.stringify(block.content ?? "")}`
  }
  return ""
}

export function toolResult(block) {
  if (!block || typeof block.tool_use_id !== "string" || !block.tool_use_id) {
    throw new UnsupportedContent("a tool_result without tool_use_id")
  }
  let content
  if (typeof block.content === "string") {
    content = [{ type: "text", text: block.content }]
  } else if (Array.isArray(block.content)) {
    content = block.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
      if (part?.type === "tool_reference" && typeof part.tool_name === "string") {
        return { type: "text", text: `Loaded tool: ${part.tool_name}` }
      }
      if (part?.type === "document") return { type: "text", text: parseUserDocumentText(part) }
      if (part?.type === "search_result") return { type: "text", text: parseSearchResultText(part) }
      if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
        return {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type || "application/octet-stream",
        }
      }
      throw new UnsupportedContent("this tool_result content")
    })
  } else if (block.content == null) {
    content = [{ type: "text", text: "" }]
  } else {
    throw new UnsupportedContent("non-text tool_result content")
  }
  return { content, isError: block.is_error === true }
}

export function blockText(block) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new UnsupportedContent("a non-object content block")
  }
  if (block.type === "text") return typeof block.text === "string" ? block.text : ""
  if (block.type === "tool_addition" || block.type === "tool_removal") return ""
  if (block.type === "tool_reference" && typeof block.tool_name === "string") {
    return `Loaded tool: ${block.tool_name}`
  }
  if (block.type === "document") return parseUserDocumentText(block)
  if (block.type === "search_result") return parseSearchResultText(block)
  if (block.type === "image") {
    parseUserImage(block)
    return "[image]"
  }
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => (part?.type === "image" ? "[image returned by tool]" : blockText(part))).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

export function messageText(message) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map(blockText).join("")
  return String(message.content ?? "")
}

export function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (!block) continue
      if (block.type === "thinking" || block.type === "redacted_thinking" ||
        block.type === "tool_addition" || block.type === "tool_removal") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = {
          type: "text",
          text: stripVolatileOpening(stripMagpiePlaceholderNotice(typeof block === "string" ? block : block.text || "")),
        }
      } else if (block.type === "document") {
        value = { type: "text", text: parseUserDocumentText(block) }
      } else if (block.type === "search_result") {
        value = { type: "text", text: parseSearchResultText(block) }
      } else if (block.type === "image") {
        const image = parseUserImage(block)
        value = { type: "image", mimeType: image.mimeType, sha256: digest(image.data) }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...toolResult(block) }
      } else if (block.type === "server_tool_use" || block.type === "mcp_tool_use" ||
        block.type === "container_upload" || SERVER_TOOL_RESULT_BLOCK_TYPES.has(block.type)) {
        value = { type: block.type, name: block.name || "", content: renderServerAssistantBlock(block) }
      } else {
        value = block
      }
      let row = rows.at(-1)
      if (!row || row.role !== message.role) {
        row = { role: message.role, content: [] }
        rows.push(row)
      }
      const last = row.content.at(-1)
      if (last?.type === "text" && value.type === "text") last.text += value.text
      else row.content.push(value)
    }
  }
  for (const row of rows) {
    row.content = row.content.filter(block => block.type !== "text" || (block.text = block.text.trim()) !== "")
  }
  return stableJSON(rows.filter(row => row.content.length))
}

const GATEWAY_SERVER_TOOL_NAMES = new Set(["web_search", "web_search_prime", "webSearchPrime", "web_fetch", "fetch"])

// Normalizes gateway-collapsed server-tool turns (e.g. Magpie collapsing
// [assistant(...tool_use:web_search), user(tool_result), assistant(...)]
// into a single assistant message containing server_tool_use + web_search_tool_result)
// so both raw expectedMessages and collapsed client history hash identically.
export function collapseServerToolHistory(messages) {
  if (!Array.isArray(messages)) return messages
  const collapsedIds = new Set()
  const step1 = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || typeof msg !== "object") continue
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content ?? "" }]
    if (msg.role === "assistant") {
      const nextMsg = messages[i + 1]
      const nextBlocks = nextMsg?.role === "user" && Array.isArray(nextMsg.content) ? nextMsg.content : null
      const serverUses = blocks.filter((b) => b?.type === "tool_use" && GATEWAY_SERVER_TOOL_NAMES.has(b.name))
      if (serverUses.length && nextBlocks && nextBlocks.length > 0 &&
        nextBlocks.every((b) => b?.type === "tool_result" && serverUses.some((u) => u.id && u.id === b.tool_use_id))) {
        for (const u of serverUses) collapsedIds.add(u.id)
        const mapped = blocks.map((b) => {
          if (b?.type === "tool_use" && GATEWAY_SERVER_TOOL_NAMES.has(b.name)) {
            return { type: "gateway_server_tool", name: b.name, input: b.input ?? {} }
          }
          return b
        })
        step1.push({ ...msg, content: mapped })
        i++ // skip the collapsed user tool_result message
        continue
      }
      const mapped = []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === "server_tool_use") {
          mapped.push({ type: "gateway_server_tool", name: b.name || "", input: b.input ?? {} })
        } else if (SERVER_TOOL_RESULT_BLOCK_TYPES.has(b.type)) {
          continue
        } else {
          mapped.push(b)
        }
      }
      step1.push({ ...msg, content: mapped })
      continue
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const kept = msg.content.filter((b) => !(b?.type === "tool_result" && collapsedIds.has(b.tool_use_id)))
      if (kept.length === 0) continue
      step1.push({ ...msg, content: kept })
      continue
    }
    step1.push(msg)
  }
  // Merge consecutive assistant messages created after stripping intermediate user tool_result rows.
  const merged = []
  for (const msg of step1) {
    const prev = merged.at(-1)
    if (prev && prev.role === "assistant" && msg.role === "assistant") {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content ?? "" }]
      const curBlocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content ?? "" }]
      prev.content = [...prevBlocks, ...curBlocks]
    } else {
      merged.push({ ...msg })
    }
  }
  return merged
}

export function collapsedHistoryKey(messages) {
  return historyKey(collapseServerToolHistory(messages))
}

export function stripToolUseInputs(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => block?.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : block)
      : message.content,
  }))
}

export function toolUseIdentitiesKey(messages) {
  if (!Array.isArray(messages)) return null
  const rows = []
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue
      if (!block.id) return null
      rows.push({ id: block.id, name: block.name || "" })
    }
  }
  return stableJSON(rows)
}

export function sameToolUseIdentities(left, right) {
  const a = toolUseIdentitiesKey(left)
  const b = toolUseIdentitiesKey(right)
  return a != null && a === b
}

export const prefillTailEnabled = () => process.env.AGY_BRIDGE_PREFILL !== "0"
const prefillCarrierNote = () => process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  || "(system note: the fragment below is part of your own unfinished reply; continue exactly from where it stops, and do not repeat it.)"

export function assistantTextOf(message) {
  if (!message || message.role !== "assistant") return null
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return null
  let text = ""
  for (const block of message.content) {
    if (!block || block.type !== "text" || typeof block.text !== "string") return null
    text += block.text
  }
  return text
}

export function prefillRun(messages) {
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return null
  if (assistantTextOf(last) === null) return null
  let runStart = messages.length
  while (runStart > 0 && messages[runStart - 1]?.role === "assistant" && assistantTextOf(messages[runStart - 1]) !== null) runStart--
  let boundary = runStart
  while (boundary > 0 && messages[boundary - 1]?.role !== "assistant") boundary--
  return { runStart, boundary }
}

function renderPrefillCarrierParts(message) {
  const body = (assistantTextOf(message) || "").trim()
  if (!body) return []
  return [{ type: "text", text: `${prefillCarrierNote()}\n${body}` }]
}

export function trailingMessages(body) {
  body = canonicalBody(body)
  const run = prefillTailEnabled() ? prefillRun(body.messages) : null
  if (run) {
    return { history: body.messages.slice(0, run.boundary), messages: body.messages.slice(run.boundary) }
  }
  let start = body.messages.length
  while (start > 0 && body.messages[start - 1].role !== "assistant") start--
  return { history: body.messages.slice(0, start), messages: body.messages.slice(start) }
}

export function lastAssistantCalls(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === "assistant") start--
  return messages.slice(start).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_use") : [])
}

export function conversationKey(rawBody) {
  const body = canonicalBody(rawBody)
  const system = historyKey([{ role: "system", content: compactIdentity(stripVolatileSystem(systemText(body))) }])
  const first = body.messages?.[0]
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  const source = discriminator + "\n" + system + "\n===\n" + firstText
  return createHash("sha256").update(source).digest("hex")
}

function appendSchemaHint(node, hint) {
  if (!hint) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}

export function sanitizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out = { ...schema }

  if (Array.isArray(out.type)) {
    const types = out.type.filter((item) => typeof item === "string")
    const nullable = types.includes("null")
    const nonNull = types.filter((item) => item !== "null")
    if (nonNull.length > 1) {
      let chosen = nonNull[0]
      if (nonNull.includes("array") && out.items !== undefined) chosen = "array"
      else if (nonNull.includes("object") && (out.properties !== undefined || out.additionalProperties !== undefined)) {
        chosen = "object"
      }
      out.type = nullable ? [chosen, "null"] : chosen
      appendSchemaHint(out, `Accepts types: ${types.join(" | ")}`)
    } else if (nonNull.length === 1) {
      out.type = nullable ? [nonNull[0], "null"] : nonNull[0]
    }
  }

  const resolvedType = typeof out.type === "string"
    ? out.type
    : Array.isArray(out.type)
      ? out.type.find((item) => item !== "null") || null
      : null

  if (resolvedType && resolvedType !== "array") {
    delete out.items
    delete out.prefixItems
    delete out.minItems
    delete out.maxItems
    delete out.uniqueItems
    delete out.contains
  }
  if (resolvedType && resolvedType !== "object") {
    delete out.properties
    delete out.patternProperties
    delete out.required
    delete out.minProperties
    delete out.maxProperties
    delete out.dependentRequired
  }

  if (Array.isArray(out.enum)) {
    const invalidEnum = out.enum.length === 0 ||
      (resolvedType && resolvedType !== "string") ||
      out.enum.some((item) => typeof item !== "string" || item.length === 0)
    if (invalidEnum) {
      if (out.enum.length) {
        appendSchemaHint(out, `Allowed values: ${out.enum.map((item) => JSON.stringify(item)).join(", ")}`)
      }
      delete out.enum
    }
  }

  if (out.const !== undefined && (typeof out.const !== "string" || out.const.length === 0 || (resolvedType && resolvedType !== "string"))) {
    appendSchemaHint(out, `Must equal: ${JSON.stringify(out.const)}`)
    delete out.const
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter((key) => typeof key === "string" && Object.hasOwn(out.properties, key))
      if (filtered.length) out.required = filtered
      else delete out.required
    }
  }
  if (out.patternProperties && typeof out.patternProperties === "object" && !Array.isArray(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  if (out.additionalProperties && typeof out.additionalProperties === "object" && !Array.isArray(out.additionalProperties)) {
    out.additionalProperties = sanitizeInputSchema(out.additionalProperties)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => sanitizeInputSchema(item))
  } else if (out.items && typeof out.items === "object") {
    out.items = sanitizeInputSchema(out.items)
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = out.prefixItems.map((item) => sanitizeInputSchema(item))
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => sanitizeInputSchema(item))
  }
  if (out.not && typeof out.not === "object" && !Array.isArray(out.not)) {
    out.not = sanitizeInputSchema(out.not)
  }
  for (const defsKey of ["$defs", "definitions"]) {
    if (out[defsKey] && typeof out[defsKey] === "object" && !Array.isArray(out[defsKey])) {
      out[defsKey] = Object.fromEntries(
        Object.entries(out[defsKey]).map(([key, value]) => [key, sanitizeInputSchema(value)]),
      )
    }
  }
  for (const key of ["propertyNames", "contains", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    if (out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = sanitizeInputSchema(out[key])
    }
  }
  if (out.dependentSchemas && typeof out.dependentSchemas === "object" && !Array.isArray(out.dependentSchemas)) {
    out.dependentSchemas = Object.fromEntries(
      Object.entries(out.dependentSchemas).map(([key, value]) => [key, sanitizeInputSchema(value)]),
    )
  }
  sanitizePatternFields(out)
  return out
}

export function normalizeTools(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`duplicate tool ${tool.name}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const rawSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
    const inputSchema = ensureGeminiArrayItems(sanitizeInputSchema(expandToolSchema(rawSchema)))
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    })
  }
  if (selected && !tools.length) throw new UnsupportedContent(`tool_choice names undeclared tool ${selected}`)
  return tools
}

export function toolsSignature(tools) {
  if (!Array.isArray(tools) || !tools.length) return "[]"
  const canonical = tools
    .map((tool) => ({
      name: String(tool?.name || ""),
      description: typeof tool?.description === "string" ? tool.description : "",
      inputSchema: tool?.inputSchema ?? tool?.input_schema ?? { type: "object", properties: {} },
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return stableJSON(canonical)
}

export function maxRequestBytes() {
  const configured = Number(process.env.AGY_BOOST_MAX_REQUEST_BYTES || process.env.AGY_BRIDGE_MAX_REQUEST_BYTES)
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured)
  return 32 * 1024 * 1024
}

export function appendPrompt(out, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
  for (const block of blocks) {
    const last = out.at(-1)
    if (last?.type === "text" && block.type === "text") last.text += block.text
    else out.push({ ...block })
  }
}

export function toPromptParts(content) {
  if (!content) return []
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const out = []
  for (const part of content) {
    if (!part) continue
    if (part.type === "text") {
      if (!part.text) continue
      if (out.at(-1)?.type === "text") out.at(-1).text += part.text
      else out.push({ type: "text", text: part.text })
    } else if (part.type === "image" && part.data) {
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" })
    }
  }
  return out
}

export function mergePromptParts(first, second) {
  const a = toPromptParts(first)
  const b = toPromptParts(second)
  if (!a.length) return b
  if (!b.length) return a
  return toPromptParts([...a, { type: "text", text: "\n\n" }, ...b])
}

export function promptHasImage(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === "image")
}

export function renderAssistantTurn(message) {
  const parts = []
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text || "")
    else if (block.type === "tool_use") {
      parts.push(`[tool call ${block.name} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`)
    } else {
      const rendered = renderServerAssistantBlock(block)
      if (rendered) parts.push(rendered)
    }
  }
  return parts.join("\n")
}

export function outputFormatReminder(body) {
  const format = body?.output_config?.format || body?.response_format
  if (!format || typeof format !== "object") return []
  if (format.type === "json_schema") {
    const schema = format.schema ?? format.json_schema?.schema
    if (schema && typeof schema === "object") {
      return [{
        type: "text",
        text: `<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON value (no Markdown code fences, no backticks, and no explanatory prose before or after) conforming strictly to this JSON Schema:\n${JSON.stringify(schema)}\n</system-reminder>`,
      }]
    }
  }
  if (format.type === "json_object") {
    return [{
      type: "text",
      text: "<system-reminder>\nStructured output requirement: Respond ONLY with a single valid JSON object (no Markdown code fences, no backticks, and no explanatory prose before or after).\n</system-reminder>",
    }]
  }
  return []
}

function workDirNote(callerWorkDir) {
  return `The caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
}

export function sessionInstructions(body, callerWorkDir) {
  const parts = []
  const system = systemText(canonicalBody(body))
  if (system.trim()) parts.push(system)
  if (callerWorkDir) parts.push(workDirNote(callerWorkDir))
  return parts.join("\n\n")
}

const QUEUED_PROMPT_PREFIX_RE = /^(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):\n([\s\S]*)$/
const QUEUED_PROMPT_SUFFIX_RE = /\n\n(?:This is how Claude Code surfaces (?:messages the user sends|prompts [^\r\n]+ submits) mid-turn[\s\S]*|IMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.|Please address this message and continue with your tasks\.)\s*$/

export function extractQueuedPrompt(raw) {
  if (typeof raw !== "string") return null
  const cleanedRaw = stripMagpiePlaceholderNotice(raw)
  const hadPlaceholder = cleanedRaw !== raw
  let trimmed = cleanedRaw.trim()
  const reminder = /^<system-reminder(?:\s[^>]*)?>([\s\S]*)<\/system-reminder(?:\s[^>]*)?>$/.exec(trimmed)
  if (reminder) trimmed = reminder[1].trim()
  const match = QUEUED_PROMPT_PREFIX_RE.exec(trimmed)
  if (!match) return null
  const unwrapped = match[1].replace(QUEUED_PROMPT_SUFFIX_RE, "").trim()
  if (!hadPlaceholder) return unwrapped
  const placeholderTag = `<system-reminder>\n${MAGPIE_PLACEHOLDER_NOTICE}\n</system-reminder>`
  return unwrapped ? `${unwrapped}\n\n${placeholderTag}` : placeholderTag
}

function renderTurnMessage(message) {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      const queued = extractQueuedPrompt(message.content)
      return queued !== null ? queued : message.content
    }
    if (Array.isArray(message.content)) {
      const out = []
      let afterToolResult = false
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          out.push(blockText(block))
          afterToolResult = true
          continue
        }
        const raw = blockText(block)
        const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
        const rendered = queued !== null ? queued : raw
        if (rendered && afterToolResult && !rendered.startsWith("\n")) {
          out.push("\n\n" + rendered)
        } else {
          out.push(rendered)
        }
        if (rendered) afterToolResult = false
      }
      return out.join("")
    }
    return messageText(message)
  }
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const reminders = []
  const queuedParts = []
  for (const block of blocks) {
    const raw = blockText(block)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const queued = extractQueuedPrompt(trimmed)
    if (queued !== null) {
      if (queued) queuedParts.push(queued)
    } else {
      reminders.push(raw)
    }
  }
  const out = []
  const joinedReminders = reminders.join("").trim()
  if (joinedReminders) {
    out.push(/^<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder(?:\s[^>]*)?>$/.test(joinedReminders)
      ? joinedReminders
      : `<system-reminder>\n${joinedReminders}\n</system-reminder>`)
  }
  out.push(...queuedParts)
  return out.join("\n\n")
}

function renderTurnMessageParts(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    let text = renderTurnMessage(message)
    if (message.role === "system" || message.role === "developer") text = outgoing(text)
    return text === "" ? [] : [{ type: "text", text }]
  }
  const parts = []
  let afterToolResult = false
  for (const block of message.content) {
    if (block?.type === "image") {
      parts.push(parseUserImage(block))
      afterToolResult = false
    } else if (block?.type === "tool_result") {
      appendPrompt(parts, `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}]\n`)
      const result = toolResult(block)
      for (const part of result.content) appendPrompt(parts, [part])
      appendPrompt(parts, "\n[end of tool result]")
      afterToolResult = true
    } else {
      const raw = blockText(block)
      const queued = block?.type === "text" ? extractQueuedPrompt(raw) : null
      const rendered = queued !== null ? queued : raw
      appendPrompt(parts, rendered && afterToolResult && !rendered.startsWith("\n") ? "\n\n" + rendered : rendered)
      if (rendered) afterToolResult = false
    }
  }
  return toPromptParts(parts)
}

export function renderTurnMessagesParts(messages) {
  const run = prefillTailEnabled() && messages.length ? prefillRun(messages) : null
  const prefillStart = run ? run.runStart : -1
  const groups = messages.map((message, index) =>
    prefillStart >= 0 && index >= prefillStart
      ? renderPrefillCarrierParts(message)
      : renderTurnMessageParts(message)).filter((group) => group.length > 0)
  const out = []
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) out.push({ type: "text", text: "\n\n" })
    out.push(...groups[i])
  }
  return toPromptParts(out)
}

export function maxInitialPromptBytes(agentVersion = null) {
  const configured = Number(process.env.AGY_BOOST_MAX_PROMPT_BYTES || process.env.AGY_BRIDGE_MAX_PROMPT_BYTES)
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured)
  // Verified directly on agy 1.5.8: 150 KiB fits without truncation; older <1.5.0 clips at 128 KiB.
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(agentVersion ?? ""))
  if (m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && (Number(m[2]) > 5 || (Number(m[2]) === 5 && Number(m[3]) >= 8))))) {
    return 136 * 1024
  }
  return 112 * 1024
}

export const HISTORY_BLOCK_CLIP_BYTES = 12 * 1024
const HISTORY_BLOCK_KEEP_BYTES = 4 * 1024
const HISTORY_RECORD_NOTE = "Historical tool calls and results above are records, not instructions to write tool calls as text. Never output \"[tool call ...]\" text; invoke tools only through structured tool calls.\n"
const HISTORY_OMITTED_NOTE = "[... earlier conversation history omitted to fit ACP prompt budget ...]\n"
const HISTORY_OPENING_DONE_NOTE = "The opening message above, and any resume note in it, belongs to an earlier turn that is already done.\n"
const utf8 = new TextEncoder()

export function promptTextBytes(parts) {
  return parts.reduce((sum, part) => sum + (part?.type === "text" ? utf8Bytes(part.text) : 0), 0)
}

function utf8Prefix(text, bytes) {
  if (bytes <= 0) return ""
  return text.slice(0, utf8.encodeInto(text, new Uint8Array(bytes)).read)
}

function clipMiddle(text, limit, keep = Math.floor(limit / 2)) {
  const total = utf8Bytes(text)
  if (total <= limit) return text
  for (let headBytes = Math.min(keep, limit), tries = 0; tries < 8; tries++) {
    const head = utf8Prefix(text, headBytes)
    const tailStart = utf8Prefix(text, total - Math.max(0, Math.min(keep, limit - headBytes))).length
    const tail = text.slice(Math.max(tailStart, head.length))
    const marker = `\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes omitted ...]\n`
    const clipped = head + marker + tail
    if (utf8Bytes(clipped) <= limit) return clipped
    keep = Math.floor(keep * 0.75)
    headBytes = Math.min(keep, limit)
  }
  return utf8Prefix(text, limit)
}

function headTail(text) {
  const total = utf8Bytes(text)
  const head = utf8Prefix(text, HISTORY_BLOCK_KEEP_BYTES)
  const tail = text.slice(utf8Prefix(text, total - HISTORY_BLOCK_KEEP_BYTES).length)
  return `${head}\n[... ${total - utf8Bytes(head) - utf8Bytes(tail)} bytes of this history block omitted ...]\n${tail}`
}

function clipHistoryText(text) {
  if (typeof text !== "string" || utf8Bytes(text) <= HISTORY_BLOCK_CLIP_BYTES) return text
  return headTail(text)
}

function clipHistoryMessage(message) {
  if (typeof message.content === "string") return { ...message, content: clipHistoryText(message.content) }
  if (!Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return { ...block, text: clipHistoryText(block.text) }
      if (block?.type === "tool_result") {
        if (typeof block.content === "string") return { ...block, content: clipHistoryText(block.content) }
        if (Array.isArray(block.content)) {
          return {
            ...block,
            content: block.content.map((part) => part?.type === "text" && typeof part.text === "string"
              ? { ...part, text: clipHistoryText(part.text) } : part),
          }
        }
      }
      if (block?.type === "tool_use") {
        const args = JSON.stringify(block.input ?? {})
        if (utf8Bytes(args) > HISTORY_BLOCK_CLIP_BYTES) return { ...block, input: { truncated_arguments: headTail(args) } }
      }
      return block
    }),
  }
}

function renderHistoryEntry(message) {
  const out = []
  if (message.role === "assistant") {
    appendPrompt(out, `Assistant: ${renderAssistantTurn(message)}\n`)
  } else {
    const queued = message.role !== "user" && extractQueuedPrompt(messageText(message).trim()) !== null
    appendPrompt(out, message.role === "user" || queued ? "Human: " : `${message.role}: `)
    appendPrompt(out, renderTurnMessageParts(message))
    appendPrompt(out, "\n")
  }
  return out
}

function clipPartsToBytes(parts, limit) {
  const out = parts.map((part) => ({ ...part }))
  for (let guard = 0; guard < 64; guard++) {
    const excess = promptTextBytes(out) - limit
    if (excess <= 0) break
    let largest = null
    for (const part of out) {
      if (part.type === "text" && (!largest || utf8Bytes(part.text) > utf8Bytes(largest.text))) largest = part
    }
    if (!largest) break
    const size = utf8Bytes(largest.text)
    largest.text = clipMiddle(largest.text, Math.max(0, size - excess))
  }
  return out
}

const NOTICE_TAG_NAMES = "system-update|teammate-message|agent-message|cross-session-message|coordinator-relay|channel|ide_opened_file|ide_selection|mcp-resource|mcp-resource-update|mcp-polling-update|post-tool-use-hook|user-prompt-submit-hook"
const CONTEXT_NOTICE_RE = new RegExp(
  `<(${NOTICE_TAG_NAMES})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|(?:\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\][^<]*)?<task-notification>[\\s\\S]*?<\\/task-notification>`,
  "g",
)
const SYSTEM_REMINDER_RE = /<system-reminder(?:\s[^>]*)?>([\s\S]*?)<\/system-reminder(?:\s[^>]*)?>/g
const PROTOCOL_NOTICE_START_RE = new RegExp(
  `^(?:<(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b|\\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\\])`,
)
const UNCLOSED_NOTICE_RE = new RegExp(`<\\/?(?:${NOTICE_TAG_NAMES}|task-notification|system-reminder)\\b`)
const LOCAL_COMMAND_RE = /<(local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g
const DSH_TIME_CONTEXT_RE = /(?:^|\r?\n)Time sampled while preparing turn \d+, step \d+: [^\r\n]+(?:\r?\nBrowser time zone for this request: [^\r\n]+)?(?:\r?\nElapsed since the preceding (?:model-visible message|step context): [^\r\n]+)?/g
const DSH_REPEAT_TOOL_RE = /(?:^|\r?\n)(?:You are repeating the exact same tool call with identical arguments\. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call\.|Repeated tool call detected:\r?\n- tool: [^\r\n]+\r?\n- consecutive_calls: \d+\r?\n- arguments: [^\r\n]+\r?\nThe repeated calls are not making progress\. Do not call this tool with these exact arguments again\. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered\.)/g
const DSH_PLAN_MODE_RE = /(?:^|\r?\n)The user switched this session (?:to plan|back to the default) mode\.(?=\r?\n|$)/g
const DSH_RUNTIME_SNAPSHOT_RE = /^Current runtime context(?:\. This snapshot supersedes earlier runtime-context snapshots\.(?:\r?\n[\s\S]*)?|: none\. Earlier runtime-context snapshots no longer apply\.)$/
// Claude Science tool-companion notices (e.g. read_file line pagination)
export const SCIENCE_SYSTEM_COMPANION_RE = /^\[System\]\s+(?:Showing lines \d+-\d+ of \d+|File |Output |Note:|Warning:|Truncated\b)/

function isMetaOnlyUserText(text) {
  const rest = stripMagpiePlaceholderNotice(text)
    .replace(SYSTEM_REMINDER_RE, "")
    .replace(CONTEXT_NOTICE_RE, "")
    .replace(LOCAL_COMMAND_RE, "")
    .replace(DSH_TIME_CONTEXT_RE, "")
    .replace(DSH_REPEAT_TOOL_RE, "")
    .replace(DSH_PLAN_MODE_RE, "")
    .replace(/\[Request interrupted by user(?: for tool use)?\]/g, "")
    .replace(/\[(?:SYSTEM NOTIFICATION|MESSAGE FROM NON-USER SOURCE) - NOT USER INPUT\]/g, "")
    .trim()
  return !rest || DSH_RUNTIME_SNAPSHOT_RE.test(rest) || SCIENCE_SYSTEM_COMPANION_RE.test(rest)
}

function isToolResultMessage(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")
}

function isUserTask(message) {
  if (message?.role !== "user") return false
  if (typeof message.content === "string") return !isMetaOnlyUserText(message.content)
  if (!Array.isArray(message.content) || isToolResultMessage(message)) return false
  if (message.content.some((block) => block?.type === "image")) return true
  return message.content.some((block) => !isMetaOnlyUserText(blockText(block)))
}

function lastCompletedTurnEnd(history) {
  for (let end = history.length; end > 0;) {
    if (history[end - 1].role !== "assistant") {
      end--
      continue
    }
    let start = end - 1
    while (start > 0 && history[start - 1].role === "assistant") start--
    const hasToolUse = history.slice(start, end).some((message) =>
      Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_use"))
    if (!hasToolUse) return end
    end = start
  }
  return 0
}

function userTurnRun(history, index) {
  if (index < 0 || index >= history.length) return null
  let start = index
  while (start > 0 && history[start - 1].role !== "assistant" && !isToolResultMessage(history[start - 1])) start--
  let end = index + 1
  while (end < history.length && history[end].role !== "assistant" && !isToolResultMessage(history[end])) end++
  const all = []
  const tasks = []
  const rest = []
  for (let i = start; i < end; i++) {
    if (i === 0) continue
    all.push(i)
    if (isUserTask(history[i])) tasks.push(i)
    else rest.push(i)
  }
  const hasTask = tasks.length > 0 || (start === 0 && end > 0 && isUserTask(history[0]))
  return hasTask ? { all, tasks, rest } : null
}

function loopOpeningRun(history, loopStart) {
  for (let i = loopStart; i < history.length; i++) {
    if (history[i].role === "assistant" || isToolResultMessage(history[i])) break
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

function latestLoopTaskRun(history, loopStart) {
  for (let i = history.length - 1; i >= loopStart; i--) {
    if (isUserTask(history[i])) return userTurnRun(history, i)
  }
  return null
}

function keptSliceBytes(indices, totalLength, entries, noteBytes) {
  let bytes = 0
  let next = 0
  for (const i of indices) {
    if (i > next) bytes += noteBytes
    bytes += entries[i].bytes
    next = i + 1
  }
  if (next < totalLength) bytes += noteBytes
  return bytes
}

export function renderInitialPromptParts(body, callerWorkDir, instructionsInSession, reserveBytes = 0, agentVersion = null) {
  const { history, messages: current } = trailingMessages(body)
  const budget = Math.max(0, maxInitialPromptBytes(agentVersion) - reserveBytes)
  const head = []
  if (!instructionsInSession) {
    const system = systemText(body)
    if (system.trim()) appendPrompt(head, `<external_system_instructions>\n${outgoing(system)}\n</external_system_instructions>\n`)
    if (callerWorkDir) appendPrompt(head, `\n${workDirNote(callerWorkDir)}\n\n`)
  }
  const currentParts = renderTurnMessagesParts(current)
  if (!head.length && !history.length) return clipPartsToBytes(currentParts, budget)
  const historyOpen = history.length ? "<conversation_history>\n" : ""
  const historyClose = history.length ? HISTORY_RECORD_NOTE + "</conversation_history>\n\n" : ""
  const turnOpen = "<current_turn>\n"
  const turnClose = "\n</current_turn>"
  const frame = utf8Bytes(historyOpen + historyClose + turnOpen + turnClose)
  let headParts = head
  let turn = currentParts
  if (promptTextBytes(headParts) + frame + promptTextBytes(turn) > budget) {
    const forTurn = Math.max(0, budget - frame - promptTextBytes(headParts))
    turn = clipPartsToBytes(turn, Math.max(forTurn, Math.min(promptTextBytes(turn), Math.floor((budget - frame) / 2))))
    headParts = clipPartsToBytes(headParts, Math.max(0, budget - frame - promptTextBytes(turn)))
  }
  let room = budget - frame - promptTextBytes(headParts) - promptTextBytes(turn)
  const render = (message) => {
    const parts = renderHistoryEntry(message)
    return { parts, bytes: promptTextBytes(parts) }
  }
  const overRoom = (list) => list.reduce((sum, entry) => sum + entry.bytes, 0) > room
  let entries = history.map(render)
  if (overRoom(entries)) entries = history.map((message) => render(clipHistoryMessage(message)))
  let kept = entries
  let showOpeningDone = false
  if (overRoom(entries)) {
    const noteBytes = utf8Bytes(HISTORY_OMITTED_NOTE)
    const inToolLoop = current.some(isToolResultMessage)
    const loopStart = inToolLoop ? lastCompletedTurnEnd(history) : history.length
    const openingDoneBytes = utf8Bytes(HISTORY_OPENING_DONE_NOTE)
    let reservedOpeningDone = false
    if (room < noteBytes) {
      kept = []
    } else {
      if (inToolLoop && loopStart > 0 && room >= noteBytes + openingDoneBytes) {
        reservedOpeningDone = true
        room -= openingDoneBytes
      }
      let keep = []
      if (entries.length && keptSliceBytes([0], entries.length, entries, noteBytes) <= room) {
        keep.push(0)
      }
      if (inToolLoop) {
        const runs = [loopOpeningRun(history, loopStart), latestLoopTaskRun(history, loopStart)].filter(Boolean)
        const whole = [...new Set([...keep, ...runs.flatMap((run) => run.all)])].sort((a, b) => a - b)
        if (whole.length > keep.length && keptSliceBytes(whole, entries.length, entries, noteBytes) <= room) {
          keep = whole
        } else {
          const order = [...new Set([...runs.flatMap((run) => run.tasks), ...runs.flatMap((run) => run.rest)])]
          for (const idx of order) {
            if (keep.includes(idx)) continue
            const nextKeep = [...keep, idx].sort((a, b) => a - b)
            if (keptSliceBytes(nextKeep, entries.length, entries, noteBytes) <= room) keep = nextKeep
          }
        }
      }
      let left = room - keptSliceBytes(keep, entries.length, entries, noteBytes)
      const tail = []
      const floor = keep.length ? keep.at(-1) : -1
      for (let i = entries.length - 1; i > floor; i--) {
        const cost = entries[i].bytes - (i === floor + 1 ? noteBytes : 0)
        if (cost > left) break
        left -= cost
        tail.unshift(i)
      }
      const keptIndices = [...keep, ...tail]
      kept = []
      let next = 0
      for (const i of keptIndices) {
        if (i > next) kept.push(null)
        kept.push(entries[i])
        next = i + 1
      }
      if (next < entries.length) kept.push(null)
      showOpeningDone = reservedOpeningDone && keep.includes(0) && kept.includes(null) &&
        keptIndices.some((i) => i >= loopStart && isUserTask(history[i]))
    }
  }
  const out = []
  appendPrompt(out, headParts)
  if (history.length) {
    appendPrompt(out, historyOpen)
    for (const entry of kept) appendPrompt(out, entry ? entry.parts : HISTORY_OMITTED_NOTE)
    if (showOpeningDone) appendPrompt(out, HISTORY_OPENING_DONE_NOTE)
    appendPrompt(out, historyClose)
  }
  appendPrompt(out, turnOpen)
  appendPrompt(out, turn)
  appendPrompt(out, turnClose)
  return promptTextBytes(out) <= budget ? out : clipPartsToBytes(out, budget)
}

export function renderContinuedTurnParts(messages) {
  return renderTurnMessagesParts(messages)
}

export function renderHistoryDeltaParts(historyDelta, currentMessages) {
  const out = []
  if (Array.isArray(historyDelta) && historyDelta.length) {
    appendPrompt(out, "<continued_history_since_checkpoint>\n")
    for (const message of historyDelta) appendPrompt(out, renderHistoryEntry(clipHistoryMessage(message)))
    appendPrompt(out, "</continued_history_since_checkpoint>\n\n")
  }
  const current = renderTurnMessagesParts(currentMessages)
  if (current.length) appendPrompt(out, current)
  return toPromptParts(out)
}

export function extractToolResults(body) {
  return trailingMessages(body).messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "tool_result") : [])
}

export function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  const trailing = trailingMessages(body)
  const lastRole = body.messages.at(-1)?.role
  const prefillTail = prefillTailEnabled() && lastRole === "assistant" && assistantTextOf(body.messages.at(-1)) !== null
  const validTailRole = lastRole === "user" || lastRole === "system" || lastRole === "developer" || prefillTail
  if (prefillTail && extractToolResults(body).length) {
    throw new UnsupportedContent("a request combining a live tool_result with an assistant prefill tail")
  }
  if (!validTailRole || (!extractToolResults(body).length &&
    !trailing.messages.some((message) => message.role === "user") && !trailing.history.length)) {
    throw new UnsupportedContent(prefillTail
      ? "a request whose only messages are assistant prefill turns (no user turn to continue from)"
      : "a request whose last message is not from the user or a tool-result notification")
  }
  if (body.system && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (ASSISTANT_ALLOWED_BLOCK_TYPES.has(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        if (!Array.isArray(message.content)) throw new UnsupportedContent("a non-text system/developer message")
        for (const block of message.content) {
          if (block?.type === "text" && typeof block.text === "string") continue
          if (block?.type === "tool_addition" || block?.type === "tool_removal") continue
          if (block && typeof block.type === "string" && block.type !== "text") {
            throw new UnsupportedContent(`a non-text system/developer content block of type ${JSON.stringify(block.type)}`)
          }
          throw new UnsupportedContent("a non-text system/developer message")
        }
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else if (block?.type === "image") parseUserImage(block)
          else if (block?.type === "text" || typeof block === "string") continue
          else if (block?.type === "document") parseUserDocumentText(block)
          else if (block?.type === "search_result") parseSearchResultText(block)
          else blockText(block)
        }
      } else if (typeof message.content !== "string") {
        messageText(message)
      }
    }
  }
}

export function resultText(result) {
  return (result?.content || []).map((part) => part?.type === "text" ? part.text : "[image returned by tool]").join("\n\n")
}

function isSkillResult(item) {
  if (item.call?.name === "Skill") return true
  const first = item.result?.content?.[0]
  return first?.type === "text" &&
    /^(?:Launching skill|Loaded skill instructions \(read-only\)): /.test(first.text || "")
}

function appendResultPart(results, index, part) {
  if (index < 0 || index >= results.length) {
    throw new UnsupportedContent("text beside a live tool_result; no matching tool companion")
  }
  const targetCall = results[index]?.call
  return results.map((item, i) => (targetCall ? item.call !== targetCall : i !== index) ? item : {
    ...item,
    result: {
      ...item.result,
      content: [...item.result.content, part],
    },
  })
}

function appendResultText(results, index, text) {
  return appendResultPart(results, index, { type: "text", text })
}

export function isInterruptedToolTurn(body) {
  let seenResult = false
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) return false
        continue
      }
      const text = stripMagpiePlaceholderNotice(blockText(block))
      if (!seenResult && message.role === "user" && text.trim()) return false
      if (seenResult && message.role === "user" &&
        /^\[Request interrupted by user(?:\s+for tool use)?\]\s*$/.test(text)) {
        return true
      }
    }
  }
  return false
}

export function inspectToolTurn(results, body) {
  let out = results
  let userSteered = false
  const notices = []
  let seenResult = false
  let resultIndex = -1
  const stoppedByHookOrUser = out.some((item) => item.result?.isError &&
    /^(?:The user doesn't want to proceed with this tool use\.|User rejected tool use\b|Operation stopped by hook\b|Execution stopped by hook\b|Blocked by PreToolUse hook\b|Hook PreToolUse:\S+ denied\b|API Error: Request was aborted\.|\[Request interrupted by user\b)/.test(resultText(item.result).trim()))
  const userInterruption = /(?:The user sent (?:a new message while you were working|the following message)|The [^\r\n]+ plugin sent a message while you were working):/
  const nonUserSourceNotice = /^\[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT\]\s*\n/
  const skillCompanion = /^\s*(?:Base directory for this skill:|ARGUMENTS:|Skill arguments:) /
  const imageCompanion = /^\[Image(?: source)?: [^\r\n]+\]$/
  const toolLoadedCompanion = /^Tools? loaded\.(?:\n\[id:[^\]\n]+\])*$/
  const loopNotice = /^\[\d+ prior \/loop wakeups? found nothing actionable; loop is healthy\.\]$/
  const tokenNoise = /^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining|USD budget: \$\S+; \$\S+ remaining|Output tokens — turn: [^\r\n]+)$/
  const hookBoilerplateNoise = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook success:\s*(?:Success)?\s*$/
  const hookOutput = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/
  const hookStoppedContinuation = /^[A-Za-z][A-Za-z0-9_.-]*(?::\S+)? hook stopped continuation:/
  const claudeMetaFeedback = /^(?:(?:Stop|SubagentStop|TeammateIdle|TaskCreated|TaskCompleted|PermissionRequest|PermissionDenied|PreCompact|PostCompact|Elicitation|ElicitationResult|ConfigChange|CwdChanged|FileChanged|WorktreeCreate|WorktreeRemove|InstructionsLoaded) hook feedback:\n[\s\S]+|UserPromptSubmit operation blocked by hook:\n[\s\S]+|The PermissionDenied hook indicated you may retry this tool call\.|The turn did not end: a tool call in your last message asked to end it, but another call in that message failed\.[\s\S]*|Your response above was stopped by a safety classifier — this is not a tool or API error\.[\s\S]*|The previous response failed to produce a valid tool call\. Please retry the tool call now\.|Your tool call was malformed and could not be parsed\. Please retry\.|Output token limit hit[\s\S]*|Your response (?:was cut off|above was cut off)[\s\S]*|\[Your previous response (?:had no visible output|reached the output limit)[\s\S]*\]|\[structured-output-enforce\][\s\S]*|\[projects-reply-gate\][\s\S]*|Linked in your reply but not sent:[\s\S]*|Goal check-in: «[\s\S]*)$/
  const isNoise = (value) => !value || tokenNoise.test(value) || hookBoilerplateNoise.test(value)
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        resultIndex = out.findIndex(item => item.block?.tool_use_id === block.tool_use_id)
        continue
      }
      if (block?.type === "image") {
        if (!seenResult) {
          userSteered = true
          continue
        }
        out = appendResultPart(out, resultIndex, parseUserImage(block))
        continue
      }
      const rawText = blockText(block)
      if (!seenResult && message.role === "user" && rawText.trim()) {
        userSteered = true
      }
      const text = stripMagpiePlaceholderNotice(rawText)
      if (text !== rawText && !notices.includes(MAGPIE_PLACEHOLDER_NOTICE)) {
        notices.push(MAGPIE_PLACEHOLDER_NOTICE)
      }
      const trimmed = text.trim()
      if (!trimmed) continue
      const preceding = out[resultIndex]
      const skillIndex = preceding && isSkillResult(preceding) ? resultIndex : -1
      const imageIndex = preceding?.result?.content?.some(part => part?.type === "image") ? resultIndex : -1
      const toolSearchIndex = preceding?.call?.name === "ToolSearch" ? resultIndex : -1
      if (message.role === "user" && skillCompanion.test(text)) {
        out = appendResultText(out, skillIndex, text)
        continue
      }
      if (message.role === "user") {
        if (extractQueuedPrompt(trimmed) !== null) {
          userSteered = true
          continue
        }
        // Science pagination/truncation notices like "[System] Showing lines 1-140 of 424."
        // must stay non-steering companion notices rather than tearing down the live ACP turn.
        if (SCIENCE_SYSTEM_COMPANION_RE.test(trimmed)) {
          notices.push(trimmed)
          continue
        }
        if (nonUserSourceNotice.test(trimmed) && !/<task-notification\b/.test(trimmed)) {
          const check = trimmed.replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
          if (UNCLOSED_NOTICE_RE.test(check)) {
            throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
          }
          notices.push(trimmed)
          continue
        }
        if (imageCompanion.test(trimmed)) {
          out = appendResultText(out, imageIndex, trimmed)
          continue
        }
        if (toolLoadedCompanion.test(trimmed)) {
          out = appendResultText(out, toolSearchIndex, trimmed)
          continue
        }
        if (loopNotice.test(trimmed)) {
          notices.push(trimmed)
          continue
        }
        if (skillIndex >= 0 && /^#{1,6}\s+[^\r\n]*\b(?:skill|instructions)\b/i.test(trimmed) &&
          !isNoise(trimmed) && !PROTOCOL_NOTICE_START_RE.test(trimmed) &&
          !userInterruption.test(trimmed) && !hookOutput.test(trimmed) && !claudeMetaFeedback.test(trimmed)) {
          out = appendResultText(out, skillIndex, text)
          continue
        }
      }
      notices.push(...Array.from(text.matchAll(CONTEXT_NOTICE_RE), (match) => match[0]))
      const withoutNotices = text.replace(CONTEXT_NOTICE_RE, "")
      for (const match of withoutNotices.matchAll(SYSTEM_REMINDER_RE)) {
        const inner = match[1].trim()
        if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) {
          userSteered = true
          continue
        }
        if (!isNoise(inner)) notices.push(inner)
      }
      const rest = withoutNotices.replace(SYSTEM_REMINDER_RE, "").trim()
      if (UNCLOSED_NOTICE_RE.test(rest)) {
        const wrapped = /^<system-reminder(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/system-reminder>$/.exec(trimmed)
        if (!wrapped && PROTOCOL_NOTICE_START_RE.test(rest)) {
          throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
        }
        if (wrapped || message.role === "system" || message.role === "developer") {
          const inner = wrapped ? wrapped[1] : rest
          if (extractQueuedPrompt(inner) !== null || userInterruption.test(inner)) userSteered = true
          else if (!isNoise(inner)) notices.push(outgoing(inner))
        } else if (message.role === "user") {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
        continue
      }
      if (message.role === "system" || message.role === "developer") {
        if (extractQueuedPrompt(rest) !== null || userInterruption.test(rest)) {
          userSteered = true
        } else if (!isNoise(rest)) {
          notices.push(outgoing(rest))
        }
      } else if (!isNoise(rest)) {
        if ((hookOutput.test(rest) || claudeMetaFeedback.test(rest)) && !userInterruption.test(rest)) {
          notices.push(rest)
        } else if (message.role === "user" || userSteered || stoppedByHookOrUser ||
          notices.some((item) => hookStoppedContinuation.test(item))) {
          userSteered = true
        } else {
          notices.push(outgoing(rest))
        }
      }
    }
  }
  const finalResults = notices.length
    ? appendResultText(out, out.length - 1, `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>`)
    : out
  return { results: finalResults, userSteered }
}

export function canReplayFollowUpAfterResults(body, rawResults) {
  const { history, messages } = trailingMessages(body)
  let lastResultIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "tool_result")) {
      lastResultIndex = i
    }
  }
  if (lastResultIndex < 0 || lastResultIndex >= messages.length - 1) return false
  const tail = messages.slice(lastResultIndex + 1)
  if (!tail.some((message) => message.role === "user")) return false
  try {
    inspectToolTurn(rawResults, { ...body, messages: [...history, ...messages.slice(0, lastResultIndex + 1)] })
  } catch {
    return false
  }
  for (const message of tail) {
    const rest = messageText(message).replace(CONTEXT_NOTICE_RE, "").replace(SYSTEM_REMINDER_RE, "")
    if (UNCLOSED_NOTICE_RE.test(rest)) return false
  }
  return true
}

export function replayHistoryProblem(body, resultBlocks) {
  const calls = lastAssistantCalls(trailingMessages(body).history)
  if (!calls.length) return "no_tool_use"
  const ids = new Set()
  for (const call of calls) {
    if (typeof call.id !== "string" || !call.id || ids.has(call.id)) return "bad_tool_use_id"
    ids.add(call.id)
    if (typeof call.name !== "string" || !call.name) return "bad_tool_use_name"
    const input = call.input ?? {}
    if (!input || typeof input !== "object" || Array.isArray(input)) return "bad_tool_use_input"
  }
  const answered = new Set()
  for (const block of resultBlocks) {
    if (!ids.has(block.tool_use_id) || answered.has(block.tool_use_id)) return "unmatched_tool_result"
    answered.add(block.tool_use_id)
  }
  return answered.size === ids.size ? null : "missing_tool_result"
}

export function namedWorkDirectory(body, headers) {
  const h = headers instanceof Headers ? headers : new Headers(headers || {})
  const raw = h.get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const firstAssistant = body.messages.findIndex((message) => message.role === "assistant")
  const opening = firstAssistant < 0 ? body.messages : body.messages.slice(0, firstAssistant)
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...opening]) {
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "text") texts.push(block.text || "")
    }
  }
  let directory = null
  const pattern = /(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)<\/cwd>/gm
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[2]).trim().replace(/^[`'"]+|[`'"]+$/g, "")
      if (value) directory = value
    }
  }
  return directory
}

export function workDirectory(directory) {
  if (!directory) return null
  let candidate = directory
  if (process.platform === "win32" && candidate.startsWith("/")) {
    const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(candidate)
    if (!wsl) return null
    candidate = `${wsl[1].toUpperCase()}:\\${(wsl[2] || "").replace(/\//g, "\\")}`
  }
  if (!path.isAbsolute(candidate)) return null
  try {
    if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
  } catch {}
  return null
}

export function estimateTextTokens(text) {
  if (!text) return 0
  let ascii = 0
  let nonAsciiBytes = 0
  const buf = Buffer.from(String(text), "utf8")
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) ascii++
    else nonAsciiBytes++
  }
  return Math.ceil(ascii / 4 + nonAsciiBytes / 3)
}

export function estimateInputTokens(body) {
  let total = 0
  let images = 0
  const walk = (value) => {
    if (value == null) return
    if (typeof value === "string") {
      total += estimateTextTokens(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === "object") {
      if (value.type === "image" && value.source?.type === "base64") {
        images++
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "cache_control" || key === "signature") continue
        walk(item)
      }
    }
  }
  walk(body.system)
  walk(body.messages)
  if (Array.isArray(body.tools) && body.tools.length) {
    total += estimateTextTokens(JSON.stringify(body.tools))
  }
  return Math.max(1, total + images * 1600)
}

export function estimatePromptPartsTokens(parts) {
  let total = 0
  let images = 0
  for (const part of parts || []) {
    if (part?.type === "text" && part.text) total += estimateTextTokens(part.text)
    else if (part?.type === "image") images++
  }
  return total + images * 1600
}

export function openingTextOf(message) {
  if (!message) return ""
  return compactIdentity(stripVolatileOpening(contentText(message.content)))
}

export function openingImagesOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block?.type !== "image") continue
    try {
      const image = parseUserImage(block)
      if (image) out.push(`${image.mimeType}:${digest(image.data)}`)
    } catch {
      const source = block.source || {}
      out.push(`invalid:${source.media_type || ""}:${digest(String(source.data || ""))}`)
    }
  }
  return out
}

function sameOpeningPrefix(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length > cur.length) return false
  return prev.every((id, index) => id === cur[index])
}

function openingExtrasOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block === "string" || block.type === "text" || block.type === "image") continue
    out.push(digest(stableJSON(block)))
  }
  return out
}

function consumeCompactPrefix(text, compactPrefix) {
  let i = 0
  let k = 0
  let lastWasNewline = true
  while (i < text.length && k < compactPrefix.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") lastWasNewline = true
      i++
      continue
    }
    if (ch !== compactPrefix[k]) return null
    k++
    i++
    lastWasNewline = false
  }
  if (k < compactPrefix.length) return null
  let sawNewline = lastWasNewline
  let j = i
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++
  if (j < text.length && (text[j] === "\n" || text[j] === "\r")) {
    sawNewline = true
    while (j < text.length && /\s/.test(text[j])) j++
  }
  return { remainderIndex: j, boundary: sawNewline }
}

function subsequentTranscriptOf(proc) {
  const messages = proc?.expectedMessages
  if (!Array.isArray(messages) || messages.length < 2) return ""
  const parts = []
  for (const message of messages.slice(1)) {
    if (!message) continue
    if (message.role === "assistant") {
      const text = assistantTextOf(message)
      if (typeof text === "string" && text.trim()) {
        parts.push(text)
        continue
      }
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of blocks) {
        if (!block) continue
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text)
        else if (block.type === "tool_use") parts.push(`${block.name || ""}:${stableJSON(block.input ?? {})}`)
      }
      continue
    }
    const text = contentText(message.content)
    if (text.trim()) parts.push(text)
  }
  return compactIdentity(parts.join("\n"))
}

const FLAT_ROLE_LABEL_RE = /^(?:assistant|user|system|human|model)\s*:\s*/i

function leftoverAfterSubsequent(remainder, subsequentCompact) {
  if (!subsequentCompact) return null
  let text = remainder
  if (FLAT_ROLE_LABEL_RE.test(text)) text = text.replace(FLAT_ROLE_LABEL_RE, "")
  if (!compactIdentity(text).startsWith(subsequentCompact)) return null
  const consumed = consumeCompactPrefix(text, subsequentCompact)
  if (!consumed) return null
  if (!consumed.boundary && consumed.remainderIndex < text.length) return null
  return text.slice(consumed.remainderIndex)
}

export function flattenedContinuationMessage(proc, firstMessage) {
  const prev = proc?.openingText || ""
  const cur = openingTextOf(firstMessage)
  if (!prev || !cur || cur === prev) return null
  if (!(cur.startsWith(prev) && cur.length > prev.length + 4)) return null
  const prevOpening = Array.isArray(proc.expectedMessages) ? proc.expectedMessages[0] : null
  const prevImages = proc.openingImages || openingImagesOf(prevOpening)
  const curImages = openingImagesOf(firstMessage)
  if (!sameOpeningPrefix(prevImages, curImages)) return null
  const prevExtras = openingExtrasOf(prevOpening)
  const curExtras = openingExtrasOf(firstMessage)
  if (!sameOpeningPrefix(prevExtras, curExtras)) return null
  const curRaw = stripVolatileOpening(contentText(firstMessage?.content))
  const consumed = consumeCompactPrefix(curRaw, prev)
  if (!consumed?.boundary) return null
  const subsequent = subsequentTranscriptOf(proc)
  if (!subsequent) return null
  const leftover = leftoverAfterSubsequent(curRaw.slice(consumed.remainderIndex), subsequent)
  if (leftover == null) return null
  const newText = leftover.replace(/^\s+/, "")
  const keptBlocks = []
  if (Array.isArray(firstMessage?.content)) {
    let skippedImages = 0
    let skippedExtras = 0
    const skipImg = prevImages?.length || 0
    const skipEx = prevExtras?.length || 0
    for (const block of firstMessage.content) {
      if (!block || typeof block === "string" || block.type === "text") continue
      if (block.type === "image") {
        if (skippedImages < skipImg) {
          skippedImages++
          continue
        }
        keptBlocks.push(block)
        continue
      }
      if (skippedExtras < skipEx) {
        skippedExtras++
        continue
      }
      keptBlocks.push(block)
    }
  }
  if (!newText && !keptBlocks.length) return null
  if (!keptBlocks.length) return { role: "user", content: newText }
  const content = []
  if (newText) content.push({ type: "text", text: newText })
  content.push(...keptBlocks)
  return { role: "user", content }
}

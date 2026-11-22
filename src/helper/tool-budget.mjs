// agy hands the model at most about 60,000 bytes of an MCP server's tool
// definitions (name, description and input schema as JSON; measured on agy
// 1.5.14, the same for every model). Past that it silently leaves
// whole tools out, keeping the smallest first, so a client's longest tools
// (often the ones it depends on most) are the ones that disappear.
//
// fitTools() keeps every tool: when the definitions are too large it shortens
// the longest description texts until they fit, and returns the full text of
// everything it shortened so the caller can give it to the model another way
// (the session's system prompt, or the next prompt).

export const AGY_TOOL_LIMIT_BYTES = 60_000
const DEFAULT_BUDGET_BYTES = 50_000
export const SHORTENED_MARK = ' [… shortened to fit agy\'s tool size limit; full text under "Full tool descriptions"]'

// [floor in bytes, which texts] tried in order until the tools fit.
const STAGES = [
  [400, "description"],
  [160, "param"],
  [120, "description"],
  [100, "param"],
]

export function toolBudgetBytes(env = process.env) {
  const n = Number(env.AGY_BOOST_TOOL_BUDGET_BYTES)
  return Number.isFinite(n) && n >= 4096 ? Math.floor(n) : DEFAULT_BUDGET_BYTES
}

const bytes = (text) => Buffer.byteLength(text, "utf8")

export function toolBytes(tool) {
  return bytes(JSON.stringify({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} }))
}

export function toolsBytes(tools) {
  let total = 0
  for (const tool of tools) total += toolBytes(tool)
  return total
}

// The longest prefix of `text` that is at most `max` bytes, ended at a
// sentence or word break when one is near.
function prefixWithin(text, max) {
  if (max <= 0) return ""
  let used = 0
  let end = 0
  for (const ch of text) {
    const size = bytes(ch)
    if (used + size > max) break
    used += size
    end += ch.length
  }
  const cut = text.slice(0, end)
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("。"), cut.lastIndexOf("\n\n"))
  if (sentence >= cut.length * 0.6) return cut.slice(0, sentence + 1).trimEnd()
  const space = cut.search(/\s\S*$/)
  if (space >= cut.length * 0.8) return cut.slice(0, space).trimEnd()
  return cut
}

// `text` cut to at most `cap` bytes including the mark.
// `text` itself when that is not longer.
export function shortenText(text, cap) {
  const size = bytes(text)
  if (size <= cap) return text
  const short = prefixWithin(text, cap - bytes(SHORTENED_MARK)) + SHORTENED_MARK
  return bytes(short) < size ? short : text
}

// Every description inside a JSON schema, with a readable path.
function schemaTexts(schema, path, out) {
  if (!schema || typeof schema !== "object") return out
  if (Array.isArray(schema)) {
    schema.forEach((item) => schemaTexts(item, path, out))
    return out
  }
  if (typeof schema.description === "string" && path) out.push({ node: schema, path })
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) schemaTexts(value, path ? `${path}.${key}` : key, out)
  }
  if (schema.items) schemaTexts(schema.items, `${path || ""}[]`, out)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) schema[key].forEach((item, i) => schemaTexts(item, `${path} (${key} ${i + 1})`, out))
  }
  for (const key of ["$defs", "definitions"]) {
    if (schema[key] && typeof schema[key] === "object") {
      for (const [name, value] of Object.entries(schema[key])) schemaTexts(value, `${key}.${name}`, out)
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    schemaTexts(schema.additionalProperties, `${path || ""}{}`, out)
  }
  return out
}

// Text slots of one kind across `tools` (which this mutates through set()).
function slotsOf(tools, kind) {
  const slots = []
  for (const tool of tools) {
    if (kind === "description") {
      if (typeof tool.description === "string") {
        slots.push({ tool, path: null, get: () => tool.description, set: (text) => { tool.description = text } })
      }
    } else {
      for (const { node, path } of schemaTexts(tool.inputSchema, "", [])) {
        slots.push({ tool, path, get: () => node.description, set: (text) => { node.description = text } })
      }
    }
  }
  return slots
}

// Cap the texts of one kind at the largest cap (not below `floor`) that brings
// the tools under `budget`; at `floor` when none does. Returns whether they fit.
// `fullOf(slot)` is the slot's original text, so a cap can also grow back.
function waterFill(tools, kind, floor, budget, fullOf) {
  const slots = slotsOf(tools, kind).filter((slot) => bytes(fullOf(slot)) > floor)
  if (!slots.length) return toolsBytes(tools) <= budget
  const full = slots.map(fullOf)
  const apply = (cap) => {
    slots.forEach((slot, i) => slot.set(shortenText(full[i], Math.max(cap, floor))))
    return toolsBytes(tools)
  }
  let lo = floor
  let hi = Math.max(...full.map(bytes))
  if (apply(lo) > budget) return false
  while (hi - lo > 16) {
    const mid = Math.floor((lo + hi) / 2)
    if (apply(mid) <= budget) lo = mid
    else hi = mid
  }
  apply(lo)
  return true
}

// { tools, notes, before, after, fits }. `tools` keeps every name, order and
// schema shape; `notes` lists each text that was shortened, with its full
// text: { name, path (null for the tool's own description), text }.
export function fitTools(tools, budget = toolBudgetBytes()) {
  const before = toolsBytes(tools)
  if (before <= budget) return { tools, notes: [], before, after: before, fits: true }
  const fitted = tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema ?? {}) }))
  const sourceParams = tools.map((tool) => new Map(schemaTexts(tool.inputSchema, "", []).map((item) => [item.path, item.node.description])))
  const fullOf = (slot) => {
    const i = fitted.indexOf(slot.tool)
    return slot.path === null ? (tools[i].description ?? "") : (sourceParams[i].get(slot.path) ?? slot.get())
  }
  let fits = false
  for (const [floor, kind] of STAGES) {
    if (waterFill(fitted, kind, floor, budget, fullOf)) {
      fits = true
      break
    }
  }
  const notes = []
  fitted.forEach((tool, i) => {
    if ((tool.description ?? "") !== (tools[i].description ?? "")) {
      notes.push({ name: tool.name, path: null, text: tools[i].description ?? "" })
    }
    for (const item of schemaTexts(tool.inputSchema, "", [])) {
      const full = sourceParams[i].get(item.path)
      if (typeof full === "string" && full !== item.node.description) notes.push({ name: tool.name, path: item.path, text: full })
    }
  })
  return { tools: fitted, notes, before, after: toolsBytes(fitted), fits }
}

export function toolNoteKey(note) {
  return JSON.stringify([note.name, note.path, note.text])
}

// The full text of shortened tool descriptions, for the system prompt or a reminder.
export function renderToolNotes(notes) {
  if (!notes.length) return ""
  const lines = [
    "# Full tool descriptions",
    "",
    `agy passes at most about ${Math.round(AGY_TOOL_LIMIT_BYTES / 1000)} KB of tool definitions to the model, so the tool list shortens the texts below (they end in "[… shortened …]"). This is their full text: treat it as part of each tool's definition.`,
  ]
  let current = null
  for (const note of notes) {
    if (note.name !== current) {
      current = note.name
      lines.push("", `## Tool \`${note.name}\``)
    }
    lines.push("", note.path === null ? note.text : `Parameter \`${note.path}\`: ${note.text}`)
  }
  return lines.join("\n")
}

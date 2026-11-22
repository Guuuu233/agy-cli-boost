import { describe, expect, it } from "bun:test"
import { fitTools, renderToolNotes, SHORTENED_MARK, toolsBytes } from "../src/helper/tool-budget.mjs"

const filler = (n, unit = "Detailed guidance sentence. ") => (unit.repeat(Math.ceil(n / unit.length))).slice(0, n)
const schema = (paramText = "input") => ({
  type: "object",
  properties: { code: { type: "string", description: paramText } },
  required: ["code"],
})
const tool = (name, descBytes, paramText) => ({ name, description: `Tool ${name}. ${filler(descBytes)}`, inputSchema: schema(paramText) })

describe("fitTools", () => {
  it("leaves tools under the budget exactly as they are", () => {
    const tools = [tool("a", 1000), tool("b", 2000)]
    const fit = fitTools(tools, 50_000)
    expect(fit.tools).toBe(tools)
    expect(fit.notes).toEqual([])
    expect(fit.fits).toBe(true)
  })

  it("keeps every tool, in order, under the budget, and returns the full text it shortened", () => {
    const tools = Array.from({ length: 27 }, (_, i) => tool(`t${String(i).padStart(2, "0")}`, 10_000))
    tools[0].description += " SECRET-END"
    const fit = fitTools(tools, 50_000)
    expect(fit.fits).toBe(true)
    expect(toolsBytes(fit.tools)).toBeLessThanOrEqual(50_000)
    expect(fit.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(fit.tools.every((t) => t.description.endsWith(SHORTENED_MARK))).toBe(true)
    expect(fit.tools[0].description.startsWith("Tool t00.")).toBe(true)
    expect(fit.tools[0].description).not.toContain("SECRET-END")
    const note = fit.notes.find((n) => n.name === "t00" && n.path === null)
    expect(note.text).toBe(tools[0].description)
    expect(renderToolNotes(fit.notes)).toContain("SECRET-END")
    // The caller's tools are not changed.
    expect(tools[0].description.endsWith("SECRET-END")).toBe(true)
  })

  it("shortens the longest texts first and leaves short ones whole", () => {
    const tools = [tool("small", 500), tool("huge", 80_000)]
    const fit = fitTools(tools, 50_000)
    expect(fit.tools[0].description).toBe(tools[0].description)
    expect(fit.tools[1].description.endsWith(SHORTENED_MARK)).toBe(true)
    expect(fit.notes.map((n) => n.name)).toEqual(["huge"])
  })

  it("shortens parameter descriptions when the tool descriptions alone cannot fit", () => {
    const tools = Array.from({ length: 20 }, (_, i) => tool(`p${i}`, 50, filler(5_000) + ` SECRET-P${i}`))
    const fit = fitTools(tools, 50_000)
    expect(fit.fits).toBe(true)
    expect(toolsBytes(fit.tools)).toBeLessThanOrEqual(50_000)
    expect(fit.tools[3].inputSchema.required).toEqual(["code"])
    expect(fit.tools[3].inputSchema.properties.code.type).toBe("string")
    const note = fit.notes.find((n) => n.name === "p3" && n.path === "code")
    expect(note.text.endsWith("SECRET-P3")).toBe(true)
    expect(renderToolNotes(fit.notes)).toContain("Parameter `code`")
  })

  it("counts bytes, not characters, and cuts multi-byte text cleanly", () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({
      name: `c${i}`,
      description: filler(9_000, "工具说明文字用于测试。"),
      inputSchema: schema(),
    }))
    const fit = fitTools(tools, 50_000)
    expect(toolsBytes(fit.tools)).toBeLessThanOrEqual(50_000)
    for (const t of fit.tools) expect(t.description).not.toContain("�")
  })
})

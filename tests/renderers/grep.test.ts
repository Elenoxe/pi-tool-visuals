import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import type { ToolRenderers } from "@earendil-works/pi-coding-agent"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import { configureHighlighting, disposeHighlighting } from "../../src/highlight/index.ts"
import { createGrepRenderer } from "../../src/renderers/grep.ts"
import type { RenderContext, ToolResult } from "../../src/renderers/shared.ts"

const theme = getThemeByName("dark")!
const invalidate = mock(() => {})
let dir: string
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: RenderContext

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "grep-renderer-"))
  config = createDefaultConfig()
  config.highlight.enable = false
  configureHighlighting(config.highlight)
  renderer = createGrepRenderer(() => config)
  invalidate.mockReset()
  context = {
    args: { pattern: "target", literal: true },
    toolCallId: "grep-renderer-test",
    cwd: dir,
    state: {},
    invalidate,
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
  }
})

afterEach(async () => {
  disposeHighlighting()
  mock.restore()
  await fs.rm(dir, { recursive: true, force: true })
})

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined }
}

function render(result: ToolResult, expanded = false): string {
  context.expanded = expanded
  const component = renderer.renderResult!(result, { expanded, isPartial: false }, theme, context)
  context.lastComponent = component
  return component.render(200).join("\n")
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Grep renderer did not finish asynchronous preparation")
    await nextTurn()
  }
}

test("groups files and preserves match/context rows, aligned numbers and discontinuous fragments", () => {
  const result = textResult(
    [
      "src/a.ts-10- const x = 1",
      "src/a.ts:11: const target = x",
      "src/a.ts-12- const y = 2",
      "src/a.ts:20: target()",
      "src/b.ts:5: const target = true",
    ].join("\n"),
  )
  const original = structuredClone(result)
  const output = stripVTControlCharacters(render(result))
  const lines = output.split("\n").map((line) => line.trimEnd())
  expect(lines.filter((line) => line === "src/a.ts")).toHaveLength(1)
  expect(lines.filter((line) => line === "src/b.ts")).toHaveLength(1)
  expect(lines.filter((line) => /^\s*\d+ [│┆] /.test(line))).toEqual([
    "  10 ┆ const x = 1",
    "  11 │ const target = x",
    "  12 ┆ const y = 2",
    "  20 │ target()",
    "   5 │ const target = true",
  ])
  expect(lines).toContain("   ⋮")
  expect(lines.indexOf("  12 ┆ const y = 2")).toBeLessThan(lines.indexOf("   ⋮"))
  expect(lines.indexOf("   ⋮")).toBeLessThan(lines.indexOf("  20 │ target()"))
  expect(lines.indexOf("  20 │ target()")).toBeLessThan(lines.indexOf("src/b.ts"))
  expect(result).toEqual(original)
})

test("emphasizes repeated case-insensitive literal spans only on match rows and preserves foreground ANSI", () => {
  const code = "before TaRgEt() + target() + after"
  context.args = { pattern: "target()", literal: true, ignoreCase: true }
  const result = textResult("source.ts:1: " + code + "\nsource.ts-2- " + code)
  const original = structuredClone(result)
  const foreground = theme.fg.bind(theme)
  // Split a match across foreground colors without depending on Shiki's tokenization.
  const colored = foreground("accent", code.slice(0, 10)) + foreground("success", code.slice(10))
  spyOn(theme, "fg").mockImplementation((color, text) =>
    color === "toolOutput" && text === code ? colored : foreground(color, text),
  )
  const rows = render(result).split("\n")
  const matchRow = rows.find((line) => stripVTControlCharacters(line).includes("1 │"))!
  const contextRow = rows.find((line) => stripVTControlCharacters(line).includes("2 ┆"))!
  const background = theme.getBgAnsi("searchMatchBg")
  expect(contextRow).not.toContain(background)
  expect(matchRow.replaceAll(background, "").replaceAll("\x1b[49m", "")).toContain(colored)

  const spans: string[] = []
  let active = false
  let span = ""
  // eslint-disable-next-line no-control-regex -- Inspect only the renderer's ANSI background spans.
  for (const token of matchRow.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
    if (token[0] === background) active = true
    else if (token[0] === "\x1b[49m" || token[0] === "\x1b[0m") {
      if (span) spans.push(span)
      span = ""
      active = false
    } else if (active && !token[0].startsWith("\x1b")) span += token[0]
  }
  if (span) spans.push(span)
  expect(spans).toEqual(["TaRgEt()", "target()"])
  expect(stripVTControlCharacters(matchRow)).toContain(code)
  expect(stripVTControlCharacters(contextRow)).toContain(code)
  expect(result).toEqual(original)
})

test("resolves directory/file targets and keeps recorded source when the live file changes or disappears", async () => {
  config.highlight.enable = true
  configureHighlighting(config.highlight)
  await fs.mkdir(join(dir, "src"))
  const path = join(dir, "src/a.ts")
  await fs.writeFile(path, "const value = 2")
  const result = textResult("a.ts:1: const value = 1")
  const original = structuredClone(result)
  context.args = { pattern: "value", path: "src", literal: true }
  invalidate.mockImplementation(() => {
    const output = stripVTControlCharacters(render(result))
    expect(output).toContain("const value = 1")
    expect(output).not.toContain("const value = 2")
  })
  const ready = () => {
    render(result)
    const runs = context.state.grep?.runs
    return (
      runs?.size === 1 &&
      [...runs.values()].every(
        (run) =>
          run.fileHighlight?.fallback === true &&
          run.fileHighlight.lines?.every((line: string | null) => line !== null) === true,
      )
    )
  }

  expect(stripVTControlCharacters(render(result))).toContain("const value = 1")
  await until(() => context.state.grep?.isFile === false && ready())
  const directoryState = context.state.grep
  expect(JSON.parse([...directoryState.runs.values()][0].fileHighlight.key)[0]).toBe(path)
  expect(stripVTControlCharacters(render(result))).toContain("src/a.ts")

  context.args = { pattern: "value", path: "src/a.ts", literal: true }
  render(result)
  await until(() => context.state.grep?.isFile === true && ready())
  expect(context.state.grep).not.toBe(directoryState)
  expect(JSON.parse([...context.state.grep.runs.values()][0].fileHighlight.key)[0]).toBe(path)

  await fs.rm(join(dir, "src"), { recursive: true })
  context.args = { pattern: "value", path: "src", literal: true }
  render(result)
  await until(() => context.state.grep?.isFile === null && ready())
  const expanded = stripVTControlCharacters(render(result, true))
  expect(expanded).toContain("const value = 1")
  expect(expanded).not.toContain("const value = 2")
  expect(invalidate).toHaveBeenCalled()
  expect(context.isError).toBe(false)
  expect(result).toEqual(original)
})

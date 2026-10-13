import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import type { ToolRenderers } from "@earendil-works/pi-coding-agent"
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Component,
} from "@earendil-works/pi-tui"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import * as highlighting from "../../src/highlight/index.ts"
import type { RenderContext, ToolResult } from "../../src/renderers/shared.ts"
import { createWriteRenderer } from "../../src/renderers/write.ts"

const theme = getThemeByName("dark")!
const invalidate = mock(() => {})
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: RenderContext
let call: Component | undefined
let previousKeys: ReturnType<typeof getKeybindings>

beforeEach(() => {
  config = createDefaultConfig()
  config.highlight.enable = false
  highlighting.configureHighlighting(config.highlight)
  renderer = createWriteRenderer(() => config)
  call = undefined
  invalidate.mockReset()
  context = {
    args: { path: "src/config.ts" },
    toolCallId: "write-renderer-test",
    cwd: process.cwd(),
    state: {},
    invalidate,
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    durationMs: 18,
    outputPad: 0,
  }
  previousKeys = getKeybindings()
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }))
})

afterEach(() => {
  highlighting.disposeHighlighting()
  setKeybindings(previousKeys)
  mock.restore()
})

function plain(component: Component): string[] {
  return component.render(160).map((line) => stripVTControlCharacters(line).trimEnd())
}

function draw(): string[] {
  context.lastComponent = call
  call = renderer.renderCall!(context.args, theme, context)
  return plain(call)
}

function result(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined }
}

test("previews the first configured lines with Read gutters, blanks, and dynamic folding hints", () => {
  const lines = Array.from({ length: 24 }, (_, index) =>
    index % 4 === 3 ? "" : `export const option${index + 1} = ${index + 1}`,
  )
  context.args = { path: "src/config.ts", content: lines.join("\n") }
  const original = structuredClone(context.args)
  const rows = lines.map((line, index) => `${String(index + 1).padStart(4)} │ ${line}`.trimEnd())
  const title = "write src/config.ts · typescript · 24 lines · 18ms"
  expect(draw()).toEqual([
    title,
    "",
    ...rows.slice(0, 8),
    "--- 16 lines hidden · ctrl+o to expand ---",
  ])
  const component = call
  expect(renderer.renderShell).toBeUndefined()
  getKeybindings().setUserBindings({ "app.tools.expand": "alt+o" })
  expect(draw().at(-1)).toBe("--- 16 lines hidden · alt+o to expand ---")
  config.tools.write = { collapsedLines: 3 }
  expect(draw()).toEqual([
    title,
    "",
    ...rows.slice(0, 3),
    "--- 21 lines hidden · alt+o to expand ---",
  ])
  getKeybindings().setUserBindings({ "app.tools.expand": [] })
  expect(draw().at(-1)).toBe("--- 21 lines hidden ---")
  context.expanded = true
  expect(draw()).toEqual([title, "", ...rows])
  expect(call).toBe(component)
  expect(context.args).toEqual(original)
})

test("highlights recorded streaming arguments without disk reads or stale lines after append and replacement", async () => {
  config.highlight.enable = true
  highlighting.configureHighlighting(config.highlight)
  config.tools.write = { collapsedLines: 1 }
  context.argsComplete = false
  const request = spyOn(highlighting, "highlightDocument")
  const fileRequest = spyOn(highlighting, "highlightFileDocument")
  const cancel = spyOn(highlighting, "cancelHighlightRequest")
  invalidate.mockImplementation(() => {
    draw()
  })
  const ready = async () => {
    const deadline = Date.now() + 5000
    while (true) {
      const latest = request.mock.results.at(-1)
      if (latest?.type === "return" && latest.value?.every((line) => line !== null)) return
      if (Date.now() > deadline) throw new Error("Write content highlighting did not finish")
      await nextTurn()
    }
  }
  const id = context.toolCallId + ":write:content"
  const source = 'const value = "before"\r\n/* open'
  context.args = { path: "src/config.ts", content: source }
  expect(draw()[2]).toBe('   1 │ const value = "before"')
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    id,
    subscriberId: id,
    source: source.replaceAll("\r\n", "\n"),
    language: "typescript",
    from: 0,
    to: 1,
    streaming: true,
  })
  await ready()
  context.expanded = true
  expect(draw()[3]).toBe("   2 │ /* open")
  expect(request.mock.calls.at(-1)?.[0].to).toBe(2)
  await ready()
  context.args = {
    path: "src/config.ts",
    content: source + '\ncomment */\nconst after = "\tready"\n',
  }
  expect(draw().slice(-3)).toEqual([
    "   3 │ comment */",
    '   4 │ const after = "    ready"',
    "   5 │",
  ])
  await ready()
  context.args = { path: "src/config.ts", content: 'const replaced = "new"\n\x1b[2J' }
  context.argsComplete = true
  expect(draw().slice(2)).toEqual(['   1 │ const replaced = "new"', "   2 │ ␛[2J"])
  await ready()
  expect(draw().join("\n")).not.toContain("before")
  expect(request.mock.calls.at(-1)?.[0].streaming).toBe(false)
  expect(invalidate).toHaveBeenCalled()
  expect(fileRequest).not.toHaveBeenCalled()
  context.args = { path: "src/config.ts", content: "" }
  draw()
  expect(cancel).toHaveBeenCalledWith(id)
  cancel.mockClear()
  config.highlight.enable = false
  context.args = { path: "src/config.ts", content: "const unhighlighted = true" }
  expect(draw()[2]).toBe("   1 │ const unhighlighted = true")
  expect(cancel).toHaveBeenCalledWith(id)
})

test("hides success text and retains the attempted source alongside actual failures", () => {
  context.args = { path: "/read-only/new.ts", content: "export const value = 1" }
  const preview = draw()
  context.lastComponent = undefined
  const success = result("Successfully wrote to /read-only/new.ts")
  const original = structuredClone(success)
  let output = renderer.renderResult!(
    success,
    { expanded: false, isPartial: false },
    theme,
    context,
  )
  expect(plain(output)).toEqual([])
  expect(success).toEqual(original)
  context.isError = true
  context.lastComponent = output
  const error = result("EACCES: permission denied\nAdditional details")
  const originalError = structuredClone(error)
  output = renderer.renderResult!(error, { expanded: false, isPartial: false }, theme, context)
  expect(plain(output)).toEqual(["", "EACCES: permission denied"])
  context.lastComponent = output
  expect(
    plain(renderer.renderResult!(error, { expanded: true, isPartial: false }, theme, context)),
  ).toEqual(["", "EACCES: permission denied", "Additional details"])
  expect(draw()).toEqual(preview)
  expect(error).toEqual(originalError)
  context.isError = false
  context.lastComponent = output
  expect(
    plain(renderer.renderResult!(success, { expanded: false, isPartial: false }, theme, context)),
  ).toEqual([])
})

test("distinguishes missing content from an empty file and preserves newline-only input", () => {
  context.argsComplete = false
  context.durationMs = undefined
  expect(draw()).toEqual(["write src/config.ts"])
  context.args = { path: "src/config.ts", content: "" }
  const foreground = spyOn(theme, "fg")
  expect(draw()).toEqual(["write src/config.ts · 0 lines"])
  expect(foreground.mock.calls).not.toContainEqual(["dim", "Empty file"])
  context.argsComplete = true
  expect(draw()).toEqual(["write src/config.ts · 0 lines", "", "Empty file"])
  expect(foreground.mock.calls).toContainEqual(["dim", "Empty file"])
  context.args = { path: "src/config.ts" }
  expect(draw()).toEqual(["write src/config.ts"])
  context.args = { path: "src/config.ts", content: "\n" }
  expect(draw()).toEqual(["write src/config.ts · typescript · 2 lines", "", "   1 │", "   2 │"])
  context.args = { path: "notes.unknown", content: "plain text" }
  expect(draw()).toEqual(["write notes.unknown · 1 line", "", "   1 │ plain text"])
})

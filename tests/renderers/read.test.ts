import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import { truncateHead, type ToolRenderers } from "@earendil-works/pi-coding-agent"
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import { configureHighlighting, disposeHighlighting } from "../../src/highlight/index.ts"
import { createReadRenderer } from "../../src/renderers/read.ts"

type ReadResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0]
type ReadContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3]

let dir: string
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: ReadContext
const theme = getThemeByName("dark")!
const invalidate = mock(() => {})
let previousKeybindings: ReturnType<typeof getKeybindings>

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "read-renderer-"))
  config = createDefaultConfig()
  config.highlight.enable = false
  configureHighlighting(config.highlight)
  renderer = createReadRenderer(() => config)
  invalidate.mockReset()
  context = {
    args: { path: "source.ts" },
    toolCallId: "read-renderer-test",
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
  previousKeybindings = getKeybindings()
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }))
})

afterEach(async () => {
  disposeHighlighting()
  setKeybindings(previousKeybindings)
  mock.restore()
  await fs.rm(dir, { recursive: true, force: true })
})

function textResult(text: string, details?: ReadResult["details"]): ReadResult {
  return { content: [{ type: "text", text }], details }
}

function render(result: ReadResult, expanded = false): string {
  context.expanded = expanded
  const component = renderer.renderResult!(result, { expanded, isPartial: false }, theme, context)
  context.lastComponent = component
  return stripVTControlCharacters(component.render(200).join("\n"))
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Read renderer did not finish asynchronous preparation")
    await nextTurn()
  }
}

function enableHighlighting(): void {
  config.highlight.enable = true
  configureHighlighting(config.highlight)
}

describe("collapsed and expanded Read", () => {
  test("shows only the first configured lines, with actual offset-based numbers", () => {
    context.args = { path: "source.ts", offset: 41 }
    config.collapsedLines = 8
    const lines = Array.from({ length: 20 }, (_, index) => `const line${index + 41} = true`)
    const result = textResult(lines.join("\n"))
    const collapsed = render(result)
    for (let number = 41; number <= 48; number++)
      expect(collapsed).toContain(`${number} │ const line${number} = true`)
    for (let number = 49; number <= 60; number++)
      expect(collapsed).not.toContain(`const line${number} = true`)
    expect(collapsed).toContain("12 lines hidden")

    const expanded = render(result, true)
    for (let number = 41; number <= 60; number++)
      expect(expanded).toContain(`${number} │ const line${number} = true`)
    expect(expanded).not.toContain("lines hidden")
  })
})

describe("continuation notices and tool truncation", () => {
  test("removes a native limit continuation notice in both views", () => {
    context.args = { path: "source.ts", limit: 60 }
    const source = Array.from({ length: 60 }, (_, index) => `const line${index + 1} = true`).join(
      "\n",
    )
    const text = source + "\n\n[90 more lines in file. Use offset=61 to continue.]"
    const result = textResult(text)
    for (const expanded of [false, true]) {
      const output = render(result, expanded)
      expect(output).toContain("1 │ const line1 = true")
      expect(output).not.toContain("more lines in file")
      expect(output).not.toContain("offset=61")
      expect(output).not.toContain("Output truncated")
    }
    expect(render(result, true)).toContain("60 │ const line60 = true")
    expect(result.content).toEqual([{ type: "text", text }])
  })

  test.each(["lines", "bytes"] as const)(
    "keeps returned source and a short warning after native %s truncation",
    (kind) => {
      const input =
        kind === "lines"
          ? Array.from({ length: 2001 }, (_, index) => `const line${index + 1} = true`).join("\n")
          : "const first = true\n" + "x".repeat(60_000)
      const truncation = truncateHead(input)
      expect(truncation.truncatedBy).toBe(kind)
      const nextOffset = truncation.outputLines + 1
      const result = textResult(
        truncation.content +
          `\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}. Use offset=${nextOffset} to continue.]`,
        { truncation },
      )
      const notice =
        kind === "lines" ? "Output truncated (2,000-line limit)" : "Output truncated (50 KB limit)"
      for (const expanded of [false, true]) {
        const output = render(result, expanded)
        expect(output).toContain(
          kind === "lines" ? "1 │ const line1 = true" : "1 │ const first = true",
        )
        if (expanded || truncation.outputLines < config.collapsedLines) {
          expect(output).toContain(notice)
        } else {
          expect(output).not.toContain(notice)
          expect(output).toContain(
            `${truncation.outputLines + 1 - config.collapsedLines} lines hidden`,
          )
        }
        expect(output).not.toContain("Showing lines")
        expect(output).not.toContain("Use offset=")
      }
      const expanded = render(result, true)
      if (kind === "lines") {
        expect(expanded).toContain("2000 │ const line2000 = true")
        expect(expanded).not.toContain("const line2001 = true")
      } else {
        expect(expanded).not.toContain("xxx")
      }
    },
  )

  test.each([
    { path: "source.ts" },
    { path: "source.ts", limit: 3 },
    { path: "source.ts", limit: 2, offset: 10 },
  ])("preserves notice-like source when extraction conditions do not match: %j", (args) => {
    context.args = args
    const source = "first\nsecond\n\n[90 more lines in file. Use offset=3 to continue.]"
    const output = render(textResult(source), true)
    expect(output).toContain("first")
    expect(output).toContain("│ [90 more lines in file. Use offset=3 to continue.]")
  })
})

describe("historical source highlighting", () => {
  test("falls back to returned text when the disk file has changed and requests a redraw", async () => {
    enableHighlighting()
    await fs.writeFile(join(dir, "source.ts"), "const value = 2")
    const result = textResult("const value = 1")
    invalidate.mockImplementation(() => {
      const output = render(result)
      expect(output).toContain("const value = 1")
      expect(output).not.toContain("const value = 2")
    })
    expect(render(result)).toContain("const value = 1")
    expect(render(result)).not.toContain("const value = 2")

    await until(
      () => context.state.fileHighlight?.fallback === true && invalidate.mock.calls.length >= 2,
    )
    expect(invalidate).toHaveBeenCalled()
    expect(render(result, true)).toContain("const value = 1")
    expect(render(result, true)).not.toContain("const value = 2")
  })
})

describe("asynchronous state coordination", () => {
  test("ignores late A preparation, advances B, and reuses completed preparation on redraw", async () => {
    enableHighlighting()
    const aPath = join(dir, "a.ts")
    const bPath = join(dir, "b.ts")
    await fs.writeFile(aPath, "const a = 1")
    await fs.writeFile(bPath, "const b = 2")
    const aGate = Promise.withResolvers<void>()
    const bGate = Promise.withResolvers<void>()
    const aStarted = Promise.withResolvers<void>()
    const bStarted = Promise.withResolvers<void>()
    const aClosed = Promise.withResolvers<void>()
    const originalOpen = fs.open
    const open = spyOn(fs, "open").mockImplementation(async (...args) => {
      const isA = args[0] === aPath
      ;(isA ? aStarted : bStarted).resolve()
      await (isA ? aGate : bGate).promise
      const handle = await originalOpen(...args)
      if (isA) {
        const close = handle.close.bind(handle)
        spyOn(handle, "close").mockImplementation(async () => {
          await close()
          aClosed.resolve()
        })
      }
      return handle
    })
    const stat = spyOn(fs, "stat")
    const aResult = textResult("const a = 1")
    const bResult = textResult("const b = 2")
    try {
      context.args = { path: "a.ts" }
      render(aResult)
      await aStarted.promise
      const aState = context.state.fileHighlight
      context.args = { path: "b.ts" }
      expect(render(bResult)).toContain("const b = 2")
      await bStarted.promise
      const bState = context.state.fileHighlight
      expect(bState).not.toBe(aState)

      aGate.resolve()
      await aClosed.promise
      await nextTurn()
      expect(context.state.fileHighlight).toBe(bState)
      expect(bState.pending).toBe(true)
      expect(bState.lines).toBeUndefined()
      expect(invalidate).not.toHaveBeenCalled()
      expect(render(bResult)).not.toContain("const a = 1")

      bGate.resolve()
      await until(() => {
        render(bResult)
        return bState.lines?.every((line: string | null) => line !== null) === true
      })
      expect(context.state.fileHighlight).toBe(bState)
      expect(render(bResult)).toContain("const b = 2")
      expect(render(bResult)).not.toContain("const a = 1")
      expect(invalidate).toHaveBeenCalled()

      const statCount = stat.mock.calls.length
      const redrawCount = invalidate.mock.calls.length
      for (let i = 0; i < 10; i++) render(bResult)
      await nextTurn()
      expect(open).toHaveBeenCalledTimes(2)
      expect(stat).toHaveBeenCalledTimes(statCount)
      expect(invalidate).toHaveBeenCalledTimes(redrawCount)
    } finally {
      aGate.resolve()
      bGate.resolve()
    }
  })
})

describe("expand keybinding hints", () => {
  test("reflects rebindings and omits the hint when no key is bound", () => {
    const result = textResult(Array.from({ length: 20 }, () => "source line").join("\n"))
    const bindings = getKeybindings()
    expect(render(result)).toContain("ctrl+o to expand")
    bindings.setUserBindings({ "app.tools.expand": "alt+o" })
    const rebound = render(result)
    expect(rebound).toContain("alt+o to expand")
    expect(rebound.toLowerCase()).not.toContain("ctrl+o")

    bindings.setUserBindings({ "app.tools.expand": [] })
    const unbound = render(result)
    expect(unbound).toContain("--- 12 lines hidden ---")
    expect(unbound).not.toContain("to expand")
  })
})

test("errors and images stay outside the source and highlighting paths", async () => {
  enableHighlighting()
  await fs.writeFile(join(dir, "source.ts"), "const value = 1")
  const open = spyOn(fs, "open")
  const error = textResult("ENOENT: missing file\nAdditional error details")
  context.isError = true
  expect(render(error)).toContain("ENOENT: missing file")
  expect(render(error)).not.toContain("Additional error details")
  expect(render(error, true)).toContain("Additional error details")
  expect(render(error, true)).not.toContain("│")

  context.isError = false
  const image: ReadResult = {
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "", mimeType: "image/png" },
    ],
    details: undefined,
  }
  expect(render(image)).toContain("Read image file [image/png]")
  expect(render(image)).not.toContain("│")
  await nextTurn()
  expect(open).not.toHaveBeenCalled()
  expect(context.state.fileHighlight).toBeUndefined()
  expect(invalidate).not.toHaveBeenCalled()
})

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import { formatSize, truncateTail, type ToolRenderers } from "@earendil-works/pi-coding-agent"
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Component,
} from "@earendil-works/pi-tui"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import * as highlighting from "../../src/highlight/index.ts"
import { createShellRenderer } from "../../src/renderers/shell.ts"
import type { RenderContext, ToolResult } from "../../src/renderers/shared.ts"

const theme = getThemeByName("dark")!
const invalidate = mock(() => {})
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: RenderContext
let previousKeys: ReturnType<typeof getKeybindings>

beforeEach(() => {
  config = createDefaultConfig()
  config.highlight.enable = false
  highlighting.configureHighlighting(config.highlight)
  renderer = createShellRenderer("bash", () => config)
  invalidate.mockReset()
  context = {
    args: { command: "git status --short" },
    toolCallId: "shell-renderer-test",
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
    durationMs: 42,
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

function textResult(text: string, details?: ToolResult["details"]): ToolResult {
  return { content: [{ type: "text", text }], details }
}

function render(
  result: ToolResult,
  { width = 120, expanded = false, isPartial = false } = {},
): string[] {
  context.expanded = expanded
  context.isPartial = isPartial
  const component = renderer.renderResult!(result, { expanded, isPartial }, theme, context)
  context.lastComponent = component
  return component.render(width)
}

function plain(rows: string[]): string[] {
  return rows.map((line) => stripVTControlCharacters(line).trimEnd())
}

test("keeps the last configured output rows with a preceding dynamic expansion hint", () => {
  const lines = Array.from({ length: 10 }, (_, index) => "line " + (index + 1))
  const result = textResult(lines.join("\n"))
  const original = structuredClone(result)
  const title = plain(renderer.renderCall!(context.args, theme, context).render(120))
  expect(title).toEqual(["bash $ git status --short · 42ms"])
  expect(renderer.renderShell).toBeUndefined()

  const collapsed = plain(render(result))
  expect(collapsed.slice(-8)).toEqual(lines.slice(-8))
  expect(collapsed[1]).toBe("--- 2 lines hidden · ctrl+o to expand ---")
  expect(collapsed).not.toContain("line 1")
  expect(collapsed).not.toContain("line 2")
  getKeybindings().setUserBindings({ "app.tools.expand": "alt+o" })
  expect(plain(render(result))[1]).toBe("--- 2 lines hidden · alt+o to expand ---")
  expect(plain(render(result, { expanded: true }))).toEqual(["", ...lines])
  expect(result).toEqual(original)
})

test("recomputes tail folding after resize using visible columns rather than logical lines", () => {
  config.tools.bash = { collapsedLines: 2 }
  const result = textResult("中文".repeat(18) + "\nEND")
  const component = renderer.renderResult!(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  )
  const narrow = plain(component.render(24))
  expect(narrow.join("\n")).toContain("2 lines hidden")
  expect(narrow.slice(-2)).toEqual(["中文".repeat(6), "END"])
  expect(plain(component.render(72))).toEqual(["", "中文".repeat(18), "END"])
  expect(plain(component.render(24))).toEqual(narrow)
  expect(plain(render(result, { width: 24, expanded: true }))).toEqual([
    "",
    "中文".repeat(6),
    "中文".repeat(6),
    "中文".repeat(6),
    "END",
  ])
})

test("reuses streaming previews, safely strips terminal controls, and only labels final empty output", () => {
  config.collapsedLines = 2
  expect(render(textResult(""), { isPartial: true })).toEqual([])
  const component = context.lastComponent
  expect(
    plain(render(textResult("old one\nold two\nold three"), { isPartial: true })).slice(-2),
  ).toEqual(["old two", "old three"])
  expect(context.lastComponent).toBe(component)

  const text = "new first\r\n\x1b[2J\x1b]0;untrusted title\x07\x1b[31mnew second\x1b[0m\nnew third"
  const result = textResult(text)
  const original = structuredClone(result)
  const raw = render(result, { isPartial: true }).join("\n")
  expect(plain(raw.split("\n")).slice(-2)).toEqual(["new second", "new third"])
  expect(raw).not.toContain("\x1b[2J")
  expect(raw).not.toContain("\x1b[31m")
  expect(raw).not.toContain("untrusted title")
  expect(raw).not.toContain("old ")
  expect(raw).not.toContain("(no output)")
  expect(result).toEqual(original)

  expect(plain(render(textResult("done")))).toEqual(["", "done"])
  expect(plain(render(textResult("")))).toEqual(["", "(no output)"])
  expect(plain(render(textResult("(no output)")))).toEqual(["", "(no output)"])
  expect(context.lastComponent).toBe(component)
})

test("colors only corroborated final Pi status, never keywords in program logs", () => {
  const foreground = spyOn(theme, "fg")
  const logs = "Compiling...\nerror TS2322\nfatal: failed is ordinary program output"
  const status = "Command exited with code 2"
  const cases = [
    { isError: true, structuredContent: { exit_code: 2 }, isPartial: false, expected: [status] },
    { isError: true, structuredContent: { exit_code: 3 }, isPartial: false, expected: [] },
    { isError: true, structuredContent: undefined, isPartial: false, expected: [] },
    { isError: false, structuredContent: { exit_code: 2 }, isPartial: false, expected: [] },
    { isError: true, structuredContent: { exit_code: 2 }, isPartial: true, expected: [] },
  ]
  for (const entry of cases) {
    foreground.mockClear()
    context.isError = entry.isError
    const result = {
      ...textResult(logs + "\n\n" + status),
      structuredContent: entry.structuredContent,
    }
    const original = structuredClone(result)
    const output = plain(render(result, { isPartial: entry.isPartial })).join("\n")
    expect(
      foreground.mock.calls.filter(([color]) => color === "error").map(([, text]) => text),
    ).toEqual(entry.expected)
    expect(
      foreground.mock.calls.filter(([color]) => color === "toolOutput").map(([, text]) => text),
    ).toContain("fatal: failed is ordinary program output")
    expect(output).toContain(logs)
    expect(output).toContain(status)
    expect(output).not.toContain("Exit code 2")
    expect(result).toEqual(original)
  }

  context.isError = true
  for (const [status, timeout, confirmed] of [
    ["Command aborted", undefined, true],
    ["Command terminated without an exit code", undefined, true],
    ["Command timed out after 30 seconds", 30, true],
    ["Command timed out after 30 seconds", 29, false],
    ["Command timed out after 30 seconds", undefined, false],
  ] as const) {
    foreground.mockClear()
    context.args = { command: "sleep 60", timeout }
    render(textResult(logs + "\n\n" + status))
    expect(
      foreground.mock.calls.filter(([color]) => color === "error").map(([, text]) => text),
    ).toEqual(confirmed ? [status] : [])
  }
})

test("replaces only verified truncation footers and keeps warnings and paths outside the tail budget", () => {
  config.collapsedLines = 2
  context.isError = true
  const path = "/tmp/pi-bash-not-created[check].log"
  const truncations = [
    truncateTail("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine", { maxLines: 6 }),
    truncateTail(
      Array.from({ length: 200 }, (_, index) => "log " + index + " " + "x".repeat(300)).join("\n"),
    ),
    truncateTail("prefix\n" + "x".repeat(1000), { maxBytes: 80 }),
  ]
  for (const truncation of truncations) {
    const start = truncation.totalLines - truncation.outputLines + 1
    const range = `Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}`
    const footer = truncation.lastLinePartial
      ? `Showing last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines} (line is ${formatSize(1000)}). Full output: ${path}`
      : range +
        (truncation.truncatedBy === "bytes" ? ` (${formatSize(truncation.maxBytes)} limit)` : "") +
        `. Full output: ${path}`
    const status = "\n\nCommand exited with code 2"
    const baseline = plain(
      render({ ...textResult(truncation.content + status), structuredContent: { exit_code: 2 } }),
    )
    const result = {
      ...textResult(truncation.content + "\n\n[" + footer + "]" + status, {
        truncation,
        fullOutputPath: path,
      }),
      structuredContent: { exit_code: 2 },
    }
    const original = structuredClone(result)
    const collapsed = plain(render(result))
    expect(collapsed.slice(0, -3)).toEqual(baseline)
    expect(collapsed.at(-1)).toBe("Full output: " + path)
    expect(collapsed.at(-2)).toMatch(/^Output truncated \(.+ limit\)$/)
    expect(collapsed.join("\n")).not.toContain("Showing ")
    const expanded = plain(render(result, { expanded: true })).join("\n")
    expect(expanded).toContain("Command exited with code 2")
    expect(expanded).toContain("Full output: " + path)
    expect(expanded).not.toContain("lines hidden")
    expect(expanded).not.toContain("Showing ")
    expect(result).toEqual(original)
  }

  const truncation = truncations[0]!
  const footer = "\n\n[Showing lines 4-9 of 9. Full output: " + path + "]"
  const raw = truncation.content + footer
  expect(plain(render(textResult(raw), { expanded: true })).join("\n")).toContain(footer)
  const mismatched = textResult(raw, {
    truncation: { ...truncation, content: "not the recorded prefix" },
    fullOutputPath: path,
  })
  expect(plain(render(mismatched, { expanded: true })).join("\n")).toContain(footer)
})

test.each(["bash", "powershell"] as const)(
  "%s highlights only the requested command range, preserves normalized content, and cancels unused subscriptions",
  async (name) => {
    renderer = createShellRenderer(name, () => config)
    config.highlight.enable = true
    highlighting.configureHighlighting(config.highlight)
    const source =
      name === "bash"
        ? "for file in src/*.ts; do\r\n\tprintf '%s\\n' \"$file\"\r\ndone"
        : "$items = Get-ChildItem\r\n\tWrite-Output $items"
    const normalized = source.replace(/\r\n?/g, "\n").replaceAll("\t", "    ")
    context.args = { command: source }
    context.durationMs = 86
    const request = spyOn(highlighting, "highlightDocument")
    const cancel = spyOn(highlighting, "cancelHighlightRequest")
    const foreground = spyOn(theme, "fg")
    let call: Component | undefined
    const draw = () => {
      context.lastComponent = call
      call = renderer.renderCall!(context.args, theme, context)
      return plain(call.render(160))
    }
    invalidate.mockImplementation(() => {
      draw()
    })
    const collapsed = draw()
    expect(collapsed).toEqual([
      `${name} ${name === "bash" ? "$" : "PS>"} ${normalized.split("\n")[0]} … · 86ms`,
    ])
    expect(foreground.mock.calls).toContainEqual(["accent", normalized.split("\n")[0]!])
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      id: context.toolCallId + ":shell-command",
      subscriberId: context.toolCallId + ":shell-command",
      source: normalized,
      language: name,
      from: 0,
      to: 1,
    })

    context.expanded = true
    const lines = normalized.split("\n")
    const expanded = draw()
    expect(expanded[0]).toBe(`${name} ${name === "bash" ? "$" : "PS>"} ${lines[0]} · 86ms`)
    expect(
      expanded.slice(1).map((line) => line.slice(name.length + (name === "bash" ? 1 : 3) + 2)),
    ).toEqual(lines.slice(1))
    expect(request.mock.calls.at(-1)?.[0].to).toBe(lines.length)

    const ready = () => {
      const result = request.mock.results.at(-1)
      return result?.type === "return" && result.value?.every((line) => line !== null)
    }
    const deadline = Date.now() + 5000
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("Shell command highlighting did not finish")
      await nextTurn()
    }
    expect(invalidate).toHaveBeenCalled()
    expect(draw()).toEqual(expanded)
    expect(context.args).toEqual({ command: source })

    context.args = { command: source + "\n# appended" }
    expect(draw().at(-1)?.trim()).toBe("# appended")
    expect(request.mock.calls.at(-1)?.[0].id).toBe(context.toolCallId + ":shell-command")
    config.highlight.enable = false
    draw()
    expect(cancel).toHaveBeenCalledWith(context.toolCallId + ":shell-command")
    cancel.mockClear()
    config.highlight.enable = true
    context.args = { command: "" }
    draw()
    expect(cancel).toHaveBeenCalledWith(context.toolCallId + ":shell-command")
  },
)

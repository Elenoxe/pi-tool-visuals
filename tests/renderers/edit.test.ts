import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters } from "node:util"

import type { ToolRenderers } from "@earendil-works/pi-coding-agent"
import {
  backgroundAnsi,
  Box,
  mixColors,
  sliceByColumn,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Component,
} from "@earendil-works/pi-tui"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import * as highlighting from "../../src/highlight/index.ts"
import { createEditRenderer } from "../../src/renderers/edit.ts"
import type { RenderContext, ToolResult } from "../../src/renderers/shared.ts"

function backgrounds(kind: "-" | "+") {
  const base = theme.colors[kind === "-" ? "toolErrorBg" : "toolSuccessBg"]
  const tint = theme.colors[kind === "-" ? "toolDiffRemoved" : "toolDiffAdded"]
  return {
    line: backgroundAnsi(mixColors(base, tint, 0.14, "srgb"), theme.getColorMode()),
    word: backgroundAnsi(mixColors(base, tint, 0.3, "srgb"), theme.getColorMode()),
  }
}

const textFiles: { readFile(path: string, encoding: "utf8"): Promise<string> } = fs
let theme = getThemeByName("dark")!
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: RenderContext
let call: Component
let directory: string
let keys: ReturnType<typeof getKeybindings>
const invalidate = mock(() => {})

beforeEach(() => {
  theme = getThemeByName("dark")!
  directory = mkdtempSync(join(tmpdir(), "edit-renderer-"))
  config = createDefaultConfig()
  config.highlight.enable = false
  highlighting.configureHighlighting(config.highlight)
  renderer = createEditRenderer(() => config)
  invalidate.mockReset()
  context = {
    args: {
      path: "config.ts",
      edits: [{ oldText: "const value = 30", newText: "const value = 60" }],
    },
    toolCallId: "edit-test",
    cwd: directory,
    state: {},
    invalidate,
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: true,
    showImages: true,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
  }
  keys = getKeybindings()
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }))
})

afterEach(() => {
  mock.restore()
  highlighting.disposeHighlighting()
  setKeybindings(keys)
  rmSync(directory, { recursive: true, force: true })
})

function plain(component: Component): string[] {
  return component.render(180).map((line) => stripVTControlCharacters(line).trimEnd())
}
function draw(): string[] {
  context.lastComponent = call
  call = renderer.renderCall!(context.args, theme, context)
  return plain(call)
}
function finish(diff?: string, error?: string): string[] {
  context.isPartial = false
  context.isError = error !== undefined
  context.durationMs = 24
  draw()
  context.lastComponent = undefined
  const result: ToolResult = {
    content: [{ type: "text", text: error ?? "Successfully replaced text in config.ts." }],
    details: diff === undefined ? undefined : { diff },
  }
  const original = structuredClone(result)
  const output = renderer.renderResult!(
    result,
    { expanded: context.expanded, isPartial: false },
    theme,
    context,
  )
  expect(result).toEqual(original)
  return [...plain(call), ...plain(output)]
}
async function ready(): Promise<void> {
  const end = Date.now() + 5000
  while (!invalidate.mock.calls.length) {
    if (Date.now() > end) throw new Error("Edit preview did not finish")
    await nextTurn()
  }
}
async function preview(source: string): Promise<string[]> {
  writeFileSync(join(directory, "config.ts"), source)
  draw()
  await ready()
  return draw()
}

test("renders a matched substring as a full file Diff with real line numbers and context", async () => {
  context.args = { path: "config.ts", edits: [{ oldText: "30", newText: "60" }] }
  const args = structuredClone(context.args)
  const lines = await preview("header\nconst value = 30\nfooter\n")
  expect(lines).toEqual([
    "edit config.ts · typescript",
    "",
    "1 edit · +1 -1",
    "",
    "    1 │ header",
    "-   2 │ const value = 30",
    "+   2 │ const value = 60",
    "    3 │ footer",
  ])
  const component = call
  draw()
  expect(call).toBe(component)
  expect(renderer.renderShell).toBe("default")
  expect(context.args).toEqual(args)
})

test("shows one coherent matched file Diff with shared highlighting and accurate totals", async () => {
  const oldBlock = 'const url = "old"\nconst headers = {}\nconst cache = "no-store"'
  const newBlock =
    'const url = "new"\nconst headers = { Accept: "json" }\nconst cache = "force-cache"'
  context.args = {
    path: "config.ts",
    edits: [
      { oldText: "const timeout = 30", newText: "const timeout = 60" },
      { oldText: oldBlock, newText: newBlock },
    ],
  }
  context.expanded = false
  config.highlight.enable = true
  const request = spyOn(highlighting, "highlightDocument").mockImplementation(() => null)
  const file = spyOn(highlighting, "highlightFileDocument")
  const rows = await preview("const timeout = 30\n\n" + oldBlock + "\n")
  expect(rows[0]).toBe("edit config.ts · typescript")
  expect(rows[2]).toBe("2 edits · +4 -4")
  expect(rows.join("\n")).not.toContain("Proposed change")
  expect(rows.at(-1)).toBe("--- 1 line hidden · ctrl+o to expand ---")
  expect(request.mock.calls.map(([options]) => options.source)).toEqual([
    "const timeout = 30\n\n" + oldBlock,
    "const timeout = 60\n\n" + newBlock,
  ])
  context.expanded = true
  const expanded = draw()
  expect(expanded).toContain('+   5 │ const cache = "force-cache"')
  expect(file).not.toHaveBeenCalled()
  const actual = [
    "-1 const timeout = 30",
    "+1 const timeout = 60",
    " 2 ",
    ...oldBlock.split("\n").map((line, index) => `-${index + 3} ${line}`),
    ...newBlock.split("\n").map((line, index) => `+${index + 3} ${line}`),
  ].join("\n")
  const completed = finish(actual)
  expect(completed[2]).toBe("2 edits · +4 -4")
  expect(completed.join("\n")).not.toContain("Proposed change")
  expect(completed.slice(1)).toEqual(expanded.slice(1))
})

test("combines two edits on one physical line into a single displayed replacement", async () => {
  context.args = {
    path: "config.ts",
    edits: [
      { oldText: "left", newText: "LEFT" },
      { oldText: "right", newText: "RIGHT" },
    ],
  }
  const rows = await preview("left + right\n")
  expect(rows[2]).toBe("2 edits · +1 -1")
  expect(rows.slice(4)).toEqual(["-   1 │ left + right", "+   1 │ LEFT + RIGHT"])
  expect(rows.join("\n")).not.toContain("Proposed change")
})

test("restored failures display all proposed groups and their totals without reading files", async () => {
  context.args = {
    path: "config.ts",
    edits: [
      { oldText: "const concurrency = 4", newText: "const concurrency = 8" },
      { oldText: "const retries = 1", newText: "const retries = 5" },
    ],
  }
  const read = spyOn(fs, "readFile")
  finish(undefined, "Could not find edits[1]")
  await ready()
  const rows = finish(undefined, "Could not find edits[1]")
  expect(rows[2]).toBe("2 edits · +2 -2")
  expect(rows).toContain("Proposed change 1/2 · +1 -1")
  expect(rows).toContain("Proposed change 2/2 · +1 -1")
  expect(rows).toContain("- │ const concurrency = 4")
  expect(rows).toContain("+ │ const retries = 5")
  expect(rows.at(-1)).toBe("Could not find edits[1]")
  expect(read).not.toHaveBeenCalled()
})

test("matches every edit against the original and updates new-side line numbers", async () => {
  context.args = {
    path: "config.ts",
    edits: [
      { oldText: "line18", newText: "line18 changed" },
      { oldText: "line2\n", newText: "new2\nextra\n" },
    ],
  }
  const rows = await preview(Array.from({ length: 24 }, (_, i) => `line${i + 1}`).join("\n") + "\n")
  expect(rows[0]).toBe("edit config.ts · typescript")
  expect(rows[2]).toBe("2 edits · +3 -2")
  expect(rows.join("\n")).not.toContain("Proposed change")
  expect(rows.indexOf("-   2 │ line2")).toBeLessThan(rows.indexOf("-  18 │ line18"))
  expect(rows).toContain("-   2 │ line2")
  expect(rows).toContain("+   3 │ extra")
  expect(rows).toContain("-  18 │ line18")
  expect(rows).toContain("+  19 │ line18 changed")
  const output = rows.join("\n")
  expect(rows.filter((row) => row.includes("⋮"))).toHaveLength(1)
  expect(output).not.toContain("hidden")
})

test.each([
  { source: "missing\n", edits: [{ oldText: "old", newText: "new" }] },
  { source: "old old\n", edits: [{ oldText: "old", newText: "new" }] },
  { source: "aaaa\n", edits: [{ oldText: "aa", newText: "new" }] },
  {
    source: "abcd\n",
    edits: [
      { oldText: "abc", newText: "x" },
      { oldText: "bc", newText: "y" },
    ],
  },
  { source: "old\n", edits: [{ oldText: "", newText: "inserted" }] },
])("falls back without misleading fragment line numbers: %j", async ({ source, edits }) => {
  context.args = { path: "config.ts", edits }
  const rows = await preview(source)
  expect(rows.join("\n")).toContain(`Proposed change 1/${edits.length} ·`)
  expect(rows.filter((row) => /^[+-] \d/.test(row))).toEqual([])
  for (const edit of edits) {
    if (edit.oldText) expect(rows).toContain("- │ " + edit.oldText)
    expect(rows).toContain("+ │ " + edit.newText)
  }
})

test("accepts overlapping substrings when there is only one non-overlapping occurrence", async () => {
  context.args = { path: "config.ts", edits: [{ oldText: "aa", newText: "b" }] }
  const rows = await preview("aaa\n")
  expect(rows[2]).toBe("1 edit · +1 -1")
  expect(rows.slice(4)).toEqual(["-   1 │ aaa", "+   1 │ ba"])
  expect(rows.join("\n")).not.toContain("Proposed change")
})

test("unreadable paths propose all edits, with the ordinary collapsed budget", async () => {
  context.args = {
    path: "missing.ts",
    edits: Array.from({ length: 12 }, (_, i) => ({ oldText: `old${i}`, newText: `new${i}` })),
  }
  context.expanded = false
  draw()
  await ready()
  const collapsed = draw()
  expect(collapsed[2]).toBe("12 edits · +12 -12")
  expect(collapsed).toContain("Proposed change 4/12 · +1 -1")
  expect(collapsed.join("\n")).not.toContain("Proposed change 5/12")
  expect(collapsed.at(-1)).toBe("--- 16 lines hidden · ctrl+o to expand ---")
  config.tools.edit = { collapsedLines: 2 }
  expect(draw().at(-1)).toBe("--- 22 lines hidden · ctrl+o to expand ---")
  expect(draw().join("\n")).not.toContain("Proposed change 2/12")
  context.expanded = true
  expect(draw()).toContain("+ │ new11")
  expect(draw().join("\n")).not.toContain("hidden")
})

test.each(["\n", "\r\n", "\r"])(
  "normalizes BOM and %j, supports native single-edit arguments and multiline replacement",
  async (ending) => {
    context.args = {
      path: "config.ts",
      oldText: "const value = 30\r\nold",
      newText: "const value = 60\rnew\rmore",
    }
    const rows = await preview(
      "\uFEFF" + ["head", "const value = 30", "old", "tail", ""].join(ending),
    )
    expect(rows[2]).toBe("1 edit · +3 -2")
    expect(rows.join("\n")).not.toContain("Proposed change")
    expect(rows).toContain("-   2 │ const value = 30")
    expect(rows).toContain("+   4 │ more")
    expect(rows).toContain("    4 │ tail")
  },
)

test("actual diff replaces the preview even when it disagrees; success text stays hidden", async () => {
  await preview("const value = 30\n")
  const read = spyOn(fs, "readFile")
  const rows = finish(
    "- 47 entirely different\n+ 48 actual result\n+ 49 another addition\n      ...",
  )
  expect(rows).toEqual([
    "edit config.ts · typescript · 24ms",
    "",
    "1 edit · +2 -1",
    "",
    "-  47 │ entirely different",
    "+  48 │ actual result",
    "+  49 │ another addition",
  ])
  expect(draw()).toEqual(rows)
  expect(read).not.toHaveBeenCalled()
  expect(rows.join("\n")).not.toContain("Proposed change")
})

test("restored success, missing diffs and restored failures never read current files", async () => {
  context.isPartial = false
  const read = spyOn(fs, "readFile")
  expect(finish("-10001 old\n+10001 new")).toContain("-10001 │ old")
  expect(finish()).toContain("Diff unavailable")
  expect(draw().join("\n")).not.toContain("const value")
  context.state = {}
  const error = finish(undefined, "Could not find the exact text in config.ts.\nMore details")
  expect(error).toContain("More details")
  await ready()
  expect(draw()).toContain("Proposed change 1/1 · +1 -1")
  expect(read).not.toHaveBeenCalled()
})

test("retains the matched file preview on failure and uses the existing error renderer", async () => {
  await preview("const value = 30\n")
  context.expanded = false
  const rows = finish(undefined, "Could not find the exact text in config.ts.\nMore details")
  expect(rows).toContain("-   1 │ const value = 30")
  expect(rows).toContain("+   1 │ const value = 60")
  expect(rows.join("\n")).not.toContain("Proposed change")
  expect(rows).toContain("Could not find the exact text in config.ts.")
  expect(rows).not.toContain("More details")
  context.expanded = true
  expect(finish(undefined, "error\nMore details")).toContain("More details")
})

test("does not read or propose incomplete/invalid arguments", async () => {
  const read = spyOn(fs, "readFile")
  context.argsComplete = false
  draw()
  await nextTurn()
  expect(read).not.toHaveBeenCalled()
  context.argsComplete = true
  context.args = { path: "config.ts", edits: [{ oldText: 42, newText: "new" }] }
  expect(draw()).toEqual(["edit config.ts · typescript"])
  expect(read).not.toHaveBeenCalled()
})

test("omits trailing gaps before folding but retains middle gaps and literal context", () => {
  config.tools.edit = { collapsedLines: 2 }
  context.expanded = false
  expect(finish("-18 old\n+18 new\n     ...\n     ...").slice(4)).toEqual([
    "-  18 │ old",
    "+  18 │ new",
  ])
  context.expanded = true
  expect(
    finish("-18 old\n+18 new\n     ...\n-47 before\n+47 after\n 48 ...\n     ...").slice(4),
  ).toEqual([
    "-  18 │ old",
    "+  18 │ new",
    "    ⋮",
    "-  47 │ before",
    "+  47 │ after",
    "   48 │ ...",
  ])
})

test("counts only folded diff rows, keeps native omission markers separate and removes hidden highlight demand", () => {
  config.highlight.enable = true
  const request = spyOn(highlighting, "highlightDocument").mockImplementation(() => null)
  const cancel = spyOn(highlighting, "cancelHighlightRequest")
  context.expanded = false
  config.tools.edit = { collapsedLines: 3 }
  const diff = "- 18 old\n+ 18 new\n      ...\n- 47 before\n+ 47 after"
  expect(finish(diff).at(-1)).toBe("--- 2 lines hidden · ctrl+o to expand ---")
  expect(request.mock.calls).toHaveLength(2)
  context.expanded = true
  expect(finish(diff)).toContain("+  47 │ after")
  expect(request.mock.calls.some(([options]) => options.id.includes(":3:"))).toBe(true)
  context.expanded = false
  finish(diff)
  expect(cancel).toHaveBeenCalledWith("edit-test:edit:3:-")
  expect(cancel).toHaveBeenCalledWith("edit-test:edit:3:+")
})

test("highlights independent before/after fragments with context and overlays only changed-word backgrounds", () => {
  config.highlight.enable = true
  const request = spyOn(highlighting, "highlightDocument").mockImplementation((options) =>
    options.source.split("\n").map((line) => "\x1b[38;2;1;2;3m" + line + "\x1b[39m"),
  )
  const file = spyOn(highlighting, "highlightFileDocument")
  finish(" 17 const context = true\n-18 const value = 30\n+18 const value = 60\n 19 // end")
  expect(request.mock.calls.map(([options]) => options.source)).toEqual([
    "const context = true\nconst value = 30\n// end",
    "const context = true\nconst value = 60\n// end",
  ])
  const rendered = call.render(180)
  const removed = rendered.find((line) =>
    stripVTControlCharacters(line).trimStart().startsWith("-"),
  )!
  const added = rendered.find((line) => stripVTControlCharacters(line).startsWith("+  18"))!
  expect(removed).toContain("\x1b[38;2;1;2;3mconst value = \x1b[48;")
  expect(removed).toContain("30\x1b[49m")
  expect(added).toContain("\x1b[38;2;1;2;3mconst value = \x1b[48;")
  expect(added).toContain("60\x1b[49m")
  expect(file).not.toHaveBeenCalled()
  config.highlight.enable = false
  const cancel = spyOn(highlighting, "cancelHighlightRequest")
  draw()
  expect(cancel).toHaveBeenCalled()
})

test("word ranges stay aligned across whitespace, tabs, Unicode, ANSI resets and multiline blocks", () => {
  config.highlight.enable = true
  spyOn(highlighting, "highlightDocument").mockImplementation((options) =>
    options.source
      .split("\n")
      .map((line) => "\x1b[31m" + line.replace("30", "3\x1b[0m0") + "\x1b[39m"),
  )
  finish("-1 \t😀 const  value = 30\n+1 😀 const value = 60")
  const raw = call
    .render(180)
    .find((line) => stripVTControlCharacters(line).trimStart().startsWith("-"))!
  expect(stripVTControlCharacters(raw)).toContain("    😀 const  value = 30")
  const removedBackground = backgrounds("-")
  expect(raw).toContain(
    `${removedBackground.word}3\x1b[0m${removedBackground.line}${removedBackground.word}0\x1b[49m${removedBackground.line}`,
  )
  finish("-1 first\n-2 second\n+1 third\n+2 fourth")
  const multiline = call.render(180).slice(4)
  expect(multiline).toHaveLength(4)
  for (const [index, line] of multiline.entries()) {
    const background = backgrounds(index < 2 ? "-" : "+")
    expect(line).toStartWith(background.line)
    expect(sliceByColumn(line, 179, 180)).toContain(background.line)
    expect(line).not.toContain(background.word)
  }
})

test("shows a continuous replacement as one deletion block then one addition block before and after execution", async () => {
  const before = Array.from({ length: 16 }, (_, index) => `export const option${index + 1} = false`)
  const after = before.map((line) => line.replace("false", "true"))
  context.args = {
    path: "config.ts",
    edits: [{ oldText: before.join("\n"), newText: after.join("\n") }],
  }
  const removed = before.map((line, index) => `-${String(index + 1).padStart(4)} │ ${line}`)
  const added = after.map((line, index) => `+${String(index + 1).padStart(4)} │ ${line}`)
  expect((await preview(before.join("\n") + "\n")).slice(4)).toEqual([...removed, ...added])
  context.expanded = false
  const collapsed = [...removed.slice(0, 8), "--- 24 lines hidden · ctrl+o to expand ---"]
  expect(draw().slice(4)).toEqual(collapsed)
  const actual = [
    ...before.map((line, index) => `-${index + 1} ${line}`),
    ...after.map((line, index) => `+${index + 1} ${line}`),
  ].join("\n")
  expect(finish(actual).slice(4)).toEqual(collapsed)
  context.expanded = true
  expect(draw().slice(4)).toEqual([...removed, ...added])
})

test("ignores outdated file reads after arguments change and after an authoritative result", async () => {
  const pending: Array<(source: string) => void> = []
  spyOn(textFiles, "readFile").mockImplementation(
    () => new Promise<string>((resolve) => pending.push(resolve)),
  )
  draw()
  context.args = { path: "config.ts", oldText: "new old", newText: "new new" }
  draw()
  pending[1]!("new old\n")
  await ready()
  expect(draw()).toContain("+   1 │ new new")
  pending[0]!("const value = 30\n")
  await nextTurn()
  expect(draw()).not.toContain("+   1 │ const value = 60")
  context.args = { path: "config.ts", oldText: "other", newText: "changed" }
  draw()
  finish("-77 authoritative old\n+77 authoritative new")
  pending[2]!("other\n")
  await nextTurn()
  expect(draw()).toContain("+  77 │ authoritative new")
  expect(draw().join("\n")).not.toContain("Proposed change")
})

test("a preview already in flight may finish after failure without hiding the error", async () => {
  let resolve!: (source: string) => void
  spyOn(textFiles, "readFile").mockImplementation(
    () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  )
  draw()
  expect(finish(undefined, "execution error")).toContain("execution error")
  resolve("const value = 30\n")
  await ready()
  expect(draw()).toContain("-   1 │ const value = 30")
  expect(draw().join("\n")).not.toContain("Proposed change")
  expect(finish(undefined, "execution error")).toContain("execution error")
})

test("refreshes asynchronous Shiki fragments independently on both sides without file highlighting", async () => {
  config.highlight.enable = true
  highlighting.configureHighlighting(config.highlight)
  const request = spyOn(highlighting, "highlightDocument")
  const file = spyOn(highlighting, "highlightFileDocument")
  const read = spyOn(fs, "readFile")
  invalidate.mockImplementation(() => {
    draw()
  })
  finish("-1 /* open\n+1 const open = true\n 2 const inside = 1\n 3 */")
  const end = Date.now() + 5000
  while (true) {
    const results = request.mock.results.slice(-2)
    if (
      results.length === 2 &&
      results.every(
        (entry) => entry.type === "return" && entry.value?.every((line) => line !== null),
      )
    ) {
      const oldSide = results[0]!
      const newSide = results[1]!
      if (oldSide.type !== "return" || newSide.type !== "return")
        throw new Error("Missing highlight")
      expect(oldSide.value![1]).not.toBe(newSide.value![1])
      expect(stripVTControlCharacters(oldSide.value![1]!)).toBe("const inside = 1")
      expect(stripVTControlCharacters(newSide.value![1]!)).toBe("const inside = 1")
      break
    }
    if (Date.now() > end) throw new Error("Edit fragment highlighting did not finish")
    await nextTurn()
  }
  expect(invalidate).toHaveBeenCalled()
  expect(file).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

test("fixes markers in column one and right-aligns four- and five-digit line number gutters", () => {
  expect(
    finish(
      [
        "-1 const a = 10",
        "+1 const a = 20",
        " 2 const b = 30",
        "-18 const c = 40",
        "+18 const c = 50",
        " 120 const d = 60",
        "-1234 const e = 70",
        "+1234 const e = 80",
      ].join("\n"),
    ).slice(4),
  ).toEqual([
    "-   1 │ const a = 10",
    "+   1 │ const a = 20",
    "    2 │ const b = 30",
    "-  18 │ const c = 40",
    "+  18 │ const c = 50",
    "  120 │ const d = 60",
    "-1234 │ const e = 70",
    "+1234 │ const e = 80",
  ])
  expect(finish("-9999 old\n+10000 new\n 10001 context").slice(4)).toEqual([
    "- 9999 │ old",
    "+10000 │ new",
    " 10001 │ context",
  ])
})

test.each(["dark", "light"])(
  "paints full diff rows through the native shell and wrapping in %s",
  (name) => {
    theme = getThemeByName(name)!
    finish(
      '-18 const value = "before" + unchangedSuffix\n+18 const value = "after" + unchangedSuffix\n 19 context',
    )
    const shell = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line))
    shell.addChild(call)
    for (const width of [18, 80]) {
      const rows = shell.render(width)
      const removed = backgrounds("-")
      const added = backgrounds("+")
      for (const [kind, background] of [
        ["-", removed],
        ["+", added],
      ] as const) {
        const changed = rows.filter((line) =>
          stripVTControlCharacters(line)
            .trimStart()
            .startsWith(kind + "  18"),
        )
        expect(changed).toHaveLength(1)
        expect(sliceByColumn(changed[0]!, 1, 2)).toContain(background.line)
        expect(sliceByColumn(changed[0]!, width - 2, width - 1)).toContain(background.line)
      }
      const continuation = rows.filter((line) =>
        stripVTControlCharacters(line).includes("unchangedSuffix"),
      )
      expect(continuation).toHaveLength(2)
      expect(sliceByColumn(continuation[0]!, width - 2, width - 1)).toContain(removed.line)
      expect(sliceByColumn(continuation[1]!, width - 2, width - 1)).toContain(added.line)
      for (const line of rows.filter(
        (line) => !line.includes(removed.line) && !line.includes(added.line),
      )) {
        expect(line).not.toContain(removed.word)
        expect(line).not.toContain(added.word)
      }
    }
    const removed = backgrounds("-")
    const changed = call.render(80).find((line) => line.startsWith(removed.line))!
    expect(changed).toContain(removed.word)
    expect(changed).toContain("before\x1b[49m" + removed.line + '" + unchangedSuffix')
  },
)

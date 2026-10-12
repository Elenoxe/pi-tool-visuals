import { expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"

import { formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import { createFindRenderer } from "../../src/renderers/find.ts"
import { createLsRenderer } from "../../src/renderers/ls.ts"
import {
  parseSearchResult,
  renderPathList,
  selectPreview,
  type RenderContext,
  type ToolResult,
} from "../../src/renderers/shared.ts"

const theme = getThemeByName("dark")!

function textResult(text: string, details?: ToolResult["details"]): ToolResult {
  return { content: [{ type: "text", text }], details }
}

test("extracts corroborated native count, byte and long-line notices without changing results", () => {
  const source = "src/a.ts\nsrc/b.ts\nsrc/c.ts"
  const counts = [
    {
      tool: "grep",
      notice: "3 matches limit reached. Use limit=6 for more, or refine pattern",
      details: { matchLimitReached: 3 },
      warning: "Match limit reached (3)",
    },
    {
      tool: "find",
      notice: "3 results limit reached. Use limit=6 for more, or refine pattern",
      details: { resultLimitReached: 3 },
      warning: "Result limit reached (3)",
    },
    {
      tool: "find",
      notice: "3 results limit reached",
      details: { resultLimitReached: 3 },
      warning: "Result limit reached (3)",
    },
    {
      tool: "ls",
      notice: "3 entries limit reached. Use limit=6 for more",
      details: { entryLimitReached: 3 },
      warning: "Entry limit reached (3)",
    },
  ] as const
  for (const { tool, notice, details, warning } of counts) {
    const result = textResult(source + "\n\n[" + notice + "]", details)
    const original = structuredClone(result)
    expect(parseSearchResult(result, tool)).toEqual({ source, warnings: [warning] })
    expect(result).toEqual(original)
  }

  const lines = Array.from(
    { length: 200 },
    (_, index) => `src/a.ts:${index + 1}: ${truncateLine("target " + "x".repeat(600)).text}`,
  )
  const truncation = truncateHead(lines.join("\n"))
  const size = formatSize(truncation.maxBytes)
  for (const tool of ["find", "ls"] as const) {
    const result = textResult(truncation.content + `\n\n[${size} limit reached]`, { truncation })
    const original = structuredClone(result)
    expect(parseSearchResult(result, tool)).toEqual({
      source: truncation.content,
      warnings: ["Output truncated (50 KB limit)"],
    })
    expect(result).toEqual(original)
  }
  const result = textResult(
    truncation.content +
      `\n\n[200 matches limit reached. Use limit=400 for more, or refine pattern. ${size} limit reached. Some lines truncated to 500 chars. Use read tool to see full lines]`,
    { matchLimitReached: 200, truncation, linesTruncated: true },
  )
  const original = structuredClone(result)
  expect(parseSearchResult(result, "grep")).toEqual({
    source: truncation.content,
    warnings: [
      "Match limit reached (200)",
      "Output truncated (50 KB limit)",
      "Some lines truncated (500-char limit)",
    ],
  })
  expect(result).toEqual(original)
})

test("preserves notice-like source when metadata, suffix or recorded truncation content disagrees", () => {
  const notice = "[3 matches limit reached. Use limit=6 for more, or refine pattern]"
  const code = `const message = "${notice}"`
  const truncation = truncateHead("first\n" + "x".repeat(60_000))
  const cases: ToolResult[] = [
    textResult(code),
    textResult(code, { matchLimitReached: 3 }),
    textResult("source\n\n" + notice),
    textResult("source\n\n" + notice, { matchLimitReached: 4 }),
    textResult("source\n\n" + notice, { entryLimitReached: 3 }),
    textResult("source\n\n" + notice.replace("limit=6", "limit=7"), { matchLimitReached: 3 }),
    textResult("source\n\n" + notice.slice(0, -1), { matchLimitReached: 3 }),
    textResult("source\n\n" + notice + "\nadditional recorded content", { matchLimitReached: 3 }),
    textResult("different source\n\n[" + formatSize(truncation.maxBytes) + " limit reached]", {
      truncation,
    }),
  ]
  for (const result of cases) {
    const original = structuredClone(result)
    expect(parseSearchResult(result, "grep").source).toBe(
      result.content[0]!.type === "text" ? result.content[0]!.text : "",
    )
    expect(result).toEqual(original)
  }
})

test("counts hidden warnings within the source-line budget and restores everything on expansion", () => {
  const items = ["one", "two", "three", "four", "five"]
  const warnings = ["Result limit reached (5)"]
  expect(selectPreview(items, warnings, 3, false)).toEqual({
    items: ["one", "two", "three"],
    warnings: [],
    hidden: 3,
  })
  expect(selectPreview(items, warnings, 5, false)).toEqual({ items, warnings: [], hidden: 1 })
  expect(selectPreview(items, warnings, 6, false)).toEqual({ items, warnings, hidden: 0 })
  expect(selectPreview(items, warnings, 3, true)).toEqual({ items, warnings, hidden: 0 })
})

test("builds a shared directory tree in occurrence order with correct sibling connectors", () => {
  const paths = ["src/highlight/a.ts", "src/highlight/b.ts", "src/renderers/grep.ts"]
  const output = renderPathList(paths, "off", theme).map(stripVTControlCharacters)
  expect(output).toEqual([
    "└─ src/",
    "   ├─ highlight/",
    "   │  ├─ a.ts",
    "   │  └─ b.ts",
    "   └─ renderers/",
    "      └─ grep.ts",
  ])
})

test.each(["find", "ls"] as const)(
  "%s folds original entries and native warnings, not generated directory nodes",
  (tool) => {
    const paths =
      tool === "find"
        ? [
            "src/highlight/a.ts",
            "src/highlight/b.ts",
            "src/renderers/grep.ts",
            "src/renderers/read.ts",
            "index.ts",
          ]
        : ["src/", "tests/", "package.json", "README.md", "bun.lock"]
    const notice =
      tool === "find"
        ? "5 results limit reached. Use limit=10 for more, or refine pattern"
        : "5 entries limit reached. Use limit=10 for more"
    const warning = tool === "find" ? "Result limit reached (5)" : "Entry limit reached (5)"
    const result = textResult(
      paths.join("\n") + "\n\n[" + notice + "]",
      tool === "find" ? { resultLimitReached: 5 } : { entryLimitReached: 5 },
    )
    const original = structuredClone(result)
    const config = createDefaultConfig()
    config.collapsedLines = 3
    config.pathIcons = "off"
    const renderer =
      tool === "find" ? createFindRenderer(() => config) : createLsRenderer(() => config)
    const context: RenderContext = {
      args: {},
      toolCallId: tool + "-renderer-test",
      cwd: "/project",
      state: {},
      invalidate() {},
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
    const collapsed = stripVTControlCharacters(
      renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, context)
        .render(200)
        .join("\n"),
    )
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
    expect(collapsed).toContain("3 lines hidden")
    expect(collapsed).not.toContain(warning)
    expect(collapsed).not.toContain("Use limit=")
    expect(collapsed).not.toContain("read.ts")
    expect(collapsed).not.toContain("README.md")
    expect(collapsed.split("\n").filter(Boolean)).toHaveLength(tool === "find" ? 7 : 4)
    if (tool === "ls")
      expect(collapsed.split("\n").filter(Boolean).slice(0, 3)).toEqual(paths.slice(0, 3))

    const expanded = stripVTControlCharacters(
      renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, context)
        .render(200)
        .join("\n"),
    )
    for (const path of paths) expect(expanded).toContain(path.replace(/\/$/, "").split("/").at(-1)!)
    expect(expanded).toContain(warning)
    expect(expanded).not.toContain("Use limit=")
    expect(expanded).not.toContain("lines hidden")
    expect(result).toEqual(original)
  },
)

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"

import type { CodemodeToolDetails, ToolRenderers } from "@earendil-works/pi-coding-agent"
import {
  getCapabilities,
  setCapabilities,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  type Component,
  visibleWidth,
} from "@earendil-works/pi-tui"

import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createDefaultConfig } from "../../src/config.ts"
import * as highlighting from "../../src/highlight/index.ts"
import { createCodemodeRenderer } from "../../src/renderers/codemode.ts"
import {
  renderToolCallTitle,
  type RenderContext,
  type ToolResult,
} from "../../src/renderers/shared.ts"

type Call = CodemodeToolDetails["calls"][number]
const theme = getThemeByName("dark")!
let config: ReturnType<typeof createDefaultConfig>
let renderer: ToolRenderers
let context: RenderContext
let callComponent: Component | undefined
let resultComponent: Component | undefined
let previousKeys: ReturnType<typeof getKeybindings>

beforeEach(() => {
  config = createDefaultConfig()
  config.highlight.enable = false
  renderer = createCodemodeRenderer(() => config)
  callComponent = resultComponent = undefined
  context = {
    args: { code: '// @options: {"timeout_ms":60000}\nconst value = 42\nreturn value' },
    toolCallId: "codemode-test",
    cwd: process.cwd(),
    state: {},
    invalidate: mock(() => {}),
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    durationMs: 1200,
    outputPad: 0,
  }
  previousKeys = getKeybindings()
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }))
})

afterEach(() => {
  setKeybindings(previousKeys)
  highlighting.disposeHighlighting()
  mock.restore()
})

function call(index: number, status: Call["status"] = "ok"): Call {
  return {
    id: `test/${index}`,
    name: "read",
    args: JSON.stringify({ path: `src/file-${index}.ts` }),
    status,
    durationMs: index,
  }
}

function result(calls: Call[] = [], text = ""): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Script ${context.isError ? "failed" : "completed"}\nWall time 1.2 seconds\nOutput:\n`,
      },
      ...(text ? [{ type: "text" as const, text }] : []),
    ],
    details: { calls },
  }
}

function draw(value?: ToolResult, width = 160): string[] {
  callComponent = renderer.renderCall!(context.args, theme, {
    ...context,
    lastComponent: callComponent,
  })
  if (value)
    resultComponent = renderer.renderResult!(
      value,
      { expanded: context.expanded, isPartial: context.isPartial },
      theme,
      { ...context, lastComponent: resultComponent },
    )
  return [callComponent, ...(value && resultComponent ? [resultComponent] : [])]
    .flatMap((component) => component.render(width))
    .map((line) => stripTerminalSequences(line).trimEnd())
}

test("renders native titles, stats, costs and errors without conflating nested failure and script failure", () => {
  const calls: Call[] = [
    call(1),
    { ...call(2, "error"), name: "edit", error: "EACCES\npermission denied" },
    { ...call(3), name: "bash", args: '{"command":"bun test"}' },
    { ...call(4), name: "write", cost: 0.00012 },
    { ...call(5, "cancelled"), name: "find", args: '{"pattern":"**/*.ts","path":"src"}' },
  ]
  expect(draw(result(calls))).toEqual([
    "codemode · 1.2s",
    "",
    "✗ Tools · 5 calls · 1 failed",
    "› read src/file-1.ts · 1ms",
    "✗ edit src/file-2.ts · 2ms",
    "› bash $ bun test · 3ms",
    "› write src/file-4.ts · 4ms · $0.00012",
    "⊘ find **/*.ts in src · 5ms",
    "",
    "--- 2 lines hidden · ctrl+o to expand ---",
  ])
  config.codemode.output.showWithCalls = true
  expect(draw(result(calls, "caught error")).join("\n")).toContain(
    "⊘ find **/*.ts in src · 5ms\n\n↩ return\ncaught error",
  )
  context.expanded = true
  expect(draw(result(calls)).join("\n")).toContain("    EACCES\n    permission denied")
  context.expanded = false
  context.isError = true
  expect(draw(result([call(1)]))).toContain("✗ Tools · 1 call")
})

test("keeps earliest completed calls and expands all calls without a second cap", () => {
  const calls = Array.from({ length: 40 }, (_, i) => call(i + 1))
  const value = result(calls)
  const original = structuredClone(value)
  const collapsed = draw(value)
  expect(collapsed.slice(3, 11)).toEqual(
    calls.slice(0, 8).map((_, i) => `› read src/file-${i + 1}.ts · ${i + 1}ms`),
  )
  expect(collapsed.slice(-3)).toEqual(["...", "", "--- 32 lines hidden · ctrl+o to expand ---"])
  expect(collapsed.filter((line) => line.includes("hidden"))).toHaveLength(1)
  context.expanded = true
  expect(draw(value).filter((line) => line.startsWith("› read"))).toHaveLength(40)
  expect(draw(value).some((line) => line.includes("hidden"))).toBe(false)
  expect(value).toEqual(original)
})

test("running selection prioritizes active calls, then earliest calls in occurrence order", () => {
  context.isPartial = true
  expect(draw()).toEqual(["codemode", "", "◆ Running…"])
  const calls = Array.from({ length: 12 }, (_, i) => call(i + 1, i >= 10 ? "running" : "ok"))
  const value = result(calls)
  const lines = draw(value)
  expect(lines).toContain("◆ Tools running · 10/12 calls")
  expect(lines.filter((line) => /^[›◐] read/.test(line))).toEqual([
    ...calls.slice(0, 6).map((_, i) => `› read src/file-${i + 1}.ts · ${i + 1}ms`),
    "◐ read src/file-11.ts · 11ms",
    "◐ read src/file-12.ts · 12ms",
  ])
  for (const item of calls) item.status = "running"
  expect(draw(value).filter((line) => line.startsWith("◐ read"))).toHaveLength(8)
  expect(draw(value).find((line) => line.startsWith("◐ read"))).toBe("◐ read src/file-5.ts · 5ms")
  for (const item of calls) item.status = "ok"
  context.isPartial = false
  expect(draw(value)[0]).toBe("codemode · 1.2s")
  expect(draw(value)[3]).toBe("› read src/file-1.ts · 1ms")
  expect(draw(value).join("\n")).not.toContain("Running")
})

test.each([
  ["read", '{"path":"src/config.ts","limit":12}', "read src/config.ts:1-12"],
  ["write", '{"path":"src/output.ts","content":"incomplete...', "write src/output.ts"],
  ["read", '{"path":"src/config.ts"...', "read src/config.ts"],
  ["read", '{"path":"src/partial...', "read"],
  ["edit", '{"edits":[{"path":"fake.ts","oldText":"x...', "edit"],
  ["read", '{"note":"fake, \\"path\\": \\"evil\\"","path":"src/partial...', "read"],
  ["read", '{"path":"src/a,b.ts","content":"...', "read src/a,b.ts"],
  ["bash", '{"command":"bun test","unused":"...', "bash $ bun test"],
  ["bash", '{"command":"bun te...', "bash"],
  ["grep", '{"pattern":"config","ignoreCase":true,"path":"src"}', "grep /config/i in src"],
  ["read", "not json", "read"],
])("formats complete fields only: %s %s", (name, args, expected) => {
  expect(draw(result([{ id: "1", name, args, status: "ok" }]))[3]).toBe("› " + expected)
})

test.each([
  ["read", { path: "src/a.ts", offset: 3, limit: 2 }, "read src/a.ts:3-4"],
  ["write", { path: "src/a.ts" }, "write src/a.ts"],
  ["edit", { file_path: "src/a.ts" }, "edit src/a.ts"],
  ["bash", { command: "bun test" }, "bash $ bun test"],
  ["powershell", { command: "Get-ChildItem" }, "powershell PS> Get-ChildItem"],
  ["grep", { pattern: "TODO", path: "src", literal: true }, 'grep "TODO" in src'],
  ["find", { pattern: "**/*.ts", path: "src" }, "find **/*.ts in src"],
  ["ls", { path: "src" }, "ls src"],
  ["ls", {}, "ls"],
  ["ls", { limit: 10 }, "ls"],
  ["grep", { pattern: "" }, "grep //"],
  ["grep", { pattern: "", question: "ignored" }, "grep //"],
  ["find", { pattern: "", path: "src", question: "ignored" }, "find  in src"],
  ["ls", { path: "", question: "ignored" }, "ls"],
  ["read", { path: "", file_path: "src/a.ts", question: "ignored" }, "read src/a.ts"],
] as const)("preserves specialized titles for compatible %s arguments", (name, args, expected) => {
  config.tools[name] = { enabled: false }
  const value = result([{ ...call(1), name, args: JSON.stringify(args) }])
  expect(draw(value)[3]).toBe("› " + expected + " · 1ms")
})

test.each([
  ["read", { question: "Which file?" }, "Which file?"],
  ["read", { path: "", question: "Which file?" }, "Which file?"],
  ["read", { path: "   ", question: "Which file?" }, "Which file?"],
  ["write", { file_path: "", task: "Generate configuration" }, "Generate configuration"],
  ["edit", { file: "", question: "Which file?" }, "Which file?"],
  ["bash", { command: "", question: "Which command?" }, "Which command?"],
  ["bash", { command: " \t", question: "Which command?" }, "Which command?"],
  ["powershell", { command: "", question: "Which command?" }, "Which command?"],
  ["write", { task: "Generate configuration" }, "Generate configuration"],
  ["edit", { sourcePath: "a.ts", targetPath: "b.ts" }, "a.ts → b.ts"],
  ["bash", { url: "https://example.com/?q=a&b=2" }, "https://example.com/?q=a&b=2"],
  ["powershell", { command: 12, query: "shiki" }, "shiki"],
  ["grep", { pattern: false, query: "shiki", path: "src" }, "shiki in src"],
  ["find", { glob: "**/*.ts" }, "**/*.ts"],
  ["ls", { path: 42, question: "Which directory?" }, "Which directory?"],
  ["ls", { question: "Which directory?" }, "Which directory?"],
  ["ls", { filePath: "/tmp/config.ts" }, "/tmp/config.ts"],
] as const)("uses generic summaries for incompatible %s arguments", (name, args, expected) => {
  expect(draw(result([{ ...call(1), name, args: JSON.stringify(args) }]))[3]).toBe(
    `› ${name} ${expected} · 1ms`,
  )
})

test.each(["ffgrep", "fffind", "mcp__GitHub__fetch", "ask_user_question", "Read", "custom_read"])(
  "uses arguments, not the tool name, to summarize %s",
  (name) => {
    const args = JSON.stringify({ pattern: "TODO", path: "src" })
    expect(draw(result([{ ...call(1), name, args }]))[3]).toBe(`› ${name} TODO in src · 1ms`)
  },
)

test.each([
  [
    {
      sourcePath: "a.ts",
      targetPath: "b.ts",
      owner: "o",
      repo: "r",
      pattern: "p",
      path: "src",
      command: "c",
    },
    "a.ts → b.ts",
  ],
  [
    { sourcePath: "a.ts", source_path: "ignored", targetPath: "b.ts", target_path: "ignored" },
    "a.ts → b.ts",
  ],
  [{ source_path: "a.ts", target_path: "b.ts" }, "a.ts → b.ts"],
  [
    { owner: "Elenoxe", repo: "pi-sync", repository: "ignored", path: "src", pattern: "p" },
    "Elenoxe/pi-sync/src",
  ],
  [{ owner: "Elenoxe", repository: "pi-sync" }, "Elenoxe/pi-sync"],
  [{ owner: "Elenoxe", repo: "", repository: "pi-sync", file: "src" }, "Elenoxe/pi-sync/src"],
  [{ pattern: "TODO", path: "src", query: "ignored", command: "ignored" }, "TODO in src"],
  [{ query: "shiki", search_query: "ignored", file_path: "src" }, "shiki in src"],
  [{ search_query: "shiki", filePath: "src" }, "shiki in src"],
  [
    { pattern: "TODO", path: "src", file_path: "ignored", filePath: "ignored", file: "ignored" },
    "TODO in src",
  ],
  [{ pattern: "TODO", path: "", file_path: "src", filePath: "ignored" }, "TODO in src"],
  [{ query: "shiki", path: null, filePath: "src", file: "ignored" }, "shiki in src"],
  [{ pattern: "TODO", file: "src" }, "TODO in src"],
  [
    { sourcePath: 42, targetPath: "b.ts", pattern: "", path: "src", query: "shiki" },
    "shiki in src",
  ],
  [{ owner: "", repo: "pi-sync", query: "shiki", path: "src" }, "shiki in src"],
  [{ command: "bun test", url: "ignored" }, "$ bun test"],
  [
    { url: "https://example.com/api?q=a&sort=desc", question: "ignored" },
    "https://example.com/api?q=a&sort=desc",
  ],
  [
    { url: 42, uri: "", endpoint: "https://example.com/api", task: "ignored" },
    "https://example.com/api",
  ],
  [{ task: "Review configuration", question: "ignored", query: "ignored" }, "Review configuration"],
  [{ question: "Continue?", query: "ignored" }, "Continue?"],
  [
    {
      query: "shiki",
      search: "ignored",
      search_query: "ignored",
      q: "ignored",
      pattern: "ignored",
    },
    "shiki",
  ],
  [{ search: "shiki", search_query: "ignored", q: "ignored" }, "shiki"],
  [{ pattern: "**/*.ts", glob: "ignored", prompt: "ignored" }, "**/*.ts"],
  [{ path: "src/config.ts", content: "ignored" }, "src/config.ts"],
  [
    { prompt: "Explain this function", message: "ignored", title: "ignored" },
    "Explain this function",
  ],
  [{ title: "main", name: "ignored", key: "ignored", ref: "ignored", branch: "ignored" }, "main"],
  [
    {
      command: " \t",
      url: false,
      task: [],
      query: {},
      pattern: null,
      path: 42,
      prompt: "",
      title: "main",
    },
    "main",
  ],
] as const)("applies fixed combination, alias, and field priorities: %j", (args, expected) => {
  expect(draw(result([{ ...call(1), name: "custom_tool", args: JSON.stringify(args) }]))[3]).toBe(
    `› custom_tool ${expected} · 1ms`,
  )
})

test.each([
  "command",
  "url",
  "uri",
  "endpoint",
  "task",
  "question",
  "query",
  "search",
  "search_query",
  "q",
  "pattern",
  "glob",
  "regex",
  "expression",
  "path",
  "file_path",
  "filePath",
  "file",
  "prompt",
  "message",
  "text",
  "content",
  "title",
  "name",
  "key",
  "ref",
  "branch",
])("supports the single-field alias %s", (key) => {
  const args = JSON.stringify({ [key]: "value" })
  expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
    `› custom_tool ${key === "command" ? "$ " : ""}value · 1ms`,
  )
})

test.each(["input", "args", "arguments", "params", "payload"])(
  "extracts one level from the %s wrapper",
  (wrapper) => {
    const args = JSON.stringify({ [wrapper]: { query: "shiki", path: "src" } })
    expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
      "› custom_tool shiki in src · 1ms",
    )
  },
)

test.each([
  [{ task: "top", input: { sourcePath: "a", targetPath: "b" } }, "top"],
  [{ input: { question: "first" }, args: { question: "second" } }, "first"],
  [{ input: [], args: { question: "second" } }, "second"],
  [{ input: {}, args: { question: "second" } }, "second"],
  [{ input: { input: { question: "too deep" } } }, ""],
  [{ params: [{ query: "not an object" }] }, ""],
  [{ unknown: "do not show JSON", count: 10, enabled: true }, ""],
  [null, ""],
  [42, ""],
  ["text", ""],
  [[{ query: "not an object" }], ""],
] as const)("respects top-level priority and wrapper boundaries: %j", (args, expected) => {
  expect(draw(result([{ ...call(1), name: "custom_tool", args: JSON.stringify(args) }]))[3]).toBe(
    `› custom_tool${expected ? " " + expected : ""} · 1ms`,
  )
})

test.each([
  ['{"query":"shiki","path":"src"}', "shiki in src"],
  ['{"query":"shiki","path":"src","content":"incomplete...', "shiki in src"],
  ['{"query":"shiki","path":"src/partial...', "shiki"],
  ['{"url":"https://example.com/?a=1,b=2","unused":"...', "https://example.com/?a=1,b=2"],
  ['{"input":{"query":"shiki","path":"src"},"unused":"...', "shiki in src"],
  ['{"input":{"query":"partial...', ""],
  ['{"query":"partial...', ""],
  ['{"note":"fake, \\"query\\": \\"evil\\"","query":"partial...', ""],
  ["invalid JSON", ""],
] as const)("summarizes only completely parsed preview fields: %s", (args, expected) => {
  expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
    `› custom_tool${expected ? " " + expected : ""} · 1ms`,
  )
})

// Keep the interesting suffix short while matching Pi's 200-code-unit preview boundary.
function truncatedPreview(prefix: string): string {
  const start = '{"unused":"'
  const tail = '",' + prefix.slice(1)
  return start + "x".repeat(200 - start.length - tail.length) + tail + "..."
}

test.each([
  ['{"url":"https://example.com/long', "https://example.com/long…"],
  ['{"command":"bun run long', "$ bun run long…"],
  ['{"path":"src/long', "src/long…"],
  ['{"query":"search keywords', "search keywords…"],
  ['{"text":"Explain this function', "Explain this function…"],
  ['{"query":"shiki","path":"src/long', "shiki in src/long…"],
  ['{"pattern":"TODO","path":"src/long', "TODO in src/long…"],
  ['{"path":"src","pattern":"TO', "TO… in src"],
  ['{"sourcePath":"a.ts","targetPath":"long', "a.ts → long…"],
  ['{"owner":"Elenoxe","repo":"pi-sync","path":"src/long', "Elenoxe/pi-sync/src/long…"],
  ['{"question":"Continue?","command":"bun run long', "$ bun run long…"],
  ['{"path":"src/a.ts","content":"long', "src/a.ts"],
  ['{"query":"shiki","path":', "shiki"],
  ['{"query":"shiki","path":"', "shiki"],
  ['{"question":"Continue?","unknown":"long', "Continue?"],
  ['{"unknown":"long', ""],
  ['{"other":{"query":"long', ""],
  ['{"input":{"input":{"query":"long', ""],
  ['{"input":[{"query":"long', ""],
  ['{"query":["long', ""],
  ['{"query":123', ""],
  ['{"query":tru', ""],
  ['{"query', ""],
  ['{"query":"__pi_truncated_value__', "__pi_truncated_value__…"],
] as const)(
  "recovers only eligible truncated values with existing priorities: %s",
  (prefix, expected) => {
    const args = truncatedPreview(prefix)
    expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
      `› custom_tool${expected ? " " + expected : ""} · 1ms`,
    )
  },
)

test.each(["input", "args", "arguments", "params", "payload"])(
  "recovers truncated strings in the %s wrapper",
  (wrapper) => {
    const args = truncatedPreview(`{"${wrapper}":{"query":"shiki","path":"src/long`)
    expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
      "› custom_tool shiki in src/long… · 1ms",
    )
  },
)

test.each([
  ["read", '{"path":"src/long', "src/long…"],
  ["write", '{"path":"src/long', "src/long…"],
  ["edit", '{"path":"src/long', "src/long…"],
  ["ls", '{"path":"src/long', "src/long…"],
  ["bash", '{"command":"bun run long', "$ bun run long…"],
  ["powershell", '{"command":"Get-Long', "PS> Get-Long…"],
  ["grep", '{"pattern":"TODO","path":"src/long', "TODO in src/long…"],
  ["grep", '{"path":"src","pattern":"TO', "TO… in src"],
  ["find", '{"path":"src","pattern":"**/*.t', "**/*.t… in src"],
  ["read", '{"path":"src/a.ts","content":"long', "src/a.ts"],
  ["read", '{"path":"src/a.ts","file":"ignored', "src/a.ts"],
] as const)(
  "handles native %s titles without treating partial values as complete",
  (name, prefix, expected) => {
    const args = truncatedPreview(prefix)
    expect(draw(result([{ ...call(1), name, args }]))[3]).toBe(`› ${name} ${expected} · 1ms`)
  },
)

test("never links a recovered path, but still links complete native paths", () => {
  const capabilities = getCapabilities()
  setCapabilities({ ...capabilities, hyperlinks: true })
  try {
    const partial = result([{ ...call(1), args: truncatedPreview('{"path":"src/long') }])
    draw(partial)
    expect(resultComponent!.render(160).join("\n")).not.toContain("file://")
    draw(result([call(1)]))
    expect(resultComponent!.render(160).join("\n")).toContain("file://")
  } finally {
    setCapabilities(capabilities)
  }
})

test("requires the exact native truncation length and suffix", () => {
  const args = truncatedPreview('{"query":"partial')
  for (const invalid of [args.slice(1), " " + args, args.slice(0, -3), args.slice(0, -3) + "…"]) {
    expect(draw(result([{ ...call(1), name: "custom_tool", args: invalid }]))[3]).toBe(
      "› custom_tool · 1ms",
    )
  }
})

test("decodes escaped quotes, commas and backslashes, but rejects incomplete escapes", () => {
  const text = 'a, "quoted" \\path'
  const args = truncatedPreview('{"text":' + JSON.stringify(text).slice(0, -1))
  expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
    `› custom_tool ${text}… · 1ms`,
  )
  for (const escape of ["\\", "\\u", "\\u1", "\\u12", "\\u123"]) {
    const args = truncatedPreview('{"query":"shiki","path":"partial' + escape)
    expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
      "› custom_tool shiki · 1ms",
    )
  }
})

test.each(["url", "command", "path", "query", "text"])(
  "recovers actual long %s previews",
  (key) => {
    const json = JSON.stringify({ [key]: "x".repeat(240) })
    const args = json.slice(0, 200) + "..."
    const expected = (key === "command" ? "$ " : "") + "x".repeat(key === "command" ? 93 : 95) + "…"
    expect(draw(result([{ ...call(1), name: "custom_tool", args }]))[3]).toBe(
      `› custom_tool ${expected} · 1ms`,
    )
  },
)

test.each([false, true])(
  "rehydrates truncated titles without changing history, expanded: %s",
  (expanded) => {
    context.expanded = expanded
    const args = truncatedPreview('{"input":{"query":"shiki","path":"src/long')
    const value = result([{ ...call(1), name: "custom_tool", args }])
    const original = structuredClone(value)
    const expected = draw(value)
    context = { ...context, state: {} }
    callComponent = resultComponent = undefined
    renderer = createCodemodeRenderer(() => config)
    expect(draw(JSON.parse(JSON.stringify(value)))).toEqual(expected)
    expect(value).toEqual(original)
  },
)

test("uses fixed status glyphs with semantic colors and retains title, duration, and cost styling", () => {
  context.isPartial = true
  const foreground = spyOn(theme, "fg")
  const statuses = ["ok", "running", "error", "cancelled"] as const
  const name = "mcp__GitHub__fetch"
  const args = JSON.stringify({ url: "https://example.com/?q=a&b=2" })
  const lines = draw(
    result(statuses.map((status, i) => ({ ...call(i + 1, status), name, args, cost: 0.02 }))),
  )
  for (const [index, icon] of ["›", "◐", "✗", "⊘"].entries())
    expect(lines).toContain(`${icon} ${name} https://example.com/?q=a&b=2 · ${index + 1}ms · $0.02`)
  for (const [color, icon] of [
    ["dim", "›"],
    ["warning", "◐"],
    ["error", "✗"],
    ["dim", "⊘"],
  ])
    expect(foreground).toHaveBeenCalledWith(color, icon)
  expect(foreground).toHaveBeenCalledWith("toolTitle", theme.bold(name))
  expect(foreground).toHaveBeenCalledWith("accent", "https://example.com/?q=a&b=2")
})

test.each([
  ["x".repeat(120), "x".repeat(95) + "…"],
  ["中".repeat(60), "中".repeat(47) + "…"],
  ["e\u0301".repeat(120), "e\u0301".repeat(95) + "…"],
])(
  "caps generic summaries by terminal columns without changing recorded arguments",
  (text, expected) => {
    const value = result([{ ...call(1), name: "custom_tool", args: JSON.stringify({ text }) }])
    const original = structuredClone(value)
    expect(draw(value)[3]).toBe(`› custom_tool ${expected} · 1ms`)
    expect(visibleWidth(expected)).toBeLessThanOrEqual(96)
    const narrow = draw(value, 24)
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true)
    expect(value).toEqual(original)
  },
)

test("sanitizes multiline text and control sequences before displaying a generic summary", () => {
  const args = JSON.stringify({ question: "第一行\r\n第二行\t\u001b[31m\u0007" })
  expect(draw(result([{ ...call(1), name: "ask_user_question", args }]))[3]).toBe(
    "› ask_user_question 第一行␊第二行    ␛[31m␇ · 1ms",
  )
})

test("does not apply the generic summary cap to specialized native titles", () => {
  const command = "x".repeat(110)
  const args = JSON.stringify({ command })
  expect(draw(result([{ ...call(1), name: "bash", args }]))[3]).toBe(`› bash $ ${command} · 1ms`)
})

test.each([false, true])(
  "restores generic titles and folding from serialized history, expanded: %s",
  (expanded) => {
    context.expanded = expanded
    config.codemode.calls.collapsedCount = 1
    const calls = [
      { ...call(1), name: "ffgrep", args: '{"pattern":"TODO","path":"src"}' },
      { ...call(2), name: "ask_user_question", args: '{"question":"Continue?"}' },
      {
        ...call(3),
        name: "custom_tool",
        args: '{"input":{"query":"shiki","path":"src"},"text":"partial...',
      },
    ]
    const value = result(calls)
    const expected = draw(value, 40)
    context = { ...context, state: {}, args: JSON.parse(JSON.stringify(context.args)) }
    callComponent = resultComponent = undefined
    renderer = createCodemodeRenderer(() => config)
    expect(draw(JSON.parse(JSON.stringify(value)), 40)).toEqual(expected)
    expect(expected.join("\n").includes("lines hidden")).toBe(!expanded)
  },
)

test("renders Completed and folds final output by wrapped terminal rows", () => {
  expect(draw(result())).toEqual(["codemode · 1.2s", "", "✓ Completed"])
  expect(draw(result([], "42"))).toEqual(["codemode · 1.2s", "", "✓ Completed", "↩ return", "42"])
  config.codemode.output.collapsedLines = 2
  const text = "a".repeat(90)
  const lines = draw(result([], text), 40)
  expect(lines.filter((line) => line.startsWith("a"))).toHaveLength(2)
  expect(lines.join("\n")).toContain("1 line hidden")
  context.expanded = true
  expect(draw(result([], text), 40).filter((line) => line.startsWith("a"))).toHaveLength(3)
})

test("uses one dynamic folding notice for omitted calls, source and output", () => {
  config.codemode.script.showCollapsed = true
  config.codemode.script.collapsedLines = 1
  config.codemode.calls.collapsedCount = 1
  config.codemode.output.collapsedLines = 1
  const value = result([call(1), call(2), call(3)], "first\nsecond\nthird")
  // Two source rows + two calls + three intentionally hidden output rows.
  expect(draw(value).at(-1)).toBe("--- 7 lines hidden · ctrl+o to expand ---")
  config.codemode.output.showWithCalls = true
  const lines = draw(value)
  expect(lines.at(-1)).toBe("--- 6 lines hidden · ctrl+o to expand ---")
  expect(lines).toContain("first")
  expect(lines.filter((line) => line.includes("hidden"))).toHaveLength(1)
  getKeybindings().setUserBindings({ "app.tools.expand": "alt+o" })
  expect(draw(value).at(-1)).toContain("alt+o to expand")
  config.codemode.script.showCollapsed = false
  expect(draw(value).at(-1)).toContain("4 lines hidden")
  context.expanded = true
  expect(draw(value).slice(1, 4)).toEqual([
    '// @options: {"timeout_ms":60000}',
    "const value = 42",
    "return value",
  ])
  expect(draw(value).join("\n")).toContain("second\nthird")
})

test("hides failed script details collapsed but preserves output, errors and full output path expanded", () => {
  context.isError = true
  config.codemode.output.showWithCalls = true
  const value = result([call(1)], "partial output\nScript error:\nactual failure")
  value.details = { calls: [call(1)], fullOutputPath: "/tmp/codemode-full.txt" }
  expect(draw(value)).toContain("✗ Tools · 1 call")
  expect(draw(value).join("\n")).not.toContain("actual failure")
  expect(draw(value).join("\n")).toContain("Full output: /tmp/codemode-full.txt")
  context.expanded = true
  const lines = draw(value)
  expect(lines.join("\n")).toContain("partial output\nScript error:\nactual failure")
  expect(lines.join("\n")).not.toContain("Script failed\nWall time")
  context.expanded = false
  expect(draw(result())).toContain("✗ Failed")
  expect(
    draw({ content: [{ type: "text", text: "invalid options" }], details: undefined }).join("\n"),
  ).not.toContain("invalid options")
})

test("does not infer failure from text and leaves native image blocks untouched", () => {
  const value = result([], "Script failed\nconsole.error is ordinary output")
  value.content.push({ type: "image", data: "base64", mimeType: "image/png" })
  const original = structuredClone(value)
  expect(draw(value)).toContain("✓ Completed")
  expect(draw(value)).toContain("Script failed")
  expect(value).toEqual(original)
  context.isPartial = true
  expect(draw(value).join("\n")).not.toContain("console.error")
})

test("rehydrates the same preview from serialized native arguments and details without live state", () => {
  const value = result(
    Array.from({ length: 10 }, (_, i) => call(i)),
    "recorded output",
  )
  context.expanded = true
  const expected = draw(value)
  const originalArgs = structuredClone(context.args)
  context = { ...context, state: {}, args: JSON.parse(JSON.stringify(context.args)) }
  callComponent = resultComponent = undefined
  renderer = createCodemodeRenderer(() => config)
  expect(draw(JSON.parse(JSON.stringify(value)))).toEqual(expected)
  expect(context.args).toEqual(originalArgs)
})

test("shares ordinary title formatting and requests only JavaScript source highlighting", () => {
  const title = stripVTControlCharacters(
    renderToolCallTitle("read", { path: "src/a.ts", offset: 3, limit: 2 }, theme, context),
  )
  expect(
    draw(
      result([
        {
          id: "1",
          name: "read",
          args: '{"path":"src/a.ts","offset":3,"limit":2}',
          status: "ok",
          durationMs: 1200,
        },
      ]),
    )[3],
  ).toBe("› " + title)
  const highlight = spyOn(highlighting, "highlightDocument").mockReturnValue(["HIGHLIGHTED"])
  const file = spyOn(highlighting, "highlightFileDocument")
  config.highlight.enable = true
  config.codemode.script.showCollapsed = true
  config.codemode.script.collapsedLines = 1
  context.argsComplete = false
  expect(draw(result())[1]).toBe("HIGHLIGHTED")
  expect(highlight).toHaveBeenCalledWith(
    expect.objectContaining({
      source: (context.args as { code: string }).code,
      language: "javascript",
      from: 0,
      to: 1,
      streaming: true,
    }),
  )
  expect(file).not.toHaveBeenCalled()
  context.expanded = true
  draw(result())
  expect(highlight.mock.calls.at(-1)?.[0].to).toBe(3)
})

test("preserves leading blank lines and header-like output in both native block layouts", () => {
  const expected = ["", "indented output"]
  expect(draw(result([], "\nindented output")).slice(-2)).toEqual(expected)
  const combined = result([], "unused")
  combined.content = [
    { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n\nindented output" },
  ]
  expect(draw(combined).slice(-2)).toEqual(expected)
  const noHeader: ToolResult = {
    content: [{ type: "text", text: "\nindented output" }],
    details: undefined,
  }
  expect(draw(noHeader).slice(-2)).toEqual(expected)
})

test("uses error statistics for failed calls even while other calls are still running", () => {
  context.isPartial = true
  const lines = draw(result([call(1, "error"), call(2, "running")]))
  expect(lines).toContain("✗ Tools running · 1/2 calls · 1 failed")
})

test("omits unmatched tool arguments but keeps timing, zero cost, and paths without output", () => {
  const value = result([
    {
      id: "model",
      name: "models.classify",
      args: '{"provider":"demo"}',
      status: "ok",
      durationMs: 32,
      cost: 0,
    },
  ])
  expect(draw(value)).toContain("› models.classify · 32ms · $0.0")
  value.details = { calls: [], fullOutputPath: "/tmp/codemode-empty.txt" }
  expect(draw(value)).toContain("Full output: /tmp/codemode-empty.txt")
})

test("counts indented, wrapped error details from every call in the unified folding notice", () => {
  config.codemode.calls.collapsedCount = 1
  const value = result(
    [
      { ...call(1, "error"), error: "first\nsecond" },
      { ...call(2, "error"), error: "third\nfourth" },
    ],
    "output one\noutput two",
  )
  const original = structuredClone(value)
  const collapsed = draw(value)
  expect(collapsed.at(-1)).toBe("--- 7 lines hidden · ctrl+o to expand ---")
  expect(collapsed.filter((line) => line.includes("hidden"))).toHaveLength(1)
  expect(collapsed.join("\n")).not.toContain("first")
  expect(collapsed.join("\n")).not.toContain("third")
  context.expanded = true
  const expanded = draw(value)
  expect(expanded).toContain("    first")
  expect(expanded).toContain("    second")
  expect(expanded).toContain("    third")
  expect(expanded).toContain("    fourth")
  expect(expanded.some((line) => line.includes("hidden"))).toBe(false)
  expect(value).toEqual(original)
})

test("counts a single error using the same indentation and wrapping as its expanded rows", () => {
  const value = result([{ ...call(1, "error"), error: "x".repeat(21) + "\nshort" }])
  expect(draw(value).at(-1)).toBe("--- 2 lines hidden · ctrl+o to expand ---")
  expect(draw(value, 24).join("\n")).toContain("3 lines hidden")
  context.expanded = true
  const expanded = draw(value, 24)
  expect(expanded.slice(-3)).toEqual(["", "x".repeat(21), "    short"])
  expect(expanded.some((line) => line.includes("hidden"))).toBe(false)
})

test("keeps the native full-output notice without repeating its path once fully visible", () => {
  const path = "/tmp/pi-codemode-full.txt"
  const notice = `[Full output: ${path} (read with offset/limit)]`
  const value = result([], "first\nsecond\n\n" + notice)
  value.details = { calls: [], fullOutputPath: path }
  const original = structuredClone(value)
  config.codemode.output.collapsedLines = 1
  const collapsed = draw(value)
  expect(collapsed).toContain("Full output: " + path)
  expect(collapsed).not.toContain(notice)
  expect(collapsed.at(-1)).toBe("--- 3 lines hidden · ctrl+o to expand ---")
  config.codemode.output.collapsedLines = 10
  expect(draw(value)).toContain(notice)
  expect(draw(value).filter((line) => line.includes(path))).toHaveLength(1)
  context.expanded = true
  const expanded = draw(value)
  expect(expanded).toContain(notice)
  expect(expanded.filter((line) => line.includes(path))).toHaveLength(1)
  expect(expanded.some((line) => line.includes("hidden"))).toBe(false)
  expect(value).toEqual(original)
})

test("only suppresses a matching native notice when all of its wrapped rows are visible", () => {
  const path = "/tmp/c.txt"
  const notice = `[Full output: ${path} (read with offset/limit)]`
  const value = result([], notice + "\nlast line")
  value.details = { calls: [], fullOutputPath: path }
  config.codemode.output.collapsedLines = 1
  expect(draw(value, 40).filter((line) => line.startsWith("Full output:"))).toEqual([
    "Full output: " + path,
  ])
  config.codemode.output.collapsedLines = 2
  const collapsed = draw(value, 40)
  expect(collapsed.some((line) => line.startsWith("Full output:"))).toBe(false)
  expect(collapsed.join("\n")).toContain("1 line hidden")
  context.expanded = true
  expect(draw(value, 40).some((line) => line.startsWith("Full output:"))).toBe(false)
})

test.each([false, true])(
  "keeps a separate full-output path for hidden output, script error: %s",
  (isError) => {
    context.isError = isError
    const path = "/tmp/pi-codemode-full.txt"
    const notice = `[Full output: ${path} (read with offset/limit)]`
    const value = result([call(1)], "partial output\n\n" + notice)
    value.details = { calls: [call(1)], fullOutputPath: path }
    const collapsed = draw(value)
    expect(collapsed).toContain("Full output: " + path)
    expect(collapsed).not.toContain(notice)
    context.expanded = true
    const expanded = draw(value)
    expect(expanded).toContain(notice)
    expect(expanded.filter((line) => line.includes(path))).toHaveLength(1)
  },
)

test.each([
  "[Full output: /tmp/other.txt (read with offset/limit)]",
  "prefix [Full output: /tmp/c.txt (read with offset/limit)]",
  "[Full output: /tmp/c.txt (read with offset/limit)] suffix",
  "[Full output: /tmp/c.txt (read with offset/limit",
])("preserves similar script text without treating it as the native path notice: %s", (text) => {
  const value = result([], text)
  value.details = { calls: [], fullOutputPath: "/tmp/c.txt" }
  context.expanded = true
  const lines = draw(value)
  expect(lines).toContain(text)
  expect(lines).toContain("Full output: /tmp/c.txt")
})

test("source regions render only visible rows and count omitted rows at the terminal width", () => {
  config.codemode.script.showCollapsed = true
  config.codemode.script.collapsedLines = 1
  const source = ["a".repeat(45), "b".repeat(65), "", "c".repeat(81)]
  context.args = { code: source.join("\n") }
  const foreground = spyOn(theme, "fg")
  const value = result()
  const collapsed = draw(value, 40)
  expect(collapsed.slice(1, 3)).toEqual(["a".repeat(40), "a".repeat(5)])
  expect(collapsed.join("\n")).toContain("6 lines hidden")
  for (const line of source)
    expect(
      foreground.mock.calls.filter(([color, text]) => color === "toolOutput" && text === line),
    ).toHaveLength(1)
  foreground.mockClear()
  expect(draw(value, 60).join("\n")).toContain("5 lines hidden")
  context.expanded = true
  foreground.mockClear()
  const expanded = draw(value, 40)
  expect(expanded.some((line) => line.includes("hidden"))).toBe(false)
  for (const line of source)
    expect(
      foreground.mock.calls.filter(([color, text]) => color === "toolOutput" && text === line),
    ).toHaveLength(1)
  context.expanded = false
  config.codemode.script.showCollapsed = false
  foreground.mockClear()
  expect(draw(value, 40).some((line) => line.includes("hidden"))).toBe(false)
  expect(foreground.mock.calls.some(([color]) => color === "toolOutput")).toBe(false)
})

test("counts wrapped source before a first result without repeating the source preview", () => {
  config.codemode.script.showCollapsed = true
  config.codemode.script.collapsedLines = 1
  context.isPartial = true
  context.args = { code: "visible\n" + "x".repeat(65) }
  const foreground = spyOn(theme, "fg")
  const running = draw(undefined, 40)
  expect(running[1]).toBe("visible")
  expect(running).toContain("◆ Running…")
  expect(running.join("\n")).toContain("2 lines hidden")
  for (const text of ["visible", "x".repeat(65)])
    expect(
      foreground.mock.calls.filter(([color, value]) => color === "toolOutput" && value === text),
    ).toHaveLength(1)
})

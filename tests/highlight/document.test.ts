import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { stripVTControlCharacters as stripAnsi } from "node:util"
import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  getThemeByName,
  loadThemeFromPath,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import * as shiki from "shiki"
import {
  highlightCode,
  highlightDocument,
  configureHighlighting,
  disposeHighlighting,
  cancelHighlightRequest,
  releaseHighlightDocument,
  type HighlightDocumentOptions,
} from "../../src/highlight/index.ts"
import { ansiLines } from "../../src/highlight/engine.ts"
import { documentCacheStats } from "../../src/highlight/document.ts"
import { ansiCache, HIGHLIGHT_LIMITS } from "../../src/highlight/cache.ts"

const createHighlighter = shiki.createHighlighter
let theme: Theme
let instance: shiki.Highlighter
let tokens: ReturnType<typeof spyOn<shiki.Highlighter, "codeToTokensBase">>
const onError = mock((_error: Error) => {})

beforeEach(() => {
  theme = getThemeByName("dark")!
  onError.mockClear()
  configureHighlighting({ enable: true, theme: "auto" })
  spyOn(shiki, "createHighlighter").mockImplementation(async (options) => {
    instance = await createHighlighter(options)
    tokens = spyOn(instance, "codeToTokensBase")
    return instance
  })
})
afterEach(() => {
  disposeHighlighting()
  Reflect.deleteProperty(theme, "appearance")
  mock.restore()
})

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Highlight timeout")
    await nextTurn()
  }
}
function options(
  source: string,
  extra: Partial<HighlightDocumentOptions> = {},
): HighlightDocumentOptions {
  return {
    id: "call:script",
    source,
    language: "ts",
    from: 0,
    to: source.split(/\r\n?|\n/).length,
    subscriberId: "call:call",
    theme,
    onError,
    ...extra,
  }
}
async function complete(request: HighlightDocumentOptions) {
  const redraw = mock(() => {})
  const initial = highlightDocument({ ...request, invalidate: redraw })
  if (initial?.every((line) => line !== null)) return initial
  await until(() => redraw.mock.calls.length > 0 || onError.mock.calls.length > 0)
  expect(onError).not.toHaveBeenCalled()
  const result = highlightDocument(request)
  expect(result?.every((line) => line !== null)).toBe(true)
  return result
}
async function shortReady(code = "const n = 1") {
  await until(() => highlightCode(code, "ts", { theme, onError }) !== null)
}

test("ANSI reuse skips tokenization and formatting, is isolated by color mode, and protects cached arrays", async () => {
  await shortReady()
  const spy = spyOn(instance, "codeToTokens")
  const style = spyOn(theme, "style")
  const result = highlightCode("const n = 1", "typescript", { theme, onError })!
  result[0] = "corrupted"
  expect(highlightCode("const n = 1", "ts", { theme, onError })![0]).not.toBe("corrupted")
  expect(spy).not.toHaveBeenCalled()
  expect(style).not.toHaveBeenCalled()
  const mode = theme.getColorMode()
  spyOn(theme, "getColorMode").mockReturnValue(mode === "truecolor" ? "256color" : "truecolor")
  expect(highlightCode("const n = 1", "ts", { theme, onError })).not.toBeNull()
  expect(spy).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 150; i++) highlightCode(`let n = ${i}`, "ts", { theme, onError })
  expect(ansiCache.size).toBe(HIGHLIGHT_LIMITS.ansiEntries)
  expect(ansiCache.characters).toBeLessThanOrEqual(HIGHLIGHT_LIMITS.ansiCharacters)
  configureHighlighting({ enable: false, theme: "auto" })
  expect(ansiCache.size).toBe(0)
})

test("synchronous budgets reject large input without initializing Shiki", () => {
  const init = spyOn(shiki, "createHighlighter")
  expect(highlightCode("x\n".repeat(1000), "ts", { theme, onError })).toBeNull()
  expect(highlightCode("x".repeat(16001), "ts", { theme, onError })).toBeNull()
  expect(init).not.toHaveBeenCalled()
})

for (const language of ["typescript", "javascript", "json", "markdown"] as const) {
  test(`real ${language} chunks equal whole-document tokenization`, async () => {
    let source: string
    switch (language) {
      case "json":
        source = JSON.stringify(
          { values: Array.from({ length: 1100 }, (_, i) => ({ i })) },
          null,
          2,
        )
        break
      case "markdown":
        source = [
          "# Title",
          "```ts",
          "/*",
          ...Array(220).fill("comment"),
          "*/",
          "const s = `",
          ...Array(180).fill("text"),
          "`",
          "```",
          "**done**",
          "",
        ].join("\n")
        break
      default:
        source = [
          "/*",
          ...Array(220).fill("comment"),
          "*/",
          "const s = `",
          ...Array(180).fill("text"),
          "`",
          "const n = 1",
          "",
        ].join("\n")
    }
    const request = options(source, { language })
    const result = await complete(request)
    const expected = instance.codeToTokens(source, {
      lang: language,
      theme: "dark-plus",
      tokenizeMaxLineLength: 16000,
    })
    expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
    expect(tokens.mock.calls.length).toBeGreaterThan(3)
    for (const [code] of tokens.mock.calls) expect(code.split("\n").length).toBeLessThanOrEqual(96)
    const count = tokens.mock.calls.length
    expect(highlightDocument(request)).toEqual(result)
    expect(tokens).toHaveBeenCalledTimes(count)
  })
}

test("a far range computes only the required context and later reuses that prefix", async () => {
  const source = ["/*", ...Array(998).fill("comment"), "*/"].join("\n")
  await complete(options(source, { from: 498, to: 500 }))
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(500)
  const count = tokens.mock.calls.length
  expect(highlightDocument(options(source, { from: 200, to: 210 }))!.every(Boolean)).toBe(true)
  expect(tokens).toHaveBeenCalledTimes(count)
  await complete(options(source, { from: 500, to: 501 }))
  expect(tokens.mock.calls.at(-1)![0]).toBe("comment")
})

test("long lines remain safe and character-heavy chunks stay bounded", async () => {
  const source = [
    "const a = 1",
    "x".repeat(50000),
    ...Array(30).fill("//" + "c".repeat(1000)),
    "\u001b[31m",
    "",
  ].join("\n")
  const result = await complete(options(source))
  expect(stripAnsi(result![1]!)).toBe("x".repeat(50000))
  expect(stripAnsi(result!.at(-2)!)).toContain("␛[31m")
  for (const [code] of tokens.mock.calls) {
    if (code.length > 16000) expect(code.split("\n").length).toBe(1)
  }
})

test("stable subscriber identity keeps only its latest callback and cancellation shrinks targets", async () => {
  await shortReady()
  const old = mock(() => {})
  const latest = mock(() => {})
  const source = "let n = 1\n".repeat(1000)
  const req = options(source, { to: 300 })
  highlightDocument({ ...req, invalidate: old })
  highlightDocument({ ...req, invalidate: latest })
  await until(() => latest.mock.calls.length > 0)
  expect(old).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledTimes(1)
  highlightDocument(options(source, { to: 800, subscriberId: "hidden" }))
  const count = tokens.mock.calls.length
  cancelHighlightRequest("hidden")
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(count)
  expect(documentCacheStats().subscribers).toBe(0)
})

test("version, language, theme, release, eviction, disable and shutdown cancel stale work", async () => {
  await shortReady()
  const old = mock(() => {})
  const source = "let n = 1\n".repeat(1000)
  highlightDocument(options(source, { invalidate: old }))
  await complete(options("/*\nnew\n*/"))
  expect(old).not.toHaveBeenCalled()
  tokens.mockClear()
  highlightDocument(options(source, { invalidate: old }))
  const beforeRelease = tokens.mock.calls.length
  releaseHighlightDocument("call:script")
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(beforeRelease)
  for (let i = 0; i < 30; i++)
    highlightDocument(options(source, { id: String(i), subscriberId: String(i), invalidate: old }))
  expect(documentCacheStats().entries).toBe(24)
  expect(documentCacheStats().subscribers).toBe(24)
  configureHighlighting({ enable: true, theme: "github-light" })
  expect(documentCacheStats().entries).toBe(0)
  expect(documentCacheStats().tasks).toBe(0)
  expect(documentCacheStats().subscribers).toBe(0)
  highlightDocument(options(source, { invalidate: old }))
  configureHighlighting({ enable: false, theme: "auto" })
  await nextTurn()
  expect(old).not.toHaveBeenCalled()
  configureHighlighting({ enable: true, theme: "auto" })
  await complete(options("const fresh = 1"))
  disposeHighlighting()
  expect(documentCacheStats().characters).toBe(0)
})

test("invalid ranges and oversized documents fail explicitly, unsupported languages return null", () => {
  expect(highlightDocument(options("x", { from: -1 }))).toBeNull()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(highlightDocument(options("x".repeat(4_000_001)))).toBeNull()
  expect(onError).toHaveBeenCalledTimes(2)
  expect(highlightDocument(options("x", { language: "not-a-language" }))).toBeNull()
})

test("small streaming updates immediately highlight the tail without reprocessing stable lines or redrawing", async () => {
  await shortReady()
  const redraw = mock(() => {})
  let source = 'const first = 1\nconst message = "hel'
  let previous = highlightDocument(options(source, { streaming: true, invalidate: redraw }))!
  expect(previous.every((line) => line !== null)).toBe(true)
  for (const suffix of [
    "l",
    "o",
    '"',
    "\n/*",
    "\ncomment",
    "\n*/\nconst s = `hel",
    "lo",
    "\nworld",
    "`",
    "\n",
  ]) {
    const stable = source.split("\n").length - 1
    const oldTail = source.split("\n").at(-1)!
    source += suffix
    tokens.mockClear()
    const current = highlightDocument(options(source, { streaming: true, invalidate: redraw }))!
    expect(current.every((line) => line !== null)).toBe(true)
    expect(current.slice(0, stable)).toEqual(previous.slice(0, stable))
    expect(tokens.mock.calls.map(([code]) => code).join("\n")).toBe(oldTail + suffix)
    const count = tokens.mock.calls.length
    expect(highlightDocument(options(source, { streaming: true, invalidate: redraw }))).toEqual(
      current,
    )
    expect(tokens).toHaveBeenCalledTimes(count)
    const expected = instance.codeToTokens(source, { lang: "typescript", theme: "dark-plus" })
    expect(current).toEqual(ansiLines(expected.tokens, theme, expected.fg))
    previous = current
  }
  const count = tokens.mock.calls.length
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(count)
  expect(redraw).not.toHaveBeenCalled()
  expect(documentCacheStats().tasks).toBe(0)
  expect(documentCacheStats().subscribers).toBe(0)
})

test.each([
  [
    "lines",
    Array.from({ length: 240 }, (_, i) => `const n${i} = ${i}`),
    HIGHLIGHT_LIMITS.syncLines,
  ],
  ["characters", Array.from({ length: 4 }, (_, i) => "//" + String(i).repeat(9000)), 1],
] as const)(
  "synchronously fills the %s budget and schedules only the remaining lines",
  async (_name, lines, completed) => {
    await shortReady()
    const source = lines.join("\n")
    const redraw = mock(() => {})
    const initial = highlightDocument(options(source, { invalidate: redraw }))!
    expect(initial.slice(0, completed).every((line) => line !== null)).toBe(true)
    expect(initial.slice(completed).every((line) => line === null)).toBe(true)
    const syncCalls = tokens.mock.calls.length
    expect(documentCacheStats().tasks).toBe(1)
    await until(() => redraw.mock.calls.length > 0)
    expect(
      tokens.mock.calls
        .slice(syncCalls)
        .map(([code]) => code)
        .join("\n"),
    ).toBe(lines.slice(completed).join("\n"))
    const result = highlightDocument(options(source))
    const expected = instance.codeToTokens(source, { lang: "typescript", theme: "dark-plus" })
    expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
    expect(redraw).toHaveBeenCalledTimes(1)
    expect(documentCacheStats().tasks).toBe(0)
  },
)

test("a synchronous streamed tail cancels pending older slices without a stale commit or redraw", async () => {
  await shortReady()
  let source = ["/*", ...Array(190).fill("comment"), "partial"].join("\n")
  const oldRedraw = mock(() => {})
  const initial = highlightDocument(options(source, { streaming: true, invalidate: oldRedraw }))!
  expect(initial.at(-1)).toBeNull()
  await nextTurn()
  expect(documentCacheStats().tasks).toBe(1)
  tokens.mockClear()
  source += " tail\n*/\nconst final = 1"
  const redraw = mock(() => {})
  const result = highlightDocument(options(source, { streaming: true, invalidate: redraw }))!
  expect(result.every((line) => line !== null)).toBe(true)
  expect(tokens.mock.calls.map(([code]) => code)).toEqual(["partial tail\n*/", "const final = 1"])
  const count = tokens.mock.calls.length
  await nextTurn()
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(count)
  expect(oldRedraw).not.toHaveBeenCalled()
  expect(redraw).not.toHaveBeenCalled()
  expect(documentCacheStats().tasks).toBe(0)
  const expected = instance.codeToTokens(source, { lang: "typescript", theme: "dark-plus" })
  expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
})

test("streaming reprocesses only the unstable tail and appended lines across comments and strings", async () => {
  let source = ["const first = 1", "/*", ...Array(180).fill("comment"), "partial"].join("\n")
  await complete(options(source, { streaming: true }))
  tokens.mockClear()
  source += " tail\n*/\nconst s = `hello\nworld"
  await complete(options(source, { streaming: true }))
  expect(tokens.mock.calls[0]![0]).toStartWith("partial tail")
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(4)
  tokens.mockClear()
  source += "!`\nconst last = 2"
  const result = await complete(options(source, { streaming: false }))
  expect(tokens.mock.calls[0]![0]).toBe("world!`")
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(2)
  const expected = instance.codeToTokens(source, { lang: "typescript", theme: "dark-plus" })
  expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
  const count = tokens.mock.calls.length
  expect(highlightDocument(options(source, { streaming: false }))).toEqual(result)
  expect(tokens).toHaveBeenCalledTimes(count)
})

test("rapid streaming updates are latest-wins and non-append modifications restart context", async () => {
  await shortReady()
  const old = mock(() => {})
  let source = "/*\n" + "comment\n".repeat(220)
  highlightDocument(options(source, { streaming: true, invalidate: old }))
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(2)
  const prefix = tokens.mock.calls[0]![0]
  source += "end"
  highlightDocument(options(source, { streaming: true, invalidate: old }))
  source += "*/\nconst final = 1"
  await complete(options(source, { streaming: false }))
  expect(tokens.mock.calls.filter(([code]) => code === prefix).length).toBe(1)
  expect(old).not.toHaveBeenCalled()
  tokens.mockClear()
  await complete(options("const reset = 1\n" + source, { streaming: false }))
  expect(tokens.mock.calls[0]![0]).toStartWith("const reset = 1")
})

for (const ending of ["\n", "\r\n", "\r"]) {
  test(`streaming empty tail and ${JSON.stringify(ending)} preserve grammar and blank lines`, async () => {
    let source = "/*" + ending + "comment" + ending
    await complete(options(source, { streaming: true }))
    tokens.mockClear()
    source += (ending === "\r" ? "\n" : "") + "*/" + ending + "const n = 1"
    const result = await complete(options(source, { streaming: false }))
    expect(tokens.mock.calls[0]![0]).toBe("*/")
    const expected = instance.codeToTokens(source.replace(/\r\n?/g, "\n"), {
      lang: "typescript",
      theme: "dark-plus",
    })
    expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
  })
}

test("multiple regions share work and cancelling one leaves the other demand and redraw intact", async () => {
  await shortReady()
  const source = "const n = 1\n".repeat(500)
  const a = mock(() => {})
  const b = mock(() => {})
  highlightDocument(options(source, { to: 100, subscriberId: "call:call", invalidate: a }))
  highlightDocument(options(source, { to: 200, subscriberId: "call:result", invalidate: b }))
  cancelHighlightRequest("call:call")
  await until(() => b.mock.calls.length > 0)
  expect(a).not.toHaveBeenCalled()
  expect(b).toHaveBeenCalledTimes(1)
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(200)
})

test("language, appearance and color mode changes rebuild document state, not the Shiki instance", async () => {
  const source = "const n = 1"
  await complete(options(source))
  const initialInstance = instance
  const first = tokens.mock.calls.length
  await complete(options(source, { language: "js" }))
  expect(tokens.mock.calls.length).toBeGreaterThan(first)
  expect(tokens.mock.calls.at(-1)![1]?.lang).toBe("javascript")
  spyOn(theme, "getColorMode").mockReturnValue("256color")
  const beforeMode = tokens.mock.calls.length
  await complete(options(source, { language: "js" }))
  expect(tokens.mock.calls.length).toBeGreaterThan(beforeMode)
  Object.defineProperty(theme, "appearance", { configurable: true, value: "light" })
  await complete(options(source, { language: "js" }))
  expect(tokens.mock.calls.at(-1)![1]?.theme).toBe("github-light")
  expect(instance).toBe(initialInstance)
})

test("document load and tokenization failures reach every live subscriber and do not retry", async () => {
  await shortReady()
  const cause = new Error("grammar import failed")
  const load = spyOn(instance, "loadLanguage").mockRejectedValueOnce(cause)
  const otherError = mock((_error: Error) => {})
  highlightDocument(options("print('x')", { id: "py-a", language: "python" }))
  highlightDocument(
    options("print('y')", {
      id: "py-b",
      language: "python",
      subscriberId: "other",
      onError: otherError,
    }),
  )
  await until(() => otherError.mock.calls.length > 0)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(otherError).toHaveBeenCalledTimes(1)
  expect(onError.mock.calls[0]![0].cause).toBe(cause)
  expect(highlightDocument(options("print('x')", { language: "python" }))).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
  onError.mockClear()
  tokens.mockImplementationOnce(() => {
    throw new Error("tokenization failed")
  })
  highlightDocument(options("const broken = 1", { id: "broken" }))
  await until(() => onError.mock.calls.length > 0)
  expect(onError.mock.calls[0]![0].message).toContain("tokenization failed")
  expect(highlightDocument(options("const broken = 1", { id: "broken" }))).toBeNull()
  expect(documentCacheStats().subscribers).toBe(0)
})

test("initialization failures clear all waiting documents, and shutdown permits a fresh engine", async () => {
  const cause = new Error("wasm unavailable")
  spyOn(shiki, "createHighlighter").mockRejectedValueOnce(cause)
  const otherError = mock((_error: Error) => {})
  highlightDocument(options("const n = 1", { id: "a" }))
  highlightDocument(options("const n = 2", { id: "b", subscriberId: "b", onError: otherError }))
  await until(() => otherError.mock.calls.length > 0)
  expect(onError.mock.calls[0]![0].cause).toBe(cause)
  expect(documentCacheStats().subscribers).toBe(0)
  expect(documentCacheStats().tasks).toBe(0)
  expect(highlightDocument(options("const n = 3", { id: "c" }))).toBeNull()
  disposeHighlighting()
  onError.mockClear()
  await complete(options("const recovered = 1"))
})

test("document character budget evicts live work and includes generated ANSI growth", async () => {
  await shortReady()
  const large = "x".repeat(1_000_000)
  const old = mock(() => {})
  highlightDocument(options(large, { id: "a", subscriberId: "a", invalidate: old }))
  highlightDocument(options(large, { id: "b", subscriberId: "b", invalidate: old }))
  highlightDocument(options(large, { id: "c", subscriberId: "c", invalidate: old }))
  highlightDocument(options(large, { id: "d", subscriberId: "d", invalidate: old }))
  expect(documentCacheStats().entries).toBe(3)
  expect(documentCacheStats().subscribers).toBe(3)
  expect(documentCacheStats().characters).toBeLessThanOrEqual(8_000_000)
  disposeHighlighting()
  onError.mockClear()
  await shortReady()
  highlightDocument(options("x".repeat(3_000_000)))
  await until(() => onError.mock.calls.length > 0)
  expect(onError.mock.calls[0]![0].message).toContain("character budget")
  expect(documentCacheStats().characters).toBe(0)
  expect(documentCacheStats().subscribers).toBe(0)
})

test("skipped extreme lines yield in pieces, preserve prior grammar and cannot commit obsolete versions", async () => {
  await shortReady()
  const source = "/*\n" + "x".repeat(100000) + "\nstill comment\n*/\nconst n = 1"
  const result = await complete(options(source))
  const expected = instance.codeToTokens(source, {
    lang: "typescript",
    theme: "dark-plus",
    tokenizeMaxLineLength: 16000,
  })
  expect(result).toEqual(ansiLines(expected.tokens, theme, expected.fg))
  tokens.mockClear()
  const original = instance.codeToTokensBase.bind(instance)
  tokens.mockImplementationOnce((code, opts) => {
    const result = original(code, opts)
    highlightDocument(options("const newest = 2"))
    return result
  })
  const old = mock(() => {})
  highlightDocument(options("const obsolete = 1", { invalidate: old }))
  await until(() => documentCacheStats().tasks === 0)
  expect(highlightDocument(options("const newest = 2"))![0]).toContain("newest")
  expect(old).not.toHaveBeenCalled()
})

test("document scheduling is foreground-first, round-robin, and bounded by requested background ranges", async () => {
  await shortReady()
  const visibleA = "// A\n".repeat(1000)
  const visibleB = "// B\n".repeat(1000)
  const background = "// background\n".repeat(1000)
  const done = mock(() => {})
  highlightDocument(
    options(background, {
      id: "background",
      subscriberId: "background",
      to: 100,
      priority: "background",
      invalidate: done,
    }),
  )
  highlightDocument(options(visibleA, { id: "A", subscriberId: "A", to: 200 }))
  highlightDocument(options(visibleB, { id: "B", subscriberId: "B", to: 200 }))
  await until(() => done.mock.calls.length > 0)
  expect(tokens.mock.calls.map(([code]) => code.split("\n")[0])).toEqual([
    "// A",
    "// B",
    "// A",
    "// B",
    "// A",
    "// B",
    "// background",
    "// background",
  ])
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(500)
})

test("simulated Pi renderer keeps identities in state, skips hidden scripts, and reuses streamed and expanded output", async () => {
  const context = {
    toolCallId: "codemode-42",
    state: { documentId: "" },
    expanded: false,
    argsComplete: false,
    invalidate: mock(() => {}),
  }
  const render = (source: string, showCollapsed = false) => {
    if (!context.expanded && !showCollapsed) {
      cancelHighlightRequest(context.toolCallId + ":call")
      return null
    }
    context.state.documentId ||= context.toolCallId + ":script"
    const raw = source.split("\n")
    const to = context.expanded ? raw.length : Math.min(raw.length, 8)
    const result = highlightDocument({
      id: context.state.documentId,
      source,
      language: "js",
      from: 0,
      to,
      streaming: !context.argsComplete,
      subscriberId: context.toolCallId + ":call",
      theme,
      invalidate: context.invalidate,
      onError,
    })
    return raw.slice(0, to).map((line, index) => result?.[index] ?? line)
  }
  const init = spyOn(shiki, "createHighlighter")
  let source = "const n = 1\n".repeat(300)
  expect(render(source)).toBeNull()
  expect(init).not.toHaveBeenCalled()
  const raw = render(source, true)!
  expect(raw.length).toBe(8)
  await until(() => context.invalidate.mock.calls.length > 0)
  expect(render(source, true)).not.toEqual(raw)
  expect(tokens.mock.calls.flatMap(([code]) => code.split("\n")).length).toBe(8)
  context.expanded = true
  context.invalidate.mockClear()
  context.invalidate = mock(() => {})
  source += "// final"
  context.argsComplete = true
  render(source)
  await until(() => context.invalidate.mock.calls.length > 0)
  expect(render(source)!.length).toBe(301)
  expect(init).toHaveBeenCalledTimes(1)
  expect(highlightCode("echo ready", "bash", { theme, onError })).toBeNull()
  await until(() => highlightCode("echo ready", "bash", { theme, onError }) !== null)
  expect(init).toHaveBeenCalledTimes(1)
  releaseHighlightDocument(context.state.documentId)
  expect(documentCacheStats().entries).toBe(0)
})

test("real Pi terminal modes yield distinct ANSI caches and document output", async () => {
  const themePath =
    import.meta.dir +
    "/../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"
  const truecolor = loadThemeFromPath(themePath, "truecolor")
  const indexed = loadThemeFromPath(themePath, "256color")
  theme = truecolor
  await shortReady()
  const color = highlightCode("const n = 1", "ts", { theme: truecolor, onError })!
  const index = highlightCode("const n = 1", "ts", { theme: indexed, onError })!
  expect(color[0]).toContain("38;2;")
  expect(index[0]).toContain("38;5;")
  expect(color).not.toEqual(index)
  const docColor = await complete(options("const n = 1", { theme: truecolor }))
  const docIndex = await complete(options("const n = 1", { theme: indexed }))
  expect(docColor).toEqual(color)
  expect(docIndex).toEqual(index)
})

test("in-place Pi theme changes cancel queued slices and redraws before another renderer request", async () => {
  await shortReady()
  const source = "const n = 1\n".repeat(1000)
  const old = mock(() => {})
  highlightDocument(options(source, { invalidate: old }))
  const beforeThemeChange = tokens.mock.calls.length
  Object.defineProperty(theme, "appearance", { configurable: true, value: "light" })
  await nextTurn()
  expect(tokens).toHaveBeenCalledTimes(beforeThemeChange)
  expect(documentCacheStats().subscribers).toBe(0)
  expect(documentCacheStats().tasks).toBe(0)
  expect(old).not.toHaveBeenCalled()
  await complete(options(source, { to: 1 }))
  expect(tokens.mock.calls.at(-1)![1]?.theme).toBe("github-light")
})

test("an obsolete language loading error cannot fail the updated document", async () => {
  await shortReady()
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  spyOn(instance, "loadLanguage").mockImplementationOnce(async () => {
    started.resolve()
    await gate.promise
  })
  const oldRedraw = mock(() => {})
  highlightDocument(options("print(1)", { language: "python", invalidate: oldRedraw }))
  await started.promise
  const current = options("const current = 1")
  const result = await complete(current)
  gate.reject(new Error("obsolete Python import failed"))
  await nextTurn()
  expect(highlightDocument(current)).toEqual(result)
  expect(oldRedraw).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

for (const resource of ["language", "theme"] as const) {
  test(`an obsolete ${resource} loading error cannot cancel a recreated document with the same ID`, async () => {
    await shortReady()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const pending = async () => {
      started.resolve()
      await gate.promise
    }
    if (resource === "language") spyOn(instance, "loadLanguage").mockImplementationOnce(pending)
    else {
      spyOn(instance, "loadTheme").mockImplementationOnce(pending)
      configureHighlighting({ enable: true, theme: "tokyo-night" })
    }
    const oldRedraw = mock(() => {})
    highlightDocument(
      options("const old = 1", {
        language: resource === "language" ? "python" : "ts",
        invalidate: oldRedraw,
      }),
    )
    await started.promise
    if (resource === "language") releaseHighlightDocument("call:script")
    else configureHighlighting({ enable: true, theme: "auto" })
    const current = options("const current = 1\n".repeat(300))
    const freshRedraw = mock(() => {})
    highlightDocument({ ...current, invalidate: freshRedraw })
    await nextTurn()
    expect(documentCacheStats().tasks).toBe(1)
    gate.reject(new Error(`obsolete ${resource} import failed`))
    await until(() => freshRedraw.mock.calls.length > 0)
    expect(highlightDocument(current)?.every((line) => line !== null)).toBe(true)
    expect(oldRedraw).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
}

test("a pending theme error after an in-place appearance change cancels only the obsolete request", async () => {
  await shortReady()
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  spyOn(instance, "loadTheme").mockImplementationOnce(async () => {
    started.resolve()
    await gate.promise
  })
  const oldRedraw = mock(() => {})
  Object.defineProperty(theme, "appearance", { configurable: true, value: "light" })
  highlightDocument(options("const n = 1", { invalidate: oldRedraw }))
  await started.promise
  Object.defineProperty(theme, "appearance", { configurable: true, value: "dark" })
  gate.reject(new Error("obsolete light theme import failed"))
  await nextTurn()
  expect(documentCacheStats().subscribers).toBe(0)
  expect(documentCacheStats().tasks).toBe(0)
  expect(oldRedraw).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  await complete(options("const current = 2"))
})

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import * as shiki from "shiki"

import {
  configureHighlighting,
  disposeHighlighting,
  highlightCode,
} from "../../src/highlight/index.ts"

const createHighlighter = shiki.createHighlighter
let theme: Theme
let appearance: "light" | "dark"
const onError = mock((_error: Error) => {})
const invalidate = mock(() => {})

// Observe our requests while retaining real Shiki initialization and tokenization.
function observe(highlighter: shiki.Highlighter) {
  return {
    highlighter,
    loadTheme: spyOn(highlighter, "loadTheme"),
    loadLanguage: spyOn(highlighter, "loadLanguage"),
    codeToTokens: spyOn(highlighter, "codeToTokens"),
    dispose: spyOn(highlighter, "dispose"),
  }
}

let instances: ReturnType<typeof observe>[]
let initialize: ReturnType<typeof spyOn<typeof shiki, "createHighlighter">>

beforeEach(() => {
  instances = []
  onError.mockClear()
  invalidate.mockClear()
  appearance = "dark"
  const selected = getThemeByName("dark")
  if (!selected) throw new Error("Pi's built-in dark theme is unavailable")
  theme = selected
  Object.defineProperty(theme, "appearance", { configurable: true, get: () => appearance })
  configureHighlighting({ enable: true, theme: "auto" })
  initialize = spyOn(shiki, "createHighlighter").mockImplementation(async (options) => {
    const highlighter = await createHighlighter(options)
    instances.push(observe(highlighter))
    return highlighter
  })
})

afterEach(() => {
  disposeHighlighting()
  configureHighlighting({ enable: true, theme: "auto" })
  Reflect.deleteProperty(theme, "appearance")
  mock.restore()
})

function render(callback = invalidate): string[] | null {
  return highlightCode("const answer = 42", "typescript", {
    theme,
    invalidate: callback,
    onError,
  })
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for highlighting")
    await nextTurn()
  }
}

async function ready(): Promise<void> {
  await until(() => render() !== null || onError.mock.calls.length > 0)
  expect(onError).not.toHaveBeenCalled()
}

function lastTokenizedTheme() {
  const options = instances.at(-1)?.codeToTokens.mock.calls.at(-1)?.[1]
  return options && "theme" in options ? options.theme : undefined
}

test("disabled highlighting does not initialize Shiki", () => {
  configureHighlighting({ enable: false, theme: "tokyo-night" })
  expect(render()).toBeNull()
  expect(initialize).not.toHaveBeenCalled()
  expect(invalidate).not.toHaveBeenCalled()
})

test("auto and custom pairs follow appearance changes on the same Theme instance", async () => {
  await ready()
  expect(lastTokenizedTheme()).toBe("dark-plus")
  appearance = "light"
  await ready()
  expect(lastTokenizedTheme()).toBe("github-light")

  configureHighlighting({
    enable: true,
    theme: { light: "min-light", dark: "catppuccin-mocha" },
  })
  await ready()
  expect(lastTokenizedTheme()).toBe("min-light")
  appearance = "dark"
  await ready()
  expect(lastTokenizedTheme()).toBe("catppuccin-mocha")
})

test("fixed themes ignore appearance and configuration changes reuse the highlighter and languages", async () => {
  configureHighlighting({ enable: true, theme: "tokyo-night" })
  await ready()
  expect(lastTokenizedTheme()).toBe("tokyo-night")
  const tokyoOutput = render()
  appearance = "light"
  expect(render()).not.toBeNull()
  expect(lastTokenizedTheme()).toBe("tokyo-night")

  configureHighlighting({ enable: true, theme: "github-light" })
  await ready()
  expect(lastTokenizedTheme()).toBe("github-light")
  configureHighlighting({ enable: true, theme: "tokyo-night" })
  expect(render()).toEqual(tokyoOutput)
  // Returning to a loaded theme now reuses its ANSI cache, not another tokenization.
  expect(lastTokenizedTheme()).toBe("github-light")
  expect(initialize).toHaveBeenCalledTimes(1)
  expect(instances[0]!.loadLanguage).toHaveBeenCalledTimes(1)
  expect(instances[0]!.loadTheme).toHaveBeenCalledTimes(2)
  expect(instances[0]!.dispose).not.toHaveBeenCalled()
})

test("pending theme requests load once and notify each distinct renderer once", async () => {
  await ready()
  const instance = instances[0]!
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const original = instance.highlighter.loadTheme.bind(instance.highlighter)
  instance.loadTheme.mockImplementationOnce(async (...args) => {
    started.resolve()
    await gate.promise
    await original(...args)
  })
  configureHighlighting({ enable: true, theme: "tokyo-night" })
  invalidate.mockClear()
  const other = mock(() => {})
  expect(render()).toBeNull()
  await started.promise
  for (let i = 0; i < 5; i++) {
    expect(render()).toBeNull()
    expect(render(other)).toBeNull()
  }
  expect(instance.loadTheme).toHaveBeenCalledTimes(2)
  gate.resolve()
  await until(() => other.mock.calls.length > 0)
  expect(invalidate).toHaveBeenCalledTimes(1)
  expect(other).toHaveBeenCalledTimes(1)
  expect(render()).not.toBeNull()
  expect(onError).not.toHaveBeenCalled()
})

test("a failed theme is reported once without retrying or blocking other themes", async () => {
  await ready()
  const instance = instances[0]!
  const cause = new Error("theme import failed")
  instance.loadTheme.mockRejectedValueOnce(cause)
  configureHighlighting({ enable: true, theme: "tokyo-night" })
  expect(render()).toBeNull()
  await until(() => onError.mock.calls.length > 0)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError.mock.calls[0]![0].cause).toBe(cause)
  expect(onError.mock.calls[0]![0].message).toContain("tokyo-night")
  for (let i = 0; i < 3; i++) expect(render()).toBeNull()
  expect(instance.loadTheme).toHaveBeenCalledTimes(2)
  configureHighlighting({ enable: true, theme: "github-light" })
  await until(() => render() !== null)
  expect(onError).toHaveBeenCalledTimes(1)
  expect(initialize).toHaveBeenCalledTimes(1)
})

test("disposing pending initialization disposes its late instance without invalidating the new one", async () => {
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  initialize.mockImplementationOnce(async (options) => {
    const highlighter = await createHighlighter(options)
    instances.push(observe(highlighter))
    started.resolve()
    await gate.promise
    return highlighter
  })
  expect(render()).toBeNull()
  await started.promise
  const old = instances[0]!
  disposeHighlighting()
  const fresh = mock(() => {})
  render(fresh)
  await until(() => fresh.mock.calls.length > 0 && render(fresh) !== null)
  gate.resolve()
  await until(() => old.dispose.mock.calls.length > 0)
  expect(invalidate).not.toHaveBeenCalled()
  expect(old.loadTheme).not.toHaveBeenCalled()
  expect(old.loadLanguage).not.toHaveBeenCalled()
  expect(render(fresh)).not.toBeNull()
  expect(instances[1]!.dispose).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

test("disabling during a theme load suppresses its late redraw and releases resources", async () => {
  await ready()
  const instance = instances[0]!
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const original = instance.highlighter.loadTheme.bind(instance.highlighter)
  instance.loadTheme.mockImplementationOnce(async (...args) => {
    // Load real data before pausing, so releasing a disposed instance touches no Shiki internals.
    await original(...args)
    started.resolve()
    await gate.promise
    completed.resolve()
  })
  configureHighlighting({ enable: true, theme: "tokyo-night" })
  invalidate.mockClear()
  expect(render()).toBeNull()
  await started.promise
  configureHighlighting({ enable: false, theme: "tokyo-night" })
  gate.resolve()
  await completed.promise
  await nextTurn()
  expect(render()).toBeNull()
  expect(instance.dispose).toHaveBeenCalledTimes(1)
  expect(invalidate).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

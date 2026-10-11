import type { Theme } from "@earendil-works/pi-coding-agent"
import { parseColor, type Color } from "@earendil-works/pi-tui"
import {
  createHighlighter,
  getTokenStyleObject,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
} from "shiki"
import { bundledLanguagesInfo } from "shiki/langs"
import { bundledThemes } from "shiki/themes"

import type { ToolVisualsConfig } from "./types.ts"

export interface HighlightOptions {
  theme: Theme
  /** Request a rerender when an asynchronously loaded language becomes ready. */
  invalidate?: () => void
  /** The caller handles error presentation and deduplication; must not throw. */
  onError: (error: Error) => void
}

// Shiki is the source of truth for both language identifiers and aliases.
const languageIds = new Map<string, BundledLanguage>()
for (const { id, aliases = [] } of bundledLanguagesInfo) {
  for (const name of [id, ...aliases]) {
    languageIds.set(name.toLowerCase(), id as BundledLanguage)
  }
}

function canonicalLanguage(name: string): BundledLanguage | undefined {
  return languageIds.get(name.trim().toLowerCase())
}

// Only filenames for which the final extension alone is insufficient.
const filenames = new Map<string, BundledLanguage>([
  ["justfile", "just"],
  ["procfile", "shellscript"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["pipfile", "toml"],
  ["cmakelists.txt", "cmake"],
  ["codeowners", "codeowners"],
  ["cargo.lock", "toml"],
  ["poetry.lock", "toml"],
  ["uv.lock", "toml"],
  ["pipfile.lock", "json"],
  ["composer.lock", "json"],
  ["yarn.lock", "yaml"],
  ["bun.lock", "jsonc"],
  ["flake.lock", "json"],
  ["tsconfig.json", "jsonc"],
  ["jsconfig.json", "jsonc"],
  [".editorconfig", "ini"],
  [".gitconfig", "ini"],
  [".gitmodules", "ini"],
  [".npmrc", "ini"],
  [".envrc", "shellscript"],
  [".bashrc", "shellscript"],
  [".bash_profile", "shellscript"],
  [".bash_logout", "shellscript"],
  [".bash_aliases", "shellscript"],
  [".bash_history", "shellscript"],
  [".zshrc", "shellscript"],
  [".zshenv", "shellscript"],
  [".zprofile", "shellscript"],
  [".zlogin", "shellscript"],
  [".profile", "shellscript"],
  ["pkgbuild", "shellscript"],
  ["gradlew", "shellscript"],
  ["mvnw", "shellscript"],
])

const extensions = new Map<string, BundledLanguage>([
  ["h", "c"],
  ["hh", "cpp"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["ipp", "cpp"],
  ["tpp", "cpp"],
  ["inl", "cpp"],
  ["mm", "objective-cpp"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["fsx", "fsharp"],
  ["ml", "ocaml"],
  ["htm", "html"],
  ["svg", "xml"],
  ["env", "dotenv"],
  ["psm1", "powershell"],
  ["psd1", "powershell"],
  ["gradle", "groovy"],
  ["code-workspace", "jsonc"],
  ["patch", "diff"],
  ["ipynb", "json"],
  ["tfstate", "json"],
])

/** Infer a canonical Shiki language ID from a path, without reading the file. */
export function languageFromPath(filePath: string): string | undefined {
  const name = filePath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
  if (!name) return undefined

  if (name === ".env" || name.startsWith(".env.")) return canonicalLanguage("dotenv")
  if (/^(?:dockerfile|containerfile)(?:\.|$)/.test(name)) return canonicalLanguage("docker")
  if (/^(?:makefile|gnumakefile)(?:\.|$)/.test(name)) return canonicalLanguage("make")

  const exact = filenames.get(name)
  if (exact) return canonicalLanguage(exact)

  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return undefined

  const extension = name.slice(dot + 1)
  // .m is shared by Objective-C, MATLAB, Wolfram Language, etc.
  if (extension === "m") return undefined
  return canonicalLanguage(extensions.get(extension) ?? extension)
}

type HighlightConfig = ToolVisualsConfig["highlight"]

let settings: HighlightConfig = { enable: true, theme: "auto" }

export function configureHighlighting(config: HighlightConfig): void {
  settings = config
  if (!config.enable) disposeHighlighting()
}

const DEFAULT_THEMES = { light: "github-light", dark: "dark-plus" } as const

function resolveHighlightTheme(appearance: "light" | "dark"): BundledTheme {
  const selected = settings.theme
  if (selected === "auto") return DEFAULT_THEMES[appearance]
  if (typeof selected === "string") return selected as BundledTheme
  return selected[appearance] as BundledTheme
}

type ErrorHandler = HighlightOptions["onError"]
type Listeners = Map<() => void, ErrorHandler>

interface HighlightingState {
  highlighter?: Highlighter
  ready?: Promise<void>
  initializationFailed: boolean
  pending: Map<BundledLanguage, Listeners>
  failedLanguages: Set<BundledLanguage>
  pendingThemes: Map<BundledTheme, Listeners>
  failedThemes: Set<BundledTheme>
}

let state: HighlightingState | undefined
const colorCache = new Map<string, Color>()

function getState(onError: ErrorHandler): HighlightingState {
  if (state) return state

  const current: HighlightingState = {
    initializationFailed: false,
    pending: new Map(),
    failedLanguages: new Set(),
    pendingThemes: new Map(),
    failedThemes: new Set(),
  }
  state = current
  current.ready = createHighlighter({
    themes: [],
    langs: [],
  })
    .then((highlighter) => {
      if (state !== current) highlighter.dispose()
      else current.highlighter = highlighter
    })
    .catch((cause: unknown) => {
      if (state === current) {
        current.initializationFailed = true
        onError(new Error(`Shiki initialization failed: ${String(cause)}`, { cause }))
      }
    })
  return current
}

function requestLanguage(
  current: HighlightingState,
  language: BundledLanguage,
  invalidate: (() => void) | undefined,
  onError: ErrorHandler,
): void {
  let listeners = current.pending.get(language)
  if (listeners) {
    if (invalidate) listeners.set(invalidate, onError)
    return
  }

  listeners = new Map()
  if (invalidate) listeners.set(invalidate, onError)
  current.pending.set(language, listeners)

  void (async () => {
    try {
      await current.ready
      if (state !== current || !current.highlighter) return
      await current.highlighter.loadLanguage(language)
      if (state !== current) return

      for (const [callback, reportError] of listeners) {
        if (state !== current) break
        try {
          callback()
        } catch (cause) {
          reportError(new Error(`Highlight invalidation failed: ${String(cause)}`, { cause }))
        }
      }
    } catch (cause) {
      if (state === current) {
        current.failedLanguages.add(language)
        onError(
          new Error(`Shiki language loading failed (${language}): ${String(cause)}`, { cause }),
        )
      }
    } finally {
      if (state === current) current.pending.delete(language)
      listeners.clear()
    }
  })()
}

function requestTheme(
  current: HighlightingState,
  themeId: BundledTheme,
  invalidate: (() => void) | undefined,
  onError: ErrorHandler,
): void {
  let listeners = current.pendingThemes.get(themeId)
  if (listeners) {
    if (invalidate) listeners.set(invalidate, onError)
    return
  }

  listeners = new Map()
  if (invalidate) listeners.set(invalidate, onError)
  current.pendingThemes.set(themeId, listeners)

  void (async () => {
    try {
      await current.ready
      if (state !== current || !current.highlighter) return
      await current.highlighter.loadTheme(bundledThemes[themeId])
      if (state !== current) return

      for (const [callback, reportError] of listeners) {
        if (state !== current) break
        try {
          callback()
        } catch (cause) {
          reportError(new Error(`Highlight invalidation failed: ${String(cause)}`, { cause }))
        }
      }
    } catch (cause) {
      if (state === current) {
        current.failedThemes.add(themeId)
        onError(new Error(`Shiki theme loading failed (${themeId}): ${String(cause)}`, { cause }))
      }
    } finally {
      if (state === current) current.pendingThemes.delete(themeId)
      listeners.clear()
    }
  })()
}

function tokenColor(color: string): Color | undefined {
  // Pi accepts #RGB and #RRGGBB; Shiki can also provide #RRGGBBAA.
  const hex = /^#[\da-f]{8}$/i.test(color) ? color.slice(0, 7) : color
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) return undefined

  let parsed = colorCache.get(hex)
  if (!parsed) {
    parsed = parseColor(hex)
    colorCache.set(hex, parsed)
  }
  return parsed
}

function safeSource(code: string): string {
  return code.replace(/\r\n?/g, "\n").replace(/\p{Cc}/gu, (char) => {
    if (char === "\t" || char === "\n") return char
    const point = char.charCodeAt(0)
    return point < 32 ? String.fromCharCode(0x2400 + point) : point === 127 ? "␡" : "�"
  })
}

/**
 * Return ANSI-styled lines synchronously, or null until the language is ready.
 * The caller should render plain source lines while waiting.
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  { theme, invalidate, onError }: HighlightOptions,
): string[] | null {
  if (!settings.enable) return null

  const id = language ? canonicalLanguage(language) : undefined
  if (!id) return null

  const themeId = resolveHighlightTheme(theme.appearance)
  const current = getState(onError)
  if (
    current.initializationFailed ||
    current.failedLanguages.has(id) ||
    current.failedThemes.has(themeId)
  ) {
    return null
  }

  const highlighter = current.highlighter
  const languageReady = highlighter?.getLoadedLanguages().includes(id) ?? false
  const themeReady = highlighter?.getLoadedThemes().includes(themeId) ?? false
  if (!languageReady) requestLanguage(current, id, invalidate, onError)
  if (!themeReady) requestTheme(current, themeId, invalidate, onError)
  if (!highlighter || !languageReady || !themeReady) return null

  try {
    const result = highlighter.codeToTokens(safeSource(code), {
      lang: id,
      theme: themeId,
    })

    return result.tokens.map((line) =>
      line
        .map((token) => {
          const style = getTokenStyleObject(token)
          const fg = tokenColor(token.color ?? result.fg ?? "")
          return theme.style(token.content, {
            fg,
            bold: style["font-weight"] === "bold",
            italic: style["font-style"] === "italic",
            underline: style["text-decoration"]?.includes("underline"),
            strikethrough: style["text-decoration"]?.includes("line-through"),
          })
        })
        .join(""),
    )
  } catch (cause) {
    onError(new Error(`Shiki highlighting failed (${id}): ${String(cause)}`, { cause }))
    return null
  }
}

/** Dispose the singleton and ignore late completions from outstanding loads. */
export function disposeHighlighting(): void {
  const previous = state
  state = undefined
  for (const listeners of previous?.pending.values() ?? []) listeners.clear()
  previous?.pending.clear()
  for (const listeners of previous?.pendingThemes.values() ?? []) listeners.clear()
  previous?.pendingThemes.clear()
  previous?.highlighter?.dispose()
  colorCache.clear()
}

import { homedir } from "node:os"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type FindToolDetails,
  type GrepToolDetails,
  type LsToolDetails,
  type ToolRenderers,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent"
import { getCapabilities, getKeybindings, hyperlink, Text } from "@earendil-works/pi-tui"

import { safeSource } from "../highlight/engine.ts"
import { getHighlightDocumentSource } from "../highlight/document.ts"
import { highlightFileId } from "../highlight/file.ts"
import {
  cancelHighlightRequest,
  highlightDocument,
  highlightFileDocument,
  languageFromPath,
} from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"

export type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0]
export type RenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3]
export type Theme = Parameters<NonNullable<ToolRenderers["renderResult"]>>[2]

export function localPath(path: string, cwd: string): string {
  let expanded = path
  if (path === "~") expanded = homedir()
  else if (path.startsWith("~/")) expanded = resolve(homedir(), path.slice(2))
  return resolve(cwd, expanded)
}

export function displayPath(path: string, cwd: string): string {
  if (!path) return "..."
  if (!isAbsolute(path)) return path
  const fromCwd = relative(cwd, path)
  if (!fromCwd) return "."
  if (fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd)) return fromCwd
  const fromHome = relative(homedir(), path)
  if (!fromHome) return "~"
  if (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome))
    return `~/${fromHome}`
  return path
}

export function printable(text: string): string {
  return safeSource(text).replaceAll("\t", "    ")
}

export function singleLine(text: string): string {
  return printable(text).replaceAll("\n", "␊")
}

export function renderPath(path: string, cwd: string, theme: Theme, linked = true): string {
  const styled = theme.fg("accent", singleLine(displayPath(path, cwd)))
  if (!linked || !path || !getCapabilities().hyperlinks) return styled
  return hyperlink(styled, pathToFileURL(localPath(path, cwd)).href)
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

export function reuseText(previous: unknown, value: string): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0)
  component.setText(value)
  return component
}

export function renderToolCall(
  name: string,
  body: string,
  metadata: (string | undefined)[],
  theme: Theme,
  context: RenderContext,
): Text {
  const values = metadata.filter((value): value is string => value !== undefined)
  if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs))
    values.push(formatDuration(context.durationMs))
  const suffix = values.length ? theme.fg("dim", ` · ${values.join(" · ")}`) : ""
  return reuseText(
    context.lastComponent,
    `${theme.fg("toolTitle", theme.bold(name))}${body ? ` ${body}` : ""}${suffix}`,
  )
}

export function textOutput(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

export function renderToolError(
  result: ToolResult,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): Text {
  const error = printable(textOutput(result)) || "Failed"
  return reuseText(
    context.lastComponent,
    `\n${theme.fg("error", expanded ? error : error.split("\n", 1)[0]!)}`,
  )
}

export function lineNumberWidth(lastLine: number): number {
  return Math.max(4, String(lastLine).length)
}

export function hiddenNotice(count: number, theme: Theme): string {
  const keys = getKeybindings().getKeys("app.tools.expand").join("/")
  const unit = count === 1 ? "line" : "lines"
  return theme.fg("dim", `--- ${count} ${unit} hidden${keys ? ` · ${keys} to expand` : ""} ---`)
}

export function selectPreview<T>(
  items: readonly T[],
  warnings: readonly string[],
  limit: number,
  expanded: boolean,
) {
  const budget = expanded ? items.length + warnings.length : limit
  return {
    items: items.slice(0, budget),
    warnings: warnings.slice(0, Math.max(0, budget - items.length)),
    hidden: Math.max(0, items.length + warnings.length - budget),
  }
}

export function truncationNotice(truncation: TruncationResult): string {
  const limit =
    truncation.truncatedBy === "lines"
      ? `${(truncation.maxLines ?? DEFAULT_MAX_LINES).toLocaleString("en-US")}-line`
      : formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)
          .replace(".0", "")
          .replace(/([A-Z]+)$/, " $1")
  return `Output truncated (${limit} limit)`
}

// Native Grep uses this limit in its notice, but Pi does not export the constant.
const GREP_MAX_LINE_LENGTH = 500

/** Strip only known native notices corroborated by the tool's structured details. */
export function parseSearchResult(result: ToolResult, tool: "grep" | "find" | "ls") {
  const output = textOutput(result)
  const details = result.details as (GrepToolDetails & FindToolDetails & LsToolDetails) | undefined
  const truncation = details?.truncation
  const patterns: string[] = []
  const warnings: string[] = []
  const numberPattern = (value: number) => String(value).replace(/[.+]/g, "\\$&")

  if (tool === "grep" && typeof details?.matchLimitReached === "number") {
    const limit = details.matchLimitReached
    patterns.push(
      String.raw`${numberPattern(limit)} matches limit reached\. Use limit=${numberPattern(limit * 2)} for more, or refine pattern`,
    )
    warnings.push(`Match limit reached (${limit})`)
  }
  if (tool === "find" && typeof details?.resultLimitReached === "number") {
    const limit = details.resultLimitReached
    // Native Find's custom glob backend omits continuation guidance.
    patterns.push(
      String.raw`${numberPattern(limit)} results limit reached(?:\. Use limit=${numberPattern(limit * 2)} for more, or refine pattern)?`,
    )
    warnings.push(`Result limit reached (${limit})`)
  }
  if (tool === "ls" && typeof details?.entryLimitReached === "number") {
    const limit = details.entryLimitReached
    patterns.push(
      String.raw`${numberPattern(limit)} entries limit reached\. Use limit=${numberPattern(limit * 2)} for more`,
    )
    warnings.push(`Entry limit reached (${limit})`)
  }
  if (truncation?.truncated) {
    const size = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES).replace(".", "\\.")
    patterns.push(String.raw`${size} limit reached`)
    warnings.push(truncationNotice(truncation))
  }
  if (tool === "grep" && details?.linesTruncated === true) {
    patterns.push(
      String.raw`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars\. Use read tool to see full lines`,
    )
    warnings.push(`Some lines truncated (${GREP_MAX_LINE_LENGTH}-char limit)`)
  }

  let source = output
  if (patterns.length) {
    const suffix = new RegExp(String.raw`\n\n\[${patterns.join(String.raw`\. `)}\]$`)
    const match = suffix.exec(output)
    if (match) {
      const candidate = output.slice(0, match.index)
      if (!truncation?.truncated || candidate === truncation.content) source = candidate
    }
  }
  return { source, warnings }
}

const NERD_BY_NAME = new Map(
  Object.entries({
    "package.json": "",
    "package-lock.json": "",
    "bun.lock": "",
    "tsconfig.json": "",
    "readme.md": "",
    license: "",
    dockerfile: "",
    makefile: "",
    ".gitignore": "",
    ".env": "",
    ".envrc": "",
  }),
)
const NERD_BY_EXTENSION = new Map(
  Object.entries({
    ts: "",
    tsx: "",
    js: "",
    jsx: "",
    json: "",
    jsonc: "",
    md: "",
    py: "",
    rs: "",
    go: "",
    java: "",
    rb: "",
    php: "",
    c: "",
    cpp: "",
    h: "",
    cs: "󰌛",
    html: "",
    css: "",
    scss: "",
    yaml: "",
    yml: "",
    toml: "",
    sh: "",
    bash: "",
    zsh: "",
    sql: "",
    xml: "",
    png: "",
    jpg: "",
    jpeg: "",
    gif: "",
    svg: "",
    webp: "",
    txt: "",
  }),
)

function pathIcon(path: string, directory: boolean, mode: ToolVisualsConfig["pathIcons"]): string {
  if (mode === "off") return ""
  if (mode === "unicode") return directory ? "▸" : "•"
  if (directory) return ""
  const name = basename(path).toLowerCase()
  return NERD_BY_NAME.get(name) ?? NERD_BY_EXTENSION.get(extname(name).slice(1)) ?? ""
}

interface PathNode {
  name: string
  directory: boolean
  children: Map<string, PathNode>
}

export function renderPathList(
  paths: readonly string[],
  mode: ToolVisualsConfig["pathIcons"],
  theme: Theme,
): string[] {
  const label = (name: string, directory: boolean) => {
    const icon = pathIcon(name, directory, mode)
    const text = theme.fg(directory ? "accent" : "toolOutput", singleLine(name))
    return `${icon ? theme.fg("dim", icon) + " " : ""}${text}`
  }
  // A directory suffix alone does not make a flat listing a tree.
  const tree = paths.some((path) => path.replace(/^\.\//, "").replace(/\/$/, "").includes("/"))
  if (!tree) return paths.map((path) => label(path, path.endsWith("/")))

  const nodes = new Map<string, PathNode>()
  for (const raw of paths) {
    const parts = raw.replace(/^\.\//, "").split("/").filter(Boolean)
    if (!parts.length) parts.push(raw)
    let children = nodes
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!
      const leaf = index === parts.length - 1
      let node = children.get(name)
      if (!node) {
        node = { name, directory: !leaf || raw.endsWith("/"), children: new Map() }
        children.set(name, node)
      }
      if (!leaf || raw.endsWith("/")) node.directory = true
      children = node.children
    }
  }
  const output: string[] = []
  const visit = (children: Map<string, PathNode>, prefix: string) => {
    const values = [...children.values()]
    for (const [index, node] of values.entries()) {
      const last = index === values.length - 1
      const name = node.directory && !node.name.endsWith("/") ? node.name + "/" : node.name
      output.push(theme.fg("dim", prefix + (last ? "└─ " : "├─ ")) + label(name, node.directory))
      visit(node.children, prefix + (last ? "   " : "│  "))
    }
  }
  visit(nodes, "")
  return output
}

export interface SourceHighlightState {
  fileHighlight?: {
    key: string
    pending: boolean
    refresh: boolean
    fallback: boolean
    lines?: (string | null)[]
  }
}

export function clearSourceHighlight(
  context: RenderContext,
  region: string,
  state: SourceHighlightState,
): void {
  cancelHighlightRequest(`${context.toolCallId}:${region}:file`)
  cancelHighlightRequest(`${context.toolCallId}:${region}:source`)
  state.fileHighlight = undefined
}

interface SourceHighlightOptions {
  source: string
  lines: readonly string[]
  /** undefined when a search root could not be resolved; highlight only recorded text. */
  path: string | undefined
  language?: string
  from: number
  region: string
  state: SourceHighlightState
  theme: Theme
  context: RenderContext
  config: ToolVisualsConfig
}

/**
 * Verify displayed lines against the complete disk file for full grammar context.
 * A mismatch uses the recorded source, never today's file contents.
 */
export function prepareSourceHighlight(
  options: SourceHighlightOptions,
): (string | null)[] | undefined {
  const { source, lines, path, from, region, state, theme, context, config } = options
  const language = options.language ?? languageFromPath(path ?? "")
  if (!config.highlight.enable || !language) {
    clearSourceHighlight(context, region, state)
    return undefined
  }
  const fileSubscriber = `${context.toolCallId}:${region}:file`
  const sourceSubscriber = `${context.toolCallId}:${region}:source`
  const key = JSON.stringify([
    path,
    from,
    lines.length,
    source,
    language,
    theme.appearance,
    theme.getColorMode(),
    config.highlight.theme,
  ])
  if (state.fileHighlight?.key !== key) {
    clearSourceHighlight(context, region, state)
    state.fileHighlight = { key, pending: false, refresh: true, fallback: path === undefined }
  }
  const current = state.fileHighlight!
  const active = () => state.fileHighlight === current
  // Missing or changed files are normal for historical results. Syntax highlighting
  // must never introduce an apparent tool execution error.
  const onError = () => {}
  // Evicted documents cannot finish cancelled callbacks; retain the recorded fragment instead.
  if (
    path !== undefined &&
    !current.fallback &&
    !current.pending &&
    current.lines?.some((line) => line === null) &&
    getHighlightDocumentSource(highlightFileId(path)) === undefined
  ) {
    current.fallback = true
  }

  if (current.refresh && !current.pending && !current.fallback) {
    current.refresh = false
    current.pending = true
    void highlightFileDocument({
      path: path!,
      language,
      displayedLines: lines,
      from,
      to: from + lines.length,
      subscriberId: fileSubscriber,
      theme,
      onError,
      invalidate: () => {
        if (!active()) return
        current.refresh = true
        context.invalidate()
      },
    }).then(
      (highlighted) => {
        if (!active()) return
        current.pending = false
        current.fallback = highlighted === null
        current.lines = highlighted ?? undefined
        context.invalidate()
      },
      () => {
        if (!active()) return
        current.pending = false
        current.fallback = true
        context.invalidate()
      },
    )
  }
  if (!current.fallback || current.lines?.every((line) => line !== null)) return current.lines
  current.lines =
    highlightDocument({
      id: `${context.toolCallId}:${region}:source-document`,
      subscriberId: sourceSubscriber,
      source,
      language,
      from: 0,
      to: lines.length,
      theme,
      invalidate: () => {
        if (active()) context.invalidate()
      },
      onError,
    }) ?? undefined
  return current.lines
}

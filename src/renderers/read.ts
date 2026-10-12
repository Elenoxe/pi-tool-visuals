import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import type { ReadToolDetails, ToolRenderers } from "@earendil-works/pi-coding-agent"
import { getCapabilities, getKeybindings, hyperlink, Text } from "@earendil-works/pi-tui"

import { resolveToolConfig } from "../config.ts"
import { safeSource } from "../highlight/engine.ts"
import {
  cancelHighlightRequest,
  highlightDocument,
  highlightFileDocument,
  languageFromPath,
} from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"

type ReadArgs = { path?: string; file_path?: string; offset?: number | null; limit?: number | null }
type ReadResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0]
type ReadContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3]
type Theme = Parameters<NonNullable<ToolRenderers["renderResult"]>>[2]
type VisibleLine = { index: number } | { hidden: number }

interface FileHighlightState {
  key: string
  pending: boolean
  refresh: boolean
  fallback: boolean
  lines?: (string | null)[]
}

interface ReadState {
  fileHighlight?: FileHighlightState
}

interface ParsedRead {
  source: string
  notice?: string
  image: boolean
  truncated: boolean
}

const USER_CONTINUATION = /\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/

function readPath(args: ReadArgs): string {
  return args.path ?? args.file_path ?? ""
}

function firstLine(args: ReadArgs): number {
  return typeof args.offset === "number" && Number.isSafeInteger(args.offset)
    ? Math.max(1, args.offset)
    : 1
}

function localPath(path: string, cwd: string): string {
  let expanded = path
  if (path === "~") expanded = homedir()
  else if (path.startsWith("~/")) expanded = resolve(homedir(), path.slice(2))
  return resolve(cwd, expanded)
}

function displayPath(path: string, cwd: string): string {
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

function printable(text: string): string {
  return safeSource(text).replaceAll("\t", "    ")
}

function singleLine(text: string): string {
  return printable(text).replaceAll("\n", "␊")
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function reuseText(previous: unknown, value: string): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0)
  component.setText(value)
  return component
}

function renderReadCall(args: ReadArgs, theme: Theme, context: ReadContext): Text {
  const path = readPath(args)
  const start = firstLine(args)
  const limit =
    typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0
      ? args.limit
      : undefined
  let range = ""
  if (args.offset != null || args.limit != null) {
    range = `:${start}`
    if (limit !== undefined) range += `-${start + limit - 1}`
  }
  const duration = context.durationMs
  const metadata = [
    languageFromPath(path),
    typeof duration === "number" && Number.isFinite(duration)
      ? formatDuration(duration)
      : undefined,
  ].filter((value): value is string => value !== undefined)
  const styledPath = theme.fg("accent", singleLine(displayPath(path, context.cwd)))
  const linkedPath =
    path && getCapabilities().hyperlinks
      ? hyperlink(styledPath, pathToFileURL(localPath(path, context.cwd)).href)
      : styledPath
  return reuseText(
    context.lastComponent,
    `${theme.fg("toolTitle", theme.bold("read"))} ${linkedPath}${range ? theme.fg("warning", range) : ""}${metadata.length ? theme.fg("dim", ` · ${metadata.join(" · ")}`) : ""}`,
  )
}

function readTextOutput(result: ReadResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function parseReadResult(result: ReadResult, args: ReadArgs): ParsedRead {
  const output = readTextOutput(result)
  const image =
    result.content.some((part) => part.type === "image") || /^Read image file\b/.test(output)
  if (image) return { source: "", notice: output, image: true, truncated: false }

  const truncation = (result.details as ReadToolDetails | undefined)?.truncation
  if (truncation?.firstLineExceedsLimit)
    return { source: "", notice: output, image: false, truncated: true }

  if (truncation?.truncated) {
    // This is the exact source fragment returned by native Read, excluding its appended notice.
    return {
      source: output.startsWith(truncation.content) ? truncation.content : output,
      notice: "Output truncated by read",
      image: false,
      truncated: true,
    }
  }

  // Native Read does not supply structured metadata when only the user's `limit` stopped reading.
  // Require both the requested number of lines and the expected next offset to match.
  if (typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0) {
    const match = USER_CONTINUATION.exec(output)
    if (match) {
      const source = output.slice(0, match.index)
      const count = source.split("\n").length
      if (count === args.limit && Number(match[2]) === firstLine(args) + count) {
        return {
          source,
          image: false,
          truncated: false,
        }
      }
    }
  }
  return { source: output, image: false, truncated: false }
}

function selectReadLines(count: number, limit: number, expanded: boolean): VisibleLine[] {
  if (expanded || count <= limit) return Array.from({ length: count }, (_, index) => ({ index }))
  return [...Array.from({ length: limit }, (_, index) => ({ index })), { hidden: count - limit }]
}

function renderReadLines(
  lines: readonly string[],
  visible: readonly VisibleLine[],
  start: number,
  highlighted: readonly (string | null)[] | undefined,
  theme: Theme,
): string[] {
  const width = String(start + lines.length - 1).length
  return visible.map((entry) => {
    if ("hidden" in entry) {
      const keys = getKeybindings().getKeys("app.tools.expand").join("/")
      return theme.fg(
        "dim",
        `      --- ${entry.hidden} lines hidden${keys ? ` · ${keys} to expand` : ""} ---`,
      )
    }
    const number = theme.fg("dim", `${String(start + entry.index).padStart(width, " ")} │ `)
    const code =
      highlighted?.[entry.index] ?? theme.fg("toolOutput", printable(lines[entry.index] ?? ""))
    return number + (code || " ").replaceAll("\t", "    ")
  })
}

function clearReadHighlight(context: ReadContext): void {
  cancelHighlightRequest(`${context.toolCallId}:read:file`)
  cancelHighlightRequest(`${context.toolCallId}:read:source`)
  const state = context.state as ReadState
  state.fileHighlight = undefined
}

/**
 * File-based highlighting has the correct full-file grammar state. Its result is used only
 * if the on-disk lines exactly match the historical tool output. Otherwise we tokenize
 * the returned source itself; we never replace it with today's file contents.
 */
function prepareReadHighlight(
  source: string,
  lines: readonly string[],
  args: ReadArgs,
  theme: Theme,
  context: ReadContext,
  config: ToolVisualsConfig,
): (string | null)[] | undefined {
  const path = readPath(args)
  const language = languageFromPath(path)
  if (!config.highlight.enable || !language) {
    clearReadHighlight(context)
    return undefined
  }

  const state = context.state as ReadState
  const fileSubscriber = `${context.toolCallId}:read:file`
  const sourceSubscriber = `${context.toolCallId}:read:source`
  const file = localPath(path, context.cwd)
  const from = firstLine(args) - 1
  const key = JSON.stringify([
    file,
    from,
    lines.length,
    source,
    language,
    theme.appearance,
    theme.getColorMode(),
    config.highlight.theme,
  ])
  if (state.fileHighlight?.key !== key) {
    cancelHighlightRequest(fileSubscriber)
    cancelHighlightRequest(sourceSubscriber)
    state.fileHighlight = { key, pending: false, refresh: true, fallback: false }
  }
  const current = state.fileHighlight!
  const active = () => state.fileHighlight === current

  if (current.refresh && !current.pending && !current.fallback) {
    current.refresh = false
    current.pending = true
    void highlightFileDocument({
      path: file,
      language,
      displayedLines: lines,
      from,
      to: from + lines.length,
      subscriberId: fileSubscriber,
      theme,
      onError: () => {},
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

  if (!current.fallback) return current.lines
  return (
    highlightDocument({
      id: `${context.toolCallId}:read:source-document`,
      subscriberId: sourceSubscriber,
      source,
      language,
      from: 0,
      to: lines.length,
      theme,
      invalidate: context.invalidate,
      onError: () => {},
    }) ?? undefined
  )
}

function renderReadResult(
  result: ReadResult,
  expanded: boolean,
  theme: Theme,
  context: ReadContext,
  config: ToolVisualsConfig,
): Text {
  if (context.isError) {
    clearReadHighlight(context)
    const error = printable(readTextOutput(result)) || "Failed"
    return reuseText(
      context.lastComponent,
      `\n${theme.fg("error", expanded ? error : error.split("\n", 1)[0]!)}`,
    )
  }

  const args = (context.args ?? {}) as ReadArgs
  const parsed = parseReadResult(result, args)
  const output: string[] = []
  if (parsed.image || !parsed.source) {
    clearReadHighlight(context)
    if (!parsed.notice) output.push(theme.fg("dim", "Empty file"))
  } else {
    // Read splits on LF. Strip only the CR associated with CRLF, preserving other characters.
    const lines = parsed.source
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    const source = lines.join("\n")
    const limit = resolveToolConfig(config, "read").collapsedLines
    const visible = selectReadLines(lines.length, limit, expanded)
    const highlighted = prepareReadHighlight(
      source,
      expanded ? lines : lines.slice(0, limit),
      args,
      theme,
      context,
      config,
    )
    output.push(...renderReadLines(lines, visible, firstLine(args), highlighted, theme))
  }
  if (parsed.notice) {
    let color: "muted" | "warning" | "dim" = "dim"
    if (parsed.image) color = "muted"
    else if (parsed.truncated) color = "warning"
    output.push(theme.fg(color, printable(parsed.notice)))
  }
  return reuseText(context.lastComponent, `\n${output.join("\n")}`)
}

export function createReadRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      return renderReadCall((args ?? {}) as ReadArgs, theme, context)
    },
    renderResult(result, options, theme, context) {
      return renderReadResult(result, options.expanded, theme, context, getConfig())
    },
  }
}

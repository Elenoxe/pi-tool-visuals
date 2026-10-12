import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import type { GrepToolInput, ToolRenderers } from "@earendil-works/pi-coding-agent"

import { resolveToolConfig } from "../config.ts"
import { languageFromPath } from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  clearSourceHighlight,
  hiddenNotice,
  lineNumberWidth,
  localPath,
  parseSearchResult,
  prepareSourceHighlight,
  printable,
  renderPath,
  renderToolCall,
  renderToolError,
  reuseText,
  selectPreview,
  singleLine,
  type RenderContext,
  type SourceHighlightState,
  type Theme,
  type ToolResult,
} from "./shared.ts"

interface GrepRow {
  file: string
  line: number
  code: string
  match: boolean
}
type GrepEntry = GrepRow | { text: string }
interface GrepState {
  key: string
  root: string
  isFile?: boolean | null
  runs: Map<string, SourceHighlightState>
}

function parseGrepRow(text: string): GrepEntry {
  // Native Grep inserts one formatting space; any additional spaces belong to the source.
  // Require that space to distinguish a path segment like ':12:foo' from the row delimiter.
  const match = /^(.+?)(:|-)([1-9]\d*)\2 (.*)$/.exec(text)
  if (!match || !Number.isSafeInteger(Number(match[3]))) return { text }
  return { file: match[1]!, line: Number(match[3]), code: match[4]!, match: match[2] === ":" }
}

function clearGrepHighlight(context: RenderContext): void {
  const state = context.state.grep as GrepState | undefined
  if (state) for (const [region, run] of state.runs) clearSourceHighlight(context, region, run)
  context.state.grep = undefined
}

function grepState(
  source: string,
  args: Partial<GrepToolInput>,
  context: RenderContext,
): GrepState {
  const root = localPath(args.path || ".", context.cwd)
  const key = JSON.stringify([root, source])
  let state = context.state.grep as GrepState | undefined
  if (state?.key === key) return state
  clearGrepHighlight(context)
  state = { key, root, isFile: args.path ? undefined : false, runs: new Map() }
  context.state.grep = state
  if (args.path) {
    const current = state
    // Native Grep prints basenames for file targets and relative paths for directory targets.
    void stat(root).then(
      (info) => {
        if (context.state.grep !== current) return
        current.isFile = info.isFile()
        context.invalidate()
      },
      () => {
        if (context.state.grep !== current) return
        // A historical search root can disappear after the tool ran.
        current.isFile = null
        context.invalidate()
      },
    )
  }
  return state
}

function rowPath(row: GrepRow, state: GrepState): string | undefined {
  if (isAbsolute(row.file)) return row.file
  if (state.isFile == null) return undefined
  return state.isFile ? state.root : resolve(state.root, row.file)
}

/** Add a match background while retaining Shiki's existing foreground colors. */
function emphasizeLiteral(styled: string, source: string, pattern: RegExp, theme: Theme): string {
  const visibleSource = printable(source)
  const ranges: Array<[number, number]> = []
  for (const match of visibleSource.matchAll(pattern)) {
    if (match.index !== undefined && match[0].length)
      ranges.push([match.index, match.index + match[0].length])
  }
  if (!ranges.length) return styled

  const background = theme.getBgAnsi("searchMatchBg")
  // eslint-disable-next-line no-control-regex -- Parse renderer-generated ANSI sequences.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g
  const parts: string[] = []
  let cursor = 0
  let column = 0
  let rangeIndex = 0
  let highlighted = false
  const append = (fragment: string): void => {
    for (const char of fragment) {
      while (rangeIndex < ranges.length && column >= ranges[rangeIndex]![1]) rangeIndex++
      const active =
        rangeIndex < ranges.length &&
        column >= ranges[rangeIndex]![0] &&
        column < ranges[rangeIndex]![1]
      if (active !== highlighted) {
        parts.push(active ? background : "\x1b[49m")
        highlighted = active
      }
      parts.push(char)
      column += char.length
    }
  }
  for (const match of styled.matchAll(ansi)) {
    const offset = match.index ?? 0
    append(styled.slice(cursor, offset))
    parts.push(match[0])
    if (highlighted && match[0].endsWith("m")) parts.push(background)
    cursor = offset + match[0].length
  }
  append(styled.slice(cursor))
  if (highlighted) parts.push("\x1b[49m")
  return column === visibleSource.length ? parts.join("") : styled
}

function renderGrepResult(
  result: ToolResult,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
  config: ToolVisualsConfig,
) {
  if (context.isError) {
    clearGrepHighlight(context)
    return renderToolError(result, expanded, theme, context)
  }
  const args = (context.args ?? {}) as Partial<GrepToolInput>
  const { source, warnings } = parseSearchResult(result, "grep")
  if (!source || source === "No matches found") {
    clearGrepHighlight(context)
    const preview = selectPreview(
      ["No matches found"],
      warnings,
      resolveToolConfig(config, "grep").collapsedLines,
      expanded,
    )
    const output = preview.items.map((line) => theme.fg("dim", line))
    output.push(...preview.warnings.map((warning) => theme.fg("warning", singleLine(warning))))
    if (preview.hidden) output.push(hiddenNotice(preview.hidden, theme))
    return reuseText(context.lastComponent, `\n${output.join("\n")}`)
  }
  const entries = source
    .split("\n")
    .filter((line) => line !== "")
    .map(parseGrepRow)
  const preview = selectPreview(
    entries,
    warnings,
    resolveToolConfig(config, "grep").collapsedLines,
    expanded,
  )
  const visible = preview.items
  const state = grepState(source, args, context)
  const width = lineNumberWidth(
    Math.max(0, ...entries.map((entry) => ("file" in entry ? entry.line : 0))),
  )
  let literal: RegExp | undefined
  if (args.literal && args.pattern) {
    const pattern = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    literal = new RegExp(pattern, args.ignoreCase ? "giu" : "gu")
  }
  const output: string[] = []
  const activeRuns = new Set<string>()
  let currentFile: string | undefined
  let previousLine: number | undefined
  for (let index = 0; index < visible.length;) {
    const first = visible[index]!
    if (!("file" in first)) {
      output.push(theme.fg("toolOutput", printable(first.text)))
      currentFile = undefined
      previousLine = undefined
      index++
      continue
    }
    const path = rowPath(first, state)
    if (currentFile !== first.file) {
      if (output.length) output.push("")
      output.push(
        path ? renderPath(path, context.cwd, theme) : theme.fg("accent", singleLine(first.file)),
      )
      currentFile = first.file
      previousLine = undefined
    }
    if (previousLine !== undefined && first.line !== previousLine + 1)
      output.push(theme.fg("dim", "⋮".padStart(width)))
    const region = `grep:${index}`
    const run: GrepRow[] = [first]
    index++
    while (index < visible.length) {
      const next = visible[index]!
      if (
        !("file" in next) ||
        next.file !== first.file ||
        next.line !== run[run.length - 1]!.line + 1
      )
        break
      run.push(next)
      index++
    }
    let runState = state.runs.get(region)
    if (!runState) {
      runState = {}
      state.runs.set(region, runState)
    }
    activeRuns.add(region)
    const lines = run.map((row) => row.code)
    previousLine = run[run.length - 1]!.line
    const targetPending = state.isFile === undefined && path === undefined
    const highlighted = targetPending
      ? undefined
      : prepareSourceHighlight({
          source: lines.join("\n"),
          lines,
          path,
          language: languageFromPath(first.file),
          from: first.line - 1,
          region,
          state: runState,
          theme,
          context,
          config,
        })
    for (const [offset, row] of run.entries()) {
      let code = (highlighted?.[offset] ?? theme.fg("toolOutput", printable(row.code))).replaceAll(
        "\t",
        "    ",
      )
      if (row.match && literal) code = emphasizeLiteral(code, row.code, literal, theme)
      if (!row.match) code = theme.style(code, { dim: true })
      const number = theme.fg(row.match ? "accent" : "dim", String(row.line).padStart(width))
      const marker = theme.fg(row.match ? "warning" : "dim", row.match ? "│" : "┆")
      output.push(`${number} ${marker} ${code || " "}`)
    }
  }
  // Collapsing or replacing a result must remove demand and callbacks for hidden runs.
  for (const [region, run] of state.runs) {
    if (activeRuns.has(region)) continue
    clearSourceHighlight(context, region, run)
    state.runs.delete(region)
  }
  output.push(...preview.warnings.map((warning) => theme.fg("warning", singleLine(warning))))
  if (preview.hidden) output.push(hiddenNotice(preview.hidden, theme))
  return reuseText(context.lastComponent, `\n${output.join("\n")}`)
}

export function createGrepRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(rawArgs, theme, context) {
      const args = (rawArgs ?? {}) as Partial<GrepToolInput>
      const flags = args.ignoreCase ? "i" : ""
      const pattern = singleLine(args.pattern ?? "")
      const query = args.literal ? JSON.stringify(pattern) : `/${pattern}/${flags}`
      const location = args.path
        ? ` ${theme.fg("muted", "in")} ${renderPath(args.path, context.cwd, theme)}`
        : ""
      const body = theme.fg("accent", query) + location
      return renderToolCall(
        "grep",
        body,
        [
          args.glob ? singleLine(args.glob) : undefined,
          args.literal && args.ignoreCase ? "ignore-case" : undefined,
        ],
        theme,
        context,
      )
    },
    renderResult(result, options, theme, context) {
      return renderGrepResult(result, options.expanded, theme, context, getConfig())
    },
  }
}

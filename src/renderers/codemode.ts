import type { CodemodeToolDetails, ToolRenderers } from "@earendil-works/pi-coding-agent"
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui"

import { cancelHighlightRequest, highlightDocument } from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  hiddenNotice,
  printable,
  renderPath,
  renderToolCallTitle,
  singleLine,
  splitFileLines,
  textOutput,
  type RenderContext,
  type Theme,
  type ToolResult,
} from "./shared.ts"

type Call = CodemodeToolDetails["calls"][number]
type State = { hasResult?: boolean }

/** Recover only complete top-level fields; never guess the end of a truncated value. */
function parseCallArgsPreview(summary: string): unknown {
  try {
    return JSON.parse(summary)
  } catch {
    const prefix = summary.endsWith("...") ? summary.slice(0, -3) : summary
    const ends = Array.from(prefix.matchAll(/,/g), (match) => match.index).reverse()
    if (/["}\]]\s*$/.test(prefix)) ends.unshift(prefix.length)
    for (const end of ends) {
      try {
        return JSON.parse(prefix.slice(0, end) + "}")
      } catch {
        // A comma inside a string or nested value is not a top-level field boundary.
      }
    }
    return undefined
  }
}

function summarizeCallArgs(rawArgs: unknown): string {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return ""
  const outer = rawArgs as Record<string, unknown>
  for (const candidate of [
    outer,
    outer.input,
    outer.args,
    outer.arguments,
    outer.params,
    outer.payload,
  ]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const args = candidate as Record<string, unknown>
    const string = (...keys: string[]) => {
      for (const key of keys) {
        const value = args[key]
        if (typeof value === "string" && value.trim()) return value
      }
      return ""
    }
    const source = string("sourcePath", "source_path")
    const target = string("targetPath", "target_path")
    if (source && target) return `${source} → ${target}`
    const owner = string("owner")
    const repo = string("repo", "repository")
    const path = string("path", "file_path", "filePath", "file")
    if (owner && repo) return `${owner}/${repo}${path ? "/" + path : ""}`
    const pattern = string("pattern")
    if (pattern && path) return `${pattern} in ${path}`
    const query = string("query", "search_query")
    if (query && path) return `${query} in ${path}`
    const command = string("command")
    if (command) return "$ " + command
    const summary = string(
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
    )
    if (summary) return summary
  }
  return ""
}

function visibleCalls(calls: Call[], limit: number, running: boolean): Call[] {
  if (calls.length <= limit) return calls
  const selected = new Set(
    running ? calls.filter((call) => call.status === "running").slice(-limit) : [],
  )
  for (const call of calls) {
    if (selected.size === limit) break
    selected.add(call)
  }
  return calls.filter((call) => selected.has(call))
}

function formatNestedCallLine(call: Call, theme: Theme, context: RenderContext): string {
  const icons = { ok: "›", error: "✗", running: "◐", cancelled: "⊘" }
  const colors = { ok: "dim", error: "error", running: "warning", cancelled: "dim" } as const
  const parsed = parseCallArgsPreview(call.args)
  const args =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const hasString = (...keys: string[]) => keys.some((key) => typeof args[key] === "string")
  const hasNonEmptyString = (...keys: string[]) =>
    keys.some((key) => typeof args[key] === "string" && args[key].trim() !== "")
  const specialized =
    (["read", "write", "edit"].includes(call.name) &&
      hasNonEmptyString("path", "file_path", "file")) ||
    (call.name === "ls" &&
      (hasString("path", "file_path", "file") ||
        Object.keys(args).every((key) => key === "limit"))) ||
    (["bash", "powershell"].includes(call.name) && hasNonEmptyString("command")) ||
    (["grep", "find"].includes(call.name) && hasString("pattern"))
  const summary = specialized
    ? undefined
    : truncateToWidth(singleLine(summarizeCallArgs(parsed)), 96, "…")
  let title = renderToolCallTitle(
    call.name,
    args,
    theme,
    { cwd: context.cwd, durationMs: call.durationMs },
    [],
    summary ? theme.fg("accent", summary) : summary,
  )
  if (typeof call.cost === "number" && Number.isFinite(call.cost))
    title += theme.fg(
      "dim",
      ` · $${call.cost >= 0.01 ? call.cost.toFixed(2) : call.cost.toPrecision(2)}`,
    )
  return theme.fg(colors[call.status], icons[call.status]) + " " + title
}

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/

function scriptOutput(result: ToolResult): string {
  const [first, ...rest] = result.content
  let content = result.content
  if (first?.type === "text" && SCRIPT_HEADER.test(first.text)) {
    const remaining = first.text.replace(SCRIPT_HEADER, "")
    content = remaining ? [{ ...first, text: remaining }, ...rest] : rest
  }
  return printable(textOutput({ ...result, content }))
}

// Both regions count wrapped rows, with a single folding notice at the end of the card.
class CodemodeCard implements Component {
  private theme!: Theme
  private context!: RenderContext
  private expanded = false
  private partial = true
  private isError = false

  private result?: ToolResult

  constructor(
    private state: State,
    private getConfig: () => ToolVisualsConfig,
    private region: "call" | "result",
  ) {}

  update(theme: Theme, context: RenderContext, result?: ToolResult): void {
    this.result = result
    this.theme = theme
    this.context = context
    this.expanded = context.expanded
    this.partial = context.isPartial
    this.isError = context.isError
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme
    const context = this.context
    const config = this.getConfig().codemode
    const result = this.result
    const running = this.partial
    const details = result?.details as CodemodeToolDetails | undefined
    const calls = details?.calls ?? []
    const expanded = this.expanded
    const rows = (text: string) => new Text(text, 0, 0).render(width)
    const output =
      this.region === "call"
        ? rows(
            renderToolCallTitle("codemode", {}, theme, {
              cwd: context.cwd,
              durationMs: running ? undefined : context.durationMs,
            }),
          )
        : []
    let hidden = 0
    const section = (lines: string[]) => {
      if (lines.length) output.push("", ...lines)
    }

    const args = context.args as { code?: unknown } | undefined
    const source = typeof args?.code === "string" ? printable(args.code) : ""
    const lines = splitFileLines(source)
    const showSource = expanded || config.script.showCollapsed
    const visible = showSource
      ? expanded
        ? lines.length
        : Math.min(lines.length, config.script.collapsedLines)
      : 0
    const id = `${context.toolCallId}:codemode:source`
    let highlighted: (string | null)[] | null = null
    if (this.region === "call" && this.getConfig().highlight.enable && visible && source) {
      highlighted = highlightDocument({
        id,
        subscriberId: id,
        source,
        language: "javascript",
        from: 0,
        to: visible,
        streaming: context.argsComplete === false,
        theme,
        invalidate: context.invalidate,
        onError: () => {},
      })
    } else if (this.region === "call") {
      cancelHighlightRequest(id)
    }
    if (this.region === "call") {
      for (let index = 0; index < visible; index++)
        output.push(...rows(highlighted?.[index] ?? theme.fg("toolOutput", lines[index]!)))
    }
    if (showSource && !expanded && (this.region === "result" || !this.state.hasResult)) {
      for (let index = visible; index < lines.length; index++)
        hidden += rows(theme.fg("toolOutput", lines[index]!)).length
    }

    if (this.region === "call") {
      if (!this.state.hasResult) {
        if (running) section(rows(theme.fg("warning", "◆ Running…")))
        if (hidden && !expanded) section(rows(hiddenNotice(hidden, theme)))
      }
      return output
    }

    const failed = calls.filter((call) => call.status === "error").length
    if (calls.length) {
      const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`
      const done = calls.filter((call) => call.status !== "running").length
      const hasError = this.isError || failed > 0
      const label = running ? `Tools running · ${done}/${count}` : `Tools · ${count}`
      const icon = hasError ? "✗" : running ? "◆" : "✓"
      const heading = theme.fg(
        hasError ? "error" : running ? "warning" : "success",
        `${icon} ${label}${failed ? ` · ${failed} failed` : ""}`,
      )
      section(rows(heading))
      const shown = expanded ? calls : visibleCalls(calls, config.calls.collapsedCount, running)
      const selected = new Set(shown)
      for (const call of calls) {
        const callRows = rows(formatNestedCallLine(call, theme, context))
        if (selected.has(call)) output.push(...callRows)
        else hidden += callRows.length
        if (call.error) {
          const errorRows = rows(
            printable(call.error)
              .split("\n")
              .map((line) => theme.fg("error", "    " + line))
              .join("\n"),
          )
          if (expanded) output.push(...errorRows)
          else hidden += errorRows.length
        }
      }
      if (shown.length < calls.length) output.push(...rows(theme.fg("dim", "...")))
    } else {
      section(
        rows(
          running
            ? theme.fg("warning", "◆ Running…")
            : this.isError
              ? theme.fg("error", "✗ Failed")
              : theme.fg("success", "✓ Completed"),
        ),
      )
    }

    if (result && !running) {
      const text = scriptOutput(result)
      const fullOutputPath = details?.fullOutputPath
      let nativePathShown = false
      if (text) {
        const outputLines = text.split("\n")
        const styledLines = outputLines.map((line) =>
          theme.fg(this.isError ? "error" : "toolOutput", line),
        )
        const outputRows = rows(styledLines.join("\n"))
        const showOutput =
          expanded || (!this.isError && (!calls.length || config.output.showWithCalls))
        const shown = showOutput
          ? expanded
            ? outputRows
            : outputRows.slice(0, config.output.collapsedLines)
          : []
        if (shown.length) {
          if (calls.length) output.push("")
          output.push(...rows(theme.fg("dim", "↩ return")))
          output.push(...shown)
        }
        const noticeIndex = fullOutputPath
          ? outputLines.indexOf(
              `[Full output: ${printable(fullOutputPath)} (read with offset/limit)]`,
            )
          : -1
        if (noticeIndex >= 0 && shown.length) {
          nativePathShown =
            shown.length === outputRows.length ||
            shown.length >= rows(styledLines.slice(0, noticeIndex + 1).join("\n")).length
        }
        hidden += outputRows.length - shown.length
      }
      if (fullOutputPath && !nativePathShown)
        section(
          rows(theme.fg("dim", "Full output: ") + renderPath(fullOutputPath, context.cwd, theme)),
        )
    }
    if (hidden && !expanded) section(rows(hiddenNotice(hidden, theme)))
    return output
  }
}

function getState(context: RenderContext): State {
  return (context.state.codemode ??= {}) as State
}

export function createCodemodeRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(_args, theme, context) {
      const state = getState(context)
      const card =
        context.lastComponent instanceof CodemodeCard
          ? context.lastComponent
          : new CodemodeCard(state, getConfig, "call")
      card.update(theme, { ...context, args: _args })
      return card
    },
    renderResult(result, options, theme, context) {
      const state = getState(context)
      state.hasResult = true
      const card =
        context.lastComponent instanceof CodemodeCard
          ? context.lastComponent
          : new CodemodeCard(state, getConfig, "result")
      card.update(
        theme,
        { ...context, expanded: options.expanded, isPartial: options.isPartial },
        result,
      )
      return card
    },
  }
}

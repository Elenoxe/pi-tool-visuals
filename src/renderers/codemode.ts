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

const ARG_WRAPPERS = ["input", "args", "arguments", "params", "payload"] as const
const SUMMARY_FIELDS = [
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
]
const COMBINATION_FIELDS = [
  "command",
  "sourcePath",
  "source_path",
  "targetPath",
  "target_path",
  "owner",
  "repo",
  "repository",
]

type ParsedCallArgsPreview = {
  args: Record<string, unknown>
  truncated?: { key: string; wrapper?: string }
}

function isArgs(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseCallArgsPreview(summary: string): ParsedCallArgsPreview {
  try {
    const args: unknown = JSON.parse(summary)
    return { args: isArgs(args) ? args : {} }
  } catch {
    const prefix = summary.endsWith("...") ? summary.slice(0, -3) : summary
    // Pi caps the entire preview at 200 UTF-16 code units, including the three dots.
    if (summary.length === 200 && summary.endsWith("...")) {
      // Longer than the preview, so even escaped input cannot contain this marker.
      const marker = "_".repeat(prefix.length + 1)
      for (const closing of ["}", "}}"]) {
        try {
          const args: unknown = JSON.parse(prefix + marker + '"' + closing)
          if (!isArgs(args)) continue
          for (const wrapper of [undefined, ...ARG_WRAPPERS]) {
            const candidate = wrapper === undefined ? args : args[wrapper]
            if (!isArgs(candidate)) continue
            const last = Object.entries(candidate).at(-1)
            if (!last) continue
            const [key, value] = last
            if (
              typeof value !== "string" ||
              !value.endsWith(marker) ||
              !value.slice(0, -marker.length).trim() ||
              ![...SUMMARY_FIELDS, ...COMBINATION_FIELDS].includes(key)
            )
              continue
            candidate[key] = value.slice(0, -marker.length)
            return { args, truncated: { key, wrapper } }
          }
        } catch {
          // Incomplete escapes, keys, arrays and deeper objects cannot be closed this way.
        }
      }
    }
    const ends = Array.from(prefix.matchAll(/,/g), (match) => match.index).reverse()
    if (/["}\]]\s*$/.test(prefix)) ends.unshift(prefix.length)
    for (const end of ends) {
      try {
        const args: unknown = JSON.parse(prefix.slice(0, end) + "}")
        if (isArgs(args)) return { args }
      } catch {
        // A comma inside a string or nested value is not a top-level field boundary.
      }
    }
    return { args: {} }
  }
}

function summarizeCallArgs({ args: outer, truncated }: ParsedCallArgsPreview): string {
  for (const wrapper of [undefined, ...ARG_WRAPPERS]) {
    const candidate = wrapper === undefined ? outer : outer[wrapper]
    if (!isArgs(candidate)) continue
    const args = candidate
    const string = (...keys: string[]) => {
      for (const key of keys) {
        const value = args[key]
        if (typeof value === "string" && value.trim())
          return value + (truncated?.key === key && truncated.wrapper === wrapper ? "…" : "")
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
    const summary = string(...SUMMARY_FIELDS)
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
  const args = parsed.args
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
  const pathKey = ["path", "file_path", "file"].find(
    (key) => typeof args[key] === "string" && args[key],
  )
  const truncatedKey = parsed.truncated?.wrapper === undefined ? parsed.truncated?.key : undefined
  const truncatedSpecialized =
    specialized &&
    truncatedKey !== undefined &&
    ((["read", "write", "edit", "ls"].includes(call.name) && truncatedKey === pathKey) ||
      (["bash", "powershell"].includes(call.name) && truncatedKey === "command") ||
      (["grep", "find"].includes(call.name) &&
        (truncatedKey === "pattern" || truncatedKey === pathKey)))
  let summary = specialized && !truncatedSpecialized ? undefined : summarizeCallArgs(parsed)
  if (truncatedSpecialized && ["bash", "powershell"].includes(call.name))
    summary = (call.name === "powershell" ? "PS> " : "$ ") + args.command + "…"
  if (summary !== undefined) summary = truncateToWidth(singleLine(summary), 96, "…")
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

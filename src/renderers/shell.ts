import {
  formatSize,
  type BashToolDetails,
  type BashToolInput,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent"
import { Container, stripTerminalSequences, Text, type Component } from "@earendil-works/pi-tui"

import { resolveToolConfig } from "../config.ts"
import { cancelHighlightRequest, highlightDocument } from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  hiddenNotice,
  printable,
  renderPath,
  renderToolCall,
  reuseText,
  textOutput,
  truncationNotice,
  type RenderContext,
  type Theme,
  type ToolResult,
} from "./shared.ts"

function shellText(text: string): string {
  return printable(stripTerminalSequences(text))
}

function parseShellResult(
  result: ToolResult & { structuredContent?: unknown },
  context: RenderContext,
  partial: boolean,
) {
  let source = textOutput(result)
  let status: string | undefined
  if (context.isError && !partial) {
    const separator = source.lastIndexOf("\n\n")
    const candidate = separator < 0 ? source : source.slice(separator + 2)
    const structured = result.structuredContent
    const code =
      structured && typeof structured === "object" && "exit_code" in structured
        ? structured.exit_code
        : undefined
    const timeout = (context.args as Partial<BashToolInput> | undefined)?.timeout
    if (
      (typeof code === "number" &&
        Number.isSafeInteger(code) &&
        code !== 0 &&
        candidate === `Command exited with code ${code}`) ||
      candidate === "Command aborted" ||
      candidate === "Command terminated without an exit code" ||
      (typeof timeout === "number" &&
        Number.isFinite(timeout) &&
        timeout > 0 &&
        candidate === `Command timed out after ${timeout} seconds`)
    ) {
      status = candidate
      source = separator < 0 ? "" : source.slice(0, separator)
    }
  }

  const details = result.details as BashToolDetails | undefined
  const truncation = details?.truncation?.truncated ? details.truncation : undefined
  const fullOutputPath = details?.fullOutputPath
  if (truncation && fullOutputPath) {
    const content = truncation.content || (partial ? "" : "(no output)")
    const start = truncation.totalLines - truncation.outputLines + 1
    const range = `Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}`
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const notice = truncation.lastLinePartial
      ? `Showing last ${escape(formatSize(truncation.outputBytes))} of line ${truncation.totalLines} \\(line is \\d+(?:\\.\\d+)?(?:B|KB|MB)\\)`
      : escape(
          range +
            (truncation.truncatedBy === "bytes"
              ? ` (${formatSize(truncation.maxBytes)} limit)`
              : ""),
        )
    const footer = new RegExp(
      `^\\n\\n\\[${notice}\\. Full output: ${escape(fullOutputPath)}\\](?=$|\\n\\n)`,
    )
    if (source.startsWith(content)) {
      const suffix = source.slice(content.length)
      const match = footer.exec(suffix)
      if (match) source = content + suffix.slice(match[0].length)
    }
  }
  return { source: shellText(source), status, truncation, fullOutputPath }
}

/** Fold already-wrapped terminal rows, keeping metadata outside the output budget. */
class ShellOutput implements Component {
  private body = new Text("", 0, 0)
  private extras = new Text("", 0, 0)
  private hint = new Text("", 0, 0)
  private expanded = false
  private limit = 8
  private theme!: Theme

  update(body: string, extras: string[], expanded: boolean, limit: number, theme: Theme): void {
    this.body = reuseText(this.body, body)
    this.extras = reuseText(this.extras, extras.join("\n"))
    this.expanded = expanded
    this.limit = limit
    this.theme = theme
  }

  invalidate(): void {
    this.body.invalidate()
    this.extras.invalidate()
    this.hint.invalidate()
  }

  render(width: number): string[] {
    const rows = this.body.render(width)
    const hidden = this.expanded ? 0 : Math.max(0, rows.length - this.limit)
    const output = hidden
      ? [
          ...reuseText(this.hint, hiddenNotice(hidden, this.theme)).render(width),
          ...rows.slice(-this.limit),
        ]
      : [...rows]
    const extras = this.extras.render(width)
    if (extras.length) {
      if (output.length) output.push("")
      output.push(...extras)
    }
    return output.length ? ["", ...output] : []
  }
}

export function createShellRenderer(
  name: "bash" | "powershell",
  getConfig: () => ToolVisualsConfig,
): ToolRenderers {
  const prompt = name === "bash" ? "$" : "PS>"
  return {
    renderCall(rawArgs, theme, context) {
      const config = getConfig()
      const args = rawArgs as Partial<BashToolInput> | undefined
      const command = shellText(typeof args?.command === "string" ? args.command : "")
      const lines = command.split("\n")
      const visible = context.expanded ? lines : lines.slice(0, 1)
      const id = `${context.toolCallId}:shell-command`
      let highlighted: (string | null)[] | null = null
      if (config.highlight.enable && command) {
        highlighted = highlightDocument({
          id,
          subscriberId: id,
          source: command,
          language: name,
          from: 0,
          to: visible.length,
          theme,
          invalidate: context.invalidate,
          onError: () => {},
        })
      } else {
        cancelHighlightRequest(id)
      }
      const styled = visible.map((line, index) => highlighted?.[index] ?? theme.fg("accent", line))
      const ellipsis = !context.expanded && lines.length > 1 ? theme.fg("dim", " …") : ""
      const component =
        context.lastComponent instanceof Container ? context.lastComponent : new Container()
      const title = renderToolCall(
        name,
        `${theme.fg("dim", prompt)} ${styled[0] ?? ""}${ellipsis}`,
        [],
        theme,
        { ...context, lastComponent: component.children[0] },
      )
      const indent = " ".repeat(name.length + prompt.length + 2)
      const continuation = reuseText(
        component.children[1],
        styled
          .slice(1)
          .map((line) => indent + line)
          .join("\n"),
      )
      component.clear()
      component.addChild(title)
      if (context.expanded && styled.length > 1) component.addChild(continuation)
      return component
    },
    renderResult(result, options, theme, context) {
      const { source, status, truncation, fullOutputPath } = parseShellResult(
        result,
        context,
        options.isPartial,
      )
      let body = source
        ? source
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n")
        : options.isPartial || status
          ? ""
          : theme.fg("dim", "(no output)")
      if (!options.isPartial && source === "(no output)") body = theme.fg("dim", source)
      if (status) body += (body ? "\n\n" : "") + theme.fg("error", status)
      const extras: string[] = []
      if (truncation) extras.push(theme.fg("warning", truncationNotice(truncation)))
      if (fullOutputPath)
        extras.push(
          theme.fg("dim", "Full output: ") + renderPath(fullOutputPath, context.cwd, theme),
        )
      const component =
        context.lastComponent instanceof ShellOutput ? context.lastComponent : new ShellOutput()
      component.update(
        body,
        extras,
        options.expanded,
        resolveToolConfig(getConfig(), name).collapsedLines,
        theme,
      )
      return component
    },
  }
}

import type { ReadToolDetails, ToolRenderers } from "@earendil-works/pi-coding-agent"
import type { Text } from "@earendil-works/pi-tui"

import { resolveToolConfig } from "../config.ts"
import { languageFromPath } from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  clearSourceHighlight,
  hiddenNotice,
  lineNumberWidth,
  localPath,
  prepareSourceHighlight,
  printable,
  renderPath,
  renderToolCall,
  renderToolError,
  reuseText,
  selectPreview,
  textOutput,
  truncationNotice,
  type RenderContext as ReadContext,
  type SourceHighlightState,
  type Theme,
  type ToolResult as ReadResult,
} from "./shared.ts"

type ReadArgs = { path?: string; file_path?: string; offset?: number | null; limit?: number | null }

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

function renderReadCall(args: ReadArgs, theme: Theme, context: ReadContext): Text {
  const path = readPath(args)
  const start = firstLine(args)
  const limit =
    typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0
      ? args.limit
      : undefined
  let range = ""
  if ((args.offset != null && args.offset !== 1) || args.limit != null) {
    range = `:${start}`
    if (limit !== undefined) range += `-${start + limit - 1}`
  }
  return renderToolCall(
    "read",
    (path ? renderPath(path, context.cwd, theme) : "") + (range ? theme.fg("warning", range) : ""),
    [languageFromPath(path)],
    theme,
    context,
  )
}

function parseReadResult(result: ReadResult, args: ReadArgs): ParsedRead {
  const output = textOutput(result)
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
      notice: truncationNotice(truncation),
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

function renderReadLines(
  lines: readonly string[],
  start: number,
  highlighted: readonly (string | null)[] | undefined,
  theme: Theme,
  width: number,
): string[] {
  return lines.map((line, index) => {
    const number = theme.fg("dim", `${String(start + index).padStart(width, " ")} │ `)
    const code = highlighted?.[index] ?? theme.fg("toolOutput", printable(line))
    return number + (code || " ").replaceAll("\t", "    ")
  })
}

function renderReadResult(
  result: ReadResult,
  expanded: boolean,
  theme: Theme,
  context: ReadContext,
  config: ToolVisualsConfig,
): Text {
  if (context.isError) {
    clearSourceHighlight(context, "read", context.state as SourceHighlightState)
    return renderToolError(result, expanded, theme, context)
  }

  const args = (context.args ?? {}) as ReadArgs
  const parsed = parseReadResult(result, args)
  // Read splits on LF. Strip only the CR associated with CRLF, preserving other characters.
  const lines = parsed.source
    ? parsed.source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    : []
  const source = lines.join("\n")
  const preview = selectPreview(
    lines,
    parsed.notice ? printable(parsed.notice).split("\n") : [],
    resolveToolConfig(config, "read").collapsedLines,
    expanded,
  )
  const output: string[] = []
  if (parsed.image || !parsed.source) {
    clearSourceHighlight(context, "read", context.state as SourceHighlightState)
    if (!parsed.notice) output.push(theme.fg("dim", "Empty file"))
  } else {
    const highlighted = prepareSourceHighlight({
      source,
      lines: preview.items,
      path: localPath(readPath(args), context.cwd),
      from: firstLine(args) - 1,
      region: "read",
      state: context.state as SourceHighlightState,
      theme,
      context,
      config,
    })
    output.push(
      ...renderReadLines(
        preview.items,
        firstLine(args),
        highlighted,
        theme,
        lineNumberWidth(firstLine(args) + lines.length - 1),
      ),
    )
  }
  if (parsed.notice) {
    let color: "muted" | "warning" | "dim" = "dim"
    if (parsed.image) color = "muted"
    else if (parsed.truncated) color = "warning"
    output.push(...preview.warnings.map((line) => theme.fg(color, line)))
  }
  if (preview.hidden) output.push(hiddenNotice(preview.hidden, theme))
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

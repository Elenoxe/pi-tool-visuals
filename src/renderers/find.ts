import type { FindToolInput, ToolRenderers } from "@earendil-works/pi-coding-agent"

import { resolveToolConfig } from "../config.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  hiddenNotice,
  parseSearchResult,
  renderPath,
  renderPathList,
  renderToolCall,
  renderToolError,
  reuseText,
  selectPreview,
  singleLine,
} from "./shared.ts"

export function createFindRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(rawArgs, theme, context) {
      const args = (rawArgs ?? {}) as Partial<FindToolInput>
      const location = args.path
        ? ` ${theme.fg("muted", "in")} ${renderPath(args.path, context.cwd, theme, false)}`
        : ""
      const body = theme.fg("accent", singleLine(args.pattern ?? "")) + location
      return renderToolCall("find", body, [], theme, context)
    },
    renderResult(result, options, theme, context) {
      if (context.isError) return renderToolError(result, options.expanded, theme, context)
      const config = getConfig()
      const { source, warnings } = parseSearchResult(result, "find")
      const paths = source.split("\n").filter((path) => path !== "")
      const empty = !paths.length || source === "No files found matching pattern"
      const preview = selectPreview(
        empty ? ["No files found"] : paths,
        warnings,
        resolveToolConfig(config, "find").collapsedLines,
        options.expanded,
      )
      const output = empty
        ? preview.items.map((line) => theme.fg("dim", line))
        : renderPathList(preview.items, config.pathIcons, theme)
      output.push(...preview.warnings.map((warning) => theme.fg("warning", warning)))
      if (preview.hidden) output.push(hiddenNotice(preview.hidden, theme))
      return reuseText(context.lastComponent, `\n${output.join("\n")}`)
    },
  }
}

import type { LsToolInput, ToolRenderers } from "@earendil-works/pi-coding-agent"

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
} from "./shared.ts"

export function createLsRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(rawArgs, theme, context) {
      const args = (rawArgs ?? {}) as Partial<LsToolInput>
      return renderToolCall(
        "ls",
        args.path ? renderPath(args.path, context.cwd, theme, false) : "",
        [],
        theme,
        context,
      )
    },
    renderResult(result, options, theme, context) {
      if (context.isError) return renderToolError(result, options.expanded, theme, context)
      const config = getConfig()
      const { source, warnings } = parseSearchResult(result, "ls")
      const paths = source.split("\n").filter((path) => path !== "")
      const empty = !paths.length || source === "(empty directory)"
      const preview = selectPreview(
        empty ? ["Empty directory"] : paths,
        warnings,
        resolveToolConfig(config, "ls").collapsedLines,
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

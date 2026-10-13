import type { ToolRenderers, WriteToolInput } from "@earendil-works/pi-coding-agent"
import { Container } from "@earendil-works/pi-tui"

import { resolveToolConfig } from "../config.ts"
import { cancelHighlightRequest, highlightDocument, languageFromPath } from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  hiddenNotice,
  lineNumberWidth,
  printable,
  renderPath,
  renderToolCall,
  renderToolError,
  reuseText,
} from "./shared.ts"

export function createWriteRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderCall(rawArgs, theme, context) {
      const config = getConfig()
      const args = rawArgs as Partial<WriteToolInput> | undefined
      const path = typeof args?.path === "string" ? args.path : ""
      const source = typeof args?.content === "string" ? printable(args.content) : undefined
      const lines = source ? source.split("\n") : []
      const visible = context.expanded
        ? lines
        : lines.slice(0, resolveToolConfig(config, "write").collapsedLines)
      const language = languageFromPath(path)
      const id = `${context.toolCallId}:write:content`
      let highlighted: (string | null)[] | null = null
      if (config.highlight.enable && language && source) {
        highlighted = highlightDocument({
          id,
          subscriberId: id,
          source,
          language,
          from: 0,
          to: visible.length,
          streaming: context.argsComplete === false,
          theme,
          invalidate: context.invalidate,
          onError: () => {},
        })
      } else {
        cancelHighlightRequest(id)
      }
      const component =
        context.lastComponent instanceof Container ? context.lastComponent : new Container()
      const title = renderToolCall(
        "write",
        path ? renderPath(path, context.cwd, theme) : "",
        [
          source ? language : undefined,
          source === undefined
            ? undefined
            : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
        ],
        theme,
        { ...context, lastComponent: component.children[0] },
      )
      const width = lineNumberWidth(lines.length)
      const output = visible.map(
        (line, index) =>
          theme.fg("dim", `${String(index + 1).padStart(width, " ")} │ `) +
          (highlighted?.[index] ?? theme.fg("toolOutput", line)),
      )
      if (source === "") output.push(theme.fg("dim", "Empty file"))
      if (lines.length > visible.length)
        output.push(hiddenNotice(lines.length - visible.length, theme))
      const preview = reuseText(
        component.children[1],
        output.length ? "\n" + output.join("\n") : "",
      )
      component.clear()
      component.addChild(title)
      if (source !== undefined) component.addChild(preview)
      return component
    },
    renderResult(result, options, theme, context) {
      return context.isError
        ? renderToolError(result, options.expanded, theme, context)
        : reuseText(context.lastComponent, "")
    },
  }
}

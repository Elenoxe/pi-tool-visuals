import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent"

import { resolveToolConfig } from "./config.ts"
import type { ToolVisualsConfig } from "./types.ts"

export type RendererLookup = (toolName: string) => ToolRenderers | undefined

export function createToolRendererResolver(
  getConfig: () => ToolVisualsConfig,
  getRenderer: RendererLookup,
): ToolRendererResolver {
  return (toolName, next) => {
    const downstream = next()
    const config = getConfig()
    const enabled =
      toolName === "codemode"
        ? config.enabled && config.codemode.enabled
        : resolveToolConfig(config, toolName).enabled
    if (!enabled) return downstream
    const enhanced = getRenderer(toolName)
    if (!enhanced?.renderCall && !enhanced?.renderResult && !enhanced?.renderShell)
      return downstream
    return {
      ...downstream,
      renderCall: enhanced.renderCall ?? downstream?.renderCall,
      renderResult: enhanced.renderResult ?? downstream?.renderResult,
      renderShell: enhanced.renderShell ?? downstream?.renderShell,
    }
  }
}

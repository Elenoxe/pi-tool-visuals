import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent"

import { createDefaultConfig, loadToolVisualsConfig } from "./config.ts"
import { configureHighlighting, disposeHighlighting } from "./highlight.ts"
import { createToolRendererResolver } from "./resolver.ts"

export default function toolVisuals(pi: ExtensionAPI): void {
  let config = createDefaultConfig()
  const renderers: Record<string, ToolRenderers> = {}

  pi.registerToolRenderer(
    createToolRendererResolver(
      () => config,
      (toolName) => (Object.hasOwn(renderers, toolName) ? renderers[toolName] : undefined),
    ),
  )

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadToolVisualsConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })
    config = loaded.config
    configureHighlighting(config.highlight)
    if (loaded.diagnostics.length) {
      throw new Error(
        `[tool-visuals] Invalid configuration layers were ignored; valid layers remain active. Fix the reported files and run /reload.\n${loaded.diagnostics.map(({ code, message }) => `[${code}] ${message}`).join("\n")}`,
      )
    }
  })

  pi.on("session_shutdown", () => {
    disposeHighlighting()
    config = createDefaultConfig()
  })
}

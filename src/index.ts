import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent"

import { createDefaultConfig, loadToolVisualsConfig } from "./config.ts"
import { configureHighlighting, disposeHighlighting } from "./highlight/index.ts"
import { createCodemodeRenderer } from "./renderers/codemode.ts"
import { createEditRenderer } from "./renderers/edit.ts"
import { createFindRenderer } from "./renderers/find.ts"
import { createGrepRenderer } from "./renderers/grep.ts"
import { createLsRenderer } from "./renderers/ls.ts"
import { createReadRenderer } from "./renderers/read.ts"
import { createShellRenderer } from "./renderers/shell.ts"
import { createWriteRenderer } from "./renderers/write.ts"
import { createToolRendererResolver } from "./resolver.ts"

export default function toolVisuals(pi: ExtensionAPI): void {
  let config = createDefaultConfig()
  const renderers: Record<string, ToolRenderers> = {
    codemode: createCodemodeRenderer(() => config),
    read: createReadRenderer(() => config),
    grep: createGrepRenderer(() => config),
    find: createFindRenderer(() => config),
    ls: createLsRenderer(() => config),
    bash: createShellRenderer("bash", () => config),
    powershell: createShellRenderer("powershell", () => config),
    write: createWriteRenderer(() => config),
    edit: createEditRenderer(() => config),
  }

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

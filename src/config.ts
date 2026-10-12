import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent"
import Type, { type TProperties } from "typebox"
import Value from "typebox/value"

import {
  toolVisualsConfigSchema,
  type ConfigDiagnostic,
  type ResolvedToolConfig,
  type ToolConfig,
  type ToolVisualsConfig,
} from "./types.ts"

export interface ConfigLoadOptions {
  cwd: string
  projectTrusted: boolean
}

export interface ConfigResult {
  config: ToolVisualsConfig
  diagnostics: ConfigDiagnostic[]
}

function partialObject<T extends TProperties>(properties: T) {
  return Type.Partial(Type.Object(properties), { additionalProperties: false })
}

const codemode = toolVisualsConfigSchema.properties.codemode.properties

// A layer contains optional overrides at every level, without inserting defaults.
const configLayerSchema = partialObject({
  ...toolVisualsConfigSchema.properties,
  highlight: partialObject(toolVisualsConfigSchema.properties.highlight.properties),
  codemode: partialObject({
    script: partialObject(codemode.script.properties),
    calls: partialObject(codemode.calls.properties),
    output: partialObject(codemode.output.properties),
    history: partialObject(codemode.history.properties),
  }),
})

export function createDefaultConfig(): ToolVisualsConfig {
  return {
    enabled: true,
    collapsedLines: 8,
    pathIcons: "unicode",
    highlight: { enable: true, theme: "auto" },
    codemode: {
      script: { showCollapsed: false, collapsedLines: 12 },
      calls: { collapsedCount: 8 },
      output: { collapsedLines: 5 },
      history: { maxBytes: 524288 },
    },
    tools: {},
  }
}

export function parseToolVisualsConfig(
  value: unknown,
  baseConfig: ToolVisualsConfig = createDefaultConfig(),
): ConfigResult {
  const config = structuredClone(baseConfig)
  if (!Value.Check(configLayerSchema, value)) {
    return {
      config,
      diagnostics: Value.Errors(configLayerSchema, value).map((error) => ({
        code: error.keyword,
        message: `${error.instancePath || "/"}: ${error.message}`,
      })),
    }
  }

  config.enabled = value.enabled ?? config.enabled
  config.collapsedLines = value.collapsedLines ?? config.collapsedLines
  config.pathIcons = value.pathIcons ?? config.pathIcons
  config.highlight.enable = value.highlight?.enable ?? config.highlight.enable
  config.highlight.theme = value.highlight?.theme ?? config.highlight.theme
  const overrides = value.codemode
  config.codemode.script.showCollapsed =
    overrides?.script?.showCollapsed ?? config.codemode.script.showCollapsed
  config.codemode.script.collapsedLines =
    overrides?.script?.collapsedLines ?? config.codemode.script.collapsedLines
  config.codemode.calls.collapsedCount =
    overrides?.calls?.collapsedCount ?? config.codemode.calls.collapsedCount
  config.codemode.output.collapsedLines =
    overrides?.output?.collapsedLines ?? config.codemode.output.collapsedLines
  config.codemode.history.maxBytes =
    overrides?.history?.maxBytes ?? config.codemode.history.maxBytes

  const tools = Object.entries(value.tools ?? {}).map(([name, tool]): [string, ToolConfig] => {
    const merged = { ...(Object.hasOwn(config.tools, name) ? config.tools[name] : undefined) }
    if (tool.enabled !== undefined) merged.enabled = tool.enabled
    if (tool.collapsedLines !== undefined) merged.collapsedLines = tool.collapsedLines
    return [name, merged]
  })
  config.tools = Object.fromEntries([...Object.entries(config.tools), ...tools])
  return { config, diagnostics: [] }
}

function loadConfigFile(path: string, baseConfig: ToolVisualsConfig): ConfigResult {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: baseConfig, diagnostics: [] }
    }
    return {
      config: baseConfig,
      diagnostics: [{ code: "read-error", message: `${path}: ${String(error)}` }],
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      config: baseConfig,
      diagnostics: [{ code: "invalid-json", message: `${path}: ${String(error)}` }],
    }
  }
  const result = parseToolVisualsConfig(value, baseConfig)
  return {
    config: result.config,
    diagnostics: result.diagnostics.map(({ code, message }) => ({
      code,
      message: `${path}: ${message}`,
    })),
  }
}

export function loadToolVisualsConfig(options: ConfigLoadOptions): ConfigResult {
  const global = loadConfigFile(join(getAgentDir(), "tool-visuals.json"), createDefaultConfig())
  if (!options.projectTrusted) return global
  const project = loadConfigFile(
    join(options.cwd, CONFIG_DIR_NAME, "tool-visuals.json"),
    global.config,
  )
  return { config: project.config, diagnostics: [...global.diagnostics, ...project.diagnostics] }
}

export function resolveToolConfig(config: ToolVisualsConfig, toolName: string): ResolvedToolConfig {
  const tool = Object.hasOwn(config.tools, toolName) ? config.tools[toolName] : undefined
  return {
    enabled: config.enabled && tool?.enabled !== false,
    collapsedLines: tool?.collapsedLines ?? config.collapsedLines,
  }
}

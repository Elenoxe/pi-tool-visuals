import type { ToolVisualsConfig } from "../types.ts"
import { ansiCache, ansiKey, HIGHLIGHT_LIMITS } from "./cache.ts"
import {
  cancelHighlightRequest as cancelDocumentRequest,
  clearHighlightDocuments,
  releaseHighlightDocument as releaseDocument,
  highlightDocument as renderDocument,
  type HighlightDocumentOptions,
} from "./document.ts"
import type { HighlightOptions } from "./engine.ts"
import {
  configureEngine,
  disposeEngine,
  readyEngine,
  resolveIdentity,
  tokenizeCode,
} from "./engine.ts"
import { cancelFileHighlightRequest, clearHighlightFiles, releaseHighlightFile } from "./file.ts"

export type { HighlightDocumentOptions } from "./document.ts"
export { highlightFileDocument, highlightFileId } from "./file.ts"
export type { HighlightFileOptions } from "./file.ts"

export { languageFromPath } from "./engine.ts"
export type { HighlightOptions } from "./engine.ts"

let configuredTheme: ToolVisualsConfig["highlight"]["theme"] = "auto"

export function configureHighlighting(config: ToolVisualsConfig["highlight"]): void {
  if (!config.enable || JSON.stringify(configuredTheme) !== JSON.stringify(config.theme)) {
    clearHighlightFiles()
    clearHighlightDocuments()
  }
  configuredTheme = typeof config.theme === "string" ? config.theme : { ...config.theme }
  if (!config.enable) ansiCache.clear()
  configureEngine(config)
}

/** Return ANSI lines, or null while loading or when highlighting is unavailable. */
export function highlightCode(
  code: string,
  language: string | undefined,
  options: HighlightOptions,
): string[] | null {
  const identity = resolveIdentity(language, options.theme)
  if (!identity) return null
  if (
    code.length > HIGHLIGHT_LIMITS.syncCharacters ||
    code.split(/\r\n?|\n/).length > HIGHLIGHT_LIMITS.syncLines
  )
    return null
  const key = ansiKey(identity.key, code)
  const cached = ansiCache.get(key)
  if (cached) return [...cached]
  const highlighter = readyEngine(identity, options)
  if (!highlighter) return null
  try {
    const lines = tokenizeCode(highlighter, code, identity, options.theme)
    ansiCache.set(
      key,
      [...lines],
      key.length + code.length + lines.reduce((sum, line) => sum + line.length, 0),
    )
    return lines
  } catch (cause) {
    options.onError(
      new Error(`Shiki highlighting failed (${identity.language}): ${String(cause)}`, { cause }),
    )
    return null
  }
}

export function highlightDocument(options: HighlightDocumentOptions): (string | null)[] | null {
  cancelFileHighlightRequest(options.subscriberId)
  return renderDocument(options)
}

export function disposeHighlighting(): void {
  clearHighlightFiles()
  clearHighlightDocuments()
  ansiCache.clear()
  disposeEngine()
}

export function cancelHighlightRequest(subscriberId: string): void {
  cancelFileHighlightRequest(subscriberId)
  cancelDocumentRequest(subscriberId)
}

export function releaseHighlightDocument(id: string): void {
  releaseHighlightFile(id)
  releaseDocument(id)
}

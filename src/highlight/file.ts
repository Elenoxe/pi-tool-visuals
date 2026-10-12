import { open, stat } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import { resolve } from "node:path"
import { BoundedLru, HIGHLIGHT_LIMITS } from "./cache.ts"
import {
  getHighlightDocumentSource,
  highlightDocument,
  releaseHighlightDocument,
  cancelHighlightRequest,
  type HighlightDocumentOptions,
} from "./document.ts"
import { languageFromPath, resolveIdentity } from "./engine.ts"

export interface HighlightFileOptions extends Omit<
  HighlightDocumentOptions,
  "id" | "source" | "streaming" | "language"
> {
  path: string
  language?: string
  /** Exact source lines displayed by the tool, with anchors/line-number prefixes removed. */
  displayedLines: readonly string[]
}

interface FileEntry {
  id: string
  version?: string
  pending?: Promise<{ source: string; version: string }>
  controller: AbortController
  requests: Map<string, object>
}

const pendingRequests = new Map<string, FileEntry>()
const files = new BoundedLru<FileEntry>(
  HIGHLIGHT_LIMITS.documents,
  HIGHLIGHT_LIMITS.documentCharacters,
  (entry) => {
    entry.controller.abort()
    releaseHighlightDocument(entry.id)
    for (const id of entry.requests.keys()) pendingRequests.delete(id)
    entry.requests.clear()
  },
)

function signature(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
}

/** Stable file-document identity for releaseHighlightDocument(). */
export function highlightFileId(path: string): string {
  return "file:" + resolve(path)
}

async function load(path: string, entry: FileEntry): Promise<{ source: string; version: string }> {
  const info = await stat(path, { bigint: true })
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`)
  const version = signature(info)
  const cached = getHighlightDocumentSource(entry.id)
  if (entry.version === version && cached !== undefined) return { source: cached, version }
  // UTF-8 uses at most four bytes per code point; the retained-text budget is checked again below.
  if (info.size > BigInt(HIGHLIGHT_LIMITS.documentCharacters * 2))
    throw new Error(`File exceeds highlight budget: ${path}`)
  const handle = await open(path, "r")
  try {
    const before = await handle.stat({ bigint: true })
    if (signature(before) !== version) throw new Error(`File changed before highlighting: ${path}`)
    // Read removes the leading UTF-8 BOM before displaying source lines.
    const source = (
      await handle.readFile({ encoding: "utf8", signal: entry.controller.signal })
    ).replace(/^\uFEFF/, "")
    const after = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (signature(after) !== version || signature(current) !== version)
      throw new Error(`File changed while highlighting: ${path}`)
    if (source.includes("\0")) throw new Error(`Binary file cannot be highlighted: ${path}`)
    if (source.length * 2 > HIGHLIGHT_LIMITS.documentCharacters)
      throw new Error(`File source exceeds highlight budget: ${path}`)
    return { source, version }
  } finally {
    await handle.close()
  }
}

/**
 * Async file preparation, then the same nonblocking document range API.
 * Start outside render(), retain the result in context.state, and invalidate on completion.
 * A mismatch returns null: render the recorded tool text, never current disk content.
 * Every invocation checks file status; concurrent status/read requests share one promise.
 */
export async function highlightFileDocument(
  options: HighlightFileOptions,
): Promise<(string | null)[] | null> {
  cancelFileHighlightRequest(options.subscriberId)
  cancelHighlightRequest(options.subscriberId)
  const path = resolve(options.path)
  const id = highlightFileId(path)
  const language = options.language ?? languageFromPath(path)
  if (!resolveIdentity(language, options.theme)) return null
  if (
    !options.subscriberId ||
    !Number.isSafeInteger(options.from) ||
    !Number.isSafeInteger(options.to) ||
    options.from < 0 ||
    options.to < options.from ||
    options.displayedLines.length !== options.to - options.from
  ) {
    options.onError(new Error("Invalid file highlight range or displayed source lines"))
    return null
  }
  let entry = files.get(id)
  if (!entry) {
    entry = { id, controller: new AbortController(), requests: new Map() }
    if (!files.set(id, entry, id.length)) return null
  }
  const token = {}
  entry.requests.set(options.subscriberId, token)
  pendingRequests.set(options.subscriberId, entry)
  if (!entry.pending) {
    entry.pending = load(path, entry)
    const current = entry
    // Attach both handlers: rejecting loads still reach each live caller below.
    void entry.pending.then(
      () => {
        current.pending = undefined
      },
      () => {
        current.pending = undefined
      },
    )
  }
  try {
    const { source, version } = await entry.pending
    if (entry.requests.get(options.subscriberId) !== token || files.peek(id) !== entry) return null
    const lines = source.split(/\r\n?|\n/)
    if (!options.displayedLines.every((line, index) => lines[options.from + index] === line))
      return null
    const result = highlightDocument({ ...options, id, source, language, streaming: false }, () =>
      files.delete(id),
    )
    if (getHighlightDocumentSource(id) === source) entry.version = version
    return result
  } catch (cause) {
    if (entry.requests.get(options.subscriberId) === token && files.peek(id) === entry) {
      options.onError(new Error(`File highlighting failed (${path}): ${String(cause)}`, { cause }))
    }
    return null
  } finally {
    if (entry.requests.get(options.subscriberId) === token) {
      entry.requests.delete(options.subscriberId)
      pendingRequests.delete(options.subscriberId)
    }
  }
}

export function cancelFileHighlightRequest(subscriberId: string): void {
  const entry = pendingRequests.get(subscriberId)
  entry?.requests.delete(subscriberId)
  pendingRequests.delete(subscriberId)
}

export function releaseHighlightFile(id: string): void {
  files.delete(id)
}
export function clearHighlightFiles(): void {
  files.clear()
  pendingRequests.clear()
}

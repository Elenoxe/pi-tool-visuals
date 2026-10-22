import type { GrammarState } from "shiki"
import { BoundedLru, HIGHLIGHT_LIMITS } from "./cache.ts"
import {
  detachEngineListener,
  engineFailure,
  safeSource,
  readyEngine,
  resolveIdentity,
  tokenizeSlice,
  type HighlightIdentity,
  type HighlightOptions,
} from "./engine.ts"
import { HighlightScheduler, type HighlightPriority } from "./scheduler.ts"

export interface HighlightDocumentOptions extends HighlightOptions {
  /** Stable identity, e.g. toolCallId + ":script"; never a path for historical tool output. */
  id: string
  source: string
  language: string | undefined
  /** Zero-based, half-open range. Only the context through to is processed. */
  from: number
  to: number
  streaming?: boolean
  priority?: HighlightPriority
  /** Stable render region ID; replaces its previous request and callback. */
  subscriberId: string
}

interface Request {
  to: number
  priority: HighlightPriority
  invalidate?: () => void
  onError: HighlightOptions["onError"]
}

class Document {
  generation = 1
  completed = 0
  ansi: string[] = []
  ansiCharacters = 0
  partialLine: string[] = []
  partialOffset = 0
  grammarState?: GrammarState
  tailStart?: GrammarState
  lines: string[]
  sourceCharacters: number
  failed = false
  onEvict?: () => void
  requests = new Map<string, Request>()

  constructor(
    readonly id: string,
    public source: string,
    public identity: HighlightIdentity,
    public theme: HighlightOptions["theme"],
    readonly onReady: () => void,
  ) {
    this.lines = source.split(/\r\n?|\n/)
    this.sourceCharacters = source.length + this.lines.reduce((sum, line) => sum + line.length, 0)
  }

  get characters(): number {
    return this.id.length + this.sourceCharacters + this.ansiCharacters
  }
}

const scheduler = new HighlightScheduler()
const subscriberDocuments = new Map<string, Document>()
const documents = new BoundedLru<Document>(
  HIGHLIGHT_LIMITS.documents,
  HIGHLIGHT_LIMITS.documentCharacters,
  (doc) => {
    invalidateDocument(doc)
    doc.onEvict?.()
  },
)

function clearRequests(doc: Document): void {
  for (const id of doc.requests.keys()) {
    subscriberDocuments.delete(id)
    scheduler.cancelNotification(id)
  }
  doc.requests.clear()
}

function invalidateDocument(doc: Document): void {
  doc.generation++
  scheduler.cancelScope(doc.id)
  detachEngineListener(doc.onReady)
  clearRequests(doc)
}

function themeMatches(doc: Document): boolean {
  return resolveIdentity(doc.identity.language, doc.theme)?.key === doc.identity.key
}

function valid(doc: Document, generation: number): boolean {
  return documents.peek(doc.id) === doc && doc.generation === generation && !doc.failed
}

function finishRequests(doc: Document, synchronousSubscriber?: string): void {
  for (const [id, request] of doc.requests) {
    if (request.to > doc.completed) continue
    doc.requests.delete(id)
    subscriberDocuments.delete(id)
    if (request.invalidate && id !== synchronousSubscriber) {
      const generation = doc.generation
      scheduler.notify(id, {
        scope: doc.id,
        valid: () => valid(doc, generation) && themeMatches(doc),
        callback: request.invalidate,
        onError: request.onError,
      })
    }
  }
}

function target(doc: Document): { to: number; priority: HighlightPriority } | undefined {
  let visible = 0
  let background = 0
  for (const request of doc.requests.values()) {
    if (request.priority === "visible") visible = Math.max(visible, request.to)
    else background = Math.max(background, request.to)
  }
  if (visible > doc.completed) return { to: visible, priority: "visible" }
  if (background > doc.completed) return { to: background, priority: "background" }
  return undefined
}

function enqueue(doc: Document): void {
  if (!themeMatches(doc)) {
    invalidateDocument(doc)
    return
  }
  const next = target(doc)
  if (!next || doc.failed || documents.peek(doc.id) !== doc) {
    scheduler.cancel(doc.id)
    return
  }
  const generation = doc.generation
  scheduler.schedule(
    {
      id: doc.id,
      valid: () => valid(doc, generation),
      run: () => {
        if (!processSlice(doc, next.to)) return
        finishRequests(doc)
        enqueue(doc)
      },
    },
    next.priority,
  )
}

function fail(doc: Document, error: Error): void {
  const handlers = new Set([...doc.requests.values()].map((request) => request.onError))
  invalidateDocument(doc)
  doc.failed = true
  for (const handler of handlers) handler(error)
}

function commitSlice(doc: Document): void {
  if (doc.characters > HIGHLIGHT_LIMITS.documentCharacters) {
    fail(doc, new Error(`Highlight document exceeds character budget (${doc.id})`))
    documents.delete(doc.id)
    return
  }
  documents.set(doc.id, doc, doc.characters)
}

function processSlice(doc: Document, to: number): boolean {
  if (!themeMatches(doc)) {
    invalidateDocument(doc)
    return false
  }
  const generation = doc.generation
  const failure = engineFailure(doc.identity)
  if (failure) {
    fail(doc, failure)
    return false
  }
  const highlighter = readyEngine(doc.identity, {
    invalidate: doc.onReady,
    onError: (error) => {
      if (!valid(doc, generation)) return
      if (!themeMatches(doc)) invalidateDocument(doc)
      else fail(doc, error)
    },
  })
  if (!highlighter) return false
  try {
    if (doc.completed === doc.lines.length - 1) doc.tailStart = doc.grammarState
    const line = doc.lines[doc.completed]!
    if (line.length >= HIGHLIGHT_LIMITS.maxLineLength) {
      // Shiki skips these lines without advancing grammar; even plain-text conversion must yield.
      const end = Math.min(line.length, doc.partialOffset + HIGHLIGHT_LIMITS.sliceCharacters)
      const part = safeSource(line.slice(doc.partialOffset, end))
      doc.partialLine.push(part)
      doc.ansiCharacters += part.length
      doc.partialOffset = end
      if (end === line.length) {
        doc.ansi.push(doc.partialLine.join(""))
        doc.partialLine = []
        doc.partialOffset = 0
        doc.completed++
      }
      commitSlice(doc)
      return valid(doc, generation)
    }
    let end = doc.completed
    let characters = 0
    // Isolate the tail so its start state can later be reused when content is appended.
    const limit = doc.completed < doc.lines.length - 1 ? Math.min(to, doc.lines.length - 1) : to
    while (end < limit && end - doc.completed < HIGHLIGHT_LIMITS.sliceLines) {
      const nextLine = doc.lines[end]!
      if (nextLine.length >= HIGHLIGHT_LIMITS.maxLineLength) break
      const length = nextLine.length + (end > doc.completed ? 1 : 0)
      if (characters + length > HIGHLIGHT_LIMITS.sliceCharacters) break
      characters += length
      end++
    }
    if (end === doc.completed) return false
    const result = tokenizeSlice(
      highlighter,
      doc.lines.slice(doc.completed, end).join("\n"),
      doc.identity,
      doc.theme,
      doc.grammarState,
    )
    if (!themeMatches(doc) && doc.generation === generation) invalidateDocument(doc)
    if (!valid(doc, generation)) return false
    doc.ansi.push(...result.lines)
    doc.ansiCharacters += result.lines.reduce((sum, line) => sum + line.length, 0)
    doc.completed = end
    doc.grammarState = result.grammarState
    commitSlice(doc)
    return valid(doc, generation)
  } catch (cause) {
    if (valid(doc, generation))
      fail(
        doc,
        new Error(
          `Shiki document highlighting failed (${doc.identity.language}): ${String(cause)}`,
          { cause },
        ),
      )
    return false
  }
}

/** Bounded synchronous range lookup; unfinished entries continue on the scheduler. */
export function highlightDocument(
  options: HighlightDocumentOptions,
  onEvict?: () => void,
): (string | null)[] | null {
  const identity = resolveIdentity(options.language, options.theme)
  cancelHighlightRequest(options.subscriberId)
  if (!identity || engineFailure(identity)) {
    releaseHighlightDocument(options.id)
    return null
  }
  if (
    !options.id ||
    !options.subscriberId ||
    !Number.isSafeInteger(options.from) ||
    !Number.isSafeInteger(options.to) ||
    options.from < 0 ||
    options.to < options.from
  ) {
    options.onError(new Error("Invalid highlight document identity or half-open line range"))
    return null
  }
  if (options.source.length * 2 + options.id.length > HIGHLIGHT_LIMITS.documentCharacters) {
    releaseHighlightDocument(options.id)
    options.onError(new Error(`Highlight document source exceeds character budget (${options.id})`))
    return null
  }
  let doc = documents.get(options.id)
  if (!doc) {
    const created = new Document(options.id, options.source, identity, options.theme, () => {
      if (documents.peek(created.id) === created) enqueue(created)
    })
    doc = created
    if (!documents.set(doc.id, doc, doc.characters)) return null
  } else if (doc.source !== options.source || doc.identity.key !== identity.key) {
    const append =
      doc.identity.key === identity.key && !doc.failed && options.source.startsWith(doc.source)
    const stable = append ? Math.min(doc.completed, doc.lines.length - 1) : 0
    const grammar = append ? (doc.completed > stable ? doc.tailStart : doc.grammarState) : undefined
    invalidateDocument(doc)
    doc.source = options.source
    doc.lines = options.source.split(/\r\n?|\n/)
    doc.sourceCharacters = doc.source.length + doc.lines.reduce((sum, line) => sum + line.length, 0)
    doc.identity = identity
    doc.theme = options.theme
    doc.completed = stable
    doc.partialLine = []
    doc.partialOffset = 0
    doc.ansi = doc.ansi.slice(0, stable)
    doc.ansiCharacters = doc.ansi.reduce((sum, line) => sum + line.length, 0)
    doc.grammarState = grammar
    doc.tailStart = undefined
    doc.failed = false
    if (!documents.set(doc.id, doc, doc.characters)) {
      options.onError(new Error(`Highlight document source exceeds character budget (${doc.id})`))
      return null
    }
  }
  if (onEvict) doc.onEvict = onEvict
  doc.theme = options.theme
  if (doc.failed) return null
  const from = Math.min(options.from, doc.lines.length)
  const to = Math.min(options.to, doc.lines.length)
  if (to > from && to > doc.completed) {
    doc.requests.set(options.subscriberId, {
      to,
      priority: options.priority ?? "visible",
      invalidate: options.invalidate,
      onError: options.onError,
    })
    subscriberDocuments.set(options.subscriberId, doc)
    scheduler.cancel(doc.id)
    const generation = doc.generation
    let syncTo = doc.completed
    let characters = 0
    while (
      options.priority !== "background" &&
      syncTo < to &&
      syncTo - doc.completed < HIGHLIGHT_LIMITS.syncLines
    ) {
      const line = doc.lines[syncTo]!
      if (line.length >= HIGHLIGHT_LIMITS.maxLineLength) break
      const length = line.length + (syncTo > doc.completed ? 1 : 0)
      if (characters + length > HIGHLIGHT_LIMITS.syncCharacters) break
      characters += length
      syncTo++
    }
    // Isolating the unstable tail may require a second slice within the same total budget.
    while (doc.completed < syncTo && processSlice(doc, syncTo)) {
      if (!valid(doc, generation)) break
    }
    if (valid(doc, generation)) {
      finishRequests(doc, options.subscriberId)
      enqueue(doc)
    }
    if (doc.failed) return null
  }
  return Array.from({ length: to - from }, (_, index) => doc!.ansi[from + index] ?? null)
}

/** Cancels a region's computation demand as well as any queued redraw. */
export function cancelHighlightRequest(subscriberId: string): void {
  scheduler.cancelNotification(subscriberId)
  const doc = subscriberDocuments.get(subscriberId)
  if (!doc) return
  doc.requests.delete(subscriberId)
  subscriberDocuments.delete(subscriberId)
  scheduler.cancel(doc.id)
  detachEngineListener(doc.onReady)
  enqueue(doc)
}

export function releaseHighlightDocument(id: string): void {
  documents.delete(id)
}

export function clearHighlightDocuments(): void {
  documents.clear()
  subscriberDocuments.clear()
  scheduler.dispose()
}

/** Internal diagnostics for benchmarks, not renderer configuration. */
export function documentCacheStats() {
  return {
    entries: documents.size,
    characters: documents.characters,
    hits: documents.hits,
    misses: documents.misses,
    tasks: scheduler.pending,
    subscribers: subscriberDocuments.size,
  }
}

/** File adapters borrow retained source; no separate file-content cache. */
export function getHighlightDocumentSource(id: string): string | undefined {
  return documents.peek(id)?.source
}

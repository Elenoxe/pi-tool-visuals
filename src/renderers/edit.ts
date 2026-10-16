import { readFile } from "node:fs/promises"

import type { ToolRenderers } from "@earendil-works/pi-coding-agent"
import { backgroundAnsi, Container, mixColors, Spacer } from "@earendil-works/pi-tui"
import { diffWords, structuredPatch } from "diff"

import { resolveToolConfig } from "../config.ts"
import {
  cancelHighlightRequest,
  highlightDocument,
  languageFromPath,
  releaseHighlightDocument,
} from "../highlight/index.ts"
import type { ToolVisualsConfig } from "../types.ts"
import {
  hiddenNotice,
  lineNumberWidth,
  localPath,
  printable,
  renderPath,
  renderToolCall,
  renderToolError,
  reuseText,
  splitFileLines,
  type RenderContext,
  type Theme,
} from "./shared.ts"

type Edit = { oldText: string; newText: string }
type Input = { path: string; edits: Edit[] }
type Range = [number, number]
type DiffRow = {
  kind: "-" | "+" | " " | "gap" | "note"
  code: string
  number?: number
  ranges?: Range[]
}

const diffColors = {
  "-": "toolDiffRemoved",
  "+": "toolDiffAdded",
  " ": "toolDiffContext",
} as const

type Preview = { rows: DiffRow[]; groups?: DiffRow[][] }
interface EditState {
  key: string
  input?: Input
  call: Container
  preview?: Preview
  pending: boolean
  phase: "pending" | "success" | "error"
  resultDiff?: string
  requests: Set<string>
}

function parseInput(raw: unknown): Input | undefined {
  if (!raw || typeof raw !== "object") return
  const args = raw as Record<string, unknown>
  const path = typeof args.path === "string" ? args.path : args.file_path
  if (typeof path !== "string" || !path) return
  const edits = Array.isArray(args.edits) ? args.edits : [args]
  if (
    !edits.length ||
    !edits.every(
      (edit) =>
        edit &&
        typeof edit === "object" &&
        typeof edit.oldText === "string" &&
        typeof edit.newText === "string",
    )
  )
    return
  return { path, edits: edits.map(({ oldText, newText }) => ({ oldText, newText })) }
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** diffWords ignores whitespace; track non-whitespace characters in each original side. */
function wordRanges(before: string, after: string): [Range[], Range[]] {
  const ranges: [Range[], Range[]] = [[], []]
  const offsets: [number, number] = [0, 0]
  for (const part of diffWords(before, after)) {
    for (const side of [0, 1] as const) {
      if (side === 0 ? part.added : part.removed) continue
      const source = side === 0 ? before : after
      let start: number | undefined
      for (const char of part.value) {
        if (/\s/u.test(char)) continue
        while (offsets[side] < source.length && /\s/u.test(source[offsets[side]]!)) offsets[side]++
        start ??= offsets[side]
        offsets[side] += char.length
      }
      if (start !== undefined && (side === 0 ? part.removed : part.added))
        ranges[side].push([start, offsets[side]])
    }
  }
  return ranges
}

function prepareRows(rows: DiffRow[]): DiffRow[] {
  while (rows.at(-1)?.kind === "gap") rows.pop()
  for (let index = 0; index < rows.length;) {
    if (rows[index]!.kind !== "-" && rows[index]!.kind !== "+") {
      index++
      continue
    }
    const start = index
    while (index < rows.length && (rows[index]!.kind === "-" || rows[index]!.kind === "+")) index++
    if (index - start !== 2) continue
    const removed = rows[start]!
    const added = rows[start + 1]!
    if (removed.kind !== "-" || added.kind !== "+") continue
    const [removedRanges, addedRanges] = wordRanges(printable(removed.code), printable(added.code))
    removed.ranges = removedRanges
    added.ranges = addedRanges
  }
  return rows
}

function parseDiff(diff: string): DiffRow[] {
  return prepareRows(
    splitFileLines(normalize(diff)).map((line): DiffRow => {
      if (/^\s*\.\.\.\s*$/.test(line)) return { kind: "gap", code: "⋮" }
      const match = /^([ +-])\s*(\d+) (.*)$/.exec(line)
      const number = Number(match?.[2])
      if (!match || !Number.isSafeInteger(number) || number < 1) return { kind: "note", code: line }
      return { kind: match[1] as "-" | "+" | " ", number, code: match[3]! }
    }),
  )
}

async function compare(before: string, after: string, numbered: boolean): Promise<DiffRow[]> {
  const patch = await new Promise<ReturnType<typeof structuredPatch>>((resolve) => {
    structuredPatch("", "", before, after, undefined, undefined, { context: 4, callback: resolve })
  })
  const rows: DiffRow[] = []
  for (const hunk of patch.hunks) {
    if (hunk.oldStart > 1 || rows.length) rows.push({ kind: "gap", code: "⋮" })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      const kind = line[0]
      if (kind !== "-" && kind !== "+" && kind !== " ") continue
      const lineNumber = kind === "+" ? newLine : oldLine
      rows.push({
        kind,
        number: numbered ? lineNumber : undefined,
        code: line.slice(1),
      })
      if (kind !== "+") oldLine++
      if (kind !== "-") newLine++
    }
  }
  return prepareRows(rows)
}

async function proposed(input: Input): Promise<Preview> {
  const groups = await Promise.all(
    input.edits.map(async (edit) => {
      const rows = await compare(normalize(edit.oldText), normalize(edit.newText), false)
      if (!rows.length) rows.push({ kind: "note", code: "No changes" })
      return rows
    }),
  )
  return { rows: groups.flat(), groups }
}

async function preview(input: Input, cwd: string): Promise<Preview> {
  let source: string
  try {
    source = normalize((await readFile(localPath(input.path, cwd), "utf8")).replace(/^\uFEFF/, ""))
  } catch {
    // A preview read failure says nothing about the tool's actual execution status.
    return proposed(input)
  }
  const matches = input.edits
    .map((edit) => {
      const oldText = normalize(edit.oldText)
      return { start: source.indexOf(oldText), oldText, newText: normalize(edit.newText) }
    })
    .sort((a, b) => a.start - b.start)
  if (
    matches.some((match, index) => {
      const previous = matches[index - 1]
      return (
        !match.oldText ||
        match.start < 0 ||
        source.indexOf(match.oldText, match.start + match.oldText.length) !== -1 ||
        (previous !== undefined && previous.start + previous.oldText.length > match.start)
      )
    })
  )
    return proposed(input)
  let modified = source
  for (const match of matches.toReversed())
    modified =
      modified.slice(0, match.start) +
      match.newText +
      modified.slice(match.start + match.oldText.length)
  return { rows: await compare(source, modified, true) }
}

function cancelRequests(state: EditState, active = new Set<string>()): void {
  for (const id of state.requests) {
    if (active.has(id)) continue
    cancelHighlightRequest(id)
    releaseHighlightDocument(id)
  }
  state.requests = active
}

function editState(raw: unknown, context: RenderContext): EditState {
  const input = parseInput(raw)
  const key = JSON.stringify([context.cwd, input ?? raw])
  let state = context.state.edit as EditState | undefined
  if (state?.key === key) return state
  if (state) cancelRequests(state)
  state = {
    key,
    input,
    call: new Container(),
    pending: false,
    phase: "pending",
    requests: new Set(),
  }
  context.state.edit = state
  return state
}

/** Overlay backgrounds only; foreground SGR sequences from Shiki remain untouched. */
function emphasize(styled: string, ranges: Range[], background: string): string {
  // eslint-disable-next-line no-control-regex -- Only renderer-generated ANSI is parsed.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g
  const output: string[] = []
  let offset = 0
  let column = 0
  let range = 0
  let active = false
  const append = (text: string) => {
    for (const char of text) {
      while (range < ranges.length && column >= ranges[range]![1]) range++
      const next = range < ranges.length && column >= ranges[range]![0]
      if (next !== active) {
        output.push(next ? background : "\x1b[49m")
        active = next
      }
      output.push(char)
      column += char.length
      if (active && column >= ranges[range]![1]) {
        output.push("\x1b[49m")
        active = false
      }
    }
  }
  for (const match of styled.matchAll(ansi)) {
    append(styled.slice(offset, match.index))
    output.push(match[0])
    if (active && match[0].endsWith("m")) output.push(background)
    offset = match.index! + match[0].length
  }
  append(styled.slice(offset))
  if (active) output.push("\x1b[49m")
  return output.join("")
}

/** Restore the row background after word emphasis or syntax resets. */
function rowBackground(line: string, background: string): string {
  // eslint-disable-next-line no-control-regex -- Restore renderer-generated ANSI background resets.
  return background + line.replace(/\x1b\[(?:0|49)m/g, "$&" + background) + "\x1b[49m"
}

function diffStats(rows: DiffRow[], theme: Theme): string {
  const added = rows.filter((row) => row.kind === "+").length
  const removed = rows.filter((row) => row.kind === "-").length
  return theme.fg(diffColors["+"], `+${added}`) + " " + theme.fg(diffColors["-"], `-${removed}`)
}

function renderDiff(
  state: EditState,
  theme: Theme,
  context: RenderContext,
  config: ToolVisualsConfig,
): Container {
  const component =
    state.call.children[1] instanceof Container ? state.call.children[1] : new Container()
  const previous = [...component.children]
  component.clear()
  if (!state.preview && !state.input) {
    cancelRequests(state)
    return component
  }
  const groups = state.preview?.groups
  const rows = state.preview?.rows ?? []
  const groupStarts = new Map<number, number>()
  let offset = 0
  for (const [index, group] of (groups ?? []).entries()) {
    groupStarts.set(offset, index)
    offset += group.length
  }
  const visible = context.expanded
    ? rows.length
    : Math.min(rows.length, resolveToolConfig(config, "edit").collapsedLines)
  const styled = new Map<DiffRow, string>()
  const active = new Set<string>()
  const language = languageFromPath(state.input?.path ?? "")
  for (let start = 0; start < visible;) {
    if (rows[start]!.kind === "gap" || rows[start]!.kind === "note") {
      start++
      continue
    }
    let end = start + 1
    while (
      end < rows.length &&
      rows[end]!.kind !== "gap" &&
      rows[end]!.kind !== "note" &&
      !groupStarts.has(end)
    )
      end++
    const regionRows = rows.slice(start, end)
    const visibleRows = rows.slice(start, Math.min(end, visible))
    for (const side of ["-", "+"] as const) {
      const fragment = regionRows.filter((row) => row.kind === side || row.kind === " ")
      const count = visibleRows.filter((row) => row.kind === side || row.kind === " ").length
      if (!config.highlight.enable || !language || !count) continue
      const id = `${context.toolCallId}:edit:${start}:${side}`
      active.add(id)
      const highlighted = highlightDocument({
        id,
        subscriberId: id,
        source: fragment.map((row) => printable(row.code)).join("\n"),
        language,
        from: 0,
        to: count,
        theme,
        invalidate: context.invalidate,
        onError: () => {},
      })
      fragment.slice(0, count).forEach((row, index) => {
        const line = highlighted?.[index]
        if (line != null && (row.kind === side || side === "+")) styled.set(row, line)
      })
    }
    start = end
  }
  cancelRequests(state, active)
  let maxLine = 0
  for (const row of rows) maxLine = Math.max(maxLine, row.number ?? 0)
  const width = lineNumberWidth(maxLine)
  const numbered = rows.some((row) => row.number !== undefined)
  const gutterWidth = numbered ? width + 1 : 1
  const backgrounds = new Map(
    (["-", "+"] as const).map((kind) => {
      const base = theme.colors[kind === "-" ? "toolErrorBg" : "toolSuccessBg"]
      const tint = theme.colors[diffColors[kind]]
      return [
        kind,
        {
          line: backgroundAnsi(mixColors(base, tint, 0.14, "srgb"), theme.getColorMode()),
          word: backgroundAnsi(mixColors(base, tint, 0.3, "srgb"), theme.getColorMode()),
        },
      ] as const
    }),
  )
  const rowBackgrounds = new Map<number, string>()
  const count = state.input?.edits.length
  const summary: string[] = []
  if (count !== undefined)
    summary.push(theme.fg("dim", `${count} ${count === 1 ? "edit" : "edits"}`))
  if (state.preview) summary.push(diffStats(state.preview.rows, theme))
  const output = ["", summary.join(theme.fg("dim", " · "))]
  if (state.preview && !groups) output.push("")
  for (const [index, row] of rows.slice(0, visible).entries()) {
    const group = groupStarts.get(index)
    if (group !== undefined && groups) {
      output.push(
        "",
        theme.fg("dim", `Proposed change ${group + 1}/${groups.length} · `) +
          diffStats(groups[group]!, theme),
      )
    }
    if (row.kind === "gap" || row.kind === "note") {
      const text = row.kind === "gap" ? "⋮".padStart(gutterWidth) : printable(row.code)
      output.push(theme.fg("dim", text))
      continue
    }
    const color = diffColors[row.kind]
    let code = styled.get(row) ?? theme.fg(color, printable(row.code))
    const background = row.kind === " " ? undefined : backgrounds.get(row.kind)!
    if (row.ranges?.length && background) {
      code = emphasize(code, row.ranges, background.word)
    }
    if (row.kind === " ") code = theme.style(code, { dim: true })
    const gutter = numbered ? row.kind + String(row.number ?? "").padStart(width, " ") : row.kind
    if (background) rowBackgrounds.set(output.length, background.line)
    output.push(theme.fg(color, gutter) + theme.fg("dim", " │ ") + code)
  }
  if (state.preview && !rows.length) output.push(theme.fg("dim", "No changes"))
  if (rows.length > visible) output.push(hiddenNotice(rows.length - visible, theme))
  for (const [index, line] of output.entries()) {
    if (!line) {
      component.addChild(previous[index] instanceof Spacer ? previous[index] : new Spacer(1))
      continue
    }
    const text = reuseText(previous[index], line)
    const background = rowBackgrounds.get(index)
    text.setCustomBgFn(background ? (value) => rowBackground(value, background) : undefined)
    component.addChild(text)
  }
  return component
}

function buildCall(
  state: EditState,
  theme: Theme,
  context: RenderContext,
  config: ToolVisualsConfig,
): Container {
  const raw = context.args as Record<string, unknown> | undefined
  const path = state.input?.path ?? (typeof raw?.path === "string" ? raw.path : "")
  const title = renderToolCall(
    "edit",
    path ? renderPath(path, context.cwd, theme) : "",
    [languageFromPath(path)],
    theme,
    { ...context, lastComponent: state.call.children[0] },
  )
  const body = renderDiff(state, theme, context, config)
  state.call.clear()
  state.call.addChild(title)
  state.call.addChild(body)
  return state.call
}

export function createEditRenderer(getConfig: () => ToolVisualsConfig): ToolRenderers {
  return {
    renderShell: "default",
    renderCall(args, theme, context) {
      const state = editState(args, context)
      // isPartial is false for restored/final results, even before renderResult is called.
      if (
        context.argsComplete &&
        context.isPartial &&
        state.input &&
        !state.preview &&
        !state.pending &&
        state.phase === "pending"
      ) {
        state.pending = true
        void preview(state.input, context.cwd).then((value) => {
          if (
            context.state.edit !== state ||
            state.phase === "success" ||
            state.resultDiff !== undefined
          )
            return
          state.preview = value
          state.pending = false
          context.invalidate()
        })
      }
      return buildCall(state, theme, context, getConfig())
    },
    renderResult(result, options, theme, context) {
      const state = editState(context.args, context)
      if (!options.isPartial) state.phase = context.isError ? "error" : "success"
      if (!context.isError) {
        const diff = (result.details as { diff?: unknown } | undefined)?.diff
        if (typeof diff === "string") {
          if (state.resultDiff !== diff) {
            state.resultDiff = diff
            state.preview = { rows: parseDiff(diff) }
          }
        } else if (!options.isPartial)
          state.preview = { rows: [{ kind: "note", code: "Diff unavailable" }] }
      } else if (!state.preview && !state.pending && state.input) {
        state.pending = true
        void proposed(state.input).then((value) => {
          if (context.state.edit !== state || state.phase !== "error") return
          state.preview = value
          state.pending = false
          context.invalidate()
        })
      }
      buildCall(state, theme, { ...context, expanded: options.expanded }, getConfig())
      return context.isError
        ? renderToolError(result, options.expanded, theme, context)
        : reuseText(context.lastComponent, "")
    },
  }
}

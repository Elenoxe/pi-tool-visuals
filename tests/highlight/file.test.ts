import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises"
import * as fs from "node:fs/promises"
import { stripVTControlCharacters } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import {
  highlightFileDocument,
  highlightFileId,
  releaseHighlightDocument,
  configureHighlighting,
  disposeHighlighting,
  cancelHighlightRequest,
  type HighlightFileOptions,
} from "../../src/highlight/index.ts"

import { documentCacheStats } from "../../src/highlight/document.ts"

let dir: string
let path: string
const theme = getThemeByName("dark")!
const onError = mock((_error: Error) => {})
const invalidate = mock(() => {})
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "highlight-file-"))
  path = join(dir, "source.ts")
  onError.mockClear()
  invalidate.mockClear()
  configureHighlighting({ enable: true, theme: "auto" })
})
afterEach(async () => {
  disposeHighlighting()
  mock.restore()
  await rm(dir, { recursive: true, force: true })
})
function request(displayedLines: readonly string[], from = 0): HighlightFileOptions {
  return {
    path,
    from,
    to: from + displayedLines.length,
    displayedLines,
    theme,
    onError,
    subscriberId: "read:result",
    invalidate,
  }
}
async function ready(options: HighlightFileOptions) {
  const deadline = Date.now() + 5000
  let result = await highlightFileDocument(options)
  while (!result?.every((line) => line !== null)) {
    if (Date.now() > deadline || onError.mock.calls.length)
      throw new Error("File highlighting did not complete")
    await nextTurn()
    result = await highlightFileDocument(options)
  }
  return result
}

test("file ranges share document source, stat-check every reuse and read only once", async () => {
  await writeFile(path, "/*\ncomment\n*/\nconst n = 1")
  const open = spyOn(fs, "open")
  const stat = spyOn(fs, "stat")
  const result = await ready(request(["comment"], 1))
  expect(result[0]).toContain("comment")
  expect(open).toHaveBeenCalledTimes(1)
  expect(stat.mock.calls.length).toBeGreaterThan(1)
  expect(await highlightFileDocument(request(["historical text"], 1))).toBeNull()
  expect(open).toHaveBeenCalledTimes(1)
  expect(onError).not.toHaveBeenCalled()
  releaseHighlightDocument(highlightFileId(path))
  await ready(request(["comment"], 1))
  expect(open).toHaveBeenCalledTimes(2)
})

test("changed or replaced files never substitute disk content for old displayed lines", async () => {
  await writeFile(path, "const old = 1")
  await ready(request(["const old = 1"]))
  await writeFile(path, "const new = 2")
  expect(await highlightFileDocument(request(["const old = 1"]))).toBeNull()
  await ready(request(["const new = 2"]))
  const replacement = join(dir, "replacement.ts")
  await writeFile(replacement, "const last = 3")
  await rename(replacement, path)
  expect(await highlightFileDocument(request(["const new = 2"]))).toBeNull()
  await ready(request(["const last = 3"]))
  expect(onError).not.toHaveBeenCalled()
})

test("concurrent file requests coalesce reads and cancelled/late loads cannot create documents", async () => {
  await writeFile(path, "const n = 1")
  const original = fs.open
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const open = spyOn(fs, "open").mockImplementation(async (...args) => {
    started.resolve()
    await gate.promise
    return original(...args)
  })
  const a = highlightFileDocument(request(["const n = 1"]))
  const b = highlightFileDocument({ ...request(["const n = 1"]), subscriberId: "grep:result" })
  await started.promise
  cancelHighlightRequest("read:result")
  disposeHighlighting()
  gate.resolve()
  expect(await a).toBeNull()
  expect(await b).toBeNull()
  expect(open).toHaveBeenCalledTimes(1)
  expect(invalidate).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

test("file mutation during reading fails explicitly, as do missing and binary files", async () => {
  await writeFile(path, "const n = 1")
  const original = fs.open
  spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await original(...args)
    const read = handle.readFile.bind(handle)
    spyOn(handle, "readFile").mockImplementationOnce((async () => {
      const result = await read({ encoding: "utf8" })
      await writeFile(path, "const changed = 2")
      return result
    }) as unknown as typeof handle.readFile)
    return handle
  })
  expect(await highlightFileDocument(request(["const n = 1"]))).toBeNull()
  expect(onError.mock.calls[0]![0].message).toContain("changed while")
  await rm(path)
  expect(await highlightFileDocument(request(["x"]))).toBeNull()
  await writeFile(path, "\0binary")
  expect(await highlightFileDocument(request(["\0binary"]))).toBeNull()
  expect(onError).toHaveBeenCalledTimes(3)
})

test("file cache eviction cancels outstanding loads and keeps source in the bounded document cache", async () => {
  const paths = await Promise.all(
    Array.from({ length: 26 }, async (_, i) => {
      const file = join(dir, i + ".ts")
      await writeFile(file, "const n = 1")
      return file
    }),
  )
  const results = await Promise.all(
    paths.map((path, i) =>
      highlightFileDocument({
        ...request(["const n = 1"]),
        path,
        subscriberId: String(i),
      }),
    ),
  )
  expect(results[0]).toBeNull()
  expect(results[1]).toBeNull()
  expect(documentCacheStats().entries).toBeLessThanOrEqual(24)
  expect(onError).not.toHaveBeenCalled()
})

test("UTF-8 BOM files match Read lines without removing BOM characters inside source", async () => {
  const lines = ["/*", "comment", "*/", 'const marker = "\uFEFFinside"']
  const source = "\uFEFF" + lines.join("\r\n")
  await writeFile(path, source)
  const open = spyOn(fs, "open")
  const result = await ready(request(lines))
  expect(result.map((line) => stripVTControlCharacters(line!))).toEqual(lines)
  expect(await highlightFileDocument(request(lines))).toEqual(result)
  expect(open).toHaveBeenCalledTimes(1)
  expect(await highlightFileDocument(request(["// historical first line"]))).toBeNull()
  expect(await fs.readFile(path, "utf8")).toBe(source)
  expect(onError).not.toHaveBeenCalled()
})

test("BOM normalization still rejects changed historical Read lines", async () => {
  await writeFile(path, "\uFEFFconst old = 1")
  await ready(request(["const old = 1"]))
  await writeFile(path, "\uFEFFconst current = 2")
  expect(await highlightFileDocument(request(["const old = 1"]))).toBeNull()
  const result = await ready(request(["const current = 2"]))
  expect(result[0]).toContain("current")
  expect(onError).not.toHaveBeenCalled()
})

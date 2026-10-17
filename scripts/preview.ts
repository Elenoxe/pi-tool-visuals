#!/usr/bin/env bun

/**
 * bun scripts/preview.ts prints a session path; open it with:
 * pi -e "$(pwd)/src/index.ts" --session <path>
 * Edit examples run natively on temporary files only; Ctrl+O expands the recorded results.
 */
import {
  createEditTool,
  DEFAULT_MAX_BYTES,
  formatSize,
  SessionManager,
  truncateTail,
  type CodemodeToolDetails,
  type EditToolInput,
} from "@earendil-works/pi-coding-agent"
import assert from "node:assert/strict"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0]
type ToolResult = Extract<SessionMessage, { role: "toolResult" }>
type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>

type Fixture = {
  toolName: string
  args: ToolCall["arguments"]
  result: Pick<ToolResult, "content" | "details" | "isError"> & { durationMs: number }
}

const root = fileURLToPath(new URL("..", import.meta.url))

function textFixture(
  toolName: string,
  args: ToolCall["arguments"],
  text: string,
  durationMs: number,
  options: { details?: ToolResult["details"]; isError?: boolean } = {},
): Fixture {
  return {
    toolName,
    args,
    result: {
      content: [{ type: "text", text }],
      details: options.details,
      isError: options.isError ?? false,
      durationMs,
    },
  }
}

async function editFixtures(directory: string): Promise<Fixture[]> {
  const oldConfig = [
    'const baseUrl = "https://legacy.example.com"',
    "const defaultHeaders = {}",
    'const cacheMode: RequestCache = "no-store"',
  ].join("\n")
  const newConfig = [
    'const baseUrl = "https://api.example.com"',
    'const defaultHeaders = { Accept: "application/json" }',
    'const cacheMode: RequestCache = "force-cache"',
  ].join("\n")
  const examples: {
    file: string
    source: string
    edits: EditToolInput["edits"]
    expectedError?: RegExp
  }[] = [
    {
      file: "src/http-client.ts",
      source: [
        "export const timeout = 3_000",
        "",
        oldConfig,
        "",
        "export async function fetchUser(id: string) {",
        "  const response = await fetch(`${baseUrl}/users/${id}`, {",
        "    headers: defaultHeaders,",
        "    cache: cacheMode,",
        "    signal: AbortSignal.timeout(timeout),",
        "  })",
        "",
        "  if (!response.ok) {",
        "    throw new Error(`Request failed: ${response.status}`)",
        "  }",
        "",
        "  return response.json()",
        "}",
        "",
      ].join("\n"),
      edits: [
        { oldText: "export const timeout = 3_000", newText: "export const timeout = 8_000" },
        { oldText: oldConfig, newText: newConfig },
      ],
    },
    {
      file: "src/worker.ts",
      source: "export const concurrency = 4\nexport const retryLimit = 3\n",
      edits: [
        { oldText: "export const concurrency = 4", newText: "export const concurrency = 8" },
        { oldText: "export const retryLimit = 1", newText: "export const retryLimit = 5" },
      ],
      expectedError: /Could not find edits\[1\]/,
    },
  ]

  mkdirSync(join(directory, "src"), { recursive: true })
  const tool = createEditTool(directory)
  const fixtures: Fixture[] = []
  for (const example of examples) {
    writeFileSync(join(directory, example.file), example.source, { flag: "wx" })
    const args: EditToolInput = { path: example.file, edits: example.edits }
    const started = performance.now()
    let result: Omit<Fixture["result"], "durationMs">
    try {
      result = { ...(await tool.execute(`preview-${example.file}`, args)), isError: false }
    } catch (error) {
      if (!example.expectedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, example.expectedError, example.file)
      result = { content: [{ type: "text", text: message }], details: undefined, isError: true }
    }
    assert.equal(result.isError, Boolean(example.expectedError), example.file)
    fixtures.push({
      toolName: "edit",
      args,
      result: { ...result, durationMs: Math.round(performance.now() - started) },
    })
  }
  return fixtures
}

function readFixture(
  path: string,
  durationMs: number,
  options: { offset?: number; limit?: number } = {},
): Fixture {
  const lines = readFileSync(resolve(root, path), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r\n?|\n/)
  const start = Math.max(0, (options.offset ?? 1) - 1)
  const end = Math.min(lines.length, start + (options.limit ?? lines.length))
  const source = lines.slice(start, end).join("\n")
  const notice =
    options.limit !== undefined && end < lines.length
      ? `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`
      : ""
  return textFixture("read", { path, ...options }, source + notice, durationMs)
}

/** Approximate Pi's native Grep result formatting from real repository source. */
function grepFixture(
  paths: readonly string[],
  pattern: string,
  durationMs: number,
  options: {
    path?: string
    glob?: string
    literal?: boolean
    ignoreCase?: boolean
    context?: number
    limit?: number
  } = {},
): Fixture {
  const searchPath = options.path ?? (paths.length === 1 ? paths[0]! : "src")
  const context = options.context ?? 0
  const limit = options.limit ?? 100
  const expression = new RegExp(
    options.literal === false ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    options.ignoreCase ? "i" : "",
  )
  const directory = statSync(resolve(root, searchPath)).isDirectory()
  const matches = paths.flatMap((path) => {
    const lines = readFileSync(resolve(root, path), "utf8").split(/\r\n?|\n/)
    return lines.flatMap((line, index) => (expression.test(line) ? [{ path, lines, index }] : []))
  })
  const rows = matches.slice(0, limit).flatMap(({ path, lines, index }) => {
    const file = directory
      ? relative(resolve(root, searchPath), resolve(root, path)).replaceAll("\\", "/")
      : basename(path)
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length, index + context + 1)
    return lines.slice(from, to).map((line, offset) => {
      const lineNumber = from + offset + 1
      const separator = lineNumber === index + 1 ? ":" : "-"
      return `${file}${separator}${lineNumber}${separator} ${line}`
    })
  })
  const reachedLimit = matches.length >= limit
  const text = rows.length
    ? rows.join("\n") +
      (reachedLimit
        ? `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`
        : "")
    : "No matches found"
  return textFixture(
    "grep",
    {
      pattern,
      path: searchPath,
      literal: options.literal ?? true,
      ...(options.glob ? { glob: options.glob } : {}),
      ...(options.ignoreCase ? { ignoreCase: true } : {}),
      ...(context ? { context } : {}),
      ...(options.limit !== undefined ? { limit } : {}),
    },
    text,
    durationMs,
    { details: reachedLimit ? { matchLimitReached: limit } : undefined },
  )
}

function findPaths(path: string): string[] {
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(resolve(root, path, directory), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relativePath = join(directory, entry.name)
      if (entry.isDirectory()) visit(relativePath)
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        found.push(relativePath.replaceAll("\\", "/"))
    }
  }
  visit("")
  return found
}

function lsFixture(path: string, durationMs: number, limit?: number): Fixture {
  const entries = readdirSync(resolve(root, path), { withFileTypes: true })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
  const shown = entries.slice(0, limit)
  const reachedLimit = limit !== undefined && entries.length > limit
  const notice = reachedLimit
    ? `\n\n[${limit} entries limit reached. Use limit=${limit * 2} for more]`
    : ""
  return textFixture(
    "ls",
    { path, ...(limit === undefined ? {} : { limit }) },
    (shown.length ? shown.join("\n") : "(empty directory)") + notice,
    durationMs,
    { details: reachedLimit ? { entryLimitReached: limit } : undefined },
  )
}

const paths = findPaths("src")
const shellTruncation = truncateTail(
  Array.from(
    { length: 250 },
    (_, index) => `file-${index + 1}.txt ${"recorded output ".repeat(25)}`,
  ).join("\n"),
)
const shellOutputPath = join(tmpdir(), "pi-powershell-preview.log")
const fixtures: Fixture[] = [
  // Read: long range, short file, and an execution error.
  readFixture("src/highlight/engine.ts", 18, { offset: 80, limit: 40 }),
  readFixture("src/resolver.ts", 240),
  textFixture(
    "read",
    { path: "src/missing.ts" },
    "ENOENT: no such file or directory, open 'src/missing.ts'",
    6,
    { isError: true },
  ),

  // Grep: grouped context, a single-file limit, an empty result, and an error.
  grepFixture(["src/renderers/read.ts", "src/renderers/shared.ts"], "theme", 1_820, {
    ignoreCase: true,
    glob: "*.ts",
    context: 1,
  }),
  grepFixture(["src/renderers/read.ts"], "const", 136, { limit: 3 }),
  textFixture("grep", { pattern: "preview-no-match", path: "src" }, "No matches found", 32),
  textFixture(
    "grep",
    { pattern: "theme", path: "src/missing" },
    "Path not found: src/missing",
    11,
    { isError: true },
  ),

  // Find: a tree, a result limit, an empty result, and an error.
  textFixture("find", { pattern: "**/*.ts", path: "src" }, paths.join("\n"), 95),
  textFixture(
    "find",
    { pattern: "*.ts", path: "src/renderers", limit: 3 },
    "find.ts\ngrep.ts\nls.ts\n\n[3 results limit reached. Use limit=6 for more, or refine pattern]",
    1_240,
    { details: { resultLimitReached: 3 } },
  ),
  textFixture(
    "find",
    { pattern: "**/preview-no-files.*", path: "src" },
    "No files found matching pattern",
    15,
  ),
  textFixture("find", { pattern: "*.ts", path: "src/missing" }, "Path not found: src/missing", 9, {
    isError: true,
  }),

  // Ls: regular entries, a limit, an empty directory, and an error.
  lsFixture("src", 14),
  lsFixture("src/renderers", 72, 3),
  textFixture("ls", { path: "empty-preview-directory" }, "(empty directory)", 4),
  textFixture(
    "ls",
    { path: "src/missing" },
    "ENOENT: no such file or directory, scandir 'src/missing'",
    7,
    { isError: true },
  ),
  // Shell fixtures are recorded examples; no commands are executed.
  textFixture(
    "bash",
    { command: 'for file in src/*.ts; do\n  echo "Checking $file"\ndone' },
    Array.from({ length: 30 }, (_, index) => `Checking demo/file-${index + 1}.ts`).join("\n") +
      "\n30 files checked\n0 errors",
    86,
  ),
  textFixture(
    "bash",
    { command: "bun run typecheck" },
    "Compiling...\nsrc/index.ts:42:7: error TS2322\n\nCommand exited with code 2",
    2300,
    { isError: true },
  ),
  textFixture(
    "bash",
    { command: "printf 'Starting job\\n'\nsleep 60", timeout: 1 },
    "Starting job\n\nCommand timed out after 1 seconds",
    1_014,
    { isError: true },
  ),
  textFixture(
    "powershell",
    { command: "Get-ChildItem -Recurse |\n  Select-Object Name, Length" },
    shellTruncation.content +
      `\n\n[Showing lines ${shellTruncation.totalLines - shellTruncation.outputLines + 1}-${shellTruncation.totalLines} of ${shellTruncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${shellOutputPath}]`,
    2_340,
    { details: { truncation: { ...shellTruncation }, fullOutputPath: shellOutputPath } },
  ),
  // Write previews use recorded arguments; these files are never written.
  textFixture(
    "write",
    {
      path: "src/preview-config.ts",
      content: Array.from({ length: 24 }, (_, index) =>
        index % 4 === 3 ? "" : `export const option${index + 1} = ${index + 1}`,
      ).join("\n"),
    },
    "Successfully wrote to src/preview-config.ts",
    18,
  ),
  textFixture(
    "write",
    { path: "src/preview-empty.ts", content: "" },
    "Successfully wrote to src/preview-empty.ts",
    12,
  ),
  textFixture(
    "write",
    { path: "/read-only/preview.ts", content: 'export const value = "not written"\n' },
    "EACCES: permission denied, open '/read-only/preview.ts'",
    7,
    { isError: true },
  ),
]

// Native Codemode snapshots, recorded examples only: nested tools are never executed here.
const codemodeFixtures: Fixture[] = []
const codemodeTools = [
  { name: "read", args: { path: "src/config.ts", offset: 1, limit: 12 } },
  { name: "bash", args: { command: "bun run typecheck" } },
  { name: "powershell", args: { command: "Get-ChildItem src" } },
  { name: "grep", args: { pattern: "enabled", path: "src", glob: "*.ts" } },
  { name: "find", args: { pattern: "**/*.ts", path: "src" } },
  { name: "ls", args: { path: "src/renderers" } },
  { name: "write", args: { path: "src/output.ts", content: "export const ready = true\n" } },
  {
    name: "edit",
    args: {
      path: "src/config.ts",
      edits: [{ oldText: "enabled: false", newText: "enabled: true" }],
    },
  },
  { name: "read", args: { path: "src/types.ts" } },
  { name: "read", args: { path: "src/renderers/shared.ts" } },
  { name: "write", args: { path: "src/output.ts", content: "recorded content ".repeat(30) } },
  {
    name: "edit",
    args: {
      path: "src/config.ts",
      edits: [{ oldText: "collapsedLines: 8", newText: "collapsedLines: 12" }],
    },
  },
]
const codemodeCalls: CodemodeToolDetails["calls"] = codemodeTools.map(({ name, args }, index) => {
  const summary = JSON.stringify(args)
  return {
    id: `preview-codemode/${index + 1}`,
    name,
    args: summary.length > 200 ? summary.slice(0, 197) + "..." : summary,
    status: "ok",
    durationMs: 8 + index,
  }
})
for (const example of [
  {
    code: [
      '// @options: {"timeout_ms":60000}',
      ...codemodeTools.map(({ name, args }) => `await tools.${name}(${JSON.stringify(args)})`),
      'text("Tools complete")',
    ].join("\n"),
    calls: codemodeCalls,
    output: "Tools complete",
  },
  {
    code: 'try { await tools.edit({ path: "src/missing.ts", edits: [] }) }\ncatch (error) { text(error.message) }',
    calls: [
      {
        ...codemodeCalls[11]!,
        args: JSON.stringify({ path: "src/missing.ts", edits: [] }),
        status: "error" as const,
        error: "File not found: src/missing.ts",
      },
    ],
    output: "File not found: src/missing.ts",
  },
  { code: "return 42", calls: [], output: "42" },
]) {
  const fixture = textFixture(
    "codemode",
    { code: example.code },
    "Script completed\nWall time 0.1 seconds\nOutput:\n",
    126,
    {
      details: { calls: example.calls.map((call) => ({ ...call })) } satisfies CodemodeToolDetails,
    },
  )
  if (example.output) fixture.result.content.push({ type: "text", text: example.output })
  codemodeFixtures.push(fixture)
}

if (import.meta.main) {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-visuals-preview-"))
  // Preserve real, relative paths for every renderer inside this isolated workspace.
  cpSync(join(root, "src"), join(directory, "src"), { recursive: true })
  const sessionPath = join(directory, "preview.jsonl")
  const session = SessionManager.open(sessionPath, undefined, directory)
  const timestamp = Date.now()
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const recordedFixtures = [...fixtures, ...(await editFixtures(directory)), ...codemodeFixtures]
  const calls: ToolCall[] = recordedFixtures.map((fixture, index) => ({
    type: "toolCall",
    id: `preview-tool-${index + 1}`,
    name: fixture.toolName,
    arguments: fixture.args,
  }))

  session.appendMessage({
    role: "assistant",
    content: calls,
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp,
  })
  for (const [index, fixture] of recordedFixtures.entries()) {
    session.appendMessage({
      role: "toolResult",
      toolCallId: calls[index]!.id,
      toolName: fixture.toolName,
      ...fixture.result,
      timestamp,
    })
  }

  console.log(sessionPath)
}

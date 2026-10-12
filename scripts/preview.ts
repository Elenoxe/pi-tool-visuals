#!/usr/bin/env bun

/** Generate a synthetic Pi session for tool-renderer previews. No tools or models are invoked. */
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0]
type ToolResult = Extract<SessionMessage, { role: "toolResult" }>
type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>

type PreviewCall = {
  toolName: string
  args: ToolCall["arguments"]
  result: Pick<ToolResult, "content" | "details" | "isError">
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))

/** Build a fake Read result from a real file, preserving the exact returned source. */
function readFixture(path: string, options: { offset?: number; limit?: number } = {}): PreviewCall {
  const lines = readFileSync(resolve(root, path), "utf8").split("\n")
  const start = Math.max(0, (options.offset ?? 1) - 1)
  const end = Math.min(lines.length, start + (options.limit ?? lines.length))
  const source = lines.slice(start, end).join("\n")
  const notice =
    end < lines.length
      ? `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`
      : ""

  return {
    toolName: "read",
    args: { path, ...options },
    result: {
      content: [{ type: "text", text: source + notice }],
      details: undefined,
      isError: false,
    },
  }
}

/** Add future Bash/Edit/Write/Codemode fixtures to this array. */
const fixtures: PreviewCall[] = [
  readFixture("src/highlight/engine.ts", { offset: 80, limit: 40 }),
  readFixture("src/resolver.ts"), // entire short file
  {
    toolName: "read",
    args: { path: "src/nonexistent-preview-file.ts" },
    result: {
      content: [
        {
          type: "text",
          text: "ENOENT: no such file or directory, open 'src/nonexistent-preview-file.ts'",
        },
      ],
      details: undefined,
      isError: true,
    },
  },
]

const directory = mkdtempSync(join(tmpdir(), "pi-tool-visuals-preview-"))
const sessionPath = join(directory, "preview.jsonl")

// Set the session's cwd to the repository so file-based highlighting can validate fixture content.
const session = SessionManager.open(sessionPath, undefined, root)
const timestamp = Date.now()
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const calls: ToolCall[] = fixtures.map((fixture, index) => ({
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
for (const [i, fixture] of fixtures.entries()) {
  session.appendMessage({
    role: "toolResult",
    toolCallId: calls[i]!.id,
    toolName: fixture.toolName,
    ...fixture.result,
    timestamp,
  })
}

// The caller decides how and when to open this file. No Pi process is started.
console.log(sessionPath)

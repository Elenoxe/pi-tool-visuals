import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createDefaultConfig,
  loadToolVisualsConfig,
  parseToolVisualsConfig,
  resolveToolConfig,
} from "../src/config.ts"

test("merges partial sections and tool overrides without changing the base", () => {
  const base = createDefaultConfig()
  base.codemode.script.showCollapsed = true
  base.tools = {
    mcp__files__read: { enabled: true, collapsedLines: 14 },
    bash: { enabled: false },
  }
  const original = structuredClone(base)

  const result = parseToolVisualsConfig(
    {
      collapsedLines: 6,
      codemode: {
        script: { showCollapsed: false },
        calls: { collapsedCount: 3 },
        output: { collapsedLines: 2 },
        history: { maxBytes: 1024 },
      },
      tools: { mcp__files__read: { enabled: false } },
    },
    base,
  )

  expect(result.diagnostics).toEqual([])
  expect(result.config).toEqual({
    ...original,
    collapsedLines: 6,
    codemode: {
      script: { ...original.codemode.script, showCollapsed: false },
      calls: { collapsedCount: 3 },
      output: { collapsedLines: 2 },
      history: { maxBytes: 1024 },
    },
    tools: {
      mcp__files__read: { enabled: false, collapsedLines: 14 },
      bash: { enabled: false },
    },
  })
  expect(base).toEqual(original)
})

test("rejects the whole layer when a root, nested, or tool field is unknown", () => {
  const base = createDefaultConfig()
  for (const [invalid, field] of [
    [{ expandedLines: 20 }, "expandedLines"],
    [{ codemode: { script: { unknown: true } } }, "unknown"],
    [{ tools: { custom: { unknown: true } } }, "unknown"],
  ] as const) {
    const result = parseToolVisualsConfig({ enabled: false, collapsedLines: 3, ...invalid }, base)
    expect(result.config).toEqual(base)
    expect(result.diagnostics.some(({ code, message }) => code && message.includes(field))).toBe(
      true,
    )
  }
})

test("resolves tool overrides while keeping the global disable authoritative", () => {
  const config = createDefaultConfig()
  config.collapsedLines = 6
  config.tools = { custom: { enabled: true, collapsedLines: 12 }, bash: { enabled: false } }

  expect(resolveToolConfig(config, "custom")).toEqual({ enabled: true, collapsedLines: 12 })
  expect(resolveToolConfig(config, "unconfigured")).toEqual({ enabled: true, collapsedLines: 6 })
  expect(resolveToolConfig(config, "bash")).toEqual({ enabled: false, collapsedLines: 6 })

  config.enabled = false
  expect(resolveToolConfig(config, "custom")).toEqual({ enabled: false, collapsedLines: 12 })
})

describe("configuration files", () => {
  let directory: string
  let cwd: string
  let globalPath: string
  let projectPath: string
  let originalAgentDir: string | undefined

  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR
    directory = mkdtempSync(join(tmpdir(), "tool-visuals-test-"))
    const agentDir = join(directory, "agent")
    cwd = join(directory, "project")
    mkdirSync(agentDir)
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    globalPath = join(agentDir, "tool-visuals.json")
    projectPath = join(cwd, ".pi", "tool-visuals.json")
    process.env.PI_CODING_AGENT_DIR = agentDir
  })

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    rmSync(directory, { recursive: true, force: true })
  })

  test("loads global then trusted project overrides and ignores an untrusted broken file", () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        collapsedLines: 12,
        tools: { custom: { enabled: false, collapsedLines: 10 } },
      }),
    )
    writeFileSync(projectPath, JSON.stringify({ tools: { custom: { collapsedLines: 4 } } }))

    const trusted = loadToolVisualsConfig({ cwd, projectTrusted: true })
    expect(trusted.diagnostics).toEqual([])
    expect(trusted.config.collapsedLines).toBe(12)
    expect(trusted.config.codemode).toEqual(createDefaultConfig().codemode)
    expect(resolveToolConfig(trusted.config, "custom")).toEqual({
      enabled: false,
      collapsedLines: 4,
    })

    writeFileSync(projectPath, "{")
    const untrusted = loadToolVisualsConfig({ cwd, projectTrusted: false })
    expect(untrusted.diagnostics).toEqual([])
    expect(resolveToolConfig(untrusted.config, "custom")).toEqual({
      enabled: false,
      collapsedLines: 10,
    })
  })

  test("preserves highlight themes for enable-only overrides and replaces theme pairs as a unit", () => {
    const options = { cwd, projectTrusted: true }
    expect(loadToolVisualsConfig(options).config.highlight).toEqual({
      enable: true,
      theme: "auto",
    })

    const theme = { light: "github-light", dark: "catppuccin-mocha" }
    writeFileSync(globalPath, JSON.stringify({ highlight: { theme } }))
    writeFileSync(projectPath, JSON.stringify({ highlight: { enable: false } }))
    expect(loadToolVisualsConfig(options).config.highlight).toEqual({ enable: false, theme })

    const replacement = { light: "min-light", dark: "tokyo-night" }
    for (const selected of [replacement, "tokyo-night", "auto"]) {
      writeFileSync(projectPath, JSON.stringify({ highlight: { theme: selected } }))
      const loaded = loadToolVisualsConfig(options)
      expect(loaded.diagnostics).toEqual([])
      expect(loaded.config.highlight).toEqual({ enable: true, theme: selected })
    }
  })

  test("rejects invalid highlight layers with diagnostics and retains the valid global layer", () => {
    const highlight = { enable: true, theme: "tokyo-night" }
    writeFileSync(globalPath, JSON.stringify({ highlight, collapsedLines: 12 }))
    for (const theme of [
      "not-a-shiki-theme",
      { light: "github-light" },
      { dark: "dark-plus" },
      { light: "github-light", dark: "not-a-shiki-theme" },
    ]) {
      writeFileSync(
        projectPath,
        JSON.stringify({ highlight: { enable: false, theme }, collapsedLines: 3 }),
      )
      const loaded = loadToolVisualsConfig({ cwd, projectTrusted: true })
      expect(loaded.config.highlight).toEqual(highlight)
      expect(loaded.config.collapsedLines).toBe(12)
      expect(loaded.diagnostics.length).toBeGreaterThan(0)
      expect(
        loaded.diagnostics.every(
          ({ message }) => message.includes(projectPath) && message.includes("/highlight/theme"),
        ),
      ).toBe(true)
    }
  })

  test("skips bad layers independently and distinguishes absent, unreadable, and invalid files", () => {
    const options = { cwd, projectTrusted: true }
    const absent = loadToolVisualsConfig(options)
    expect(absent.diagnostics).toEqual([])
    expect(absent.config).toEqual(createDefaultConfig())

    writeFileSync(globalPath, "{")
    writeFileSync(projectPath, JSON.stringify({ collapsedLines: 3 }))
    const badGlobal = loadToolVisualsConfig(options)
    expect(badGlobal.config.collapsedLines).toBe(3)
    expect(badGlobal.diagnostics).toEqual([
      { code: "invalid-json", message: expect.stringContaining(globalPath) },
    ])

    writeFileSync(globalPath, JSON.stringify({ collapsedLines: 12 }))
    writeFileSync(
      projectPath,
      JSON.stringify({ enabled: false, codemode: { calls: { collapsedCount: 0 } } }),
    )
    const badProject = loadToolVisualsConfig(options)
    expect(badProject.config.enabled).toBe(true)
    expect(badProject.config.collapsedLines).toBe(12)
    expect(badProject.diagnostics.length).toBeGreaterThan(0)
    expect(
      badProject.diagnostics.every(({ code, message }) => code && message.includes(projectPath)),
    ).toBe(true)
    expect(badProject.diagnostics.some(({ message }) => message.includes("collapsedCount"))).toBe(
      true,
    )

    rmSync(globalPath)
    mkdirSync(globalPath)
    writeFileSync(projectPath, "{")
    const bothBad = loadToolVisualsConfig(options)
    expect(bothBad.config).toEqual(createDefaultConfig())
    expect(bothBad.diagnostics).toEqual([
      { code: "read-error", message: expect.stringContaining(globalPath) },
      { code: "invalid-json", message: expect.stringContaining(projectPath) },
    ])
  })
})

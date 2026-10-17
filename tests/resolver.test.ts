import { expect, test } from "bun:test"
import type { ToolRenderers } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"

import { createDefaultConfig } from "../src/config.ts"
import { createToolRendererResolver } from "../src/resolver.ts"

const originalCall = () => new Text("original call")
const originalResult = () => new Text("original result")
const enhancedCall = () => new Text("enhanced call")
const downstream: ToolRenderers = {
  renderCall: originalCall,
  renderResult: originalResult,
  renderShell: "self",
}

test("falls back for unsupported, empty, or disabled tools using the current configuration", () => {
  let config = createDefaultConfig()
  const renderers: Record<string, ToolRenderers> = {
    custom: { renderCall: enhancedCall },
    empty: {},
  }
  const resolver = createToolRendererResolver(
    () => config,
    (name) => (Object.hasOwn(renderers, name) ? renderers[name] : undefined),
  )
  const next = () => downstream

  expect(resolver("unsupported", next)).toBe(downstream)
  expect(resolver("empty", next)).toBe(downstream)
  expect(resolver("custom", next)?.renderCall).toBe(enhancedCall)

  config.tools.custom = { enabled: false }
  expect(resolver("custom", next)).toBe(downstream)

  config = { ...createDefaultConfig(), enabled: false, tools: { custom: { enabled: true } } }
  expect(resolver("custom", next)).toBe(downstream)

  config = createDefaultConfig()
  expect(resolver("custom", next)?.renderCall).toBe(enhancedCall)
})

test("preserves uncovered slots and shell settings, including when no downstream exists", () => {
  const config = createDefaultConfig()
  let enhanced: ToolRenderers = { renderCall: enhancedCall, renderResult: undefined }
  const resolver = createToolRendererResolver(
    () => config,
    () => enhanced,
  )

  expect(resolver("custom", () => downstream)).toEqual({
    renderCall: enhancedCall,
    renderResult: originalResult,
    renderShell: "self",
  })

  enhanced = { renderShell: "default" }
  expect(resolver("custom", () => downstream)).toEqual({
    renderCall: originalCall,
    renderResult: originalResult,
    renderShell: "default",
  })

  enhanced = { renderCall: enhancedCall }
  expect(resolver("custom", () => undefined)).toEqual({
    renderCall: enhancedCall,
    renderResult: undefined,
    renderShell: undefined,
  })
})

test("codemode uses root and dedicated enable flags, not tools.codemode", () => {
  const config = createDefaultConfig()
  const resolver = createToolRendererResolver(
    () => config,
    () => ({ renderCall: enhancedCall }),
  )
  config.tools.codemode = { enabled: false }
  expect(resolver("codemode", () => downstream)?.renderCall).toBe(enhancedCall)
  config.codemode.enabled = false
  config.tools.codemode.enabled = true
  expect(resolver("codemode", () => downstream)).toBe(downstream)
  config.codemode.enabled = true
  config.enabled = false
  expect(resolver("codemode", () => downstream)).toBe(downstream)
})

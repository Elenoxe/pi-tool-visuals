import { expect, test } from "bun:test"
import { BoundedLru, ansiKey } from "../../src/highlight/cache.ts"

test("LRU touches reads, reaccounts mutations, evicts by count and characters, and clears", () => {
  const evicted: string[] = []
  const cache = new BoundedLru<string>(2, 10, (value) => evicted.push(value))
  cache.set("a", "a", 3)
  cache.set("b", "b", 3)
  expect(cache.get("a")).toBe("a")
  cache.set("c", "c", 3)
  expect(evicted).toEqual(["b"])
  cache.set("a", "a", 8)
  expect(cache.peek("c")).toBeUndefined()
  expect(cache.characters).toBe(8)
  expect(cache.set("huge", "huge", 11)).toBe(false)
  cache.clear()
  expect(cache.size).toBe(0)
  expect(cache.characters).toBe(0)
})

test("ANSI identity is unambiguous including source and terminal mode", () => {
  expect(ansiKey("a", 'b","c')).not.toBe(ansiKey('a","b', "c"))
  expect(ansiKey("typescript:dark-plus:truecolor", "x")).not.toBe(
    ansiKey("typescript:dark-plus:256", "x"),
  )
})

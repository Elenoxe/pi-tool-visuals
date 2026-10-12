import { expect, mock, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { HighlightScheduler, type SliceTask } from "../../src/highlight/scheduler.ts"

test("foreground first, same-level round robin, one slice per turn, and deduplication", async () => {
  const scheduler = new HighlightScheduler()
  const order: string[] = []
  const task = (id: string, rounds: number, priority: "visible" | "background"): SliceTask => ({
    id,
    valid: () => true,
    run() {
      order.push(id)
      if (--rounds) scheduler.schedule(this, priority)
    },
  })
  try {
    scheduler.schedule(task("bg", 2, "background"), "background")
    const a = task("a", 3, "visible")
    scheduler.schedule(a, "visible")
    scheduler.schedule(a, "visible")
    scheduler.schedule(task("b", 2, "visible"), "visible")
    expect(scheduler.pending).toBe(3)
    await nextTurn()
    expect(order).toEqual(["a"])
    for (let i = 0; i < 10; i++) await nextTurn()
    expect(order).toEqual(["a", "b", "a", "b", "a", "bg", "bg"])
  } finally {
    scheduler.dispose()
  }
})

test("promotion, generation invalidation, cancellation, and disposal stop obsolete tasks", async () => {
  const scheduler = new HighlightScheduler()
  const run = mock(() => {})
  let generation = 1
  const task = { id: "a", valid: () => generation === 1, run }
  scheduler.schedule(task, "background")
  scheduler.schedule(task, "visible")
  expect(scheduler.pending).toBe(1)
  generation++
  await nextTurn()
  expect(run).not.toHaveBeenCalled()
  scheduler.schedule({ ...task, valid: () => true }, "visible")
  scheduler.cancel("a")
  await nextTurn()
  expect(run).not.toHaveBeenCalled()
  scheduler.schedule({ ...task, valid: () => true }, "visible")
  scheduler.dispose()
  await nextTurn()
  expect(run).not.toHaveBeenCalled()
})

test("notifications batch latest callbacks, coalesce shared invalidators, isolate errors and allow reentrant cancellation", async () => {
  const scheduler = new HighlightScheduler()
  const old = mock(() => {})
  const fresh = mock(() => {})
  const error = mock((_error: Error) => {})
  const note = (callback: () => void) => ({
    scope: "doc",
    callback,
    valid: () => true,
    onError: error,
  })
  scheduler.notify("call:call", note(old))
  scheduler.notify("call:call", note(fresh))
  scheduler.notify("call:result", note(fresh))
  scheduler.notify("hidden", { ...note(old), valid: () => false })
  await nextTurn()
  expect(old).not.toHaveBeenCalled()
  expect(fresh).toHaveBeenCalledTimes(1)
  scheduler.notify(
    "throw",
    note(() => {
      throw new Error("redraw")
    }),
  )
  scheduler.notify(
    "cancel",
    note(() => scheduler.cancelNotification("later")),
  )
  scheduler.notify("later", note(old))
  await nextTurn()
  expect(error).toHaveBeenCalledTimes(1)
  expect(old).not.toHaveBeenCalled()
  scheduler.notify("shutdown", note(old))
  scheduler.dispose()
  await nextTurn()
  expect(old).not.toHaveBeenCalled()
})

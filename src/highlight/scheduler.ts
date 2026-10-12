export type HighlightPriority = "visible" | "background"

export interface SliceTask {
  id: string
  valid: () => boolean
  run: () => void
}

interface Notification {
  scope: string
  valid: () => boolean
  callback: () => void
  onError: (error: Error) => void
}

/** One synchronous slice per turn. Map order gives round-robin within each priority. */
export class HighlightScheduler {
  private visible = new Map<string, SliceTask>()
  private background = new Map<string, SliceTask>()
  private notifications = new Map<string, Notification>()
  private tick?: ReturnType<typeof setImmediate>
  private redraw?: ReturnType<typeof setImmediate>

  schedule(task: SliceTask, priority: HighlightPriority): void {
    const queue = priority === "visible" ? this.visible : this.background
    const other = priority === "visible" ? this.background : this.visible
    other.delete(task.id)
    queue.set(task.id, task)
    this.wake()
  }

  cancel(id: string): void {
    this.visible.delete(id)
    this.background.delete(id)
    if (!this.visible.size && !this.background.size && this.tick) {
      clearImmediate(this.tick)
      this.tick = undefined
    }
  }

  cancelScope(id: string): void {
    this.cancel(id)
    for (const [key, notification] of this.notifications) {
      if (notification.scope === id) this.notifications.delete(key)
    }
  }

  notify(id: string, notification: Notification): void {
    this.notifications.set(id, notification)
    if (this.redraw) return
    this.redraw = setImmediate(() => {
      this.redraw = undefined
      const pending = [...this.notifications.entries()]
      const invoked = new Set<() => void>()
      for (const [id, item] of pending) {
        if (this.notifications.get(id) !== item) continue
        this.notifications.delete(id)
        if (!item.valid() || invoked.has(item.callback)) continue
        invoked.add(item.callback)
        try {
          item.callback()
        } catch (cause) {
          item.onError(new Error(`Highlight invalidation failed: ${String(cause)}`, { cause }))
        }
      }
    })
  }

  cancelNotification(id: string): void {
    this.notifications.delete(id)
  }

  private wake(): void {
    if (this.tick) return
    this.tick = setImmediate(() => {
      this.tick = undefined
      const queue = this.visible.size ? this.visible : this.background
      const first = queue.entries().next().value
      if (first) {
        const [id, task] = first
        queue.delete(id)
        if (task.valid()) task.run()
      }
      if (this.visible.size || this.background.size) this.wake()
    })
  }

  dispose(): void {
    if (this.tick) clearImmediate(this.tick)
    if (this.redraw) clearImmediate(this.redraw)
    this.tick = this.redraw = undefined
    this.visible.clear()
    this.background.clear()
    this.notifications.clear()
  }

  get pending(): number {
    return this.visible.size + this.background.size
  }
}

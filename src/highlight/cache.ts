/** Character budgets count UTF-16 code units, not heap bytes. */
export const HIGHLIGHT_LIMITS = {
  ansiEntries: 128,
  ansiCharacters: 4_000_000,
  documents: 24,
  documentCharacters: 8_000_000,
  syncLines: 96,
  syncCharacters: 16_000,
  syncLineCharacters: 2_000,
  sliceLines: 96,
  sliceCharacters: 16_000,
  maxLineLength: 16_000,
  colorEntries: 4096,
  colorCharacters: 131_072,
} as const

/** Map insertion order supplies LRU order; replacements re-account mutable values. */
export class BoundedLru<T> {
  private entries = new Map<string, { value: T; characters: number }>()
  characters = 0
  hits = 0
  misses = 0

  constructor(
    private maxEntries: number,
    private maxCharacters: number,
    private onEvict?: (value: T, key: string) => void,
  ) {}

  get size(): number {
    return this.entries.size
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    this.hits++
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  set(key: string, value: T, characters: number): boolean {
    const old = this.entries.get(key)
    if (old) {
      this.entries.delete(key)
      this.characters -= old.characters
      if (old.value !== value) this.onEvict?.(old.value, key)
    }
    if (characters > this.maxCharacters) {
      this.onEvict?.(value, key)
      return false
    }
    this.entries.set(key, { value, characters })
    this.characters += characters
    while (this.size > this.maxEntries || this.characters > this.maxCharacters) {
      this.delete(this.entries.keys().next().value!)
    }
    return this.entries.has(key)
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.characters -= entry.characters
    this.onEvict?.(entry.value, key)
  }

  clear(): void {
    for (const key of this.entries.keys()) this.delete(key)
    this.hits = this.misses = 0
  }
}

export const ansiCache = new BoundedLru<readonly string[]>(
  HIGHLIGHT_LIMITS.ansiEntries,
  HIGHLIGHT_LIMITS.ansiCharacters,
)

/** Full source in an unambiguous tuple avoids hashing and collision handling. */
export function ansiKey(identity: string, source: string): string {
  return JSON.stringify([identity, source])
}

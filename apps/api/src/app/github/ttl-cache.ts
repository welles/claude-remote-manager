/**
 * A small cache of promises with a time to live: concurrent callers of the
 * same key share one request, failures are not kept, and the oldest
 * entries are dropped beyond `maxEntries`.
 */
export class TtlCache<T> {
  private readonly entries = new Map<
    string,
    { at: number; value: Promise<T> }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) {
      return cached.value;
    }
    const value = load();
    const entry = { at: this.now(), value };
    this.entries.delete(key);
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

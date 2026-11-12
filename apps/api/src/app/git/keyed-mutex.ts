/**
 * Runs tasks with the same key one after another, in call order; tasks with
 * different keys run concurrently. In-process only.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, number>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
    try {
      await previous;
      return await task();
    } finally {
      release();
      const count = (this.holders.get(key) ?? 1) - 1;
      if (count === 0) {
        this.holders.delete(key);
      } else {
        this.holders.set(key, count);
      }
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Whether a task with this key is running or waiting. */
  isBusy(key: string): boolean {
    return this.holders.has(key);
  }
}

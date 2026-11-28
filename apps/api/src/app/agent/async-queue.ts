/**
 * An async iterable fed by `push`: consumers wait for the next item until
 * the queue is closed. Used as the streaming input of a Claude Code process.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiting: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed) {
      throw new Error('Queue is closed');
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /**
   * Ends the queue with an error: consumers get the queued items, then the
   * error.
   */
  fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.closed = true;
    // Consumers already waiting get the error too, not a clean end.
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(error);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return this.failure
            ? Promise.reject(this.failure)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) =>
          this.waiting.push({ resolve, reject }),
        );
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

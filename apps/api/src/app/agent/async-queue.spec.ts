import { AsyncQueue } from './async-queue';

describe('AsyncQueue', () => {
  it('hands queued items out before the error it failed with', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    queue.fail(new Error('gone'));
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).rejects.toThrow('gone');
  });

  it('gives a consumer that already waits the error, not a clean end', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.fail(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
  });

  it('ends waiting consumers when closed, and ignores a later failure', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.close();
    queue.fail(new Error('late'));
    await expect(waiting).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});

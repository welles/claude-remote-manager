import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('KeyedMutex', () => {
  it('runs tasks with the same key one after another, in call order', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = mutex.run('a', async () => {
      log.push('first start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      log.push('first end');
    });
    const second = mutex.run('a', async () => {
      log.push('second');
    });
    await tick();
    expect(log).toEqual(['first start']);
    expect(mutex.isBusy('a')).toBe(true);

    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(['first start', 'first end', 'second']);
    expect(mutex.isBusy('a')).toBe(false);
  });

  it('does not block tasks with other keys', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const blocked = mutex.run(
      'a',
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await expect(mutex.run('b', async () => 'b done')).resolves.toBe('b done');
    release();
    await blocked;
  });

  it('continues after a failing task', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.run('a', async () => 1)).resolves.toBe(1);
    expect(mutex.isBusy('a')).toBe(false);
  });
});

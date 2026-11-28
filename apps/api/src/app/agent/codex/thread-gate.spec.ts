import { ThreadGate } from './codex-runner';

describe('ThreadGate', () => {
  it('runs the tasks of a thread one after the other, others alongside', async () => {
    const gate = new ThreadGate();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = gate.run('t1', async () => {
      order.push('read:start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('read:end');
    });
    const other = gate.run('t2', async () => {
      order.push('other');
    });
    const second = gate.run('t1', async () => {
      order.push('start');
    });
    await other;
    expect(order).toEqual(['read:start', 'other']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['read:start', 'other', 'read:end', 'start']);
  });

  it('goes on after a failed task', async () => {
    const gate = new ThreadGate();
    await expect(
      gate.run('t', async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await expect(gate.run('t', async () => 'ok')).resolves.toBe('ok');
  });
});

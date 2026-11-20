import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SINGLE_USER } from '../common/process-isolation';
import * as ownership from '../common/ownership';
import type { ProcessLauncher } from '../common/process-isolation';
import { EnvironmentFiles, type WrittenFiles } from './environment-files';

describe('EnvironmentFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-env-files-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes private files per process and removes them', async () => {
    const files = new EnvironmentFiles(join(dir, 'root'), SINGLE_USER);
    expect(await files.write('s1', [])).toBeNull();
    const written = await files.write('s1', [
      {
        variable: 'KUBECONFIG',
        fileName: 'kubeconfig',
        content: 'apiVersion: v1',
      },
    ]);
    expect(written).not.toBeNull();
    const path = written?.env['KUBECONFIG'] as string;
    expect(readFileSync(path, 'utf8')).toBe('apiVersion: v1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(written?.dir as string).mode & 0o777).toBe(0o700);
    await files.remove(written as WrittenFiles);
    expect(existsSync(written?.dir as string)).toBe(false);
    expect(existsSync(path)).toBe(false);
    await files.write('s2', [{ variable: 'A', fileName: 'a', content: 'x' }]);
    await files.clear();
    expect(existsSync(join(dir, 'root'))).toBe(false);
  });

  it("hands only the files to the session user, the directories stay the API's", async () => {
    const handOver = jest
      .spyOn(ownership, 'handOverToSession')
      .mockResolvedValue(undefined);
    const separated = {
      separated: true,
      sessionUser: {
        name: 'claude',
        uid: 1001,
        gid: 1001,
        home: '/home/claude',
      },
    } as unknown as ProcessLauncher;
    const root = join(dir, 'root');
    const files = new EnvironmentFiles(root, separated);
    const written = (await files.write('s1', [
      { variable: 'A', fileName: 'a.json', content: '{}' },
      { variable: 'B', fileName: 'b', content: 'x' },
    ])) as WrittenFiles;
    expect(handOver.mock.calls.map(([path]) => path)).toEqual(written.paths);
    // The session user passes through but cannot list or add entries.
    expect(statSync(root).mode & 0o777).toBe(0o711);
    expect(statSync(written.dir).mode & 0o777).toBe(0o711);
    expect(statSync(written.dir).uid).toBe(process.getuid?.());
    await files.remove(written);
    expect(existsSync(written.dir)).toBe(false);
    handOver.mockRestore();
  });
});

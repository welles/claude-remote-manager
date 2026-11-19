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
import { EnvironmentFiles } from './environment-files';

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
    await files.remove(written?.dir as string);
    expect(existsSync(path)).toBe(false);
    await files.write('s2', [{ variable: 'A', fileName: 'a', content: 'x' }]);
    await files.clear();
    expect(existsSync(join(dir, 'root'))).toBe(false);
  });
});

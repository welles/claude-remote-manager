import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShownFileDto } from '@claude-remote-manager/shared-types';
import { pngImage } from '../attachments/testing/images';
import { testAppConfig } from '../config/app-config';
import { openDatabase, type AppDatabase } from '../db/database';
import {
  FileAccessError,
  SessionFileAccess,
} from '../files/session-file-access';
import { SessionRepository } from '../sessions/session.repository';
import { classifyFile } from './file-kind';
import { ShownFilesService, type FileShown } from './shown-files.service';

describe('ShownFilesService', () => {
  let dir: string;
  let scratch: string;
  let db: AppDatabase;
  let service: ShownFilesService;
  let shown: FileShown[];
  const snapshots = () => readdirSync(join(dir, 'files', 'shown'));
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (error) {
      return error instanceof FileAccessError ? error.code : String(error);
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crm-shown-'));
    scratch = join(dir, 'scratch', 's1');
    mkdirSync(join(scratch, 'out'), { recursive: true });
    db = openDatabase(':memory:');
    const sessions = new SessionRepository(db);
    sessions.create({
      id: 's1',
      title: null,
      model: null,
      permissionMode: 'default',
      status: 'running',
      slug: 's1',
      pendingMessage: null,
      directories: [
        {
          path: scratch,
          kind: 'scratch',
          repositoryId: null,
          branch: null,
          baseBranch: null,
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    service = new ShownFilesService(
      testAppConfig(dir),
      db,
      sessions,
      new SessionFileAccess(),
    );
    await service.onModuleInit();
    shown = [];
    service.shown$.subscribe((event) => shown.push(event));
  });

  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps what the file contained when it was shown', async () => {
    writeFileSync(join(scratch, 'out', 'report.md'), '# Report\n');
    const file = await service.show(
      's1',
      'tu-1',
      'out/report.md',
      '  The report  ',
      'show_file',
    );
    expect(file).toMatchObject<Partial<ShownFileDto>>({
      origin: 'show_file',
      path: join(scratch, 'out', 'report.md'),
      name: 'report.md',
      caption: 'The report',
      kind: 'markdown',
      mediaType: 'text/plain; charset=utf-8',
      language: 'markdown',
      size: 9,
      snapshot: true,
    });
    expect(shown).toEqual([{ sessionId: 's1', toolUseId: 'tu-1', file }]);
    writeFileSync(join(scratch, 'out', 'report.md'), 'changed');
    const { path } = service.snapshotPath(file.id);
    expect(readFileSync(path as string, 'utf8')).toBe('# Report\n');
    expect(statSync(path as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'files', 'shown')).mode & 0o777).toBe(0o700);
    expect(service.forSession('s1')).toEqual([file]);
  });

  it('keeps only the metadata of files above the limit', async () => {
    service.maxSnapshotBytes = 10;
    writeFileSync(join(scratch, 'big.log'), 'x'.repeat(50));
    const file = await service.show('s1', null, 'big.log', null, 'show_file');
    expect(file).toMatchObject({ snapshot: false, size: 50, kind: 'text' });
    expect(service.snapshotPath(file.id).path).toBeNull();
    expect(snapshots()).toEqual([]);
    expect(service.liveRoots(file.id).roots).toEqual([scratch]);
  });

  it('refuses files outside the session’s directories and special files', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    symlinkSync(join(dir, 'secret.txt'), join(scratch, 'link.txt'));
    symlinkSync(dir, join(scratch, 'up'));
    execFileSync('mkfifo', [join(scratch, 'fifo')]);
    const show = (path: string) =>
      code(service.show('s1', null, path, null, 'show_file'));
    expect(await show('link.txt')).toBe('outside');
    expect(await show('up/secret.txt')).toBe('outside');
    expect(await show('../../secret.txt')).toBe('outside');
    expect(await show(join(dir, 'secret.txt'))).toBe('outside');
    expect(await show('/etc/passwd')).toBe('outside');
    expect(await show('fifo')).toBe('not_regular');
    expect(await show('out')).toBe('not_regular');
    expect(await show('missing.png')).toBe('not_found');
    expect(shown).toEqual([]);
    expect(snapshots()).toEqual([]);
  });

  it('keeps images Claude read from their content', async () => {
    const file = await service.fromData(
      's1',
      'tu-2',
      join(scratch, 'shot.png'),
      pngImage(),
      'read',
    );
    expect(file).toMatchObject({
      origin: 'read',
      kind: 'image',
      mediaType: 'image/png',
      snapshot: true,
    });
    expect(readFileSync(service.snapshotPath(file.id).path as string)).toEqual(
      pngImage(),
    );
  });

  it('removes a session’s snapshots and stray files', async () => {
    writeFileSync(join(scratch, 'a.txt'), 'a');
    const file = await service.show('s1', null, 'a.txt', null, 'show_file');
    writeFileSync(join(dir, 'files', 'shown', 'stray'), 'x');
    await service.sweep();
    expect(snapshots()).toEqual([file.id]);
    await service.removeSession('s1');
    expect(snapshots()).toEqual([]);
    expect(() => service.get(file.id)).toThrow('No such file');
  });
});

describe('classifyFile', () => {
  const kind = (name: string, data: Buffer | string) =>
    classifyFile(name, Buffer.from(data), true);

  it('tells the viewer how to show a file', () => {
    expect(kind('a.png', pngImage())).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      language: null,
    });
    // Content wins over the name.
    expect(kind('photo.txt', pngImage()).kind).toBe('image');
    expect(kind('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual({
      kind: 'image',
      mediaType: 'image/svg+xml',
      language: 'xml',
    });
    expect(kind('doc.pdf', '%PDF-1.7\n...')).toMatchObject({
      kind: 'pdf',
      mediaType: 'application/pdf',
    });
    expect(kind('index.html', '<h1>Hi</h1>')).toMatchObject({
      kind: 'html',
      mediaType: 'text/html; charset=utf-8',
    });
    expect(kind('main.ts', 'const a = 1;')).toEqual({
      kind: 'text',
      mediaType: 'text/plain; charset=utf-8',
      language: 'typescript',
    });
    expect(kind('LICENSE', 'MIT')).toMatchObject({
      kind: 'text',
      language: null,
    });
    expect(kind('data.bin', Buffer.from([0, 1, 2]))).toMatchObject({
      kind: 'binary',
      mediaType: 'application/octet-stream',
    });
    expect(kind('latin1.txt', Buffer.from([0x66, 0xe9, 0x65])).kind).toBe(
      'binary',
    );
    // A cut file may end inside a character.
    expect(
      classifyFile('cut.txt', Buffer.from('aé').subarray(0, 2), false).kind,
    ).toBe('text');
  });
});

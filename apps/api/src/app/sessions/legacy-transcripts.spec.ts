import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_MARKER, migrateLegacyTranscripts } from './legacy-transcripts';

describe('migrateLegacyTranscripts', () => {
  let dir: string;
  let legacy: string;
  let target: string;
  let memory: string;
  const project = '-var-lib-crm-workspace-sessions-fix-acme-app';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crm-legacy-'));
    legacy = join(dir, 'data', 'claude');
    target = join(dir, 'home', '.claude');
    memory = join(dir, 'data', 'memory');
    await mkdir(join(legacy, 'projects', project, 'old-session'), {
      recursive: true,
    });
    await writeFile(join(legacy, 'projects', project, 'old.jsonl'), 'old\n');
    await writeFile(
      join(legacy, 'projects', project, 'old-session', 'agent.jsonl'),
      'sub\n',
    );
    await writeFile(
      join(legacy, 'projects', project, 'both.jsonl'),
      'legacy\n',
    );
    await mkdir(join(legacy, 'repository-memory', 'repo-1'), {
      recursive: true,
    });
    await writeFile(
      join(legacy, 'repository-memory', 'repo-1', 'MEMORY.md'),
      'remember\n',
    );
    await mkdir(join(target, 'projects', project), { recursive: true });
    await writeFile(join(target, 'projects', project, 'both.jsonl'), 'new\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('copies missing transcripts once, never overwrites, and moves the memory', async () => {
    expect(await migrateLegacyTranscripts(legacy, target, memory)).toEqual({
      copied: 2,
      skipped: 1,
      memoryMoved: true,
    });
    const projectDir = join(target, 'projects', project);
    expect(await readFile(join(projectDir, 'old.jsonl'), 'utf8')).toBe('old\n');
    expect(
      await readFile(join(projectDir, 'old-session', 'agent.jsonl'), 'utf8'),
    ).toBe('sub\n');
    expect(await readFile(join(projectDir, 'both.jsonl'), 'utf8')).toBe(
      'new\n',
    );
    expect(await readFile(join(memory, 'repo-1', 'MEMORY.md'), 'utf8')).toBe(
      'remember\n',
    );
    // The old transcripts stay; a marker keeps this from running again.
    await stat(join(legacy, 'projects', project, 'old.jsonl'));
    expect(await readFile(join(legacy, LEGACY_MARKER), 'utf8')).toContain(
      target,
    );
    await rm(join(projectDir, 'old.jsonl'));
    expect(await migrateLegacyTranscripts(legacy, target, memory)).toBeNull();
    await expect(stat(join(projectDir, 'old.jsonl'))).rejects.toThrow();
  });

  it('does nothing without an old directory, and keeps an existing memory directory', async () => {
    expect(
      await migrateLegacyTranscripts(join(dir, 'none'), target, memory),
    ).toBeNull();
    await mkdir(memory, { recursive: true });
    expect(
      await migrateLegacyTranscripts(legacy, target, memory),
    ).toMatchObject({ memoryMoved: false });
    await stat(join(legacy, 'repository-memory', 'repo-1', 'MEMORY.md'));
  });
});

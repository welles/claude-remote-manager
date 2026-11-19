import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { openDatabase, type AppDatabase } from '../db/database';
import { environmentEntries, sessions } from '../db/schema';
import { EnvironmentsService } from './environments.service';
import { SecretCipher } from './secret-cipher';

describe('EnvironmentsService', () => {
  let db: AppDatabase;
  let dir: string;
  let service: EnvironmentsService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'crm-environments-'));
    service = new EnvironmentsService(
      db,
      new SecretCipher(join(dir, 'key'), undefined),
    );
  });
  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const addSession = (environmentId: string, archived = false) => {
    const id = randomUUID();
    db.insert(sessions)
      .values({
        id,
        title: `Session ${id.slice(0, 4)}`,
        status: 'finished',
        updatedAt: new Date(),
        environmentId,
        archivedAt: archived ? new Date() : null,
      })
      .run();
    return id;
  };

  it('stores secrets encrypted and never returns them', () => {
    const created = service.create({
      name: ' Stripe ',
      instructions: 'Use the test mode.',
      variables: [
        { name: 'STRIPE_KEY', secret: true, value: 'sk_test_123456' },
        { name: 'API_BASE_URL', secret: false, value: 'https://api.test' },
      ],
      files: [
        {
          variable: 'GOOGLE_APPLICATION_CREDENTIALS',
          fileName: 'credentials.json',
          secret: true,
          content: '{"private_key":"PRIVATEKEY"}',
        },
      ],
    });
    expect(created.name).toBe('Stripe');
    expect(created.variables).toEqual([
      expect.objectContaining({
        name: 'STRIPE_KEY',
        secret: true,
        value: null,
        length: 14,
      }),
      expect.objectContaining({
        name: 'API_BASE_URL',
        value: 'https://api.test',
      }),
    ]);
    expect(created.files[0]).toEqual(
      expect.objectContaining({ content: null, fileName: 'credentials.json' }),
    );
    expect(JSON.stringify(service.list())).not.toContain('sk_test_123456');
    const rows = db.select().from(environmentEntries).all();
    expect(JSON.stringify(rows)).not.toContain('sk_test_123456');
    expect(JSON.stringify(rows)).not.toContain('PRIVATEKEY');

    const launch = service.forLaunch(created.id);
    expect(launch?.variables).toEqual({
      STRIPE_KEY: 'sk_test_123456',
      API_BASE_URL: 'https://api.test',
    });
    expect(launch?.files).toEqual([
      {
        variable: 'GOOGLE_APPLICATION_CREDENTIALS',
        fileName: 'credentials.json',
        content: '{"private_key":"PRIVATEKEY"}',
      },
    ]);
    const mask = service.masker(created.id);
    expect(mask('key sk_test_123456 at https://api.test')).toBe(
      'key *** at https://api.test',
    );
  });

  it('keeps a secret without new value, also when renamed', () => {
    const created = service.create({
      name: 'A',
      variables: [{ name: 'TOKEN', secret: true, value: 'secret-value' }],
    });
    const id = created.variables[0].id;
    const updated = service.update(created.id, {
      name: 'A',
      variables: [{ id, name: 'NEW_TOKEN', secret: true }],
    });
    expect(updated.variables[0].id).toBe(id);
    expect(service.forLaunch(created.id)?.variables).toEqual({
      NEW_TOKEN: 'secret-value',
    });
    // Turning the switch off never reveals the stored value.
    expect(() =>
      service.update(created.id, {
        name: 'A',
        variables: [{ id, name: 'NEW_TOKEN', secret: false }],
      }),
    ).toThrow('enter its value again');
    // A new secret needs a value.
    expect(() =>
      service.update(created.id, {
        name: 'A',
        variables: [{ name: 'OTHER', secret: true }],
      }),
    ).toThrow(BadRequestException);
    // Left out: deleted.
    expect(service.update(created.id, { name: 'A' }).variables).toEqual([]);
  });

  it('rejects reserved, invalid and duplicate names', () => {
    for (const name of [
      'PATH',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CRM_X',
      '1A',
      'A-B',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      expect(() =>
        service.create({
          name: 'X',
          variables: [{ name, secret: false, value: 'v' }],
        }),
      ).toThrow(BadRequestException);
    }
    expect(() =>
      service.create({
        name: 'X',
        variables: [{ name: 'A', secret: false, value: 'v' }],
        files: [{ variable: 'A', fileName: 'a', secret: false, content: 'x' }],
      }),
    ).toThrow('more than once');
    expect(() =>
      service.create({
        name: 'X',
        files: [
          { variable: 'A', fileName: '../a', secret: false, content: 'x' },
        ],
      }),
    ).toThrow(BadRequestException);
    service.create({ name: 'X' });
    expect(() => service.create({ name: 'X' })).toThrow(ConflictException);
  });

  it('rejects an entry ID given twice', () => {
    const created = service.create({
      name: 'A',
      variables: [{ name: 'TOKEN', secret: true, value: 'secret-value' }],
    });
    const id = created.variables[0].id;
    expect(() =>
      service.update(created.id, {
        name: 'A',
        variables: [
          { id, name: 'ONE', secret: true },
          { id, name: 'TWO', secret: true },
        ],
      }),
    ).toThrow(BadRequestException);
  });

  it('has at most one default', () => {
    const a = service.create({ name: 'A', isDefault: true });
    const b = service.create({ name: 'B', isDefault: true });
    expect(service.get(a.id).isDefault).toBe(false);
    expect(service.get(b.id).isDefault).toBe(true);
    // Unchanged when left out.
    expect(service.update(b.id, { name: 'B2' }).isDefault).toBe(true);
  });

  it('checks preset repositories', () => {
    expect(() =>
      service.create({
        name: 'A',
        repositories: [{ repositoryId: randomUUID() }],
      }),
    ).toThrow('not found');
  });

  it('is deleted only when no session uses it, archived ones included', () => {
    const environment = service.create({ name: 'A' });
    const active = addSession(environment.id);
    const archived = addSession(environment.id, true);
    expect(service.get(environment.id).sessions).toHaveLength(2);
    expect(() => service.remove(environment.id)).toThrow(ConflictException);
    db.update(sessions)
      .set({ archivedAt: new Date() })
      .where(eq(sessions.id, active))
      .run();
    // Archived sessions keep it too: their history holds the secrets.
    expect(() => service.remove(environment.id)).toThrow('(archived)');
    db.delete(sessions).where(eq(sessions.id, active)).run();
    db.delete(sessions).where(eq(sessions.id, archived)).run();
    service.remove(environment.id);
    expect(service.list()).toEqual([]);
  });

  it('checks the environment of a new session', () => {
    expect(service.requireForSession(undefined)).toBeNull();
    expect(() => service.requireForSession('x')).toThrow(BadRequestException);
    expect(() => service.requireForSession(randomUUID())).toThrow('not found');
    const environment = service.create({ name: 'A', setupScript: 'echo hi' });
    expect(service.requireForSession(environment.id)?.setupScript).toBe(
      'echo hi',
    );
    expect(service.summary(environment.id)).toEqual({
      id: environment.id,
      name: 'A',
    });
  });
});

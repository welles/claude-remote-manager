import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '@claude-remote-manager/shared-types';
import { testAppConfig } from '../config/app-config';
import { openDatabase, type AppDatabase } from '../db/database';
import { SessionRepository } from '../sessions/session.repository';
import { AttachmentStore, UNCLAIMED_TTL_MS } from './attachment.store';
import { sniffImageType } from './image-type';
import { JPEG_HEAD, pngImage } from './testing/images';

describe('AttachmentStore', () => {
  let dir: string;
  let db: AppDatabase;
  let store: AttachmentStore;
  const files = () => readdirSync(join(dir, 'files', 'attachments'));

  const session = (id: string) =>
    new SessionRepository(db).create({
      id,
      title: null,
      model: null,
      permissionMode: 'default',
      status: 'waiting',
      slug: id,
      pendingMessage: null,
      directories: [
        {
          path: join(dir, id),
          kind: 'scratch',
          repositoryId: null,
          branch: null,
          baseBranch: null,
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crm-attachments-'));
    db = openDatabase(':memory:');
    store = new AttachmentStore(testAppConfig(dir), db);
    await store.onModuleInit();
    session('s1');
    session('s2');
  });

  afterEach(() => {
    store.onModuleDestroy();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('recognizes image types by their content', () => {
    expect(sniffImageType(pngImage())).toBe('image/png');
    expect(sniffImageType(JPEG_HEAD)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(
      'image/webp',
    );
    expect(sniffImageType(Buffer.from('<svg xmlns="..."/>'))).toBeNull();
  });

  it('stores checked images privately', async () => {
    const image = pngImage();
    const attachment = await store.create(
      image,
      'image/png',
      'dir/../shot\n.png',
    );
    expect(attachment).toEqual({
      id: expect.any(String),
      name: 'shot.png',
      mediaType: 'image/png',
      size: image.length,
    });
    const path = join(dir, 'files', 'attachments', attachment.id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'files', 'attachments')).mode & 0o777).toBe(
      0o700,
    );

    for (const [data, type, message] of [
      [image, 'image/jpeg', 'not a JPEG image'],
      [Buffer.from('<svg/>'), 'image/svg+xml', 'Only image/png'],
      [Buffer.alloc(0), 'image/png', 'empty'],
      [
        Buffer.concat([image, Buffer.alloc(MAX_ATTACHMENT_BYTES)]),
        'image/png',
        'larger than 5 MB',
      ],
    ] as const) {
      await expect(store.create(data, type, null)).rejects.toThrow(message);
    }
    expect(files()).toEqual([attachment.id]);
  });

  it('gives uploads to one message for good', async () => {
    const a = await store.create(pngImage(), 'image/png', 'a.png');
    const b = await store.create(pngImage(2, 2), 'image/png', null);
    expect(() => store.check([a.id, b.id])).not.toThrow();
    expect(store.claim([b.id, a.id], 's1', 'm1')).toEqual([b, a]);
    // A repeated send of the same message is fine, another message is not.
    expect(store.claim([b.id, a.id], 's1', 'm1')).toEqual([b, a]);
    expect(() => store.claim([a.id], 's1', 'm2')).toThrow('another message');
    expect(() => store.claim([a.id], 's2', 'm1')).toThrow('another message');
    expect(() => store.check([a.id])).toThrow('another message');
    expect(() => store.claim(['not-an-id'], 's1', 'm3')).toThrow('distinct');
    expect(() => store.claim([a.id, a.id], 's1', 'm3')).toThrow('distinct');
    expect(store.forMessage('s1', 'm1')).toEqual([b, a]);
    expect(store.forSession('s1')).toEqual(new Map([['m1', [b, a]]]));
    expect(await store.agentImages('s1', 'm1')).toEqual([
      { mediaType: 'image/png', data: pngImage(2, 2).toString('base64') },
      { mediaType: 'image/png', data: pngImage().toString('base64') },
    ]);
    expect(store.content(a.id)).toEqual({
      path: join(dir, 'files', 'attachments', a.id),
      attachment: a,
    });
    expect(() => store.content('../../etc/passwd')).toThrow('No such');
  });

  it('removes a session’s images, stale uploads and stray files', async () => {
    const kept = await store.create(pngImage(), 'image/png', null);
    const claimed = await store.create(pngImage(), 'image/png', null);
    const stale = await store.create(pngImage(), 'image/png', null);
    store.claim([claimed.id], 's1', 'm1');
    writeFileSync(join(dir, 'files', 'attachments', 'stray'), 'x');
    await store.sweep(Date.now() + UNCLAIMED_TTL_MS / 2);
    expect(files().sort()).toEqual([kept.id, claimed.id, stale.id].sort());
    await store.sweep(Date.now() + UNCLAIMED_TTL_MS + 60_000);
    expect(files()).toEqual([claimed.id]);
    await store.removeSession('s1');
    expect(files()).toEqual([]);
    expect(store.forSession('s1').size).toBe(0);
    expect(existsSync(join(dir, 'files', 'attachments'))).toBe(true);
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { pngImage } from '../attachments/testing/images';
import { waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';
import { ShownFilesService } from './shown-files.service';

describe('ShownFilesController', () => {
  let app: TestApp;
  let scratch: string;
  let files: ShownFilesService;

  beforeAll(async () => {
    app = await startTestApp();
    const session = (
      await postJson(app.port, '/api/sessions', { prompt: 'Hi', scratch: true })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    scratch = session.cwd;
    mkdirSync(scratch, { recursive: true });
    files = app.app.get(ShownFilesService);
    sessionId = session.id;
  });
  let sessionId: string;
  afterAll(() => app.close());

  const show = async (name: string, content: Buffer | string) => {
    writeFileSync(join(scratch, name), content);
    return files.show(sessionId, null, name, null, 'show_file');
  };
  const get = (path: string) => rawRequest(app.port, 'GET', path);

  it('serves HTML only sandboxed, without access to the app', async () => {
    const file = await show(
      'page.html',
      '<script>fetch("/api/sessions")</script><h1>Hi</h1>',
    );
    expect((await get(`/api/shown-files/${file.id}`)).json()).toMatchObject({
      kind: 'html',
      name: 'page.html',
    });
    const response = await get(`/api/shown-files/${file.id}/content`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('<h1>Hi</h1>');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const csp = response.headers['content-security-policy'] as string;
    // An opaque origin: no cookies, storage or API of the app.
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('connect-src');
    expect(response.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('serves images, text and PDFs inline and the rest as download', async () => {
    const svg = await show(
      'chart.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    let response = await get(`/api/shown-files/${svg.id}/content`);
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['content-security-policy']).toMatch(/^sandbox;/);

    const png = await show('shot.png', pngImage());
    response = await get(`/api/shown-files/${png.id}/content`);
    expect(response.headers['content-type']).toBe('image/png');

    const pdf = await show('doc.pdf', '%PDF-1.4\n%%EOF\n');
    response = await get(`/api/shown-files/${pdf.id}/content`);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );

    const binary = await show('data ü.bin', Buffer.from([0, 1, 2]));
    response = await get(`/api/shown-files/${binary.id}/content`);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="data _.bin"; filename*=UTF-8''data%20%C3%BC.bin`,
    );

    const text = await show('main.ts', 'const a = 1;');
    response = await get(`/api/shown-files/${text.id}/content?download=1`);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
    expect(response.body).toBe('const a = 1;');
  });

  it('serves large files live while they exist', async () => {
    files.maxSnapshotBytes = 5;
    const file = await show('big.txt', 'current content');
    files.maxSnapshotBytes = 20 * 1024 * 1024;
    expect((await get(`/api/shown-files/${file.id}/content`)).status).toBe(410);
    const live = await get(`/api/shown-files/${file.id}/live`);
    expect(live.status).toBe(200);
    expect(live.body).toBe('current content');
    expect(live.headers['content-security-policy']).toMatch(/^sandbox;/);
    writeFileSync(join(scratch, 'big.txt'), '');
    expect((await get(`/api/shown-files/${file.id}/live`)).body).toBe('');
    // Replaced by a link out of the session: refused.
    const { rmSync, symlinkSync } = await import('node:fs');
    rmSync(join(scratch, 'big.txt'));
    symlinkSync('/etc/passwd', join(scratch, 'big.txt'));
    expect((await get(`/api/shown-files/${file.id}/live`)).status).toBe(410);
    expect((await get('/api/shown-files/unknown/content')).status).toBe(404);
  });
});

import { request as httpRequest } from 'node:http';
import { MAX_ATTACHMENT_BYTES } from '@claude-remote-manager/shared-types';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';
import { JPEG_HEAD, pngImage } from './testing/images';

/** POST with a binary body. */
function upload(
  port: number,
  body: Buffer,
  headers: Record<string, string>,
  path = '/api/attachments',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path, headers },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (data += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: data }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('AttachmentsController', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(() => app.close());

  it('takes images and serves them so they cannot run as pages', async () => {
    const image = pngImage();
    const created = await upload(app.port, image, {
      'content-type': 'image/png',
      'x-file-name': encodeURIComponent('Screenshot 1.png'),
    });
    expect(created.status).toBe(201);
    const attachment = JSON.parse(created.body) as { id: string; name: string };
    expect(attachment.name).toBe('Screenshot 1.png');

    const served = await rawRequest(
      app.port,
      'GET',
      `/api/attachments/${attachment.id}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
    });
    expect(
      (await rawRequest(app.port, 'GET', '/api/attachments/unknown')).status,
    ).toBe(404);
  });

  it('refuses other types, wrong content and large bodies', async () => {
    // Not an image type: refused by the request guard.
    expect(
      (
        await upload(app.port, Buffer.from('hi'), {
          'content-type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await upload(app.port, Buffer.from('<svg/>'), {
          'content-type': 'image/svg+xml',
        })
      ).status,
    ).toBe(415);
    // Declared PNG, actually JPEG.
    expect(
      (await upload(app.port, JPEG_HEAD, { 'content-type': 'image/png' }))
        .status,
    ).toBe(400);
    expect(
      (
        await upload(app.port, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), {
          'content-type': 'image/png',
        })
      ).status,
    ).toBe(413);
    // Image bodies are accepted on this route only.
    expect(
      (
        await upload(
          app.port,
          pngImage(),
          { 'content-type': 'image/png' },
          '/api/sessions',
        )
      ).status,
    ).toBe(415);
    // A foreign page cannot upload.
    expect(
      (
        await upload(app.port, pngImage(), {
          'content-type': 'image/png',
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
  });

  it('sends a new session’s first message with its images', async () => {
    const created = await upload(app.port, pngImage(), {
      'content-type': 'image/png',
    });
    const { id } = JSON.parse(created.body) as { id: string };
    const response = await postJson(app.port, '/api/sessions', {
      prompt: '',
      attachmentIds: [id],
      newProject: { name: 'images' },
    });
    expect(response.status).toBe(201);
    expect(response.json<{ title: string }>().title).toBe('Image');
    await new Promise<void>((resolve) => {
      const check = () =>
        app.runner.runs.length > 0 ? resolve() : setTimeout(check, 20);
      check();
    });
    expect(app.runner.runs[0].sent[0]).toMatchObject({
      text: '',
      images: [{ mediaType: 'image/png', data: pngImage().toString('base64') }],
    });
    // The upload belongs to that message now.
    const again = await postJson(app.port, '/api/sessions', {
      prompt: 'x',
      attachmentIds: [id],
      newProject: { name: 'images-2' },
    });
    expect(again.status).toBe(400);
  });
});

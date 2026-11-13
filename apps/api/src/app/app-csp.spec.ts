import { APP_CSP } from './configure-app';
import { rawRequest, startTestApp, type TestApp } from './testing/test-app';

describe('Content Security Policy of the web app', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(() => app.close());

  it('is sent with the app’s pages, not with the API', async () => {
    const page = await rawRequest(app.port, 'GET', '/sessions/x');
    expect(page.headers['content-security-policy']).toBe(APP_CSP);
    const api = await rawRequest(app.port, 'GET', '/api/health');
    expect(api.headers['content-security-policy']).toBeUndefined();
    for (const directive of [
      "script-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(APP_CSP).toContain(directive);
    }
    expect(APP_CSP).not.toMatch(/script-src[^;]*unsafe/);
  });
});

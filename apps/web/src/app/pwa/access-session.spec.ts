import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ACCESS_PROBE,
  AccessSession,
  accessInterceptor,
  probeAccess,
  type AccessState,
} from './access-session';

const redirect = () =>
  Object.defineProperty(new Response(null), 'type', {
    value: 'opaqueredirect',
  }) as Response;

describe('Access session', () => {
  it('probes the health check without following redirects', async () => {
    const calls: RequestInit[] = [];
    const probe = (response: () => Promise<Response>) =>
      probeAccess(async (_, init) => {
        calls.push(init ?? {});
        return response();
      });
    expect(await probe(async () => redirect())).toBe('expired');
    expect(await probe(async () => new Response('', { status: 401 }))).toBe(
      'expired',
    );
    expect(await probe(async () => new Response('{"status":"ok"}'))).toBe('ok');
    expect(
      await probe(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe('offline');
    expect(calls[0]).toMatchObject({ redirect: 'manual', cache: 'no-store' });
  });

  describe('interceptor', () => {
    let http: HttpClient;
    let backend: HttpTestingController;
    let access: AccessSession;
    let probeResult: AccessState;
    let probes: number;

    beforeEach(() => {
      probes = 0;
      probeResult = 'expired';
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(withInterceptors([accessInterceptor])),
          provideHttpClientTesting(),
          {
            provide: ACCESS_PROBE,
            useValue: async () => {
              probes++;
              return probeResult;
            },
          },
        ],
      });
      http = TestBed.inject(HttpClient);
      backend = TestBed.inject(HttpTestingController);
      access = TestBed.inject(AccessSession);
    });
    afterEach(() => backend.verify());

    it('takes the API’s refusal for an expired token at its word', () => {
      http.get('/api/sessions').subscribe({ error: () => undefined });
      backend
        .expectOne('/api/sessions')
        .flush(
          { statusCode: 401, reason: 'access_token_expired' },
          { status: 401, statusText: 'Unauthorized' },
        );
      expect(access.state()).toBe('expired');
      expect(probes).toBe(0);
      // A later answer means the user signed in again.
      http.get('/api/sessions').subscribe();
      backend.expectOne('/api/sessions').flush({ sessions: [] });
      expect(access.state()).toBe('ok');
    });

    it('checks what a failed request means (redirect to the login, offline)', async () => {
      http.get('/api/sessions').subscribe({ error: () => undefined });
      backend.expectOne('/api/sessions').error(new ProgressEvent('error'));
      await Promise.resolve();
      await Promise.resolve();
      expect(probes).toBe(1);
      expect(access.state()).toBe('expired');

      probeResult = 'offline';
      http.get('/api/sessions').subscribe({ error: () => undefined });
      backend.expectOne('/api/sessions').error(new ProgressEvent('error'));
      await new Promise((resolve) => setTimeout(resolve));
      expect(access.state()).toBe('offline');
    });

    it('ignores ordinary errors', () => {
      http.get('/api/sessions/x').subscribe({ error: () => undefined });
      backend
        .expectOne('/api/sessions/x')
        .flush(
          { message: 'not found' },
          { status: 404, statusText: 'Not Found' },
        );
      expect(probes).toBe(0);
      expect(access.state()).toBe('ok');
    });
  });
});

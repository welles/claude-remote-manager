import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { HealthResponse } from '@claude-remote-manager/shared-types';
import { Home } from './home';

describe('Home', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shows the health information of the server', async () => {
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();

    const health: HealthResponse = {
      status: 'ok',
      version: '1.2.3',
      commit: '0123456789abcdef',
      commitTime: '2026-01-01T00:00:00Z',
    };
    http.expectOne('/api/health').flush(health);
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const text = (id: string) =>
      element.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();
    expect(text('status')).toBe('ok');
    expect(text('version')).toBe('1.2.3');
    expect(text('commit')).toBe('0123456');
  });

  it('shows an error when the server is not reachable', async () => {
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();

    http
      .expectOne('/api/health')
      .flush(null, { status: 502, statusText: 'Bad Gateway' });
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.error')?.textContent).toContain(
      'not reachable',
    );
  });
});

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
  Router,
} from '@angular/router';
import { of } from 'rxjs';
import { SessionFilesPage } from './session-files-page';

describe('SessionFilesPage', () => {
  it('lists the files, marks changes, opens a file and references it', async () => {
    TestBed.configureTestingModule({
      imports: [SessionFilesPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: 's1' })) },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(SessionFilesPage);
    const element: HTMLElement = fixture.nativeElement;
    http.expectOne('/api/sessions/s1/browse').flush({
      directories: [
        {
          directory: 0,
          repository: 'acme/app',
          path: '/w/acme/app',
          files: ['src/a.ts', 'README.md'],
          truncated: false,
          error: null,
        },
      ],
    });
    http.expectOne('/api/sessions/s1/diff').flush({
      sessionId: 's1',
      repositories: [
        {
          path: '/w/acme/app',
          files: [{ path: 'src/a.ts', status: 'modified' }],
        },
      ],
      limits: {},
    });
    await fixture.whenStable();
    const names = () =>
      [
        ...element.querySelectorAll(
          '[data-testid="file-row"] [data-testid="file-name"]',
        ),
      ].map((name) => name.textContent?.trim());
    expect(names()).toEqual(['src', 'README.md']);
    expect(
      element.querySelector('[data-testid="changed-count"]')?.textContent,
    ).toContain('1 changed');
    // Open the folder: the changed file is marked.
    (
      element.querySelector('[data-testid="file-row"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    expect(names()).toEqual(['src', 'a.ts', 'README.md']);
    expect(
      element.querySelector('[data-testid="file-change"]')?.textContent?.trim(),
    ).toBe('M');

    (
      element.querySelectorAll(
        '[data-testid="file-row"]',
      )[1] as HTMLButtonElement
    ).click();
    http
      .expectOne(
        (request) =>
          request.url === '/api/sessions/s1/browse/file' &&
          request.params.get('directory') === '0' &&
          request.params.get('path') === 'src/a.ts',
      )
      .flush({
        directory: 0,
        path: 'src/a.ts',
        name: 'a.ts',
        kind: 'binary',
        mediaType: 'application/octet-stream',
        language: null,
        size: 3,
        mention: '@src/a.ts',
      });
    await fixture.whenStable();
    const download = element.querySelector(
      '[data-testid="download"]',
    ) as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe(
      '/api/sessions/s1/browse/content?directory=0&path=src%2Fa.ts&download=1',
    );
    (
      element.querySelector(
        '[data-testid="viewer-action"]',
      ) as HTMLButtonElement
    ).click();
    expect(navigate).toHaveBeenCalledWith(['/sessions', 's1'], {
      queryParams: { mention: '@src/a.ts' },
    });
  });
});

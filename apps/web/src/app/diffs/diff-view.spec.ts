import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { FileDiff } from '@claude-remote-manager/shared-types';
import { DiffView } from './diff-view';
import type { DiffLayout } from './diff-rows';
import { fileDiff } from './testing/file-diffs';

describe('DiffView', () => {
  let fixture: ComponentFixture<DiffView>;

  const render = async (
    diff: FileDiff,
    layout: DiffLayout = 'unified',
    limit: number | null = null,
  ) => {
    await TestBed.configureTestingModule({
      imports: [DiffView],
    }).compileComponents();
    fixture = TestBed.createComponent(DiffView);
    fixture.componentRef.setInput('diff', diff);
    fixture.componentRef.setInput('layout', layout);
    fixture.componentRef.setInput('limit', limit);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };
  const cells = (element: HTMLElement, selector: string) =>
    [...element.querySelectorAll(selector)].map((cell) => cell.textContent);

  it('shows lines with signs and numbers, as text', async () => {
    const element = await render(
      fileDiff({
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-<b>old</b>', '+<script>alert(1)</script>'],
          },
        ],
      }),
    );
    expect(cells(element, 'td.code')).toEqual([
      '-<b>old</b>',
      '+<script>alert(1)</script>',
    ]);
    expect(element.querySelector('script, b')).toBeNull();
    expect(element.querySelector('tr.del')).not.toBeNull();
    expect(element.querySelector('tr.add')).not.toBeNull();
  });

  it('lays out old and new side by side', async () => {
    const element = await render(fileDiff(), 'split');
    expect(element.querySelector('[data-testid="diff-split"]')).not.toBeNull();
    expect(cells(element, 'td.code.del')).toEqual(['const b = 2;']);
    expect(cells(element, 'td.code.add')).toEqual([
      'const b = 3;',
      'const c = 4;',
    ]);
  });

  it('shows the first lines until expanded', async () => {
    const element = await render(fileDiff(), 'unified', 3);
    expect(element.querySelectorAll('tr')).toHaveLength(3);
    const expand = element.querySelector(
      '[data-testid="diff-expand"]',
    ) as HTMLButtonElement;
    expect(expand.textContent).toContain('Show all 6 lines');
    expand.click();
    await fixture.whenStable();
    expect(element.querySelectorAll('tr')).toHaveLength(6);
    expect(element.querySelector('[data-testid="diff-expand"]')).toBeNull();
  });

  it('says when there is nothing to show', async () => {
    let element = await render(fileDiff({ binary: true, hunks: [] }));
    expect(element.textContent).toContain('Binary file');
    TestBed.resetTestingModule();
    element = await render(fileDiff({ truncated: true, hunks: [] }));
    expect(element.textContent).toContain('Too large to show');
    TestBed.resetTestingModule();
    element = await render(
      fileDiff({ hunks: fileDiff().hunks, truncated: true }),
    );
    expect(
      element.querySelector('[data-testid="diff-truncated"]'),
    ).not.toBeNull();
  });
});

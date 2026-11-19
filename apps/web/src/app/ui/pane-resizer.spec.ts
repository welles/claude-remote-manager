import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PaneResizer, PaneWidth, type PaneWidthRange } from './pane-resizer';

const RANGE: PaneWidthRange = {
  min: 240,
  max: 560,
  initial: 320,
  windowShare: 0.5,
};
const KEY = 'test.paneWidth';

describe('PaneWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1440,
    });
  });

  it('starts at the default and keeps a changed width', () => {
    const width = new PaneWidth(KEY, RANGE);
    expect(width.value()).toBe(320);

    width.set(400.4);
    width.save();

    expect(localStorage.getItem(KEY)).toBe('400');
    expect(new PaneWidth(KEY, RANGE).value()).toBe(400);
  });

  it('limits the width to its range and to its share of the window', () => {
    const width = new PaneWidth(KEY, RANGE);
    width.set(100);
    expect(width.value()).toBe(240);
    width.set(9999);
    expect(width.value()).toBe(560);

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    });
    width.set(9999);
    expect(width.value()).toBe(500);
  });

  it('forgets the stored width on reset', () => {
    localStorage.setItem(KEY, '450');
    const width = new PaneWidth(KEY, RANGE);
    expect(width.value()).toBe(450);

    width.reset();

    expect(width.value()).toBe(320);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('ignores stored values that are not widths', () => {
    localStorage.setItem(KEY, 'wide');
    expect(new PaneWidth(KEY, RANGE).value()).toBe(320);
  });
});

@Component({
  imports: [PaneResizer],
  template: `
    <div class="column" [style.width.px]="width.value()">
      <app-pane-resizer [width]="width" [edge]="edge" label="Width" />
    </div>
  `,
})
class Host {
  readonly width = new PaneWidth(KEY, RANGE);
  edge: 'start' | 'end' = 'end';
}

describe('PaneResizer', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1440,
    });
  });

  function render(edge: 'start' | 'end') {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.edge = edge;
    fixture.detectChanges();
    const handle = fixture.nativeElement.querySelector(
      'app-pane-resizer',
    ) as HTMLElement;
    // jsdom has no layout: the column reports the width it was given.
    const column = handle.parentElement as HTMLElement;
    column.getBoundingClientRect = () =>
      ({ width: fixture.componentInstance.width.value() }) as DOMRect;
    const press = (key: string, shiftKey = false) => {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, cancelable: true }),
      );
      fixture.detectChanges();
    };
    return { fixture, handle, press };
  }

  it('is a labelled separator with the current width', () => {
    const { handle } = render('end');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-label')).toBe('Width');
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.getAttribute('aria-valuemin')).toBe('240');
    expect(handle.getAttribute('aria-valuemax')).toBe('560');
  });

  it('widens a left column with the right arrow and stores it', () => {
    const { fixture, press } = render('end');
    press('ArrowRight');
    expect(fixture.componentInstance.width.value()).toBe(336);
    press('ArrowRight', true);
    expect(fixture.componentInstance.width.value()).toBe(400);
    expect(localStorage.getItem(KEY)).toBe('400');
  });

  it('widens a right column with the left arrow', () => {
    const { fixture, press } = render('start');
    press('ArrowLeft');
    expect(fixture.componentInstance.width.value()).toBe(336);
    press('ArrowRight');
    expect(fixture.componentInstance.width.value()).toBe(320);
  });

  it('jumps to the limits and back to the default', () => {
    const { fixture, handle, press } = render('end');
    press('End');
    expect(fixture.componentInstance.width.value()).toBe(560);
    press('Home');
    expect(fixture.componentInstance.width.value()).toBe(240);
    handle.dispatchEvent(new MouseEvent('dblclick'));
    expect(fixture.componentInstance.width.value()).toBe(320);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

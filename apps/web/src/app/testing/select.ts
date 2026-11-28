import type { ComponentFixture } from '@angular/core/testing';
import { words } from './text';

/**
 * Opens the `mat-select` with this test ID and returns its options (those
 * of its own panel: closed panels may linger in the overlay).
 */
async function open(
  fixture: ComponentFixture<unknown>,
  testId: string,
): Promise<{ select: HTMLElement; options: HTMLElement[] }> {
  const select = (fixture.nativeElement as HTMLElement).querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLElement | null;
  if (!select) {
    throw new Error(`No select ${testId}`);
  }
  (select.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
  fixture.detectChanges();
  await fixture.whenStable();
  const panel = document.getElementById(
    select.getAttribute('aria-controls') ?? '',
  );
  return {
    select,
    options: [
      ...(panel?.querySelectorAll('mat-option') ?? []),
    ] as HTMLElement[],
  };
}

/** Opens a select and picks the option with this text. */
export async function choose(
  fixture: ComponentFixture<unknown>,
  testId: string,
  label: string,
): Promise<void> {
  const { options } = await open(fixture, testId);
  const option = options.find((node) => words(node) === label);
  if (!option) {
    throw new Error(
      `No option ${label} in ${testId}: ${options.map((node) => words(node)).join(', ')}`,
    );
  }
  option.click();
  fixture.detectChanges();
  await fixture.whenStable();
}

/** The options a select offers (opened and closed again). */
export async function optionsOf(
  fixture: ComponentFixture<unknown>,
  testId: string,
): Promise<string[]> {
  const { select, options } = await open(fixture, testId);
  const texts = options.map((node) => words(node));
  select.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  fixture.detectChanges();
  await fixture.whenStable();
  return texts;
}

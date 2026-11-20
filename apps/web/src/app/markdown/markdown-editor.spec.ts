import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatFormFieldModule } from '@angular/material/form-field';
import { EditorDriver } from '../testing/editor';
import { MarkdownEditor } from './markdown-editor';

@Component({
  imports: [MarkdownEditor, MatFormFieldModule],
  template: `
    <mat-form-field>
      <mat-label>Prompt</mat-label>
      <app-markdown-editor
        [(text)]="text"
        [attributes]="{ 'data-testid': 'editor', 'aria-label': 'Prompt' }"
        (edited)="events.push('edited')"
        (caret)="events.push('caret')"
        (beforeKey)="onKey($event)"
      />
    </mat-form-field>
  `,
})
class Host {
  readonly text = signal('');
  readonly events: string[] = [];
  readonly editor = viewChild.required(MarkdownEditor);
  /** Keys the page takes before the editor. */
  taken: string[] = [];

  onKey(event: KeyboardEvent): void {
    if (this.taken.includes(event.key)) {
      event.preventDefault();
    }
  }
}

describe('MarkdownEditor', () => {
  const render = async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const host = fixture.componentInstance;
    const editor = new EditorDriver(fixture.nativeElement, 'editor');
    return { fixture, host, editor };
  };

  it('reports typing and caret moves, and binds its text', async () => {
    const { fixture, host, editor } = await render();
    editor.type('Hello');
    editor.moveCaret(2);
    expect(host.events).toEqual(['edited', 'caret']);
    expect(host.text()).toBe('Hello');

    // Text from the page replaces the editor's, without an event.
    host.text.set('Other');
    await fixture.whenStable();
    expect(editor.value).toBe('Other');
    expect(host.events).toEqual(['edited', 'caret']);
  });

  it('sets text as the autocompletes do: undoable, no event', async () => {
    const { host, editor } = await render();
    editor.type('Fix #1');
    host.editor().value = 'Fix #17 ';
    host.editor().setSelectionRange(8, 8);
    expect(editor.value).toBe('Fix #17 ');
    expect(host.text()).toBe('Fix #17 ');
    expect(host.editor().selectionStart).toBe(8);
    expect(host.events).toEqual(['edited']);
    editor.press('z', { ctrlKey: true });
    expect(editor.value).toBe('Fix #1');
  });

  it('continues lists on Enter and ends them on an empty item', async () => {
    const { editor } = await render();
    editor.type('- one');
    editor.press('Enter');
    expect(editor.value).toBe('- one\n- ');
    editor.press('Enter');
    expect(editor.value).toBe('- one\n');
    editor.type('plain');
    editor.press('Enter');
    expect(editor.value).toBe('plain\n');
    editor.type('1. one');
    editor.press('Enter');
    expect(editor.value).toBe('1. one\n2. ');
  });

  it('nests list items with Tab and leaves Tab alone elsewhere', async () => {
    const { editor } = await render();
    editor.type('- one\n- two');
    expect(editor.press('Tab').defaultPrevented).toBe(true);
    expect(editor.value).toBe('- one\n  - two');
    expect(editor.press('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(editor.value).toBe('- one\n- two');
    editor.type('plain');
    expect(editor.press('Tab').defaultPrevented).toBe(false);
  });

  it('formats with shortcuts and from the toolbar', async () => {
    const { host, editor } = await render();
    editor.type('word');
    editor.view.dispatch({ selection: { anchor: 0, head: 4 } });
    editor.press('b', { ctrlKey: true });
    expect(editor.value).toBe('**word**');
    editor.press('8', {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 56,
    } as KeyboardEventInit);
    expect(editor.value).toBe('- **word**');
    host.editor().format('quote');
    expect(editor.value).toBe('> **word**');
  });

  it('lets the page take keys first', async () => {
    const { host, editor } = await render();
    host.taken = ['Enter'];
    editor.type('- one');
    expect(editor.press('Enter').defaultPrevented).toBe(true);
    expect(editor.value).toBe('- one');
  });

  it('works as a form field control', async () => {
    const { fixture, editor } = await render();
    const element = fixture.nativeElement as HTMLElement;
    const field = element.querySelector('.mat-mdc-form-field') as HTMLElement;
    expect(
      element.querySelector('.mdc-floating-label--float-above'),
    ).toBeNull();
    editor.type('x');
    await fixture.whenStable();
    expect(
      element.querySelector('.mdc-floating-label--float-above'),
    ).not.toBeNull();
    expect(field).not.toBeNull();
    expect(editor.element.getAttribute('aria-label')).toBe('Prompt');
  });
});

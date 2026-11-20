import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  output,
  signal,
} from '@angular/core';
import { AppIcon, type IconName } from '../ui/icon';
import type { MarkdownFormat } from './markdown-commands';
import { FORMAT_SHORTCUTS } from './markdown-extensions';

interface ToolbarButton {
  format: MarkdownFormat;
  icon: IconName;
  label: string;
}

const BUTTONS: readonly ToolbarButton[] = [
  { format: 'bold', icon: 'bold', label: 'Bold' },
  { format: 'italic', icon: 'italic', label: 'Italic' },
  { format: 'strikethrough', icon: 'strikethrough', label: 'Strikethrough' },
  { format: 'heading', icon: 'heading', label: 'Heading' },
  { format: 'quote', icon: 'quote', label: 'Quote' },
  { format: 'code', icon: 'code', label: 'Code' },
  { format: 'codeBlock', icon: 'code-block', label: 'Code block' },
  { format: 'link', icon: 'link', label: 'Link' },
  { format: 'bullet', icon: 'list-bullet', label: 'Bulleted list' },
  { format: 'numbered', icon: 'list-numbered', label: 'Numbered list' },
  { format: 'task', icon: 'list-task', label: 'Task list' },
];

const isMac = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** `Mod-Shift-8` as the user presses it: `Ctrl+Shift+8` or `⌘⇧8`. */
export function shortcutLabel(key: string, mac = isMac()): string {
  const parts = key.split('-');
  const last = parts.pop() ?? '';
  const names: Record<string, string> = mac
    ? { Mod: '⌘', Shift: '⇧', Alt: '⌥' }
    : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };
  const keys = [
    ...parts.map((part) => names[part] ?? part),
    last.toUpperCase(),
  ];
  return keys.join(mac ? '' : '+');
}

/**
 * Buttons that apply Markdown formats to the editor's selection. They do
 * not take the focus (pressing one keeps the editor's selection), and the
 * row scrolls sideways where it does not fit.
 */
@Component({
  selector: 'app-markdown-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  template: `
    @for (button of buttons; track button.format) {
      <button
        type="button"
        class="icon-btn size-9!"
        [title]="title(button)"
        [attr.aria-label]="button.label"
        (mousedown)="$event.preventDefault()"
        (click)="format.emit(button.format)"
        [attr.data-testid]="'format-' + button.format"
      >
        <app-icon [name]="button.icon" />
      </button>
    }
  `,
  host: {
    role: 'toolbar',
    'aria-label': 'Formatting',
    class:
      'flex gap-0.5 overflow-x-auto [scrollbar-width:none] [--app-icon-size:18px]',
  },
})
export class MarkdownToolbar {
  readonly format = output<MarkdownFormat>();
  protected readonly buttons = BUTTONS;

  protected title(button: ToolbarButton): string {
    const key = FORMAT_SHORTCUTS[button.format];
    return key ? `${button.label} (${shortcutLabel(key)})` : button.label;
  }
}

const STORAGE_KEY = 'crm.formattingToolbar';

/**
 * Whether the formatting toolbar is shown (the text-format button toggles
 * it), kept in the browser; hidden by default.
 */
@Injectable({ providedIn: 'root' })
export class FormattingToolbarPreference {
  readonly shown = signal(this.initial());

  toggle(): void {
    this.shown.update((shown) => !shown);
    try {
      localStorage.setItem(STORAGE_KEY, String(this.shown()));
    } catch {
      // Not stored (private mode): only for this page.
    }
  }

  private initial(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}

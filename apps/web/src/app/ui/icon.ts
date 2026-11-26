import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * Stroke icons on a 24×24 grid, drawn with `currentColor` (no icon font:
 * nothing is downloaded and the CSP stays strict). Each icon is a list of
 * SVG path data.
 */
export const ICONS = {
  back: ['M15 18l-6-6 6-6'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  more: [
    'M12 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 19.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  ],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  send: ['M12 19V5', 'M5 12l7-7 7 7'],
  stop: [
    'M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z',
  ],
  attach: [
    'M21 12l-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9',
  ],
  changes: ['M8 3v12', 'M4 7l4-4 4 4', 'M16 21V9', 'M12 17l4 4 4-4'],
  branch: [
    'M6 3v12',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 9a9 9 0 0 1-9 9',
  ],
  commit: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3 12h6', 'M15 12h6'],
  'pull-request': [
    'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 9v6',
    'M18 15V9a3 3 0 0 0-3-3h-4',
    'M13 4l-2 2 2 2',
  ],
  check: ['M5 12l5 5L20 7'],
  alert: [
    'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    'M12 9v4',
    'M12 17h.01',
  ],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16v-4', 'M12 8h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  file: [
    'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
    'M14 3v5h5',
  ],
  eye: [
    'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  external: [
    'M14 4h6v6',
    'M20 4l-9 9',
    'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  ],
  refresh: [
    'M20 11a8 8 0 0 0-14.8-4.2L4 8',
    'M4 4v4h4',
    'M4 13a8 8 0 0 0 14.8 4.2L20 16',
    'M20 20v-4h-4',
  ],
  trash: [
    'M4 7h16',
    'M10 11v6',
    'M14 11v6',
    'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
    'M9 7V4h6v3',
  ],
  archive: [
    'M3 4h18v4H3z',
    'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8',
    'M10 12h4',
  ],
  clean: ['M14 3l-4 9', 'M6 13h10l1 8H5z', 'M9 17v4', 'M13 17v4'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  ],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  repo: [
    'M6 3v12',
    'M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 9c0 6-12 3-12 6',
  ],
  sessions: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
  server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  at: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8',
  ],
  image: [
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M20 15l-5-5L5 20',
  ],
  'cloud-off': [
    'M3 3l18 18',
    'M8 7.5A5 5 0 0 1 17 10h1a4 4 0 0 1 2.6 7',
    'M18 19H7a5 5 0 0 1-2.8-9.1',
  ],
  key: [
    'M15 9a2 2 0 1 0 0-.01',
    'M21 7a5 5 0 0 1-7.5 4.3L6 19H3v-3l7.7-7.5A5 5 0 1 1 21 7z',
  ],
  // Markdown formatting (the composer's toolbar).
  'text-format': ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'],
  bold: ['M7 5h5.5a3.5 3.5 0 0 1 0 7H7z', 'M7 12h6.5a3.5 3.5 0 0 1 0 7H7z'],
  italic: ['M11 5h7', 'M6 19h7', 'M15 5L9 19'],
  strikethrough: [
    'M4 12h16',
    'M16.5 7.5C15.8 5.9 14.2 5 12 5c-2.8 0-4.5 1.4-4.5 3.3 0 1.2.6 2.1 1.8 2.7',
    'M7.5 16.5c.7 1.6 2.3 2.5 4.5 2.5 2.8 0 4.5-1.4 4.5-3.3 0-.6-.1-1.2-.4-1.7',
  ],
  heading: ['M6 5v14', 'M18 5v14', 'M6 12h12'],
  quote: ['M5 5v14', 'M10 8h9', 'M10 12h9', 'M10 16h6'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5'],
  'code-block': [
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M10 9l-3 3 3 3',
    'M14 9l3 3-3 3',
  ],
  link: [
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1',
    'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  'list-bullet': [
    'M9 6h11',
    'M9 12h11',
    'M9 18h11',
    'M4.5 6h.01',
    'M4.5 12h.01',
    'M4.5 18h.01',
  ],
  'list-numbered': [
    'M10 6h10',
    'M10 12h10',
    'M10 18h10',
    'M4 4.5l1.5-1v5',
    'M4 14.5a1.5 1.5 0 0 1 3 .3c0 1-3 2.2-3 3.7h3',
  ],
  'list-task': [
    'M4 4h6v6H4z',
    'M4 14h6v6H4z',
    'M5.5 17l1.3 1.3 2-2.6',
    'M14 7h6',
    'M14 17h6',
  ],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

/**
 * `<app-icon name="send" />`: decorative by default (hidden from screen
 * readers); the button around it carries the `aria-label`. Size follows
 * `--app-icon-size` (20 px).
 */
@Component({
  selector: 'app-icon',
  host: { class: 'inline-flex size-[var(--app-icon-size,20px)] flex-none' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    class="size-full fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:var(--app-icon-stroke,1.8)]"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    @for (d of paths(); track $index) {
      <path [attr.d]="d" />
    }
  </svg>`,
})
export class AppIcon {
  readonly name = input.required<IconName>();
  protected readonly paths = computed(() => ICONS[this.name()]);
}

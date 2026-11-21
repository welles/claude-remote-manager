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

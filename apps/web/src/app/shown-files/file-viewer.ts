import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import type { ShownFileDto } from '@claude-remote-manager/shared-types';
import { MarkdownPipe } from '../sessions/markdown.pipe';
import { AppIcon } from '../ui/icon';
import { highlight } from './highlight';
import { formatSize, MAX_RENDERED_TEXT, shownFileUrl } from './shown-files-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A shown file in a side sheet (the whole screen on phones), closed with
 * Close, Escape or a click beside it (highlight.js is loaded on first
 * use): images directly, Markdown rendered (sanitized), HTML in a sandboxed
 * frame with an opaque origin (the server's CSP sandboxes it as well),
 * code and text highlighted, PDFs in the browser's viewer, anything else
 * as download.
 */
@Component({
  selector: 'app-file-viewer',
  imports: [AppIcon, MarkdownPipe, MatProgressBarModule],
  templateUrl: './file-viewer.html',
  host: {
    class: 'fixed inset-0 z-1000',
    role: 'dialog',
    'aria-modal': 'true',
    '[attr.aria-label]': 'file().name',
    '(document:keydown.escape)': 'closed.emit()',
  },
})
export class FileViewer implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly sanitizer = inject(DomSanitizer);

  readonly file = input.required<ShownFileDto>();
  /**
   * Where the content is, for files that are not shown files (the file
   * browser); always a URL of this app.
   */
  readonly contentUrl = input<string | null>(null);
  readonly contentDownloadUrl = input<string | null>(null);
  /** An extra action in the head (e.g. "Reference in message"). */
  readonly actionLabel = input<string | null>(null);
  readonly closed = output<void>();
  readonly action = output<void>();

  protected readonly url = computed(
    () => this.contentUrl() ?? shownFileUrl(this.file()),
  );
  protected readonly downloadUrl = computed(
    () =>
      this.contentDownloadUrl() ??
      shownFileUrl(this.file(), { download: true }),
  );
  protected readonly size = computed(() => formatSize(this.file().size));
  /** The frame's source: only ever this app's own content URL. */
  protected readonly frameUrl = computed<SafeResourceUrl | null>(() => {
    const own = this.contentUrl();
    return (own !== null && own.startsWith('/api/sessions/')) ||
      (own === null && UUID.test(this.file().id))
      ? this.sanitizer.bypassSecurityTrustResourceUrl(this.url())
      : null;
  });
  protected readonly text = signal<string | null>(null);
  protected readonly highlighted = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Text files are fetched and shown by the app itself. */
  protected readonly textual = computed(
    () => this.file().kind === 'markdown' || this.file().kind === 'text',
  );
  protected readonly tooLarge = computed(
    () => this.textual() && this.file().size > MAX_RENDERED_TEXT,
  );

  ngOnInit(): void {
    const file = this.file();
    if (!this.textual() || this.tooLarge()) {
      return;
    }
    this.loading.set(true);
    this.http.get(this.url(), { responseType: 'text' }).subscribe({
      next: (text) => {
        this.text.set(text);
        if (file.kind !== 'text') {
          this.loading.set(false);
          return;
        }
        void highlight(text, file.language).then(
          (html) => {
            this.highlighted.set(html);
            this.loading.set(false);
          },
          () => this.loading.set(false),
        );
      },
      error: () => {
        this.error.set(
          file.snapshot
            ? 'The file could not be loaded.'
            : 'The file is no longer available.',
        );
        this.loading.set(false);
      },
    });
  }
}

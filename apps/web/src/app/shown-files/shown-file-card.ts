import { Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { ShownFileDto } from '@claude-remote-manager/shared-types';
import { formatSize, shownFileUrl } from './shown-files-api';

const KIND_LABELS: Record<ShownFileDto['kind'], string> = {
  image: 'Image',
  markdown: 'Markdown',
  html: 'HTML page',
  pdf: 'PDF',
  text: 'Text',
  binary: 'File',
};

/**
 * A file Claude showed (or an image it read or wrote), in the
 * conversation: images as a thumbnail, other files as a card; both open
 * the viewer.
 */
@Component({
  selector: 'app-shown-file-card',
  imports: [MatButtonModule],
  template: `
    @let f = file();
    @if (f.kind === 'image') {
      <button
        type="button"
        class="thumbnail"
        (click)="open.emit(f)"
        [attr.aria-label]="'Open ' + f.name"
        data-testid="shown-image"
      >
        <img [src]="url()" [alt]="f.caption ?? f.name" loading="lazy" />
      </button>
      @if (f.caption) {
        <p class="caption">{{ f.caption }}</p>
      }
    } @else {
      <div class="card" data-testid="shown-file">
        <div class="text">
          <span class="name">{{ f.name }}</span>
          <span class="meta">{{ kindLabel() }} · {{ size() }}</span>
          @if (f.caption) {
            <span class="caption">{{ f.caption }}</span>
          }
        </div>
        <button
          matButton="outlined"
          (click)="open.emit(f)"
          data-testid="open-file"
        >
          Open
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .thumbnail {
      display: block;
      padding: 0;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      overflow: hidden;
      cursor: zoom-in;
      background: var(--mat-sys-surface-container);
    }
    img {
      display: block;
      max-width: min(320px, 100%);
      max-height: 240px;
      object-fit: contain;
    }
    .card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container-low);
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .name {
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .meta,
    .caption {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    p.caption {
      margin: 4px 0 0;
    }
  `,
})
export class ShownFileCard {
  readonly file = input.required<ShownFileDto>();
  readonly open = output<ShownFileDto>();
  protected readonly url = computed(() => shownFileUrl(this.file()));
  protected readonly kindLabel = computed(() => KIND_LABELS[this.file().kind]);
  protected readonly size = computed(() => formatSize(this.file().size));
}

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
  host: { class: 'block' },
  template: `
    @let f = file();
    @if (f.kind === 'image') {
      <button
        type="button"
        class="block cursor-zoom-in overflow-hidden rounded-sm border border-outline-variant bg-surface-container p-0"
        (click)="open.emit(f)"
        [attr.aria-label]="'Open ' + f.name"
        data-testid="shown-image"
      >
        <img
          class="block max-h-60 max-w-[min(320px,100%)] object-contain"
          [src]="url()"
          [alt]="f.caption ?? f.name"
          loading="lazy"
        />
      </button>
      @if (f.caption) {
        <p class="hint-text mt-1">{{ f.caption }}</p>
      }
    } @else {
      <div class="item-card flex-nowrap" data-testid="shown-file">
        <div class="flex min-w-0 flex-col">
          <span class="font-medium wrap-anywhere">{{ f.name }}</span>
          <span class="hint-text">{{ kindLabel() }} · {{ size() }}</span>
          @if (f.caption) {
            <span class="hint-text">{{ f.caption }}</span>
          }
        </div>
        <button matButton (click)="open.emit(f)" data-testid="open-file">
          Open
        </button>
      </div>
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

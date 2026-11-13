import { Component, input, output } from '@angular/core';
import type { PreviewDto } from '@claude-remote-manager/shared-types';
import { PreviewCard } from './preview-card';

/** The running previews of a session, in its header. */
@Component({
  selector: 'app-session-previews',
  imports: [PreviewCard],
  template: `
    @if (previews().length > 0) {
      <section class="previews" data-testid="session-previews">
        <h2>Previews</h2>
        @for (preview of previews(); track preview.id) {
          <app-preview-card [preview]="preview" (embed)="embed.emit($event)" />
        }
      </section>
    }
  `,
  styles: `
    .previews {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-small);
    }
  `,
})
export class SessionPreviews {
  readonly previews = input.required<PreviewDto[]>();
  readonly embed = output<PreviewDto>();
}

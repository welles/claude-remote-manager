import { Component, input, output } from '@angular/core';
import type { PreviewDto } from '@claude-remote-manager/shared-types';
import { PreviewCard } from './preview-card';

/** The running previews of a session, in its details. */
@Component({
  selector: 'app-session-previews',
  imports: [PreviewCard],
  template: `
    @if (previews().length > 0) {
      <section class="flex flex-col gap-1.5" data-testid="session-previews">
        <h3 class="app-section-label m-0">Previews</h3>
        <p class="hint-text mb-1" data-testid="previews-keep-running">
          The session does not go idle while it has previews: the agent and the
          dev servers it started keep running until you stop the previews or end
          the session.
        </p>
        @for (preview of previews(); track preview.id) {
          <app-preview-card [preview]="preview" (embed)="embed.emit($event)" />
        }
      </section>
    }
  `,
})
export class SessionPreviews {
  readonly previews = input.required<PreviewDto[]>();
  readonly embed = output<PreviewDto>();
}

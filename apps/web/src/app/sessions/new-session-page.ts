import {
  Component,
  afterNextRender,
  inject,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { SHARE_CACHE, sharedPrompt, takeShare } from '../../sw/share-store';
import { AppBanner } from '../ui/banner';
import { AppPageBar } from '../ui/page-bar';
import { NewSessionForm, type SessionPrefill } from './new-session-form';

/**
 * Starting a session (`/new`), reached in one tap from the session list.
 * `share=<id>` fills the form with content shared to the app (the share
 * target's redirect); the prompt has the focus.
 */
@Component({
  selector: 'app-new-session-page',
  host: { class: 'app-page' },
  imports: [AppBanner, AppPageBar, NewSessionForm],
  template: `
    <app-page-bar
      heading="New session"
      back="/"
      backLabel="Back to the sessions"
    />
    @if (shareNotice(); as notice) {
      <app-banner data-testid="share-notice">{{ notice }}</app-banner>
    }
    <app-new-session-form
      class="app-compact"
      [prefill]="prefill()"
      (created)="open($event)"
    />
  `,
  styles: `
    :host {
      --app-page-max: 760px;
    }
    app-new-session-form {
      display: block;
      padding-top: var(--app-space-1);
    }
  `,
})
export class NewSessionPage implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly form = viewChild.required(NewSessionForm);

  protected readonly prefill = signal<SessionPrefill | null>(null);
  protected readonly shareNotice = signal<string | null>(null);

  constructor() {
    afterNextRender(() => {
      if (!this.route.snapshot.queryParamMap.has('share')) {
        this.form().focusPrompt();
      }
    });
  }

  ngOnInit(): void {
    const share = this.route.snapshot.queryParamMap.get('share');
    if (share) {
      void this.takeShare(share);
    }
  }

  protected open(session: SessionDto): void {
    void this.router.navigate(['/sessions', session.id]);
  }

  /** Content shared to the app becomes the new session's prompt and images. */
  private async takeShare(id: string): Promise<void> {
    try {
      const content =
        id !== 'failed' && 'caches' in globalThis
          ? await takeShare(await caches.open(SHARE_CACHE), id)
          : null;
      if (content) {
        this.prefill.set({
          prompt: sharedPrompt(content),
          files: content.files,
        });
        this.shareNotice.set(
          'Shared content is in the form below: choose where the session works and start it.',
        );
      } else {
        this.shareNotice.set('The shared content could not be received.');
      }
    } catch {
      this.shareNotice.set('The shared content could not be received.');
    }
    void this.router.navigate([], {
      queryParams: { share: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}

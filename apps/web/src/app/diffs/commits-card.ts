import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  CommitSummary,
  CommitsAddedEvent,
} from '@claude-remote-manager/shared-types';
import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { commitQuery } from './commit-links';

/**
 * New commits on a session branch in the conversation: one row per commit
 * (short ID, subject, line counts) that opens to the whole message and the
 * changed files, with a link to the commit's diff on the changes page.
 */
@Component({
  selector: 'app-commits-card',
  imports: [AppDatePipe, AppIcon, RouterLink],
  host: {
    class:
      'flex flex-col gap-1 rounded-(--mat-sys-corner-small) border border-outline-variant bg-surface-container-low px-3 py-2 type-body-medium [--app-icon-size:16px]',
    'data-testid': 'commits-card',
  },
  template: `
    @let c = commits();
    <p
      class="m-0 flex flex-wrap items-center gap-x-1.5 type-label-medium text-on-surface-variant"
      data-testid="commits-heading"
    >
      <app-icon name="commit" /><span>{{ heading() }}</span>
      <code class="wrap-anywhere">{{ c.branch }}</code>
      @if (showRepository()) {
        <span class="wrap-anywhere">· {{ c.repository }}</span>
      }
    </p>
    @for (commit of c.commits; track commit.sha) {
      <details class="group/commit" data-testid="commit">
        <summary
          class="flex cursor-pointer list-none items-baseline gap-2 py-0.5 [&::-webkit-details-marker]:hidden"
        >
          <app-icon
            class="flex-none self-center text-on-surface-variant transition-transform duration-120 ease-[ease] group-open/commit:rotate-90"
            name="chevron-right"
          />
          <code class="flex-none text-[12px] text-on-surface-variant">{{
            commit.sha.slice(0, 7)
          }}</code>
          <span class="min-w-0 flex-1 truncate font-medium">{{
            commit.subject || '(no message)'
          }}</span>
          <span class="flex-none whitespace-nowrap type-body-small">
            @if (commit.parents.length > 1) {
              <span class="text-on-surface-variant">merge</span>
            } @else {
              <span class="text-diff-add">+{{ commit.additions }}</span>
              <span class="text-diff-del">−{{ commit.deletions }}</span>
            }
          </span>
        </summary>
        <div class="flex flex-col gap-1 pt-1 pb-1.5 pl-[22px]">
          <p class="m-0 hint-text">
            {{ commit.authorName }} · {{ commit.authoredAt | appDate }}
          </p>
          @if (commit.body) {
            <p
              class="m-0 type-body-small wrap-anywhere whitespace-pre-wrap"
              data-testid="commit-body"
            >
              {{ commit.body }}
            </p>
          }
          @if (commit.files.length > 0) {
            <ul
              class="m-0 list-none p-0 type-body-small"
              data-testid="commit-files"
            >
              @for (file of commit.files; track $index) {
                <li class="flex items-baseline gap-2">
                  <code class="min-w-0 flex-1 wrap-anywhere">
                    @if (file.oldPath) {
                      <span class="text-on-surface-variant"
                        >{{ file.oldPath }} →
                      </span>
                    }
                    {{ file.path }}</code
                  >
                  <span class="whitespace-nowrap">
                    @if (file.binary) {
                      binary
                    } @else {
                      <span class="text-diff-add">+{{ file.additions }}</span>
                      <span class="text-diff-del">−{{ file.deletions }}</span>
                    }
                  </span>
                </li>
              }
            </ul>
            @if (commit.fileCount > commit.files.length) {
              <p class="m-0 hint-text">
                and {{ commit.fileCount - commit.files.length }} more
                {{
                  commit.fileCount - commit.files.length === 1
                    ? 'file'
                    : 'files'
                }}
              </p>
            }
          }
          @if (c.repositoryId) {
            <a
              class="self-start type-label-large text-primary"
              [routerLink]="['/sessions', sessionId(), 'changes']"
              [queryParams]="query(commit)"
              data-testid="commit-diff-link"
              >Show diff</a
            >
          }
        </div>
      </details>
    }
    @if (c.commitCount > c.commits.length) {
      <p class="m-0 hint-text">
        and {{ c.commitCount - c.commits.length }} earlier
        {{ c.commitCount - c.commits.length === 1 ? 'commit' : 'commits' }}
      </p>
    }
  `,
})
export class CommitsCard {
  readonly commits = input.required<CommitsAddedEvent>();
  readonly sessionId = input.required<string>();
  /** Name the repository (sessions with several). */
  readonly showRepository = input(false);

  protected readonly heading = computed(() => {
    const { commitCount, rewritten } = this.commits();
    const count = `${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}`;
    return rewritten ? `Rewrote ${count} on` : `${count} on`;
  });

  protected query(commit: CommitSummary) {
    const c = this.commits();
    return commitQuery(c.repositoryId ?? '', c.branch, commit.sha);
  }
}

import { AppDatePipe } from '../ui/dates';
import { Component, computed, inject, input, signal } from '@angular/core';
import { TextFieldModule } from '@angular/cdk/text-field';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  isActiveDirectory,
  type PullRequestDto,
  type SessionDirectoryDto,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { DiscardCloneDialog } from './discard-clone-dialog';
import { PullRequestAutomation } from './pull-request-automation';
import { PullRequestChecks } from './pull-request-checks';
import { SessionsApi } from './sessions-api';

/** A clone of the session that can be pushed. */
interface PushableClone {
  repositoryId: string;
  name: string;
  github: boolean;
  directory: SessionDirectoryDto;
  pullRequests: PullRequestDto[];
}

export const PULL_REQUEST_STATE_LABELS: Record<
  PullRequestDto['state'],
  string
> = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
};

/**
 * Push and pull requests per repository of a session: a Push button for
 * every clone with a remote, Create PR for GitHub repositories, and the
 * session's pull requests with state and link. Results arrive as session
 * updates over the WebSocket.
 */
@Component({
  selector: 'app-session-git-panel',
  imports: [
    AppDatePipe,
    DiscardCloneDialog,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    PullRequestAutomation,
    PullRequestChecks,
    TextFieldModule,
  ],
  templateUrl: './session-git-panel.html',
  styleUrl: './session-git-panel.scss',
})
export class SessionGitPanel {
  private readonly api = inject(SessionsApi);

  readonly session = input.required<SessionDto>();

  protected readonly stateLabels = PULL_REQUEST_STATE_LABELS;
  protected readonly clones = computed<PushableClone[]>(() => {
    const session = this.session();
    return session.directories.flatMap((directory) =>
      directory.kind === 'clone' &&
      directory.repository &&
      !directory.repository.local &&
      isActiveDirectory(directory)
        ? [
            {
              repositoryId: directory.repository.id,
              name: directory.repository.fullName,
              github: directory.repository.github,
              directory,
              pullRequests: session.pullRequests.filter(
                (pull) => pull.repositoryId === directory.repository?.id,
              ),
            },
          ]
        : [],
    );
  });

  /**
   * Clones autoclose kept because they hold work that is not on GitHub
   * (the session ended; the others were removed).
   */
  protected readonly keptClones = computed(() => {
    const session = this.session();
    if (!session.autoclosedAt || session.status !== 'finished') {
      return [];
    }
    return session.directories.flatMap((directory) =>
      directory.kind === 'clone' &&
      directory.state === 'ready' &&
      directory.repository
        ? [
            {
              repositoryId: directory.repository.id,
              name: directory.repository.fullName,
              path: directory.path,
            },
          ]
        : [],
    );
  });

  /** Repository with an action running. */
  protected readonly busy = signal<string | null>(null);
  protected readonly messages = signal<
    Record<string, { text: string; error: boolean }>
  >({});
  /** Repository whose PR form is open, and its fields. */
  protected readonly composing = signal<string | null>(null);
  protected title = '';
  protected body = '';
  protected base = '';
  protected draft = false;

  protected push(clone: PushableClone): void {
    this.run(clone, 'Pushing…', (done, fail) =>
      this.api.push(this.session().id, clone.repositoryId).subscribe({
        next: () => done(`Pushed ${clone.directory.branch}`),
        error: (error: unknown) =>
          fail(errorMessage(error, 'The push failed.')),
      }),
    );
  }

  protected compose(clone: PushableClone): void {
    this.title = this.session().title ?? '';
    this.body = '';
    this.base = clone.directory.baseBranch ?? '';
    this.draft = false;
    this.composing.set(clone.repositoryId);
  }

  protected createPullRequest(clone: PushableClone): void {
    const request = {
      title: this.title.trim(),
      body: this.body,
      ...(this.base.trim() ? { base: this.base.trim() } : {}),
      draft: this.draft,
    };
    this.run(clone, 'Creating the pull request…', (done, fail) =>
      this.api
        .createPullRequest(this.session().id, clone.repositoryId, request)
        .subscribe({
          next: (pull) => {
            this.composing.set(null);
            done(`Pull request #${pull.number} is ${pull.state}`);
          },
          error: (error: unknown) =>
            fail(errorMessage(error, 'The pull request could not be created.')),
        }),
    );
  }

  protected isPushed(clone: PushableClone): boolean {
    return clone.directory.pushedCommit !== null;
  }

  private run(
    clone: PushableClone,
    progress: string,
    start: (done: (text: string) => void, fail: (text: string) => void) => void,
  ): void {
    const set = (text: string, error = false) =>
      this.messages.update((messages) => ({
        ...messages,
        [clone.repositoryId]: { text, error },
      }));
    this.busy.set(clone.repositoryId);
    set(progress);
    start(
      (text) => {
        this.busy.set(null);
        set(text);
      },
      (text) => {
        this.busy.set(null);
        set(text, true);
      },
    );
  }
}

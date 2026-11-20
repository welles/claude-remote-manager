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
  /** Repository and branch: the session may have several clones of one. */
  key: string;
  repositoryId: string;
  /** The clone's session branch, naming it to the API. */
  branch: string | null;
  /** Whether the repository has several clones: the branch is shown. */
  showBranch: boolean;
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
    const clonesOf = (repositoryId: string) =>
      session.directories.filter(
        (directory) =>
          directory.kind === 'clone' &&
          directory.repository?.id === repositoryId &&
          directory.state !== 'removed',
      );
    /**
     * The clone a pull request is listed under: the one on its head
     * branch; else (a retired clone's, or one from elsewhere) the
     * repository's first clone left, where it shows its branch.
     */
    const ownerOf = (pull: PullRequestDto) => {
      const siblings = clonesOf(pull.repositoryId);
      return (
        siblings.find((directory) => directory.branch === pull.headBranch) ??
        siblings[0]
      );
    };
    return session.directories.flatMap((directory) => {
      if (
        directory.kind !== 'clone' ||
        !directory.repository ||
        directory.repository.local ||
        directory.state === 'removed' ||
        !isActiveDirectory(directory)
      ) {
        return [];
      }
      const repositoryId = directory.repository.id;
      const siblings = clonesOf(repositoryId);
      return [
        {
          key: cloneKey(repositoryId, directory.branch),
          repositoryId,
          branch: directory.branch,
          showBranch:
            siblings.length > 1 ||
            session.directories.some(
              (other) =>
                other !== directory &&
                other.kind === 'clone' &&
                other.repository?.id === repositoryId,
            ),
          name: directory.repository.fullName,
          github: directory.repository.github,
          directory,
          pullRequests: session.pullRequests.filter(
            (pull) =>
              pull.repositoryId === repositoryId && ownerOf(pull) === directory,
          ),
        },
      ];
    });
  });

  /**
   * Pull requests of repositories without a current clone (all of them were
   * removed after their pull requests), by repository, with their branch.
   */
  protected readonly retiredPullRequests = computed(() => {
    const session = this.session();
    const current = new Set(
      session.directories
        .filter(
          (directory) =>
            directory.kind === 'clone' && directory.state !== 'removed',
        )
        .map((directory) => directory.repository?.id),
    );
    const groups = new Map<
      string,
      { key: string; name: string; pullRequests: PullRequestDto[] }
    >();
    for (const pull of session.pullRequests) {
      if (current.has(pull.repositoryId)) {
        continue;
      }
      const name =
        session.directories.find(
          (directory) => directory.repository?.id === pull.repositoryId,
        )?.repository?.fullName ?? pull.repositoryId;
      const group = groups.get(pull.repositoryId) ?? {
        key: pull.repositoryId,
        name,
        pullRequests: [],
      };
      group.pullRequests.push(pull);
      groups.set(pull.repositoryId, group);
    }
    return [...groups.values()];
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
    const kept = session.directories.filter(
      (directory) =>
        directory.kind === 'clone' &&
        directory.state === 'ready' &&
        directory.repository,
    );
    return kept.flatMap((directory) =>
      directory.repository
        ? [
            {
              key: cloneKey(directory.repository.id, directory.branch),
              repositoryId: directory.repository.id,
              branch: directory.branch,
              showBranch: kept.some(
                (other) =>
                  other !== directory &&
                  other.repository?.id === directory.repository?.id,
              ),
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
      this.api
        .push(this.session().id, clone.repositoryId, clone.branch)
        .subscribe({
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
    this.composing.set(clone.key);
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
        .createPullRequest(
          this.session().id,
          clone.repositoryId,
          request,
          clone.branch,
        )
        .subscribe({
          next: (pull) => {
            this.composing.set(null);
            done(
              pull.draft && pull.state === 'open'
                ? `Pull request #${pull.number} is a draft`
                : `Pull request #${pull.number} is ${pull.state}`,
            );
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
        [clone.key]: { text, error },
      }));
    this.busy.set(clone.key);
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

/** Key of a clone: its repository and branch. */
function cloneKey(repositoryId: string, branch: string | null): string {
  return `${repositoryId}\u0000${branch ?? ''}`;
}

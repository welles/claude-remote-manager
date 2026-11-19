import {
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { EnvironmentDto } from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { AppDialog } from '../ui/dialog';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';
import { Toasts } from '../ui/toasts';
import { EnvironmentEditor } from './environment-editor';
import { EnvironmentsApi } from './environments-api';

/**
 * Environments: variables, files (secrets of any kind or plain values),
 * instructions, a setup script and presets for new sessions. A list, the
 * form of one environment (new or existing) and deleting after
 * confirmation. Lazy-loaded.
 */
@Component({
  selector: 'app-environments-page',
  host: { class: 'app-page' },
  imports: [
    AppDialog,
    AppIcon,
    AppPageBar,
    EnvironmentEditor,
    MatButtonModule,
    MatProgressBarModule,
    RouterLink,
  ],
  templateUrl: './environments-page.html',
  styleUrl: './environments-page.scss',
})
export class EnvironmentsPage implements OnInit {
  private readonly api = inject(EnvironmentsApi);
  private readonly toasts = inject(Toasts);
  private readonly route = inject(ActivatedRoute);
  /** `?id=`: the environment to open once the list is loaded. */
  private requested: string | null = null;
  private readonly deleteDialog = viewChild.required(AppDialog);

  protected readonly environments = signal<EnvironmentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** The environment being edited: an ID, `new`, or `null` (the list). */
  protected readonly editing = signal<string | null>(null);
  protected readonly edited = computed(() => {
    const id = this.editing();
    return id && id !== 'new'
      ? (this.environments().find((entry) => entry.id === id) ?? null)
      : null;
  });
  protected readonly deleting = signal<EnvironmentDto | null>(null);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<string | null>(null);

  ngOnInit(): void {
    this.requested = this.route.snapshot.queryParamMap.get('id');
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: ({ environments }) => {
        this.environments.set(environments);
        this.loading.set(false);
        const requested = this.requested;
        this.requested = null;
        if (requested && environments.some((entry) => entry.id === requested)) {
          this.edit(requested);
        }
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(
          errorMessage(error, 'The environments could not be loaded.'),
        );
      },
    });
  }

  protected heading(): string {
    const id = this.editing();
    if (id === 'new') {
      return 'New environment';
    }
    return this.edited()?.name ?? 'Environments';
  }

  protected activeSessions(environment: EnvironmentDto): number {
    return environment.sessions.filter((session) => !session.archived).length;
  }

  protected edit(id: string): void {
    this.editing.set(id);
    window.scrollTo?.({ top: 0 });
  }

  protected saved(environment: EnvironmentDto): void {
    const wasNew = this.editing() === 'new';
    this.editing.set(null);
    this.toasts.show({
      title: wasNew
        ? `Environment ${environment.name} created`
        : `Environment ${environment.name} saved`,
      lines: wasNew
        ? []
        : ['Running sessions use the changes from their next start.'],
    });
    // The default may have moved: read all again.
    this.load();
  }

  protected askDelete(environment: EnvironmentDto): void {
    this.deleting.set(environment);
    this.deleteBusy.set(false);
    this.deleteError.set(null);
    this.deleteDialog().open();
  }

  protected closeDelete(): void {
    this.deleteDialog().close();
  }

  protected confirmDelete(): void {
    const environment = this.deleting();
    if (!environment) {
      return;
    }
    this.deleteBusy.set(true);
    this.deleteError.set(null);
    this.api.delete(environment.id).subscribe({
      next: () => {
        this.deleteDialog().close();
        this.deleting.set(null);
        this.environments.update((list) =>
          list.filter((entry) => entry.id !== environment.id),
        );
        if (this.editing() === environment.id) {
          this.editing.set(null);
        }
        this.toasts.show({ title: `Environment ${environment.name} deleted` });
      },
      error: (error: unknown) => {
        this.deleteBusy.set(false);
        this.deleteError.set(
          errorMessage(error, 'The environment was not deleted.'),
        );
      },
    });
  }
}

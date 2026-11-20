import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type {
  AppSettingsDto,
  GitHubInstallationDto,
  GitHubStatusDto,
  HealthResponse,
} from '@claude-remote-manager/shared-types';
import { GitHubApi } from '../github/github-api';
import { errorMessage } from '../repositories/repositories-api';
import { NotificationSettings } from './notification-settings';
import { SettingsApi } from './settings-api';
import { RouterLink } from '@angular/router';
import { AppIcon } from '../ui/icon';
import { formatIsoMinute, supportedTimeZone } from '../ui/dates';
import { AppPageBar } from '../ui/page-bar';

/**
 * The version to show: the release version of tagged builds, else the
 * image's tag `sha-<short commit>` (untagged builds report `0.0.0`);
 * `0.0.0` for local builds without a commit.
 */
export function displayVersion(health: HealthResponse): string {
  if (health.version !== '0.0.0') {
    return health.version;
  }
  return health.commit ? `sha-${health.commit.slice(0, 7)}` : health.version;
}

/**
 * Settings of the app: the commit identity of session clones (read-only,
 * from the server's environment), notifications, the state of the
 * GitHub App and the server's status and version.
 */
@Component({
  selector: 'app-settings-page',
  host: { class: 'app-page' },
  imports: [
    AppIcon,
    AppPageBar,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatProgressBarModule,
    NotificationSettings,
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage implements OnInit {
  private readonly settingsApi = inject(SettingsApi);
  private readonly githubApi = inject(GitHubApi);

  protected readonly settings = signal<AppSettingsDto | null>(null);
  protected readonly error = signal(false);

  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
  /**
   * Status, version, commit and commit time of the server, for the
   * template; the time in the server's zone (from the settings), in the
   * browser's until they are loaded or when the browser does not know it.
   */
  protected readonly server = computed(() => {
    const health = this.health.hasValue() ? this.health.value() : undefined;
    if (!health) {
      return null;
    }
    const timeZone = supportedTimeZone(this.settings()?.timeZone);
    return {
      status: health.status,
      version: displayVersion(health),
      commit: health.commit ? health.commit.slice(0, 7) : null,
      date: health.commitTime
        ? formatIsoMinute(health.commitTime, timeZone)
        : null,
      timeZone: timeZone ?? null,
    };
  });

  protected readonly github = signal<GitHubStatusDto | null>(null);
  protected readonly githubError = signal<string | null>(null);

  ngOnInit(): void {
    this.settingsApi.get().subscribe({
      next: (settings) => this.settings.set(settings),
      error: () => this.error.set(true),
    });
    this.loadGitHub();
  }

  /** What an installation has not accepted, e.g. "permissions checks, actions". */
  protected acceptance(installation: GitHubInstallationDto): string {
    const parts: string[] = [];
    if (installation.missingPermissions.length > 0) {
      parts.push(
        `permissions ${installation.missingPermissions.map((gap) => gap.permission).join(', ')}`,
      );
    }
    if (installation.missingEvents.length > 0) {
      parts.push(`webhook events ${installation.missingEvents.join(', ')}`);
    }
    return parts.join(' and ');
  }

  protected loadGitHub(refresh = false): void {
    this.githubError.set(null);
    this.githubApi.status(refresh).subscribe({
      next: (status) => this.github.set(status),
      error: (error: unknown) =>
        this.githubError.set(
          errorMessage(error, 'The GitHub status could not be loaded.'),
        ),
    });
  }
}

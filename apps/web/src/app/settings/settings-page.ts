import { Component, inject, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type {
  AppSettingsDto,
  GitHubStatusDto,
} from '@claude-remote-manager/shared-types';
import { GitHubApi } from '../github/github-api';
import { errorMessage } from '../repositories/repositories-api';
import { NotificationSettings } from './notification-settings';
import { SettingsApi } from './settings-api';
import { RouterLink } from '@angular/router';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';

/**
 * Settings of the app: the commit identity of session clones (read-only,
 * from the server's environment), notifications and the state of the
 * GitHub App.
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

  protected readonly github = signal<GitHubStatusDto | null>(null);
  protected readonly githubError = signal<string | null>(null);

  ngOnInit(): void {
    this.settingsApi.get().subscribe({
      next: (settings) => this.settings.set(settings),
      error: () => this.error.set(true),
    });
    this.loadGitHub();
  }

  protected loadGitHub(): void {
    this.githubError.set(null);
    this.githubApi.status().subscribe({
      next: (status) => this.github.set(status),
      error: (error: unknown) =>
        this.githubError.set(
          errorMessage(error, 'The GitHub status could not be loaded.'),
        ),
    });
  }
}

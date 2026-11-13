import { Component, inject, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import type { GitHubStatusDto } from '@claude-remote-manager/shared-types';
import { GitHubApi } from '../github/github-api';
import { errorMessage } from '../repositories/repositories-api';
import { NotificationSettings } from './notification-settings';
import { SettingsApi } from './settings-api';

/**
 * Settings of the app: the commit identity of session clones,
 * notifications and the state of the GitHub App.
 */
@Component({
  selector: 'app-settings-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    NotificationSettings,
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage implements OnInit {
  private readonly settingsApi = inject(SettingsApi);
  private readonly githubApi = inject(GitHubApi);

  protected authorName = '';
  protected authorEmail = '';
  protected readonly identitySet = signal(false);
  protected readonly loaded = signal(false);
  protected readonly saving = signal(false);
  protected readonly message = signal<{ text: string; error: boolean } | null>(
    null,
  );

  protected readonly github = signal<GitHubStatusDto | null>(null);
  protected readonly githubError = signal<string | null>(null);

  ngOnInit(): void {
    this.settingsApi.get().subscribe({
      next: (settings) => {
        this.authorName = settings.gitAuthorName ?? '';
        this.authorEmail = settings.gitAuthorEmail ?? '';
        this.identitySet.set(settings.gitAuthorName !== null);
        this.loaded.set(true);
      },
      error: () => {
        this.loaded.set(true);
        this.message.set({
          text: 'The settings could not be loaded.',
          error: true,
        });
      },
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

  protected save(): void {
    this.saving.set(true);
    this.message.set(null);
    this.settingsApi
      .update({
        gitAuthorName: this.authorName.trim() || null,
        gitAuthorEmail: this.authorEmail.trim() || null,
      })
      .subscribe({
        next: (settings) => {
          this.saving.set(false);
          this.identitySet.set(settings.gitAuthorName !== null);
          this.message.set({
            text: 'Saved. Existing session clones use the new identity for their next commits.',
            error: false,
          });
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.message.set({
            text: errorMessage(error, 'The settings could not be saved.'),
            error: true,
          });
        },
      });
  }
}

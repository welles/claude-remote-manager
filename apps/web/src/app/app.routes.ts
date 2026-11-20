import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./sessions/session-list').then((m) => m.SessionList),
  },
  {
    path: 'new',
    loadComponent: () =>
      import('./sessions/new-session-page').then((m) => m.NewSessionPage),
  },
  {
    path: 'sessions/:id',
    loadComponent: () =>
      import('./sessions/session-view').then((m) => m.SessionView),
  },
  {
    path: 'sessions/:id/changes',
    loadComponent: () =>
      import('./diffs/session-changes-page').then((m) => m.SessionChangesPage),
  },
  {
    path: 'sessions/:id/files',
    loadComponent: () =>
      import('./files/session-files-page').then((m) => m.SessionFilesPage),
  },
  {
    path: 'repositories',
    loadComponent: () =>
      import('./repositories/repository-list').then((m) => m.RepositoryList),
  },
  {
    path: 'environments',
    loadComponent: () =>
      import('./environments/environments-page').then(
        (m) => m.EnvironmentsPage,
      ),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'usage',
    loadComponent: () => import('./usage/usage-page').then((m) => m.UsagePage),
  },
  {
    path: 'workspace',
    loadComponent: () =>
      import('./workspace/workspace-page').then((m) => m.WorkspacePage),
  },
  { path: '**', redirectTo: '' },
];

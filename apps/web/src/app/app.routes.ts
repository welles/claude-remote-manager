import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./sessions/session-list').then((m) => m.SessionList),
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
    path: 'repositories',
    loadComponent: () =>
      import('./repositories/repository-list').then((m) => m.RepositoryList),
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
  {
    path: 'status',
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  { path: '**', redirectTo: '' },
];

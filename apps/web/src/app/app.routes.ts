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
    path: 'status',
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  { path: '**', redirectTo: '' },
];

import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import {
  PreloadAllModules,
  provideRouter,
  withPreloading,
} from '@angular/router';
import { LocationStrategy } from '@angular/common';
import { appRoutes } from './app.routes';
import { ListBelowLocationStrategy } from './navigation/list-below-location-strategy';
import { accessInterceptor } from './pwa/access-session';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([accessInterceptor])),
    // All pages load after the start, so the offline shell has them cached.
    provideRouter(appRoutes, withPreloading(PreloadAllModules)),
    // Back (also the swipe on phones) always leads to the session list.
    { provide: LocationStrategy, useClass: ListBelowLocationStrategy },
  ],
};

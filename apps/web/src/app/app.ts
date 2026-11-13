import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { AccessSession } from './pwa/access-session';
import { NeedsYouCount } from './pwa/needs-you';
import { SessionSocket } from './sessions/session-socket';
import { AppIcon, type IconName } from './ui/icon';

interface Destination {
  label: string;
  icon: IconName;
  link: string;
  /** URL prefixes that belong to the destination. */
  matches: (url: string) => boolean;
  testId: string;
}

const DESTINATIONS: Destination[] = [
  {
    label: 'Sessions',
    icon: 'sessions',
    link: '/',
    matches: (url) =>
      url === '/' ||
      url.startsWith('/?') ||
      url.startsWith('/sessions') ||
      url.startsWith('/new'),
    testId: 'nav-sessions',
  },
  {
    label: 'Repos',
    icon: 'repo',
    link: '/repositories',
    matches: (url) => url.startsWith('/repositories'),
    testId: 'nav-repositories',
  },
  {
    label: 'Usage',
    icon: 'chart',
    link: '/usage',
    matches: (url) => url.startsWith('/usage'),
    testId: 'usage-link',
  },
  {
    label: 'Settings',
    icon: 'settings',
    link: '/settings',
    matches: (url) =>
      url.startsWith('/settings') ||
      url.startsWith('/workspace') ||
      url.startsWith('/status'),
    testId: 'nav-settings',
  },
];

/** Pages with the bottom navigation on phones; the others are details. */
function isTopLevel(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return ['/', '/repositories', '/usage', '/settings'].includes(path);
}

/**
 * The app shell: navigation (a rail from 840 px, a bottom bar on top-level
 * pages below), the global sign-in and offline banners, and the page. Plain
 * HTML and CSS without Material modules, so the start bundle stays small;
 * each page renders its own app bar (`app-page-bar`).
 */
@Component({
  imports: [AppIcon, RouterLink, RouterOutlet],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly access = inject(AccessSession);
  protected readonly needsYou = inject(NeedsYouCount).count;
  protected readonly destinations = DESTINATIONS;
  private readonly router = inject(Router);
  protected readonly url = signal(this.router.url);
  protected readonly topLevel = computed(() => isTopLevel(this.url()));
  private readonly top = viewChild<ElementRef<HTMLElement>>('top');
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');

  constructor() {
    // The connection carries the presence (no notifications about what is
    // in front of the user) and keeps the badge current.
    inject(SessionSocket).connect();
    const injector = inject(Injector);
    let destroyed = false;
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => (destroyed = true));
    void import('./pwa/background').then((module) => {
      if (!destroyed) {
        module.startBackground(injector);
      }
    });
    addEventListener('online', () => void this.access.check());
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.url.set(event.urlAfterRedirects);
      }
    });
    destroyRef.onDestroy(() => subscription.unsubscribe());
    // Page bars stick below the banners: publish their height.
    afterNextRender(() => {
      const top = this.top()?.nativeElement;
      if (!top || typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(() =>
        document.documentElement.style.setProperty(
          '--app-top-inset',
          `${top.offsetHeight}px`,
        ),
      );
      observer.observe(top);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected active(destination: Destination): boolean {
    return destination.matches(this.url());
  }

  /** Skip link: focus the page without changing the URL. */
  protected skip(event: Event): void {
    event.preventDefault();
    this.main()?.nativeElement.focus();
  }
}

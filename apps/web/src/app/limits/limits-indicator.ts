import {
  Component,
  computed,
  inject,
  signal,
  type OnInit,
  DestroyRef,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { formatTime, isStale, limitViews } from './limit-format';
import { LimitsStore } from './limits-store';

/**
 * The account's 5-hour and weekly limits in the header: the main values at
 * a glance, all windows with reset times in a menu.
 */
@Component({
  selector: 'app-limits-indicator',
  imports: [MatButtonModule, MatMenuModule],
  templateUrl: './limits-indicator.html',
  styleUrl: './limits-indicator.scss',
})
export class LimitsIndicator implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly now = signal(Date.now());
  protected readonly limits = this.store.limits;
  protected readonly failed = this.store.failed;
  protected readonly views = computed(() => {
    const limits = this.limits();
    return limits ? limitViews(limits, this.now()) : [];
  });
  /** The windows in the header: 5 hours and week (or the first ones). */
  protected readonly headline = computed(() => this.views().slice(0, 2));
  protected readonly stale = computed(() => {
    const limits = this.limits();
    return limits !== null && isStale(limits, this.now());
  });
  protected readonly updated = computed(() => {
    const at = this.limits()?.updatedAt;
    return at ? formatTime(at, this.now()) : null;
  });

  ngOnInit(): void {
    this.store.start();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected refresh(): void {
    this.store.load();
  }
}

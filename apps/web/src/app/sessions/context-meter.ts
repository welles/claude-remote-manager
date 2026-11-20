import { DecimalPipe } from '@angular/common';
import { Component, input } from '@angular/core';
import type { ContextUsage } from '@claude-remote-manager/shared-types';
import { Meter } from '../ui/meter';
import { formatTokens } from './format';

/**
 * Context window usage of a session: tokens and percent, a meter below (the
 * same as the plan limits in the details).
 */
@Component({
  selector: 'app-context-meter',
  imports: [DecimalPipe, Meter],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    @let c = context();
    <div
      class="flex items-baseline justify-between gap-2"
      [title]="c ? 'Context window of ' + c.model : ''"
    >
      <span class="type-body-medium">Context</span>
      @if (c) {
        <span
          class="type-body-small text-right tabular-nums"
          [class]="
            c.percentage >= 80
              ? 'font-bold text-error'
              : 'text-on-surface-variant'
          "
          data-testid="context"
          >{{ formatTokens(c.usedTokens) }} / {{ formatTokens(c.maxTokens) }} ·
          {{ c.percentage | number: '1.0-1' }}%</span
        >
      } @else {
        <span
          class="type-body-small text-on-surface-variant"
          data-testid="context-unknown"
          >known after Claude's next answer</span
        >
      }
    </div>
    <app-meter
      [value]="c?.percentage ?? null"
      [high]="(c?.percentage ?? 0) >= 80"
      [label]="c ? 'Context window usage' : null"
    />
  `,
})
export class ContextMeter {
  readonly context = input<ContextUsage | null>(null);
  protected readonly formatTokens = formatTokens;
}

import { DecimalPipe } from '@angular/common';
import { Component, input } from '@angular/core';
import type { ContextUsage } from '@claude-remote-manager/shared-types';
import { formatTokens } from './format';

/**
 * Context window usage of a session: tokens and percent, a bar below (the
 * same meter as the plan limits in the details).
 */
@Component({
  selector: 'app-context-meter',
  imports: [DecimalPipe],
  template: `
    @if (context(); as c) {
      <div class="context" title="Context window of {{ c.model }}">
        <div class="row">
          <span class="label">Context</span>
          <span
            class="value"
            [class.high]="c.percentage >= 80"
            data-testid="context"
            >{{ formatTokens(c.usedTokens) }} /
            {{ formatTokens(c.maxTokens) }} ·
            {{ c.percentage | number: '1.0-1' }}%</span
          >
        </div>
        <div
          class="bar"
          role="progressbar"
          aria-label="Context window usage"
          [attr.aria-valuenow]="c.percentage"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="fill"
            [class.high]="c.percentage >= 80"
            [style.width.%]="c.percentage > 100 ? 100 : c.percentage"
          ></div>
        </div>
      </div>
    } @else {
      <div class="context">
        <div class="row">
          <span class="label">Context</span>
          <span class="value" data-testid="context-unknown"
            >known after Claude's next answer</span
          >
        </div>
        <div class="bar" aria-hidden="true"></div>
      </div>
    }
  `,
  styleUrl: './context-meter.scss',
})
export class ContextMeter {
  readonly context = input<ContextUsage | null>(null);
  protected readonly formatTokens = formatTokens;
}

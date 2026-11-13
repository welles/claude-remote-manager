import { DecimalPipe } from '@angular/common';
import { Component, input } from '@angular/core';
import type { ContextUsage } from '@claude-remote-manager/shared-types';
import { formatTokens } from './format';

/** Context window usage of a session: tokens, percent and a bar. */
@Component({
  selector: 'app-context-meter',
  imports: [DecimalPipe],
  template: `
    @if (context(); as c) {
      <div class="context" title="Context window of {{ c.model }}">
        <span data-testid="context">
          Context {{ formatTokens(c.usedTokens) }} /
          {{ formatTokens(c.maxTokens) }} ({{
            c.percentage | number: '1.0-1'
          }}%)
        </span>
        <div
          class="context-bar"
          role="progressbar"
          aria-label="Context window usage"
          [attr.aria-valuenow]="c.percentage"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="context-fill"
            [class.high]="c.percentage >= 80"
            [style.width.%]="c.percentage > 100 ? 100 : c.percentage"
          ></div>
        </div>
      </div>
    } @else {
      <div class="context" data-testid="context-unknown">
        Context usage: known after Claude's next answer
      </div>
    }
  `,
  styleUrl: './context-meter.scss',
})
export class ContextMeter {
  readonly context = input<ContextUsage | null>(null);
  protected readonly formatTokens = formatTokens;
}

import { DecimalPipe, KeyValuePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type {
  PreviewDto,
  SessionDto,
  ShownFileDto,
} from '@claude-remote-manager/shared-types';
import { MessageImages } from '../attachments/message-images';
import { FileDiffCard } from '../diffs/file-diff-card';
import { MessageContext } from '../github-references/message-context';
import { MessageText } from '../github-references/message-text';
import { sessionGitHubRepositories } from '../github-references/references';
import { PreviewCard } from '../previews/preview-card';
import { currentPreview } from '../previews/previews-api';
import { ShownFileCard } from '../shown-files/shown-file-card';
import { AppBanner } from '../ui/banner';
import { AppIcon, type IconName } from '../ui/icon';
import {
  progressText,
  questionCard,
  resolutionText,
  toolSummary,
  type ConversationItem,
} from './conversation';
import { formatCost, formatTokens, totalTokens } from './format';
import { MarkdownPipe } from './markdown.pipe';
import type { ShownItem } from './preparation';
import { relativePaths, sessionPath } from './session-directories';
import {
  groupTools,
  shortToolName,
  toolCounts,
  type ToolGroup,
} from './tool-groups';

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;
type Tone = 'ok' | 'bad' | 'ask' | 'busy' | 'quiet';
type SetupItem = Extract<ConversationItem, { kind: 'setup' }>;
export type QueuedItem = Extract<ConversationItem, { kind: 'queued' }>;

/**
 * The conversation of a session: messages, Claude's text (Markdown), tool
 * calls as quiet rows with the paths shortened to the session's
 * directories (a run of them folded into one row), their diffs, shown
 * files and previews, one row for the preparation, turn footers, and the
 * state at the end.
 */
@Component({
  selector: 'app-session-conversation',
  host: { 'data-testid': 'conversation' },
  imports: [
    AppBanner,
    AppIcon,
    DecimalPipe,
    FileDiffCard,
    KeyValuePipe,
    MarkdownPipe,
    MatButtonModule,
    MatProgressBarModule,
    MessageContext,
    MessageImages,
    MessageText,
    NgTemplateOutlet,
    PreviewCard,
    ShownFileCard,
  ],
  templateUrl: './session-conversation.html',
  styleUrls: ['./session-conversation.scss', './tool-rows.scss'],
})
export class SessionConversation {
  readonly items = input.required<ShownItem[]>();
  readonly session = input<SessionDto | null>(null);
  readonly sessionId = input('');
  readonly loading = input(false);
  /** A turn is in progress. */
  readonly running = input(false);
  readonly preparing = input(false);
  /** How many approval requests wait (shown in the dock, not here). */
  readonly pendingRequests = input(0);
  readonly resumable = input(true);

  readonly openFile = output<ShownFileDto>();
  readonly embed = output<PreviewDto>();
  /** A message that was not sent goes back into the input. */
  readonly edit = output<QueuedItem>();

  /** Reference chips name the repository of `#12` (several repositories). */
  protected readonly multiRepository = computed(
    () => sessionGitHubRepositories(this.session()).length > 1,
  );

  /** The items with each run of tool calls folded into a group. */
  protected readonly entries = computed(() => groupTools(this.items()));

  protected readonly resolutionText = resolutionText;
  protected readonly questionCard = questionCard;
  protected readonly progressText = progressText;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;

  /** The anchor of an assistant text item (Claude's message ID). */
  protected anchorOf(key: string): string | null {
    return key.startsWith('text:') ? (key.split(':')[1] ?? null) : null;
  }

  /** A preview (e.g. from the history) as it is now. */
  protected current(preview: PreviewDto): PreviewDto {
    return currentPreview(preview, this.session()?.previews ?? []);
  }

  /** A path of the session, relative to its directories. */
  protected sessionPath(path: string): string {
    return sessionPath(path, this.session()?.directories ?? []);
  }

  protected inputJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  /**
   * A tool call's summary with the session's directories shortened
   * (before the summary is cut to length, so the telling end stays).
   */
  protected toolLine(item: ToolItem): string {
    const directories = this.session()?.directories ?? [];
    const value =
      typeof item.input === 'object' && item.input !== null
        ? Object.fromEntries(
            Object.entries(item.input).map(([key, field]) => [
              key,
              typeof field === 'string'
                ? relativePaths(field, directories)
                : field,
            ]),
          )
        : item.input;
    return toolSummary(item.name, value);
  }

  protected toolState(item: ToolItem): string {
    if (item.byApp) {
      return item.byApp.outcome === 'succeeded' ? 'done by the app' : 'failed';
    }
    if (item.denied) {
      return 'denied';
    }
    const permission = item.permission;
    if (permission && !permission.resolved) {
      return permission.request.kind === 'question'
        ? 'question'
        : 'needs approval';
    }
    if (permission?.resolved?.decision === 'deny') {
      return permission.resolved.cause === 'user' ? 'denied' : 'cancelled';
    }
    if (!item.result) {
      return this.running() ? 'running' : 'no result';
    }
    return item.result.isError ? 'error' : 'done';
  }

  /**
   * What a group's row says: whether a call waits for the user, runs or
   * failed, the call that runs (or the tools used), and how many failed.
   */
  protected groupState(group: ToolGroup): {
    tone: Tone;
    current: string | null;
    counts: string;
    state: string | null;
  } {
    const states = group.tools.map((tool) => this.toolState(tool));
    const tones = states.map((state) => this.toolTone(state));
    const denied = states.filter((state) => state === 'denied').length;
    const failed = tones.filter((tone) => tone === 'bad').length - denied;
    const waiting = group.tools.find((_, index) => tones[index] === 'ask');
    const running = group.tools.findLast((_, index) => tones[index] === 'busy');
    const current = waiting ?? running;
    const problems = [
      failed > 0 ? `${failed} failed` : null,
      denied > 0 ? `${denied} denied` : null,
    ].filter((text) => text !== null);
    return {
      tone: waiting
        ? 'ask'
        : running
          ? 'busy'
          : problems.length > 0
            ? 'bad'
            : 'quiet',
      current: current
        ? `${shortToolName(current.name)} ${this.toolLine(current)}`.trim()
        : null,
      counts: toolCounts(group.tools),
      state: waiting
        ? this.toolState(waiting)
        : running
          ? 'running'
          : problems.join(' · ') || null,
    };
  }

  /** Colour group of a tool row's state. */
  protected toolTone(state: string): Tone {
    switch (state) {
      case 'done':
      case 'done by the app':
        return 'ok';
      case 'error':
      case 'denied':
      case 'failed':
        return 'bad';
      case 'needs approval':
      case 'question':
        return 'ask';
      case 'running':
        return 'busy';
      default:
        return 'quiet';
    }
  }

  protected toolIcon(state: string): IconName {
    switch (this.toolTone(state)) {
      case 'ok':
        return 'check';
      case 'bad':
        return 'close';
      case 'ask':
        return 'alert';
      case 'busy':
        return 'clock';
      default:
        return 'terminal';
    }
  }

  protected setupState(item: SetupItem): string {
    switch (item.state) {
      case 'started':
        return 'running';
      case 'failed':
        return item.exitCode !== null
          ? `failed (exit ${item.exitCode})`
          : 'failed';
      case 'timed_out':
        return 'timed out';
      default:
        return item.state;
    }
  }
}

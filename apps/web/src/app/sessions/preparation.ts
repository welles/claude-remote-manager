import { progressText, type ConversationItem } from './conversation';

type ProgressItem = Extract<ConversationItem, { kind: 'progress' }>;
type SetupItem = Extract<ConversationItem, { kind: 'setup' }>;

/** Consecutive preparation steps shown as one row. */
export interface PreparationGroup {
  kind: 'prep';
  key: string;
  /** Preparation steps and the setup scripts run between them. */
  steps: (ProgressItem | SetupItem)[];
  /** The last step's text, e.g. "Cloned acme/app · …". */
  summary: string;
  failed: boolean;
  /** No step is still running. */
  done: boolean;
}

export type ShownItem =
  | Exclude<ConversationItem, { kind: 'progress' }>
  | PreparationGroup;

/**
 * The conversation with each run of preparation steps (`progress`) folded
 * into one group: the steps of every session are the same few lines, so
 * they are one row, open only when a step failed.
 */
export function groupPreparation(items: ConversationItem[]): ShownItem[] {
  const shown: ShownItem[] = [];
  let group: PreparationGroup | null = null;
  for (const item of items) {
    if (item.kind === 'setup' && group) {
      group.steps.push(item);
      group.failed ||= item.state === 'failed' || item.state === 'timed_out';
      group.done &&= item.state !== 'started';
      continue;
    }
    if (item.kind !== 'progress') {
      group = null;
      shown.push(item);
      continue;
    }
    if (!group) {
      group = {
        kind: 'prep',
        key: `prep:${item.key}`,
        steps: [],
        summary: '',
        failed: false,
        done: true,
      };
      shown.push(group);
    }
    group.steps.push(item);
    group.summary = progressText(item);
    group.failed ||= item.state === 'failed';
    group.done = item.state !== 'started';
  }
  return shown;
}

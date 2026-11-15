import { progressText, type ConversationItem } from './conversation';

type ProgressItem = Extract<ConversationItem, { kind: 'progress' }>;
type SetupItem = Extract<ConversationItem, { kind: 'setup' }>;

/** Consecutive preparation steps shown as one row. */
export interface PreparationGroup {
  kind: 'prep';
  key: string;
  /** `Prepare`, or `Add repository` for a repository added later. */
  label: string;
  /** The addition the steps belong to; `null` for the session's own. */
  addition: string | null;
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
 * they are one row, open only when a step failed. Adding a repository to
 * the running session is a group of its own (one per attempt).
 */
export function groupPreparation(items: ConversationItem[]): ShownItem[] {
  const shown: ShownItem[] = [];
  let group: PreparationGroup | null = null;
  for (const item of items) {
    if (item.kind === 'setup' && group && group.addition === item.addition) {
      group.steps.push(item);
      if (!group.addition) {
        group.failed ||= item.state === 'failed' || item.state === 'timed_out';
        group.done &&= item.state !== 'started';
      }
      continue;
    }
    if (item.kind !== 'progress') {
      group = null;
      shown.push(item);
      continue;
    }
    if (!group || group.addition !== item.addition) {
      group = {
        kind: 'prep',
        key: `prep:${item.key}`,
        label: item.addition ? 'Add repository' : 'Prepare',
        addition: item.addition,
        steps: [],
        summary: '',
        failed: false,
        done: true,
      };
      shown.push(group);
    }
    group.steps.push(item);
    if (group.addition) {
      // An addition's row says how the addition went (its `add` step, which
      // later states replace in place), not its last git step.
      if (item.step === 'add') {
        group.summary = progressText(item);
        group.failed = item.state === 'failed';
        group.done = item.state !== 'started';
      }
      continue;
    }
    group.summary = progressText(item);
    group.failed ||= item.state === 'failed';
    group.done = item.state !== 'started';
  }
  for (const item of shown) {
    if (item.kind === 'prep' && item.addition && item.done) {
      // The outcome of an addition (its `add` step) reads last.
      item.steps = [
        ...item.steps.filter(
          (step) => step.kind !== 'progress' || step.step !== 'add',
        ),
        ...item.steps.filter(
          (step) => step.kind === 'progress' && step.step === 'add',
        ),
      ];
    }
  }
  return shown;
}

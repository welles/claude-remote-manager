import type {
  ModelOption,
  ReviewEffort,
  ReviewMode,
  ReviewSeverity,
  ReviewTrigger,
} from '@claude-remote-manager/shared-types';
import { DEFAULT_REVIEW_MODEL } from '@claude-remote-manager/shared-types';

export const EFFORT_LABELS: Record<ReviewEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const SEVERITY_LABELS: Record<ReviewSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Fable 5.2, the reviewer's default, also when Claude Code does not list it. */
const DEFAULT_OPTION: ModelOption = {
  value: DEFAULT_REVIEW_MODEL,
  label: 'Fable 5.2',
  description: 'The default model of reviews',
  resolvedModel: DEFAULT_REVIEW_MODEL,
};

/**
 * Models a reviewer can use: Claude Code's list without its "Default"
 * row, plus Fable 5.2 and `current` when the list lacks them (a model
 * chosen earlier stays selectable).
 */
export function reviewModelOptions(
  models: readonly ModelOption[],
  current: string | null,
): ModelOption[] {
  const options = models.filter(
    (option): option is ModelOption & { value: string } =>
      option.value !== null,
  );
  const known = (value: string) =>
    options.some(
      (option) => option.value === value || option.resolvedModel === value,
    );
  const extra: ModelOption[] = [];
  if (!known(DEFAULT_REVIEW_MODEL)) {
    extra.push(DEFAULT_OPTION);
  }
  if (current && current !== DEFAULT_REVIEW_MODEL && !known(current)) {
    extra.push({
      value: current,
      label: current,
      description: '',
      resolvedModel: current,
    });
  }
  return [...extra, ...options];
}

/** A model's label in `options`, else the model itself. */
export function reviewModelLabel(
  options: readonly ModelOption[],
  model: string,
): string {
  return (
    options.find(
      (option) => option.value === model || option.resolvedModel === model,
    )?.label ?? (model === DEFAULT_REVIEW_MODEL ? 'Fable 5.2' : model)
  );
}

export const MODE_LABELS: Record<ReviewMode, { label: string; hint: string }> =
  {
    off: {
      label: 'Off',
      hint: 'Reviews start only with “Review now”.',
    },
    claude: {
      label: 'When Claude asks',
      hint: 'Claude asks for a review after a finished, locally checked work package.',
    },
    turn: {
      label: 'After every turn',
      hint: 'After each turn that changed the diff, and when Claude asks.',
    },
  };

/**
 * How a review started, for its card and the session's details; `agent`
 * names the session's agent ("Claude", "Codex").
 */
export function triggerLabel(trigger: ReviewTrigger, agent = 'Claude'): string {
  return trigger === 'auto'
    ? 'Auto-review'
    : trigger === 'claude'
      ? `Review requested by ${agent}`
      : 'Review';
}

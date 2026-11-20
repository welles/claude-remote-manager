import { TextFieldModule } from '@angular/cdk/text-field';
import { Component, computed, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import {
  PERMISSION_MODE_INFO,
  type PermissionRequestEvent,
  type PermissionResponse,
  type SessionDirectoryDto,
  type PlanApprovalMode,
  type RepositoryAdditionCall,
  type UserQuestion,
} from '@claude-remote-manager/shared-types';
import { FileDiffCard } from '../diffs/file-diff-card';
import { MarkdownPipe } from './markdown.pipe';
import { requestSummary } from './permission-summary';
import { sessionPath } from './session-directories';

/** Value of the "own answer" choice of a single-select question. */
export const OTHER = '\u0000other';

/** The user's choice for one question. */
interface QuestionState {
  selected: string[];
  other: string;
}

/**
 * Answer of a question from the choice: the option's label (labels joined
 * with `, ` for multi-select, plus own text), or the own text.
 */
export function answerOf(
  question: UserQuestion,
  state: QuestionState | undefined,
): string {
  const other = state?.other.trim() ?? '';
  const selected = (state?.selected ?? []).filter((value) => value !== OTHER);
  if (question.multiSelect) {
    return [...selected, ...(other ? [other] : [])].join(', ');
  }
  if (state?.selected.includes(OTHER) || selected.length === 0) {
    return other;
  }
  return selected[0];
}

/**
 * An approval request as a card: what Claude wants to do (or asks, or
 * plans) and the possible answers. Used in the session view, also on
 * phones, so everything wraps and the buttons are large.
 */
@Component({
  selector: 'app-permission-card',
  imports: [
    FileDiffCard,
    MarkdownPipe,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    TextFieldModule,
  ],
  templateUrl: './permission-card.html',
  styleUrl: './permission-card.scss',
})
export class PermissionCard {
  readonly request = input.required<PermissionRequestEvent>();
  /** Whether answers can be sent (connected, no answer on its way). */
  readonly enabled = input(true);
  /** E.g. "1 of 3" when more requests wait. */
  readonly position = input<string | null>(null);
  readonly answer = output<PermissionResponse>();
  /** The session's directories, to name changed files shortly. */
  readonly directories = input<SessionDirectoryDto[]>([]);

  protected readonly modeInfo = PERMISSION_MODE_INFO;
  protected readonly other = OTHER;
  /** The switches a `set_pr_automation` call can set, in display order. */
  protected readonly automationSwitches = [
    'autofix',
    'automerge',
    'autoclose',
  ] as const;
  protected readonly summary = computed(() => requestSummary(this.request()));
  protected readonly diffLabel = computed(() => {
    const diff = this.request().diff;
    return diff ? sessionPath(diff.path, this.directories()) : null;
  });
  protected readonly heading = computed(() => {
    switch (this.request().kind) {
      case 'question':
        return 'Claude asks';
      case 'plan':
        return 'Plan for approval';
      default:
        return 'Approval needed';
    }
  });
  /** Whether the push goes only to the session branch, plainly. */
  protected readonly plainPushes = computed(() =>
    this.request().gitPushes.every(
      (push) => push.sessionBranchOnly && push.warnings.length === 0,
    ),
  );

  /** The deny (or "keep planning") form is open. */
  protected readonly denying = signal(false);
  protected readonly message = signal('');
  protected readonly planMode = signal<PlanApprovalMode>('default');
  protected readonly choices = signal(new Map<string, QuestionState>());

  protected readonly answers = computed(() => {
    const answers: Record<string, string> = {};
    for (const question of this.request().questions ?? []) {
      answers[question.question] = answerOf(
        question,
        this.choices().get(question.question),
      );
    }
    return answers;
  });
  protected readonly complete = computed(() =>
    Object.values(this.answers()).every((answer) => answer.trim() !== ''),
  );

  /** Where a repository Claude wants to add comes from. */
  protected additionSource(addition: RepositoryAdditionCall): string {
    const registered = addition.registered ? '' : ', not registered yet';
    switch (addition.source) {
      case 'github':
        return `GitHub, through the app's installation${registered}`;
      case 'project':
        return 'Local project';
      default:
        return `Clone URL${registered}`;
    }
  }

  protected isSelected(question: UserQuestion, value: string): boolean {
    return (
      this.choices().get(question.question)?.selected.includes(value) ?? false
    );
  }

  /** The chosen option (or own answer) of a single-select question. */
  protected singleValue(question: UserQuestion): string | null {
    return this.choices().get(question.question)?.selected[0] ?? null;
  }

  protected otherText(question: UserQuestion): string {
    return this.choices().get(question.question)?.other ?? '';
  }

  protected choose(question: UserQuestion, value: string): void {
    this.updateChoice(question, (state) => ({ ...state, selected: [value] }));
  }

  protected toggle(question: UserQuestion, value: string, on: boolean): void {
    this.updateChoice(question, (state) => ({
      ...state,
      selected: on
        ? [...state.selected.filter((entry) => entry !== value), value]
        : state.selected.filter((entry) => entry !== value),
    }));
  }

  protected setOther(question: UserQuestion, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.updateChoice(question, (state) => ({
      other: text,
      // Typing an own answer chooses it (single-select).
      selected: question.multiSelect || !text.trim() ? state.selected : [OTHER],
    }));
  }

  protected onMessage(event: Event): void {
    this.message.set((event.target as HTMLTextAreaElement).value);
  }

  protected allow(scope: 'once' | 'session' = 'once'): void {
    this.send(
      scope === 'session'
        ? { decision: 'allow', scope }
        : { decision: 'allow' },
    );
  }

  protected sendAnswers(): void {
    if (this.complete()) {
      this.send({ decision: 'allow', answers: this.answers() });
    }
  }

  protected approvePlan(): void {
    this.send({ decision: 'allow', mode: this.planMode() });
  }

  protected deny(): void {
    const message = this.message().trim();
    this.send(message ? { decision: 'deny', message } : { decision: 'deny' });
  }

  private send(response: PermissionResponse): void {
    if (this.enabled()) {
      this.answer.emit(response);
    }
  }

  private updateChoice(
    question: UserQuestion,
    update: (state: QuestionState) => QuestionState,
  ): void {
    this.choices.update((choices) => {
      const next = new Map(choices);
      next.set(
        question.question,
        update(next.get(question.question) ?? { selected: [], other: '' }),
      );
      return next;
    });
  }
}

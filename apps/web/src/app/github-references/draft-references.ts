import { computed, inject, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';
import {
  MAX_REFERENCES_PER_MESSAGE,
  parseReferences,
  referenceKey,
  type GitHubReferenceDetail,
  type MessageReferenceRequest,
} from '@claude-remote-manager/shared-types';
import {
  bareNumbers,
  draftChip,
  draftReferences,
  NO_OPTIONS,
  ReferenceDetails,
  resolveBare,
  type BareResolution,
  type ReferenceChipModel,
  type ReferenceOptions,
} from './references';

/** A reference of the text being written, as the input shows it. */
export type DraftReferenceEntry =
  | { kind: 'chip'; key: string; chip: ReferenceChipModel }
  | {
      /** `#12` exists in several repositories: the user picks one. */
      kind: 'ambiguous';
      key: string;
      number: number;
      candidates: { repository: string; detail: GitHubReferenceDetail }[];
    };

/**
 * The GitHub references of a text being written: `owner/repo#12` refers to
 * that repository; `#12` in a session with one repository to that one, with
 * several to the one that has it. When several have it, the user chooses
 * (the text then says `owner/repo#12`), and until then the message cannot
 * be sent. Create it in a component's field initializer.
 */
export class DraftReferences {
  private readonly details = inject(ReferenceDetails);
  /** The text once typing paused, so partial numbers are not looked up. */
  private readonly settled: Signal<string>;
  /** What the bare `#12` of the settled text refer to (several repositories). */
  private readonly bare = computed(() => {
    const repositories = this.repositories();
    const resolutions = new Map<number, BareResolution>();
    if (repositories.length < 2) {
      return resolutions;
    }
    for (const number of bareNumbers(this.settled())) {
      resolutions.set(
        number,
        resolveBare(
          repositories,
          repositories.map((repository) =>
            this.details.get(repository, number)(),
          ),
        ),
      );
    }
    return resolutions;
  });

  /** The references as chips, or the choice of repository, in text order. */
  readonly entries = computed<DraftReferenceEntry[]>(() => {
    const repositories = this.repositories();
    const options = this.options();
    const bare = this.bare();
    const seen = new Set<string>();
    const entries: DraftReferenceEntry[] = [];
    for (const parsed of parseReferences(this.settled(), null)) {
      const resolution = parsed.repository ? null : bare.get(parsed.number);
      if (resolution?.status === 'ambiguous') {
        const key = `#${parsed.number}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({
            kind: 'ambiguous',
            key,
            number: parsed.number,
            candidates: resolution.candidates,
          });
        }
        continue;
      }
      const repository =
        parsed.repository ??
        (resolution?.status === 'resolved'
          ? resolution.repository
          : repositories[0]);
      if (!repository) {
        continue;
      }
      const key = referenceKey(repository, parsed.number);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const chosen = options.get(key) ?? NO_OPTIONS;
      const request: MessageReferenceRequest = {
        token: parsed.token,
        repository,
        number: parsed.number,
        comments: chosen.comments,
        diff: chosen.diff,
      };
      entries.push({
        kind: 'chip',
        key,
        chip: draftChip(
          request,
          resolution?.status === 'pending'
            ? { status: 'loading' }
            : this.details.get(repository, parsed.number)(),
        ),
      });
    }
    return entries.slice(0, MAX_REFERENCES_PER_MESSAGE);
  });

  /**
   * A bare `#12` is not yet known to refer to one repository (still being
   * looked up, or the user has to choose): the message waits.
   */
  readonly unresolved = computed(() => {
    if (this.repositories().length < 2) {
      return false;
    }
    const numbers = bareNumbers(this.text());
    if (numbers.length === 0) {
      return false;
    }
    if (this.settled() !== this.text()) {
      return true;
    }
    const bare = this.bare();
    return numbers.some((number) => bare.get(number)?.status !== 'resolved');
  });

  /**
   * @param text the text being written
   * @param repositories the session's GitHub repositories, the main one first
   * @param options comments and diffs chosen per reference
   */
  constructor(
    private readonly text: () => string,
    private readonly repositories: () => string[],
    private readonly options: () => ReadonlyMap<string, ReferenceOptions>,
  ) {
    this.settled = toSignal(
      toObservable(computed(() => this.text())).pipe(debounceTime(400)),
      { initialValue: '' },
    );
  }

  /** The references to send with `text` (once {@link unresolved} is false). */
  requests(text: string): MessageReferenceRequest[] {
    const repositories = this.repositories();
    const bare = this.bare();
    return draftReferences(text, repositories, this.options(), (number) => {
      const resolution = bare.get(number);
      return resolution?.status === 'resolved'
        ? resolution.repository
        : (repositories[0] ?? null);
    });
  }
}

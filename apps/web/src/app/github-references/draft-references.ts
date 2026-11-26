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
  NO_OPTIONS,
  ReferenceDetails,
  resolveBare,
  type BareResolution,
  type ReferenceChipModel,
  type ReferenceOptions,
} from './references';

/** A reference of the text being written, as the input shows it. */
export type DraftReferenceEntry =
  | {
      kind: 'chip';
      key: string;
      chip: ReferenceChipModel;
      /** A `#12` still being looked up: its repository is not known yet. */
      pending: boolean;
    }
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
  /**
   * What the bare `#12` of the settled text refer to (several
   * repositories): every number that could be sent is looked up.
   */
  private readonly bare = computed(() => {
    const repositories = this.distinctRepositories();
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

  /**
   * The references as chips, or the choice of repository, in text order. A
   * `#12` of several repositories in a text that is only offered (the
   * prompt suggestion) is left out instead of asking.
   */
  readonly entries = computed<DraftReferenceEntry[]>(() =>
    this.choosable(this.resolve(this.settled(), this.bare())).map(
      (reference): DraftReferenceEntry => {
        const { resolution, request, key } = reference;
        if (resolution?.status === 'ambiguous') {
          return {
            kind: 'ambiguous',
            key,
            number: request.number,
            candidates: resolution.candidates,
          };
        }
        const pending = resolution?.status === 'pending';
        return {
          kind: 'chip',
          key,
          pending,
          chip: draftChip(
            request,
            pending
              ? { status: 'loading' }
              : this.details.get(request.repository, request.number)(),
          ),
        };
      },
    ),
  );

  /**
   * A bare `#12` that is sent is not yet known to refer to one repository
   * (just typed, still being looked up, or the user has to choose): the
   * message waits.
   */
  readonly unresolved = computed(() =>
    this.choosable(this.resolve(this.text(), this.bare())).some(
      ({ resolution }) =>
        resolution !== null && resolution.status !== 'resolved',
    ),
  );

  /**
   * @param text the text being written
   * @param repositories the session's GitHub repositories, the main one first
   * @param options comments and diffs chosen per reference
   * @param offered the text is only offered, not written (the prompt
   *   suggestion): an ambiguous `#12` is not asked about and not sent
   */
  constructor(
    private readonly text: () => string,
    private readonly repositories: () => string[],
    private readonly options: () => ReadonlyMap<string, ReferenceOptions>,
    private readonly offered: () => boolean = () => false,
  ) {
    this.settled = toSignal(
      toObservable(computed(() => this.text())).pipe(debounceTime(400)),
      { initialValue: '' },
    );
  }

  /** The references to send with `text` (once {@link unresolved} is false). */
  requests(text: string): MessageReferenceRequest[] {
    return this.choosable(this.resolve(text, this.bare())).map(({ request }) => {
      const { comments, diff, ...rest } = request;
      return {
        ...rest,
        ...(comments ? { comments: true } : {}),
        ...(diff ? { diff: true } : {}),
      };
    });
  }

  /** The repositories, each once (further clones name one again). */
  private readonly distinctRepositories = computed(() => [
    ...new Set(this.repositories()),
  ]);

  /** Leaves out the ambiguous references of an offered text. */
  private choosable<T extends { resolution: BareResolution | null }>(
    references: T[],
  ): T[] {
    return this.offered()
      ? references.filter(
          ({ resolution }) => resolution?.status !== 'ambiguous',
        )
      : references;
  }

  /**
   * The references of a text that are sent, each once, in order: what each
   * refers to, and for a bare `#12` with several repositories how far it is
   * resolved (a number not looked up yet is `pending`). Pending and
   * ambiguous ones count as their own reference (`#12`) until resolved.
   */
  private resolve(
    text: string,
    bare: ReadonlyMap<number, BareResolution>,
  ): {
    key: string;
    request: Required<MessageReferenceRequest>;
    resolution: BareResolution | null;
  }[] {
    const repositories = this.distinctRepositories();
    const options = this.options();
    const several = repositories.length > 1;
    const seen = new Set<string>();
    const resolved: {
      key: string;
      request: Required<MessageReferenceRequest>;
      resolution: BareResolution | null;
    }[] = [];
    for (const parsed of parseReferences(text, null)) {
      const resolution =
        parsed.repository || !several
          ? null
          : (bare.get(parsed.number) ?? { status: 'pending' as const });
      const repository =
        parsed.repository ??
        (resolution?.status === 'resolved'
          ? resolution.repository
          : repositories[0]);
      if (!repository) {
        continue;
      }
      const key =
        resolution && resolution.status !== 'resolved'
          ? `#${parsed.number}`
          : referenceKey(repository, parsed.number);
      if (seen.has(key)) {
        continue;
      }
      if (seen.size === MAX_REFERENCES_PER_MESSAGE) {
        break;
      }
      seen.add(key);
      const chosen = options.get(key) ?? NO_OPTIONS;
      resolved.push({
        key,
        resolution,
        request: {
          token: parsed.token,
          repository,
          number: parsed.number,
          comments: chosen.comments,
          diff: chosen.diff,
        },
      });
    }
    return resolved;
  }
}

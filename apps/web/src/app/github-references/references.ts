import { Injectable, inject, signal, type Signal } from '@angular/core';
import {
  MAX_REFERENCES_PER_MESSAGE,
  parseReferences,
  referenceKey,
  referenceUrl,
  type GitHubReferenceDetail,
  type GitHubReferenceKind,
  type GitHubReferenceState,
  type MessageReference,
  type MessageReferenceRequest,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ReferencesApi } from './references-api';

/** What a reference chip shows. */
export interface ReferenceChipModel {
  token: string;
  repository: string;
  number: number;
  /** `loading`: the composer is still asking GitHub. */
  status: 'loading' | 'resolved' | 'failed';
  kind: GitHubReferenceKind | null;
  title: string | null;
  state: GitHubReferenceState | null;
  draft: boolean;
  url: string;
  error: string | null;
  /** What was cut or left out of what Claude got (sent messages). */
  notes: string[];
  comments: boolean;
  diff: boolean;
}

/** What to give Claude of a reference besides title and description. */
export interface ReferenceOptions {
  comments: boolean;
  diff: boolean;
}

export const NO_OPTIONS: ReferenceOptions = { comments: false, diff: false };

export function chipOf(reference: MessageReference): ReferenceChipModel {
  return { ...reference };
}

/**
 * `open`, `draft`, `merged`, `closed`; for failed ones `not found` or
 * `unavailable`.
 */
export function stateLabel(chip: ReferenceChipModel): string {
  if (chip.status === 'loading') {
    return 'loading';
  }
  if (chip.status === 'failed' || !chip.state) {
    // A missing item, or GitHub could not be asked (rate limit, offline).
    return /not found|cannot access/i.test(chip.error ?? '')
      ? 'not found'
      : 'unavailable';
  }
  return chip.draft && chip.state === 'open' ? 'draft' : chip.state;
}

/** `name` of `owner/name`. */
export function repositoryName(fullName: string): string {
  return fullName.slice(fullName.indexOf('/') + 1);
}

/** GitHub repositories of a session, the main one first (for `#12`). */
export function sessionGitHubRepositories(
  session: SessionDto | null,
): string[] {
  return (session?.directories ?? [])
    .filter((directory) => directory.repository?.github)
    .map((directory) => directory.repository?.fullName ?? '');
}

/**
 * The references in a draft, each once, with the options chosen for it:
 * `owner/repo#12` refers to that repository, `#12` to the one
 * `repositoryOf` names (by default the first; `null` leaves it out).
 */
export function draftReferences(
  text: string,
  repositories: string[],
  options: ReadonlyMap<string, ReferenceOptions>,
  repositoryOf: (number: number) => string | null = () =>
    repositories[0] ?? null,
): MessageReferenceRequest[] {
  const seen = new Set<string>();
  const references: MessageReferenceRequest[] = [];
  for (const parsed of parseReferences(text, null)) {
    const repository = parsed.repository ?? repositoryOf(parsed.number);
    if (!repository) {
      continue;
    }
    const key = referenceKey(repository, parsed.number);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const chosen = options.get(key) ?? NO_OPTIONS;
    references.push({
      token: parsed.token,
      repository,
      number: parsed.number,
      ...(chosen.comments ? { comments: true } : {}),
      ...(chosen.diff ? { diff: true } : {}),
    });
  }
  return references.slice(0, MAX_REFERENCES_PER_MESSAGE);
}

/** The numbers of the bare `#12` references of a text, each once. */
export function bareNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const parsed of parseReferences(text, null)) {
    if (!parsed.repository) {
      numbers.add(parsed.number);
    }
  }
  return [...numbers].slice(0, MAX_REFERENCES_PER_MESSAGE);
}

/**
 * Writes every bare `#12` of a text as `owner/repo#12`, once the user
 * chose which repository it means.
 */
export function qualifyReference(
  text: string,
  number: number,
  repository: string,
): string {
  let result = text;
  for (const parsed of parseReferences(text, null).reverse()) {
    if (!parsed.repository && parsed.number === number) {
      result =
        result.slice(0, parsed.start) +
        `${repository}#${number}` +
        result.slice(parsed.end);
    }
  }
  return result;
}

/** What a bare `#12` refers to in a session with several repositories. */
export type BareResolution =
  | { status: 'pending' }
  | { status: 'resolved'; repository: string }
  | {
      status: 'ambiguous';
      candidates: { repository: string; detail: GitHubReferenceDetail }[];
    };

/**
 * `#12` in a session with several repositories: the repository that has
 * it, or the choice when several have it. When none has it (or GitHub
 * cannot be asked), the first repository, as for one repository.
 * `states` are the lookups of `#12` in `repositories`, in order.
 */
export function resolveBare(
  repositories: string[],
  states: DetailState[],
): BareResolution {
  if (states.some((state) => state.status === 'loading')) {
    return { status: 'pending' };
  }
  const candidates = repositories.flatMap((repository, index) => {
    const state = states[index];
    return state?.status === 'resolved'
      ? [{ repository, detail: state.detail }]
      : [];
  });
  if (candidates.length > 1) {
    return { status: 'ambiguous', candidates };
  }
  return {
    status: 'resolved',
    repository: candidates[0]?.repository ?? repositories[0],
  };
}

/** Options of sent references, to put a message back into the input. */
export function optionsOf(
  references: readonly MessageReference[],
): Map<string, ReferenceOptions> {
  return new Map(
    references.map((reference) => [
      referenceKey(reference.repository, reference.number),
      { comments: reference.comments, diff: reference.diff },
    ]),
  );
}

export type DetailState =
  | { status: 'loading' }
  | { status: 'resolved'; detail: GitHubReferenceDetail }
  | { status: 'failed'; error: string };

/** Details are asked again after this long. */
const DETAIL_TTL_MS = 60_000;

/** Issue and pull request details for chips, cached briefly. */
@Injectable({ providedIn: 'root' })
export class ReferenceDetails {
  private readonly api = inject(ReferencesApi);
  private readonly entries = new Map<
    string,
    { at: number; state: ReturnType<typeof signal<DetailState>> }
  >();

  get(repository: string, number: number): Signal<DetailState> {
    const key = referenceKey(repository, number);
    const cached = this.entries.get(key);
    if (
      cached &&
      (cached.state().status === 'loading' ||
        Date.now() - cached.at < DETAIL_TTL_MS)
    ) {
      return cached.state;
    }
    const state = cached?.state ?? signal<DetailState>({ status: 'loading' });
    this.entries.set(key, { at: Date.now(), state });
    this.api.detail(repository, number).subscribe({
      next: (detail) => state.set({ status: 'resolved', detail }),
      error: (error: unknown) =>
        state.set({
          status: 'failed',
          error: errorMessage(error, 'GitHub could not be asked'),
        }),
    });
    return state;
  }
}

/** A chip for a reference in the input, from its details. */
export function draftChip(
  request: MessageReferenceRequest,
  state: DetailState,
): ReferenceChipModel {
  const detail = state.status === 'resolved' ? state.detail : null;
  return {
    token: request.token,
    repository: request.repository,
    number: request.number,
    status: state.status,
    kind: detail?.kind ?? null,
    title: detail?.title ?? null,
    state: detail?.state ?? null,
    draft: detail?.draft ?? false,
    url: detail?.url ?? referenceUrl(request.repository, request.number, null),
    error: state.status === 'failed' ? state.error : null,
    notes: [],
    comments: request.comments ?? false,
    diff: request.diff ?? false,
  };
}

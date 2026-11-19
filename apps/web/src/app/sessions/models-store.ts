import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type {
  ModelListResponse,
  ModelOption,
} from '@claude-remote-manager/shared-types';

/** Until the list is loaded (or if it cannot be): Claude Code's aliases. */
export const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  {
    value: null,
    label: 'Default',
    description: "Claude Code's default",
    resolvedModel: null,
  },
  { value: 'opus', label: 'Opus', description: '', resolvedModel: null },
  { value: 'sonnet', label: 'Sonnet', description: '', resolvedModel: null },
  { value: 'haiku', label: 'Haiku', description: '', resolvedModel: null },
];

/** The models a session can use, loaded once from `GET /api/models`. */
@Injectable({ providedIn: 'root' })
export class ModelsStore {
  private readonly http = inject(HttpClient);
  private requested = false;

  readonly models = signal<ModelOption[]>(FALLBACK_MODEL_OPTIONS);
  readonly source = signal<ModelListResponse['source'] | 'loading'>('loading');

  load(): void {
    if (this.requested) {
      return;
    }
    this.requested = true;
    this.http.get<ModelListResponse>('/api/models').subscribe({
      next: (response) => {
        this.models.set(response.models);
        this.source.set(response.source);
      },
      error: () => {
        this.requested = false;
        this.source.set('fallback');
      },
    });
  }
}

/**
 * The model value as the options use it: Claude Code's `default` row stands
 * for not choosing a model (`null`), also where a session stored the name.
 */
export function normalizeModel(value: string | null): string | null {
  return value === 'default' ? null : value;
}

/** The options, plus `value` if it is not among them (e.g. an older model). */
export function modelOptionsWith(
  options: ModelOption[],
  model: string | null,
): ModelOption[] {
  const value = normalizeModel(model);
  return options.some((option) => option.value === value)
    ? options
    : [
        ...options,
        {
          value,
          label: value ?? 'Default',
          description: '',
          resolvedModel: null,
        },
      ];
}

/**
 * Display name of a model value outside the model choice (session list,
 * session strip): the default shows the model it currently resolves to
 * (e.g. "Opus 5.5"), not "Default (recommended)"; other values their label.
 * Only the choices themselves name the default as such.
 */
export function modelLabel(
  options: ModelOption[],
  model: string | null,
): string {
  const value = normalizeModel(model);
  const option = options.find((candidate) => candidate.value === value);
  if (value === null) {
    return option?.resolvedModel
      ? readableModelName(option.resolvedModel)
      : 'Default';
  }
  return option?.label ?? value;
}

const FAMILY_FIRST = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const VERSION_FIRST = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;

/**
 * A model ID as people say it: `claude-opus-5-5` → "Opus 5.5",
 * `claude-3-5-haiku-20241022` → "Haiku 3.5", a `[1m]` suffix → "(1M)".
 * IDs of another form stay as they are.
 */
export function readableModelName(id: string): string {
  const context = /\[1m\]$/i.test(id) ? ' (1M)' : '';
  const bare = id.replace(/\[1m\]$/i, '').toLowerCase();
  const familyFirst = FAMILY_FIRST.exec(bare);
  const versionFirst = familyFirst ? null : VERSION_FIRST.exec(bare);
  const [family, major, minor] = familyFirst
    ? [familyFirst[1], familyFirst[2], familyFirst[3]]
    : versionFirst
      ? [versionFirst[3], versionFirst[1], versionFirst[2]]
      : [null, null, null];
  if (!family || !major) {
    return id;
  }
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return `${name} ${major}${minor ? `.${minor}` : ''}${context}`;
}

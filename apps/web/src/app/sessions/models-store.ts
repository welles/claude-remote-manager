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

/** Display name of a model value among the options. */
export function modelLabel(
  options: ModelOption[],
  model: string | null,
): string {
  const value = normalizeModel(model);
  return (
    options.find((option) => option.value === value)?.label ??
    value ??
    'Default'
  );
}

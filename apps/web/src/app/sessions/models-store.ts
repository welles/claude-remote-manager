import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import {
  DEFAULT_ENGINE,
  type AgentEngineId,
  type ModelListResponse,
  type ModelOption,
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

/** Until an engine's list is loaded (or if it cannot be), per engine. */
export const FALLBACK_MODELS: Record<AgentEngineId, ModelOption[]> = {
  'claude-code': FALLBACK_MODEL_OPTIONS,
  codex: [
    {
      value: null,
      label: 'Default',
      description: "Codex's default",
      resolvedModel: null,
    },
  ],
};

interface EngineModels {
  models: ModelOption[];
  source: ModelListResponse['source'];
}

/**
 * The models a session of an engine can use, loaded once per engine from
 * `GET /api/models?engine=…` (Claude Code's without the parameter). Callers
 * that name no engine get Claude Code's.
 */
@Injectable({ providedIn: 'root' })
export class ModelsStore {
  private readonly http = inject(HttpClient);
  private readonly requested = new Set<AgentEngineId>();
  private readonly lists = signal<ReadonlyMap<AgentEngineId, EngineModels>>(
    new Map(),
  );

  /** The engine's models; its fallback list until loaded. */
  models(engine: AgentEngineId = DEFAULT_ENGINE): ModelOption[] {
    return (
      this.lists().get(engine)?.models ??
      FALLBACK_MODELS[engine] ??
      FALLBACK_MODEL_OPTIONS
    );
  }

  /** Where the engine's list came from (`loading` until known). */
  source(
    engine: AgentEngineId = DEFAULT_ENGINE,
  ): ModelListResponse['source'] | 'loading' {
    return this.lists().get(engine)?.source ?? 'loading';
  }

  /** Loads the engine's list unless it was (or is being) loaded. */
  load(engine: AgentEngineId = DEFAULT_ENGINE): void {
    if (this.requested.has(engine)) {
      return;
    }
    this.requested.add(engine);
    const url =
      engine === DEFAULT_ENGINE
        ? '/api/models'
        : `/api/models?engine=${encodeURIComponent(engine)}`;
    this.http.get<ModelListResponse>(url).subscribe({
      next: (response) =>
        this.set(engine, { models: response.models, source: response.source }),
      error: () => {
        // Tried again by the next caller; the fallback list meanwhile.
        this.requested.delete(engine);
        this.set(engine, { models: this.models(engine), source: 'fallback' });
      },
    });
  }

  private set(engine: AgentEngineId, entry: EngineModels): void {
    this.lists.update((lists) => new Map(lists).set(engine, entry));
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

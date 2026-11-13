import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { PreviewDto } from '@claude-remote-manager/shared-types';

/** REST client for previews (the list comes with the session). */
@Injectable({ providedIn: 'root' })
export class PreviewsApi {
  private readonly http = inject(HttpClient);

  /** Ends a preview's forwarding; the dev server keeps running. */
  stop(sessionId: string, previewId: string): Observable<PreviewDto> {
    return this.http.post<PreviewDto>(
      `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/stop`,
      {},
    );
  }
}

/** The preview's URL if it is an http(s) URL (the only ones linked or framed). */
export function previewHref(preview: PreviewDto): string | null {
  try {
    const url = new URL(preview.url);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const PREVIEW_STATE_LABELS: Record<PreviewDto['state'], string> = {
  running: 'Running',
  unreachable: 'Not reachable',
  stopped: 'Stopped',
};

/**
 * A preview as it is now: the session's current one with the same ID, or
 * the given one (e.g. from the history) as stopped.
 */
export function currentPreview(
  preview: PreviewDto,
  active: readonly PreviewDto[],
): PreviewDto {
  return (
    active.find((candidate) => candidate.id === preview.id) ?? {
      ...preview,
      state: 'stopped',
      problem: null,
    }
  );
}

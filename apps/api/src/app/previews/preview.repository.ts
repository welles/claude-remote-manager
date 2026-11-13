import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PreviewStopper } from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { previews, type PreviewRow } from '../db/schema';

/** Previews of dev servers (see `previews` in the schema). */
@Injectable()
export class PreviewRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** All previews that are not stopped. */
  active(): PreviewRow[] {
    return this.db
      .select()
      .from(previews)
      .where(isNull(previews.stoppedAt))
      .orderBy(asc(previews.createdAt))
      .all();
  }

  activeForSession(sessionId: string): PreviewRow[] {
    return this.db
      .select()
      .from(previews)
      .where(and(eq(previews.sessionId, sessionId), isNull(previews.stoppedAt)))
      .orderBy(asc(previews.createdAt))
      .all();
  }

  activeByLabel(label: string): PreviewRow | null {
    return (
      this.db
        .select()
        .from(previews)
        .where(and(eq(previews.label, label), isNull(previews.stoppedAt)))
        .get() ?? null
    );
  }

  activeByPort(port: number): PreviewRow | null {
    return (
      this.db
        .select()
        .from(previews)
        .where(and(eq(previews.port, port), isNull(previews.stoppedAt)))
        .get() ?? null
    );
  }

  /** The latest preview with this label, also a stopped one. */
  latestByLabel(label: string): PreviewRow | null {
    return (
      this.db
        .select()
        .from(previews)
        .where(eq(previews.label, label))
        .orderBy(asc(previews.createdAt))
        .all()
        .at(-1) ?? null
    );
  }

  get(id: string): PreviewRow | null {
    return (
      this.db.select().from(previews).where(eq(previews.id, id)).get() ?? null
    );
  }

  /** Adds an active preview; throws if the port is exposed already. */
  add(preview: {
    sessionId: string;
    port: number;
    name: string;
    label: string;
  }): PreviewRow {
    return this.db
      .insert(previews)
      .values({ id: randomUUID(), ...preview })
      .returning()
      .get();
  }

  rename(id: string, name: string): PreviewRow {
    return this.db
      .update(previews)
      .set({ name })
      .where(eq(previews.id, id))
      .returning()
      .get();
  }

  /** Marks an active preview stopped; `null` if it was not active. */
  stop(id: string, by: PreviewStopper, now = new Date()): PreviewRow | null {
    return (
      this.db
        .update(previews)
        .set({ stoppedAt: now, stoppedBy: by })
        .where(and(eq(previews.id, id), isNull(previews.stoppedAt)))
        .returning()
        .get() ?? null
    );
  }
}

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PushSubscriptionDto } from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { pushSubscriptions, type PushSubscriptionRow } from '../db/schema';

/** Web Push subscriptions, one per browser or device. */
@Injectable()
export class PushSubscriptionRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  list(): PushSubscriptionRow[] {
    return this.db
      .select()
      .from(pushSubscriptions)
      .orderBy(pushSubscriptions.createdAt)
      .all();
  }

  /**
   * Adds a subscription, or updates the keys and label of the one with the
   * same endpoint (a device subscribing again).
   */
  upsert(subscription: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string;
  }): PushSubscriptionRow {
    return this.db
      .insert(pushSubscriptions)
      .values({ id: randomUUID(), ...subscription })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          label: subscription.label,
          lastError: null,
        },
      })
      .returning()
      .get();
  }

  remove(id: string): boolean {
    return (
      this.db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.id, id))
        .run().changes > 0
    );
  }

  removeByEndpoint(endpoint: string): boolean {
    return (
      this.db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .run().changes > 0
    );
  }

  recordResult(id: string, error: string | null, now = new Date()): void {
    this.db
      .update(pushSubscriptions)
      .set(
        error === null
          ? { lastSuccessAt: now, lastError: null }
          : { lastError: error },
      )
      .where(eq(pushSubscriptions.id, id))
      .run();
  }
}

export function pushSubscriptionDto(
  row: PushSubscriptionRow,
): PushSubscriptionDto {
  return {
    id: row.id,
    label: row.label,
    pushService: new URL(row.endpoint).host,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

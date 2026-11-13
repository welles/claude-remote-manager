import { Inject, Injectable } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { DATABASE, type AppDatabase } from '../db/database';
import { webhookDeliveries } from '../db/schema';

/** Deliveries are remembered this long (GitHub redelivers for days). */
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Processed webhook deliveries, so redeliveries and duplicates are ignored. */
@Injectable()
export class WebhookDeliveryRepository {
  private prunedAt = 0;

  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** Records a delivery; `false` when it was seen before. */
  record(id: string, event: string, now = new Date()): boolean {
    if (now.getTime() - this.prunedAt > 60 * 60_000) {
      this.prunedAt = now.getTime();
      this.db
        .delete(webhookDeliveries)
        .where(
          lt(
            webhookDeliveries.receivedAt,
            new Date(now.getTime() - DELIVERY_RETENTION_MS),
          ),
        )
        .run();
    }
    const result = this.db
      .insert(webhookDeliveries)
      .values({ id, event, receivedAt: now })
      .onConflictDoNothing()
      .run();
    return result.changes > 0;
  }
}

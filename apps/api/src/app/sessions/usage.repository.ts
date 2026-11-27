import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { UsageTotals } from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { usageRecords } from '../db/schema';

/** Usage of one model, either per request or summed. */
export type ModelUsageAmounts = UsageTotals;

export const EMPTY_USAGE: Readonly<UsageTotals> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0,
});

const sums = {
  inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
  cacheCreationInputTokens: sql<number>`coalesce(sum(${usageRecords.cacheCreationInputTokens}), 0)`,
  cacheReadInputTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadInputTokens}), 0)`,
  costUsd: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)`,
};

@Injectable()
export class UsageRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /**
   * Stores the usage of one request, one row per model; `reviewId` for
   * the request of an independent review.
   */
  record(
    sessionId: string,
    sdkSessionId: string | null,
    byModel: Record<string, ModelUsageAmounts>,
    now = new Date(),
    reviewId: string | null = null,
    accountId: string | null = null,
  ): void {
    const rows = Object.entries(byModel).map(([model, usage]) => ({
      sessionId,
      sdkSessionId,
      reviewId,
      accountId,
      model,
      ...usage,
      createdAt: now,
    }));
    if (rows.length > 0) {
      this.db.insert(usageRecords).values(rows).run();
    }
  }

  /** Summed usage of one session. */
  totalsForSession(sessionId: string): UsageTotals {
    return (
      this.totalsBySession([sessionId]).get(sessionId) ?? { ...EMPTY_USAGE }
    );
  }

  /** Summed usage per session; sessions without usage are missing. */
  totalsBySession(sessionIds?: string[]): Map<string, UsageTotals> {
    if (sessionIds?.length === 0) {
      return new Map();
    }
    const query = this.db
      .select({ sessionId: usageRecords.sessionId, ...sums })
      .from(usageRecords)
      .groupBy(usageRecords.sessionId);
    const rows = sessionIds
      ? query.where(inArray(usageRecords.sessionId, sessionIds)).all()
      : query.all();
    return new Map(rows.map(({ sessionId, ...totals }) => [sessionId, totals]));
  }

  /**
   * Summed usage of the session's Claude Code process per model (without
   * independent reviews): where the totals of its result messages start.
   */
  totalsByModel(sessionId: string): Record<string, UsageTotals> {
    const rows = this.db
      .select({ model: usageRecords.model, ...sums })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.sessionId, sessionId),
          isNull(usageRecords.reviewId),
        ),
      )
      .groupBy(usageRecords.model)
      .all();
    return Object.fromEntries(
      rows.map(({ model, ...totals }) => [model, totals]),
    );
  }
}

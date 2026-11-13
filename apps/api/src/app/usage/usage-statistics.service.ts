import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, gte, lt } from 'drizzle-orm';
import {
  USAGE_GRANULARITIES,
  USAGE_GROUPS,
  type UsageGranularity,
  type UsageGroupBy,
  type UsageSeries,
  type UsageStatistics,
  type UsageTotals,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { deletedSessions, usageRecords } from '../db/schema';
import { SessionRepository } from '../sessions/session.repository';
import { EMPTY_USAGE } from '../sessions/usage.repository';
import {
  bucketOf,
  bucketsBetween,
  dayNumber,
  defaultFrom,
  isDate,
  isTimeZone,
  localDateFormatter,
} from './calendar';

/** Most buckets one answer may have (a year of days). */
export const MAX_BUCKETS = 400;

const DAY_MS = 86_400_000;

function add(target: UsageTotals, row: UsageTotals): void {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheCreationInputTokens += row.cacheCreationInputTokens;
  target.cacheReadInputTokens += row.cacheReadInputTokens;
  target.costUsd += row.costUsd;
}

/** What a session is in the statistics. */
interface SessionInfo {
  label: string;
  repositories: string[];
  state: 'deleted' | 'archived' | null;
  exists: boolean;
}

export interface UsageQuery {
  granularity?: unknown;
  groupBy?: unknown;
  tz?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Usage over time, by day, ISO week or month, split by session, by the
 * session's repositories or by model. Day boundaries are those of the
 * time zone the caller names (the browser's), UTC if it names none or
 * one this runtime does not know. A session with several repositories
 * counts once, under all of them together (e.g. `acme/app + acme/lib`),
 * so the groups add up to the total. Deleted sessions keep their usage
 * under the title and repositories they had.
 */
@Injectable()
export class UsageStatisticsService {
  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly sessions: SessionRepository,
  ) {}

  statistics(query: UsageQuery, now = Date.now()): UsageStatistics {
    const granularity = (
      USAGE_GRANULARITIES.includes(query.granularity as UsageGranularity)
        ? query.granularity
        : 'day'
    ) as UsageGranularity;
    const groupBy = (
      USAGE_GROUPS.includes(query.groupBy as UsageGroupBy)
        ? query.groupBy
        : 'session'
    ) as UsageGroupBy;
    const timeZone = isTimeZone(query.tz) ? query.tz : 'UTC';
    const localDate = localDateFormatter(timeZone);
    const today = localDate(now);
    for (const name of ['from', 'to'] as const) {
      if (query[name] !== undefined && !isDate(query[name])) {
        throw new BadRequestException(`${name} must be a date (YYYY-MM-DD)`);
      }
    }
    const to = (query.to as string | undefined) ?? today;
    const from =
      (query.from as string | undefined) ?? defaultFrom(to, granularity);
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }
    const buckets = bucketsBetween(from, to, granularity);
    if (buckets.length > MAX_BUCKETS) {
      throw new BadRequestException(
        `The range has too many ${granularity}s; choose a shorter one or a coarser granularity`,
      );
    }
    const index = new Map(
      buckets.map((bucket, position) => [bucket, position]),
    );
    // Local days lie within a day of the UTC day with the same date.
    const rows = this.db
      .select()
      .from(usageRecords)
      .where(
        and(
          gte(usageRecords.createdAt, new Date((dayNumber(from) - 1) * DAY_MS)),
          lt(usageRecords.createdAt, new Date((dayNumber(to) + 2) * DAY_MS)),
        ),
      )
      .all();
    const sessionInfo = this.sessionInfo();
    const series = new Map<string, UsageSeries>();
    const totals = { ...EMPTY_USAGE };
    const requests = new Set<string>();
    for (const row of rows) {
      const date = localDate(row.createdAt.getTime());
      if (date < from || date > to) {
        continue;
      }
      const position = index.get(bucketOf(date, granularity));
      if (position === undefined) {
        continue;
      }
      const info = sessionInfo.get(row.sessionId) ?? {
        label: 'Unknown session',
        repositories: [],
        state: null,
        exists: false,
      };
      const key =
        groupBy === 'model'
          ? row.model
          : groupBy === 'session'
            ? row.sessionId
            : info.repositories.join(' + ') || '';
      let entry = series.get(key);
      if (!entry) {
        entry = {
          key,
          label:
            groupBy === 'model'
              ? row.model
              : groupBy === 'session'
                ? info.label
                : key || 'No repository (scratch)',
          state: groupBy === 'session' ? info.state : null,
          sessionId:
            groupBy === 'session' && info.exists ? row.sessionId : null,
          totals: { ...EMPTY_USAGE },
          values: buckets.map(() => ({ ...EMPTY_USAGE })),
        };
        series.set(key, entry);
      }
      add(entry.values[position], row);
      add(entry.totals, row);
      add(totals, row);
      requests.add(`${row.sessionId}@${row.createdAt.getTime()}`);
    }
    const round = (value: UsageTotals) => {
      value.costUsd = Math.round(value.costUsd * 1e6) / 1e6;
    };
    for (const entry of series.values()) {
      round(entry.totals);
      entry.values.forEach(round);
    }
    round(totals);
    return {
      granularity,
      groupBy,
      timeZone,
      from,
      to,
      buckets,
      series: [...series.values()].sort(
        (a, b) =>
          b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label),
      ),
      totals,
      requests: requests.size,
    };
  }

  private sessionInfo(): Map<string, SessionInfo> {
    const info = new Map<string, SessionInfo>();
    for (const row of this.db.select().from(deletedSessions).all()) {
      info.set(row.id, {
        label: row.title || 'Untitled session',
        repositories: row.repositories,
        state: 'deleted',
        exists: false,
      });
    }
    for (const session of this.sessions.list('include')) {
      info.set(session.id, {
        label: session.title || 'Untitled session',
        repositories: session.directories.flatMap((directory) =>
          directory.repositoryName ? [directory.repositoryName] : [],
        ),
        state: session.archivedAt ? 'archived' : null,
        exists: true,
      });
    }
    return info;
  }
}

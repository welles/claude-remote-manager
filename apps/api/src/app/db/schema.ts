import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  SessionPermissionMode,
  SessionStatus,
} from '@claude-remote-manager/shared-types';

/**
 * Database schema. Only metadata lives here; Claude Code stores the
 * conversation transcripts itself. Change the schema, then run
 * `npm run db:generate` to create the SQL migration.
 */

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  /** Claude Code session ID used for resuming; known after the first start. */
  sdkSessionId: text('sdk_session_id'),
  title: text('title'),
  model: text('model'),
  permissionMode: text('permission_mode')
    .$type<SessionPermissionMode>()
    .notNull()
    .default('default'),
  status: text('status').$type<SessionStatus>().notNull(),
  /** Working directory of the session. */
  cwd: text('cwd').notNull(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Directories a session may access besides its working directory, in order.
 * Later steps link worktrees of further repositories here.
 */
export const sessionDirectories = sqliteTable(
  'session_directories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    path: text('path').notNull(),
  },
  (table) => [
    uniqueIndex('session_directories_session_position').on(
      table.sessionId,
      table.position,
    ),
  ],
);

/**
 * Token usage and theoretical API cost per request (one result message of
 * Claude Code) and model.
 */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Claude Code session the request ran in. */
    sdkSessionId: text('sdk_session_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull(),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('usage_records_session').on(table.sessionId),
    index('usage_records_created_at').on(table.createdAt),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;

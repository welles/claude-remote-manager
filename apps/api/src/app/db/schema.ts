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
  SessionDirectoryState,
  SessionPermissionMode,
  SessionStatus,
  SetupStatus,
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

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

/**
 * Registered repositories. Each has one shared bare clone at `local_path`
 * (`REPOS_DIR/<owner>/<name>`); sessions get worktrees of it.
 */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    cloneUrl: text('clone_url').notNull(),
    /** Default branch of the remote as last fetched. */
    defaultBranch: text('default_branch'),
    localPath: text('local_path').notNull(),
    /** Shell script run in each new worktree, e.g. `npm ci`. */
    setupScript: text('setup_script'),
    /** GitHub repository ID, for the GitHub integration. */
    githubRepositoryId: integer('github_repository_id'),
    /** GitHub App installation that grants access to the repository. */
    githubInstallationId: integer('github_installation_id'),
    /** When the shared clone was created; `null` while not cloned. */
    clonedAt: timestamp('cloned_at'),
    fetchedAt: timestamp('fetched_at'),
    /** Error of the last clone or fetch. */
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('repositories_owner_name').on(table.owner, table.name),
    uniqueIndex('repositories_local_path').on(table.localPath),
  ],
);

/** New projects without a repository: `PROJECTS_DIR/<name>`. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  path: text('path').notNull().unique(),
  /** Repository created for the project later (GitHub integration). */
  repositoryId: text('repository_id').references(() => repositories.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
});

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
  /**
   * Unique readable name for worktree directories and branches
   * (`claude/<slug>`); `null` for sessions from before worktrees.
   */
  slug: text('slug').unique(),
  /**
   * First message while it waits for the preparation (worktrees, setup
   * scripts); cleared when it is handed to Claude Code.
   */
  pendingMessage: text('pending_message', { mode: 'json' }).$type<{
    id: string;
    text: string;
  }>(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Directories of a session in order: position 0 is the working directory
 * (the main repository's worktree or the new project), the others are
 * additional directories. A row with `repository_id` is a worktree of that
 * repository on `branch`, created from `base_branch` at `base_commit`; a
 * row with `project_id` is a new project; rows with neither are plain
 * directories (sessions from before worktrees).
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
    repositoryId: text('repository_id').references(() => repositories.id),
    projectId: text('project_id').references(() => projects.id),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    baseCommit: text('base_commit'),
    state: text('state')
      .$type<SessionDirectoryState>()
      .notNull()
      .default('ready'),
    setupStatus: text('setup_status')
      .$type<SetupStatus>()
      .notNull()
      .default('none'),
  },
  (table) => [
    uniqueIndex('session_directories_session_position').on(
      table.sessionId,
      table.position,
    ),
    uniqueIndex('session_directories_session_repository').on(
      table.sessionId,
      table.repositoryId,
    ),
    uniqueIndex('session_directories_repository_branch').on(
      table.repositoryId,
      table.branch,
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

/**
 * Session events that are not in the Claude Code transcript (permission
 * decisions, errors, notices, turn results, context usage), so that the
 * history survives restarts. Conversation events come from the transcript.
 * `anchor_uuid` is the transcript entry the event followed; `anchor_user_id`
 * the user message of the turn, as a fallback for placing the event.
 */
export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** The event without `seq` and `at`, as JSON. */
    payload: text('payload').notNull(),
    anchorUuid: text('anchor_uuid'),
    anchorUserId: text('anchor_user_id'),
    createdAt: createdAt(),
  },
  (table) => [index('session_events_session').on(table.sessionId, table.id)],
);

export type RepositoryRow = typeof repositories.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionDirectoryRow = typeof sessionDirectories.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;

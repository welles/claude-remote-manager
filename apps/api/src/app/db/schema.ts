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
  PreviewStopper,
  PullRequestCreator,
  PullRequestState,
  RepositoryAddedBy,
  RepositoryAdditionState,
  SessionDirectoryKind,
  SessionDirectoryState,
  SessionPermissionMode,
  SessionStatus,
  SessionTitleSource,
  SetupStatus,
  ShownFileKind,
  ShownFileOrigin,
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
 * Registered repositories and local projects. Each has a mirror at
 * `local_path` (`<workspace>/repos/<owner>/<name>`): a bare repository that
 * is cloned once and then only fetched; sessions clone it. `clone_url` is
 * `null` for a local project without remote (owner `local`).
 */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    cloneUrl: text('clone_url'),
    /** Default branch as last fetched (`main` for local projects). */
    defaultBranch: text('default_branch'),
    localPath: text('local_path').notNull(),
    /** Shell script run in each new session clone, e.g. `npm ci`. */
    setupScript: text('setup_script'),
    /** GitHub repository ID, for the GitHub integration. */
    githubRepositoryId: integer('github_repository_id'),
    /** GitHub App installation that grants access to the repository. */
    githubInstallationId: integer('github_installation_id'),
    /** When the mirror was created; `null` while it does not exist. */
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

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  /** Claude Code session ID used for resuming; known after the first start. */
  sdkSessionId: text('sdk_session_id'),
  title: text('title'),
  /**
   * Where the title comes from: the first message (`prompt`), the user
   * (`user`: a title given when creating, or a rename) or Claude's tool
   * `set_session_title` (`claude`). Claude never replaces a user's title.
   */
  titleSource: text('title_source')
    .$type<SessionTitleSource>()
    .notNull()
    .default('prompt'),
  model: text('model'),
  permissionMode: text('permission_mode')
    .$type<SessionPermissionMode>()
    .notNull()
    .default('default'),
  status: text('status').$type<SessionStatus>().notNull(),
  /**
   * Unique readable name for the session's directories and branches
   * (`claude/<slug>`); `null` for sessions from before session clones.
   */
  slug: text('slug').unique(),
  /**
   * First message while it is not sent to Claude Code yet: during the
   * preparation, and after a failed setup script until the user decides.
   */
  pendingMessage: text('pending_message', { mode: 'json' }).$type<{
    id: string;
    text: string;
  }>(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  /**
   * When autoclose ended the session after its pull requests were merged
   * or closed; clones still `ready` afterwards were kept on purpose (work
   * that is not on GitHub).
   */
  autoclosedAt: timestamp('autoclosed_at'),
  /**
   * When the session was archived: hidden from the default list, history
   * readable, ended; `null` while not archived.
   */
  archivedAt: timestamp('archived_at'),
});

/**
 * Sessions deleted for good, so that their usage stays attributable: the
 * title and repositories as they were when the session was deleted. The
 * `usage_records` of a deleted session keep its ID.
 */
export const deletedSessions = sqliteTable('deleted_sessions', {
  id: text('id').primaryKey(),
  title: text('title'),
  /** Full names (`owner/name`) of its repositories in order, as JSON. */
  repositories: text('repositories', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  /** When the session was created. */
  createdAt: timestamp('created_at').notNull(),
  deletedAt: timestamp('deleted_at').notNull(),
});

/**
 * GitHub webhook deliveries already processed (`X-GitHub-Delivery`), so a
 * redelivery or duplicate does nothing. Pruned after a week.
 */
export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  receivedAt: timestamp('received_at').notNull(),
});

/**
 * Directories of a session in order: position 0 is the working directory,
 * the others are additional directories.
 * - `clone`: the session's own clone of `repository_id` on `branch`,
 *   created from `base_branch` of the mirror at `base_commit`;
 * - `scratch`: an empty directory of the session without git;
 * - `directory`: a plain directory (sessions from before session clones).
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
    kind: text('kind')
      .$type<SessionDirectoryKind>()
      .notNull()
      .default('directory'),
    repositoryId: text('repository_id').references(() => repositories.id),
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
    /** Commit of the session branch last pushed by the app (or Claude). */
    pushedCommit: text('pushed_commit'),
    pushedAt: timestamp('pushed_at'),
    /**
     * Set for a repository added while the session ran (`null`: the
     * session started with it), with who added it, where the addition
     * stands (`addition_state`, see `RepositoryAdditionState`; directories
     * that are not `ready` there are not given to Claude) and why it
     * failed or is held.
     */
    addedAt: timestamp('added_at'),
    addedBy: text('added_by').$type<RepositoryAddedBy>(),
    additionState: text('addition_state').$type<RepositoryAdditionState>(),
    additionError: text('addition_error'),
    /**
     * Claude has not been told about the added repository yet (path,
     * branch, base branch): the app says so with the next message.
     */
    announce: integer('announce', { mode: 'boolean' }).notNull().default(false),
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
  ],
);

/**
 * Pull requests of session clones: a session can have several, one (or,
 * over time, more) per repository it changed. Created by the user (button)
 * or by Claude (tool `create_pull_request`); the state is refreshed from
 * GitHub (later also by webhooks, for the PR automation).
 */
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    state: text('state').$type<PullRequestState>().notNull(),
    draft: integer('draft', { mode: 'boolean' }).notNull().default(false),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    createdBy: text('created_by').$type<PullRequestCreator>().notNull(),
    /** When it was opened on GitHub. */
    openedAt: timestamp('opened_at').notNull(),
    closedAt: timestamp('closed_at'),
    mergedAt: timestamp('merged_at'),
    /** Last time the state was read from GitHub. */
    syncedAt: timestamp('synced_at').notNull(),
    createdAt: createdAt(),
    /** Head commit on GitHub as last read (CI failures count only for it). */
    headSha: text('head_sha'),
    // --- PR automation (both off by default) ------------------------------
    /** Autofix: failed checks and review feedback continue the session. */
    autofix: integer('autofix', { mode: 'boolean' }).notNull().default(false),
    /** Autoclose: merged or closed ends the session and removes clones. */
    autoclose: integer('autoclose', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Autofix runs allowed for this pull request. */
    autofixMaxAttempts: integer('autofix_max_attempts').notNull().default(3),
    /** Autofix runs started so far (reset only by the user). */
    autofixAttempts: integer('autofix_attempts').notNull().default(0),
    /** When the limit stopped a run and the user was told; cleared on reset. */
    autofixGaveUpAt: timestamp('autofix_gave_up_at'),
    /** Head commit whose failed checks a run was started for already. */
    autofixCiHandledSha: text('autofix_ci_handled_sha'),
    /** Reviews and review comments after this time are new. */
    autofixReviewsAfter: timestamp('autofix_reviews_after'),
    /** Last autofix run: start and what triggered it (`ci`, `review`). */
    autofixLastRunAt: timestamp('autofix_last_run_at'),
    autofixLastTrigger: text('autofix_last_trigger'),
    /** An autofix run is going on (its turn has not ended yet). */
    autofixRunning: integer('autofix_running', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** When the merge or close was handled (notification, autoclose). */
    closeHandledAt: timestamp('close_handled_at'),
  },
  (table) => [
    uniqueIndex('pull_requests_repository_number').on(
      table.repositoryId,
      table.number,
    ),
    index('pull_requests_session').on(table.sessionId),
  ],
);

/**
 * Token usage and theoretical API cost per request (one result message of
 * Claude Code) and model. Kept when its session is deleted (no foreign
 * key): `deleted_sessions` says what the session was.
 */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
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

/**
 * Settings of the app that the user edits in the UI (not secrets: those
 * come from the environment). One row per setting, the value as JSON.
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/**
 * Images attached to user messages. The file is
 * `<filesDir>/attachments/<id>` (owned by the API, not readable by
 * sessions). Uploaded before the message is sent; `session_id` and
 * `message_id` are set when a message (or a new session's first message)
 * takes it. Unclaimed uploads are removed after a day.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => sessions.id, {
      onDelete: 'cascade',
    }),
    /** ID of the user message (also the transcript entry's UUID). */
    messageId: text('message_id'),
    /** Position in the message. */
    position: integer('position').notNull().default(0),
    name: text('name'),
    mediaType: text('media_type').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('attachments_message').on(table.sessionId, table.messageId),
  ],
);

/**
 * Files put in front of the user (tool `show_file`, images Claude read or
 * wrote). The snapshot of the content is `<filesDir>/shown/<id>` (owned by
 * the API, not reachable by sessions) when `snapshot` is set; larger files
 * keep only this row and are served from `path` while it exists.
 */
export const shownFiles = sqliteTable(
  'shown_files',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    toolUseId: text('tool_use_id'),
    origin: text('origin').$type<ShownFileOrigin>().notNull(),
    /** Real path at the time it was shown. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    caption: text('caption'),
    kind: text('kind').$type<ShownFileKind>().notNull(),
    mediaType: text('media_type').notNull(),
    language: text('language'),
    size: integer('size').notNull(),
    snapshot: integer('snapshot', { mode: 'boolean' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('shown_files_session').on(table.sessionId)],
);

/**
 * Browsers and devices that receive Web Push notifications, one row per
 * push subscription (endpoint and the keys to encrypt for it). Removed
 * when the push service reports the subscription gone.
 */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** Readable device name from the user agent. */
  label: text('label').notNull(),
  createdAt: createdAt(),
  lastSuccessAt: timestamp('last_success_at'),
  lastError: text('last_error'),
});

/**
 * What the app gave Claude with a user message besides the message itself:
 * the GitHub issues and pull requests it references (as resolved when it
 * was sent, for the chips) and the untrusted context text exactly as
 * Claude got it. Also marks messages the app composed itself (`origin`
 * `app`, e.g. the PR automation). One row per message that has any of it.
 */
export const messageContexts = sqliteTable(
  'message_contexts',
  {
    /** ID of the user message (also the transcript entry's UUID). */
    messageId: text('message_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** `user` or `app`. */
    origin: text('origin').$type<'user' | 'app'>().notNull(),
    /** `MessageReference[]` as JSON. */
    references: text('references').notNull(),
    /**
     * UUID of the context message in the Claude Code transcript (sent
     * before the user message); `null` without context.
     */
    contextId: text('context_id'),
    /** The context text Claude got; `null` without. */
    context: text('context'),
    createdAt: createdAt(),
  },
  (table) => [index('message_contexts_session').on(table.sessionId)],
);

/**
 * Previews of dev servers (tool `expose_port`): the session's port is
 * forwarded from the host name `<label>.<preview domain>` while
 * `stopped_at` is null. A port is exposed by at most one session at a
 * time; the label (`<session slug>-<port>`) is therefore unique among
 * active previews too.
 */
export const previews = sqliteTable(
  'previews',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    port: integer('port').notNull(),
    name: text('name').notNull(),
    /** First label of the host name, `<session slug>-<port>`. */
    label: text('label').notNull(),
    createdAt: createdAt(),
    stoppedAt: timestamp('stopped_at'),
    stoppedBy: text('stopped_by').$type<PreviewStopper>(),
  },
  (table) => [
    uniqueIndex('previews_active_port')
      .on(table.port)
      .where(sql`${table.stoppedAt} is null`),
    index('previews_session').on(table.sessionId),
    index('previews_label').on(table.label),
  ],
);

/**
 * Conversation text of sessions for the full-text search: the user's
 * messages and Claude's answers (top-level text blocks), rebuilt from a
 * session's history whenever it is loaded and added to as the session
 * runs. `folded` is the text in lower case (Unicode), which the FTS5 table
 * `search_index` (trigram tokenizer, external content, kept in sync by
 * triggers; created in the migration, not by drizzle) indexes.
 */
export const searchDocuments = sqliteTable(
  'search_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** `user` or `assistant`. */
    kind: text('kind').$type<'user' | 'assistant'>().notNull(),
    /** ID of the user message, or of Claude's message. */
    anchor: text('anchor').notNull(),
    /** SHA-1 of the text: the same text of the same message is stored once. */
    hash: text('hash').notNull(),
    text: text('text').notNull(),
    folded: text('folded').notNull(),
  },
  (table) => [
    uniqueIndex('search_documents_unique').on(
      table.sessionId,
      table.anchor,
      table.hash,
    ),
  ],
);

/**
 * What the search index of a session was built from: the transcript's
 * size and modification time (or `missing`), so a transcript that changed
 * or disappeared while the server was down is indexed again at startup.
 */
export const searchSessions = sqliteTable('search_sessions', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  indexedAt: timestamp('indexed_at').notNull(),
});

export type RepositoryRow = typeof repositories.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionDirectoryRow = typeof sessionDirectories.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ShownFileRow = typeof shownFiles.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type MessageContextRow = typeof messageContexts.$inferSelect;
export type PreviewRow = typeof previews.$inferSelect;
export type DeletedSessionRow = typeof deletedSessions.$inferSelect;

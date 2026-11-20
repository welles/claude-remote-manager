import type { GitHubPermissionGap } from '@claude-remote-manager/shared-types';
import type { GitHubPermission } from './installation-tokens';

/** A permission the app needs, and why (shown when it is missing). */
interface RequiredPermission {
  permission: GitHubPermission;
  access: 'read' | 'write';
  usedFor: string;
}

/**
 * The repository permissions the app needs (README "GitHub"), one per
 * permission a token can ask for (a new one fails to compile until it is
 * listed here). A token cannot get more than this.
 */
const REQUIRED: Record<
  GitHubPermission,
  Omit<RequiredPermission, 'permission'>
> = {
  metadata: {
    access: 'read',
    usedFor: "listing the installations' repositories",
  },
  contents: {
    access: 'write',
    usedFor: 'cloning, fetching, pushing and merging',
  },
  pull_requests: {
    access: 'write',
    usedFor: 'creating, reading and merging pull requests, review threads',
  },
  workflows: {
    access: 'write',
    usedFor: 'pushing changes to .github/workflows',
  },
  administration: {
    access: 'write',
    usedFor: 'creating repositories for local projects in organizations',
  },
  issues: {
    access: 'read',
    usedFor: '# references and comments on pull requests',
  },
  checks: {
    access: 'read',
    usedFor: 'CI checks of pull requests (PR automation)',
  },
  statuses: {
    access: 'read',
    usedFor: 'commit statuses of pull requests (PR automation)',
  },
  actions: {
    access: 'read',
    usedFor: 'logs of failed GitHub Actions jobs (autofix)',
  },
};

export const REQUIRED_PERMISSIONS: readonly RequiredPermission[] =
  Object.entries(REQUIRED).map(([permission, rest]) => ({
    permission: permission as GitHubPermission,
    ...rest,
  }));

/**
 * Webhook events the PR automation follows (README "PR automation"); only
 * needed when a webhook secret is configured, else it polls.
 */
export const REQUIRED_EVENTS: readonly string[] = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'issue_comment',
  'check_run',
  'check_suite',
  'status',
];

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** The required permissions `granted` (GitHub's map) lacks or has too low. */
export function permissionGaps(
  granted: Record<string, string> | undefined,
): GitHubPermissionGap[] {
  return REQUIRED_PERMISSIONS.filter(
    ({ permission, access }) =>
      (RANK[granted?.[permission] ?? ''] ?? 0) < RANK[access],
  ).map(({ permission, access, usedFor }) => ({
    permission,
    needed: access,
    granted: granted?.[permission] ?? null,
    usedFor,
  }));
}

/** The required webhook events `subscribed` lacks. */
export function missingEvents(subscribed: string[] | undefined): string[] {
  const events = new Set(subscribed ?? []);
  return REQUIRED_EVENTS.filter((event) => !events.has(event));
}

/** One line per gap, for logs. */
export function describeGap(gap: GitHubPermissionGap): string {
  return `${gap.permission}: ${gap.needed} needed, ${gap.granted ?? 'none'} granted (${gap.usedFor})`;
}

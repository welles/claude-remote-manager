import type {
  AutofixTrigger,
  PullRequestDto,
} from '@claude-remote-manager/shared-types';
import type { PullRequestRecord } from './session.repository';

export function pullRequestDto(pull: PullRequestRecord): PullRequestDto {
  return {
    id: pull.id,
    repositoryId: pull.repositoryId,
    repository: pull.repositoryName,
    number: pull.number,
    url: pull.url,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    headBranch: pull.headBranch,
    baseBranch: pull.baseBranch,
    createdBy: pull.createdBy,
    openedAt: pull.openedAt.toISOString(),
    closedAt: pull.closedAt?.toISOString() ?? null,
    mergedAt: pull.mergedAt?.toISOString() ?? null,
    syncedAt: pull.syncedAt.toISOString(),
    automation: {
      autofix: pull.autofix,
      autoclose: pull.autoclose,
      attempts: pull.autofixAttempts,
      maxAttempts: pull.autofixMaxAttempts,
      gaveUp: pull.autofixGaveUpAt !== null,
      running: pull.autofixRunning,
      lastRunAt: pull.autofixLastRunAt?.toISOString() ?? null,
      lastTrigger: (pull.autofixLastTrigger as AutofixTrigger | null) ?? null,
    },
  };
}

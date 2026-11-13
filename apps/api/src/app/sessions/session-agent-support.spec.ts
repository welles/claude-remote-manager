import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import type { AgentTool } from '../agent/agent-runner';
import { commitFile, git } from '../git/testing/git-fixtures';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { CREATE_PULL_REQUEST_TOOL_NAME } from './approval-grants';
import { NO_APPROVAL_UI_MESSAGE } from './sessions.service';
import { flush, waitFor } from './testing/fake-agent';

describe('session integrations (credentials, tool, memory)', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });
  afterEach(() => harness.close());

  /** A GitHub repository whose remote is a local repository. */
  const githubRepository = async (name = 'app') => {
    const repository = await harness.addRepository('alice', name);
    const installation = harness.github.addInstallation('alice');
    const remote = harness.github.addRepository(installation, name);
    harness.repositoryRecords.update(repository.id, {
      githubRepositoryId: remote.id,
      githubInstallationId: installation.id,
    });
    harness.github.headExists = (_, head) => {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${head}`], {
          cwd: repository.origin,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    return repository;
  };

  const start = async (repositoryId: string | null): Promise<SessionDto> => {
    const session = await harness.service.create({
      prompt: 'Work',
      title: 'Improve',
      ...(repositoryId
        ? { repositories: [{ repositoryId }] }
        : { scratch: true }),
    });
    await harness.prepared(session.id);
    return harness.service.get(session.id);
  };

  const options = () => harness.runner.last.options;
  const tool = (name: string): AgentTool => {
    const found = options().tools?.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(`no tool ${name}`);
    }
    return found;
  };
  const ask = (
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    mcpServer?: { name: string; source: string },
  ) =>
    (options().canUseTool as CanUseTool)(toolName, input, {
      signal: new AbortController().signal,
      toolUseID,
      requestId: 'r',
      ...(mcpServer ? { mcpServer } : {}),
    });

  it('gives the process a session token, the push ask rule and the repository’s memory', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);

    const env = options().env ?? {};
    expect(env['CRM_API_URL']).toBe(harness.config.internalApiUrl);
    expect(harness.sessionCredentials.resolve(env['CRM_SESSION_TOKEN'])).toBe(
      session.id,
    );
    const memory = join(harness.config.memoryDir, repository.id);
    expect(options().settings).toEqual({
      permissions: { ask: ['Bash(git push:*)'] },
      autoMemoryDirectory: memory,
    });
    expect(existsSync(memory)).toBe(true);
    expect(
      options().tools?.map((entry) => [entry.name, entry.alwaysAsk]),
    ).toEqual([['create_pull_request', true]]);
    expect(
      await git(session.cwd, 'config', '--get-all', 'credential.helper'),
    ).toMatch(/^\n?.*git-credential-crm\.cjs'$/);

    // A second session of the repository shares the memory directory.
    await start(repository.id);
    expect(options().settings?.['autoMemoryDirectory']).toBe(memory);
  });

  it('keeps Claude Code’s default memory and no tools for scratch sessions', async () => {
    await start(null);
    expect(options().settings).toEqual({
      permissions: { ask: ['Bash(git push:*)'] },
    });
    expect(options().tools).toEqual([]);
  });

  it('revokes the session token when the process ends', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    const token = options().env?.['CRM_SESSION_TOKEN'];
    await harness.service.end(session.id);
    await waitFor(() => harness.sessionCredentials.resolve(token) === null);
  });

  it('runs create_pull_request only after the user approved that call', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    await commitFile(session.cwd, 'work.txt', 'w');
    const input = { title: 'Add work', body: 'Done' };
    const sdk = { name: 'crm', source: 'sdk' };

    // Today: denied without dialog, visibly; the tool refuses to run.
    await expect(
      ask(CREATE_PULL_REQUEST_TOOL_NAME, input, 'tu-1', sdk),
    ).resolves.toEqual({ behavior: 'deny', message: NO_APPROVAL_UI_MESSAGE });
    const denied = await tool('create_pull_request').handler(input);
    expect(denied).toMatchObject({ isError: true });
    expect(denied.text).toContain('not approved');
    expect(harness.github.pulls).toHaveLength(0);
    expect(harness.eventsOfType(session.id, 'permission.denied')).toHaveLength(
      1,
    );

    // With a (fake) approval, after Claude pushed the branch.
    harness.approver.answer = () => ({ behavior: 'allow' });
    await harness.sessionGit.push(session.id, repository.id);
    await expect(
      ask(CREATE_PULL_REQUEST_TOOL_NAME, input, 'tu-2', sdk),
    ).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(harness.approver.requests.at(-1)).toMatchObject({
      sessionId: session.id,
      toolName: CREATE_PULL_REQUEST_TOOL_NAME,
      toolUseId: 'tu-2',
      mcpServer: sdk,
    });
    const created = await tool('create_pull_request').handler(input);
    expect(created.isError).toBeUndefined();
    expect(created.text).toContain('https://github.com/alice/app/pull/1');
    expect(harness.service.get(session.id).pullRequests).toEqual([
      expect.objectContaining({ createdBy: 'claude', title: 'Add work' }),
    ]);

    // One approval, one call.
    expect((await tool('create_pull_request').handler(input)).isError).toBe(
      true,
    );
  });

  it('names the repository when the call is ambiguous or foreign', async () => {
    const first = await githubRepository('app');
    const second = await githubRepository('lib');
    const session = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: first.id }, { repositoryId: second.id }],
    });
    await harness.prepared(session.id);
    harness.approver.answer = () => ({ behavior: 'allow' });
    const call = async (input: Record<string, unknown>) => {
      await ask(CREATE_PULL_REQUEST_TOOL_NAME, input, 't', {
        name: 'crm',
        source: 'sdk',
      });
      return tool('create_pull_request').handler(input);
    };
    await expect(call({ title: 'x' })).rejects.toThrow('Name the repository');
    await expect(call({ title: 'x', repository: 'bob/app' })).rejects.toThrow(
      'not a GitHub repository of this session',
    );
  });

  it('grants a push from its approval until Claude Code reports its result', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    harness.approver.answer = () => ({ behavior: 'allow' });
    await ask('Bash', { command: 'git push -u origin HEAD' }, 'push-1');
    expect(harness.grants.hasPushGrant(session.id)).toBe(true);

    harness.runner.last.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'push-1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
    });
    await flush();
    await waitFor(() => !harness.grants.hasPushGrant(session.id));
  });

  it('records a push Claude made from the remote-tracking branch', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    const commit = await commitFile(session.cwd, 'work.txt', 'w');
    harness.approver.answer = () => ({ behavior: 'allow' });
    await ask('Bash', { command: 'git push' }, 'push-1');
    // What Claude's push does (here without credentials: a local remote).
    await git(
      session.cwd,
      'push',
      '--quiet',
      'origin',
      `HEAD:refs/heads/claude/${session.slug}`,
    );
    await git(session.cwd, 'fetch', '--quiet', 'origin');
    harness.support.toolFinished(session.id, 'push-1');
    await waitFor(
      () =>
        harness.service.get(session.id).directories[0].pushedCommit === commit,
    );
  });
});

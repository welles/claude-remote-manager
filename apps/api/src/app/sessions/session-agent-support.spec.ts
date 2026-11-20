import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import type { AgentTool } from '../agent/agent-runner';
import { commitFile, git } from '../git/testing/git-fixtures';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import {
  CREATE_PULL_REQUEST_TOOL_NAME,
  REPLY_TO_REVIEW_THREAD_TOOL_NAME,
  SHOW_FILE_TOOL_NAME,
} from './app-tools';
import { SESSION_SETTINGS } from './session-agent-support';
import { pngImage } from '../attachments/testing/images';
import { flush, resultMessage, waitFor } from './testing/fake-agent';

describe('session integrations (tools, memory, pushes)', () => {
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

  it("gives the process the repository's memory and the user's own git credentials", async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);

    // No credentials of the app: git uses the user's own.
    expect(Object.keys(options().env ?? {})).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^CRM_/)]),
    );
    const memory = join(harness.config.memoryDir, repository.id);
    expect(options().settings).toEqual({
      ...SESSION_SETTINGS,
      autoMemoryDirectory: memory,
    });
    // Nothing of the user's settings is overridden: bypass mode, MCP
    // servers and claude.ai connectors are as in a terminal.
    expect(SESSION_SETTINGS).not.toHaveProperty('permissions');
    expect(SESSION_SETTINGS).not.toHaveProperty('disableClaudeAiConnectors');
    expect(existsSync(memory)).toBe(true);
    expect(options().tools?.map((entry) => entry.name)).toEqual([
      'show_file',
      'create_pull_request',
      'reply_to_review_thread',
      'request_owner_decision',
      'set_session_title',
      'set_waiting_state',
      'add_repository',
    ]);
    // Showing a file, setting the title and the waiting state, and asking
    // for the owner's decision (it only pauses automerge) never ask.
    expect(options().allowedTools).toContain('mcp__crm__show_file');
    expect(options().allowedTools).toContain('mcp__crm__set_session_title');
    expect(options().allowedTools).toContain('mcp__crm__set_waiting_state');
    expect(options().allowedTools).toContain(
      'mcp__crm__request_owner_decision',
    );
    await expect(
      git(session.cwd, 'config', '--local', '--get-all', 'credential.helper'),
    ).rejects.toThrow();

    // A second session of the repository shares the memory directory.
    await start(repository.id);
    expect(options().settings?.['autoMemoryDirectory']).toBe(memory);
  });

  it('appends the session instructions of the machine to the system prompt', async () => {
    const file = join(harness.config.memoryDir, '..', 'instructions.md');
    writeFileSync(file, '# This machine\n\nMARKER\n');
    harness.config.sessionInstructionsFile = file;
    await start(null);
    expect(options().instructions).toBe('# This machine\n\nMARKER');
    harness.config.sessionInstructionsFile = join(file, 'missing');
    await start(null);
    expect(options().instructions).toBeUndefined();
  });

  it('keeps Claude Code’s default memory and gives scratch sessions show_file and add_repository', async () => {
    await start(null);
    expect(options().settings).toEqual(SESSION_SETTINGS);
    expect(options().tools?.map((entry) => entry.name)).toEqual([
      'show_file',
      'set_session_title',
      'set_waiting_state',
      'add_repository',
    ]);
  });

  it('shows files with show_file, without asking, as events of the session', async () => {
    const session = await start(null);
    writeFileSync(join(session.cwd, 'report.md'), '# Done\n');
    // Claude Code allows the tool by rule; canUseTool would allow it too.
    await expect(
      ask(SHOW_FILE_TOOL_NAME, { path: 'report.md' }, 'tu-s', {
        name: 'crm',
        source: 'sdk',
      }),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { path: 'report.md' },
    });
    expect(harness.approver.requests).toHaveLength(0);

    const result = await tool('show_file').handler(
      { path: 'report.md', caption: 'Summary' },
      { toolUseId: 'tu-s' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Shown to the user');
    await waitFor(
      () => harness.eventsOfType(session.id, 'file.shown').length === 1,
    );
    expect(harness.eventsOfType(session.id, 'file.shown')[0]).toMatchObject({
      toolUseId: 'tu-s',
      file: { name: 'report.md', caption: 'Summary', kind: 'markdown' },
    });

    // Outside the session: refused, nothing shown.
    const outside = await tool('show_file').handler(
      { path: '/etc/passwd' },
      { toolUseId: 'tu-o' },
    );
    expect(outside).toMatchObject({ isError: true });
    expect(outside.text).toContain('not inside the session');
  });

  it('shows images Claude read or wrote on their tool calls', async () => {
    const session = await start(null);
    writeFileSync(
      join(session.cwd, 'chart.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    harness.runner.last.emit(
      {
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: join(session.cwd, 'shot.png') },
            },
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: { file_path: join(session.cwd, 'chart.svg'), content: '' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'read-1', content: [] },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: {
          type: 'image',
          file: {
            base64: pngImage().toString('base64'),
            type: 'image/png',
            originalSize: 10,
          },
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'write-1', content: 'Done' },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: {
          type: 'create',
          filePath: join(session.cwd, 'chart.svg'),
          content: '',
          structuredPatch: [],
          originalFile: null,
        },
      },
    );
    await waitFor(
      () => harness.eventsOfType(session.id, 'file.shown').length === 2,
    );
    expect(
      harness
        .eventsOfType(session.id, 'file.shown')
        .map((event) => [
          event.toolUseId,
          event.file.origin,
          event.file.mediaType,
        ])
        .sort(),
    ).toEqual([
      ['read-1', 'read', 'image/png'],
      ['write-1', 'write', 'image/svg+xml'],
    ]);
  });

  it('runs create_pull_request as the permission mode says, like any tool', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    await commitFile(session.cwd, 'work.txt', 'w');
    const input = { title: 'Add work', body: 'Done' };
    const sdk = { name: 'crm', source: 'sdk' };

    // When Claude Code asks, the request shows the pull request with the
    // defaults the tool uses.
    harness.approver.autoAnswer = { decision: 'deny', message: 'Not yet' };
    await expect(
      ask(CREATE_PULL_REQUEST_TOOL_NAME, input, 'tu-1', sdk),
    ).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Not yet'),
    });
    expect(
      harness.eventsOfType(session.id, 'permission.request').at(-1),
    ).toMatchObject({
      kind: 'tool',
      pullRequest: {
        repository: 'alice/app',
        title: 'Add work',
        body: 'Done',
        base: 'main',
        draft: false,
      },
    });
    expect(harness.github.pulls).toHaveLength(0);

    // A call the permission mode let through (nothing asked) runs.
    await harness.sessionGit.push(session.id, repository.id);
    const created = await tool('create_pull_request').handler(input, {
      toolUseId: 'tu-2',
    });
    expect(created.isError).toBeUndefined();
    expect(created.text).toContain('https://github.com/alice/app/pull/1');
    expect(harness.service.get(session.id).pullRequests).toEqual([
      expect.objectContaining({ createdBy: 'claude', title: 'Add work' }),
    ]);
  });

  describe('reply_to_review_thread', () => {
    /**
     * A session with pull request #1 (created by its tool) whose review
     * threads have the first comments 501 and 601.
     */
    const withPullRequest = async () => {
      const repository = await githubRepository();
      const session = await start(repository.id);
      await commitFile(session.cwd, 'work.txt', 'w');
      await harness.sessionGit.push(session.id, repository.id);
      await tool('create_pull_request').handler(
        { title: 'Add work' },
        { toolUseId: 'tu-pr' },
      );
      const remoteId = harness.repositoryRecords.get(repository.id)
        ?.githubRepositoryId as number;
      const threads = [
        { resolved: false, author: 'bob', body: 'Fix this', commentIds: [501] },
        {
          resolved: false,
          author: 'bob',
          body: 'And this',
          commentIds: [601, 602],
        },
      ];
      harness.github.reviewThreads.set(`${remoteId}#1`, threads);
      const reply = (input: Record<string, unknown>) =>
        tool('reply_to_review_thread').handler(input, { toolUseId: 'tu-r' });
      return { repository, session, remoteId, threads, reply };
    };

    it('replies, resolves, or both, on the session’s own pull request', async () => {
      const { remoteId, threads, reply } = await withPullRequest();

      const replied = await reply({
        pull_request: 1,
        comment_id: 501,
        body: 'Fixed in abc123',
      });
      expect(replied.isError).toBeUndefined();
      expect(replied.text).toContain(
        'Replied on the review thread of alice/app#1: https://github.com/alice/app/pull/1#discussion_r',
      );
      expect(harness.github.reviewReplies).toEqual([
        expect.objectContaining({
          repositoryId: remoteId,
          number: 1,
          commentId: 501,
          body: 'Fixed in abc123',
        }),
      ]);
      expect(threads[0].resolved).toBe(false);

      // Only resolving; also by a later comment of the thread.
      const resolved = await reply({
        pull_request: 1,
        comment_id: 602,
        resolve: true,
      });
      expect(resolved).toEqual({
        text: 'Resolved the thread on alice/app#1.',
      });
      expect(threads[1].resolved).toBe(true);
      expect(harness.github.reviewReplies).toHaveLength(1);

      // Both; the repository named.
      const both = await reply({
        repository: 'alice/app',
        pull_request: 1,
        comment_id: 501,
        body: 'Done',
        resolve: true,
      });
      expect(both.isError).toBeUndefined();
      expect(both.text).toMatch(/^Replied .* Resolved the thread/);
      expect(threads[0].resolved).toBe(true);
      expect(harness.github.reviewReplies).toHaveLength(2);
      expect(harness.github.resolvedThreads).toHaveLength(2);

      // Again: nothing to resolve any more.
      await expect(
        reply({ pull_request: 1, comment_id: 501, resolve: true }),
      ).resolves.toEqual({
        text: 'The thread on alice/app#1 was resolved already.',
      });
      expect(harness.github.resolvedThreads).toHaveLength(2);

      // With tokens for exactly this repository, writing pull requests only.
      const tokens = harness.github.requests
        .filter(
          (request) =>
            /\/replies$/.test(request.path) || request.path === '/graphql',
        )
        .map((request) => request.auth);
      expect(tokens.length).toBeGreaterThan(0);
      for (const auth of tokens) {
        expect(auth).toMatchObject({
          repositoryIds: [remoteId],
          permissions: { pull_requests: 'write' },
        });
      }
    });

    it('refuses pull requests of others and calls without a reply or resolve', async () => {
      const { remoteId, reply } = await withPullRequest();
      harness.github.pulls.push({
        ...harness.github.pulls[0],
        number: 2,
        head: 'someone-else',
      });
      harness.github.reviewThreads.set(`${remoteId}#2`, [
        { resolved: false, author: 'bob', body: 'x', commentIds: [701] },
      ]);
      const before = harness.github.requests.length;

      const foreign = await reply({
        pull_request: 2,
        comment_id: 701,
        body: 'Hi',
        resolve: true,
      });
      expect(foreign.isError).toBe(true);
      expect(foreign.text).toContain(
        'alice/app#2 is not a pull request of this session',
      );
      expect(foreign.text).toContain('#1');
      const empty = await reply({ pull_request: 1, comment_id: 501 });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('Give a reply');
      const repository = await reply({
        repository: 'bob/app',
        pull_request: 1,
        comment_id: 501,
        body: 'Hi',
      });
      expect(repository.isError).toBe(true);
      expect(repository.text).toContain(
        'not a GitHub repository of this session',
      );
      // Nothing reached GitHub.
      expect(harness.github.requests.length).toBe(before);
      expect(harness.github.reviewReplies).toHaveLength(0);
    });

    it('says when the comment is in no thread, before replying', async () => {
      const { threads, reply } = await withPullRequest();
      const resolving = await reply({
        pull_request: 1,
        comment_id: 999,
        body: 'Fixed',
        resolve: true,
      });
      expect(resolving).toEqual({
        isError: true,
        text: expect.stringContaining(
          'No review thread of alice/app#1 has the comment 999',
        ),
      });
      expect(harness.github.reviewReplies).toHaveLength(0);
      const replying = await reply({
        pull_request: 1,
        comment_id: 999,
        body: 'Fixed',
      });
      expect(replying.isError).toBe(true);
      expect(replying.text).toContain(
        'No review thread of alice/app#1 has the comment 999',
      );
      expect(harness.github.reviewReplies).toHaveLength(0);
      expect(threads.every((thread) => !thread.resolved)).toBe(true);
    });

    it('replies to the first comment of the thread when named by a later one', async () => {
      const { reply } = await withPullRequest();
      // GitHub refuses replies to replies.
      const replied = await reply({
        pull_request: 1,
        comment_id: 602,
        body: 'Fixed in abc123',
      });
      expect(replied.isError).toBeUndefined();
      expect(harness.github.reviewReplies).toEqual([
        expect.objectContaining({ commentId: 601, body: 'Fixed in abc123' }),
      ]);
    });

    it('refuses a comment of another pull request, also for a reply only', async () => {
      const { remoteId, threads, reply } = await withPullRequest();
      harness.github.pulls.push({
        ...harness.github.pulls[0],
        number: 2,
        head: 'someone-else',
      });
      const foreign = {
        resolved: false,
        author: 'bob',
        body: 'x',
        commentIds: [701],
      };
      harness.github.reviewThreads.set(`${remoteId}#2`, [foreign]);
      harness.github.reviewItems.set(`${remoteId}#2`, [
        {
          kind: 'review_comment',
          id: 701,
          author: 'bob',
          body: 'x',
          createdAt: '2026-11-20T10:00:00Z',
        },
      ]);
      for (const input of [
        { pull_request: 1, comment_id: 701, body: 'Fixed' },
        { pull_request: 1, comment_id: 701, body: 'Fixed', resolve: true },
        { pull_request: 1, comment_id: 701, resolve: true },
      ]) {
        const result = await reply(input);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(
          'No review thread of alice/app#1 has the comment 701',
        );
      }
      expect(harness.github.reviewReplies).toHaveLength(0);
      expect(foreign.resolved).toBe(false);
      expect(threads.every((thread) => !thread.resolved)).toBe(true);
    });

    it('passes GitHub’s refusals on as tool errors', async () => {
      const { threads, reply } = await withPullRequest();
      const forbidden = new Response(
        JSON.stringify({ message: 'Resource not accessible by integration' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
      harness.github.intercept = (request) =>
        /\/replies$/.test(request.path) ? forbidden.clone() : undefined;
      const replying = await reply({
        pull_request: 1,
        comment_id: 501,
        body: 'Fixed',
      });
      expect(replying.isError).toBe(true);
      expect(replying.text).toContain('Resource not accessible by integration');

      // GraphQL reports errors with status 200.
      harness.github.intercept = (request) =>
        request.path === '/graphql' &&
        JSON.stringify(request.body).includes('resolveReviewThread')
          ? new Response(
              JSON.stringify({
                data: { resolveReviewThread: null },
                errors: [{ message: 'Resource not accessible by integration' }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : undefined;
      const resolving = await reply({
        pull_request: 1,
        comment_id: 501,
        resolve: true,
      });
      expect(resolving).toEqual({
        isError: true,
        text: expect.stringContaining(
          'GitHub did not resolve the review thread: Resource not accessible by integration',
        ),
      });
      // A reply that went out is named when resolving fails.
      harness.github.intercept = (request) =>
        request.path === '/graphql' &&
        JSON.stringify(request.body).includes('resolveReviewThread')
          ? forbidden.clone()
          : undefined;
      const both = await reply({
        pull_request: 1,
        comment_id: 501,
        body: 'Fixed',
        resolve: true,
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain(
        'Replied (https://github.com/alice/app/pull/1',
      );
      expect(both.text).toContain('but the thread was not resolved');
      expect(threads[0].resolved).toBe(false);

      // Any GraphQL error counts, also with data and without a message.
      harness.github.intercept = (request) =>
        request.path === '/graphql'
          ? new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        pageInfo: { hasNextPage: false },
                        nodes: [],
                      },
                    },
                  },
                },
                errors: [{}],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : undefined;
      const partial = await reply({
        pull_request: 1,
        comment_id: 501,
        body: 'Fixed',
      });
      expect(partial).toEqual({
        isError: true,
        text: expect.stringContaining('GitHub did not list the review threads'),
      });
    });

    it('asks as the permission mode says, but not during an Autofix run', async () => {
      const { session } = await withPullRequest();
      const sdk = { name: 'crm', source: 'sdk' };
      const input = {
        pull_request: 1,
        comment_id: 501,
        body: 'Fixed in abc123',
        resolve: true,
      };
      // Not pre-approved: in the default mode Claude Code asks.
      expect(options().allowedTools).not.toContain(
        REPLY_TO_REVIEW_THREAD_TOOL_NAME,
      );
      harness.approver.autoAnswer = { decision: 'deny', message: 'Not yet' };
      await expect(
        ask(REPLY_TO_REVIEW_THREAD_TOOL_NAME, input, 'tu-1', sdk),
      ).resolves.toMatchObject({ behavior: 'deny' });
      expect(
        harness.eventsOfType(session.id, 'permission.request').at(-1),
      ).toMatchObject({
        reviewThreadReply: {
          repository: 'alice/app',
          pullRequest: 1,
          commentId: 501,
          body: 'Fixed in abc123',
          resolve: true,
        },
      });
      const gate = options().gate;
      if (!gate) {
        throw new Error('no gate');
      }
      const call = (mcpServer: { name: string; source: string } | null) =>
        gate({
          toolName: REPLY_TO_REVIEW_THREAD_TOOL_NAME,
          input,
          toolUseId: 'tu-g',
          agentId: null,
          mcpServer,
        });
      expect(call(sdk)).toBeNull();

      // An Autofix run: it runs without asking.
      harness.runner.last.emit(resultMessage(1, 0));
      await flush();
      await harness.service.sendMessage(session.id, {
        text: 'Fix the review findings',
        origin: 'app',
        holdAutoMode: true,
      });
      await waitFor(() =>
        harness.runner.last.sent.some((message) =>
          message.text.includes('Fix the review findings'),
        ),
      );
      const asked = harness.approver.requests.length;
      // Not sent to the user by the gate, and allowed when Claude Code asks.
      expect(call(sdk)).toBeNull();
      await expect(
        ask(REPLY_TO_REVIEW_THREAD_TOOL_NAME, input, 'tu-2', sdk),
      ).resolves.toEqual({ behavior: 'allow', updatedInput: input });
      expect(harness.approver.requests).toHaveLength(asked);
      // A tool of that name from another server is not the app's.
      const other = { name: 'crm', source: 'user' };
      expect(call(other)).toMatchObject({ decision: 'ask' });
      // Other actions still ask during the run.
      expect(
        gate({
          toolName: CREATE_PULL_REQUEST_TOOL_NAME,
          input: {},
          toolUseId: 'tu-c',
          agentId: null,
          mcpServer: sdk,
        }),
      ).toMatchObject({ decision: 'ask' });
    });
  });

  it('names the repository when the call is ambiguous or foreign', async () => {
    const first = await githubRepository('app');
    const second = await githubRepository('lib');
    const session = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: first.id }, { repositoryId: second.id }],
    });
    await harness.prepared(session.id);
    harness.approver.autoAnswer = { decision: 'allow' };
    const call = async (input: Record<string, unknown>) => {
      await ask(CREATE_PULL_REQUEST_TOOL_NAME, input, 't', {
        name: 'crm',
        source: 'sdk',
      });
      return tool('create_pull_request').handler(input, { toolUseId: null });
    };
    await expect(call({ title: 'x' })).rejects.toThrow('Name the repository');
    await expect(call({ title: 'x', repository: 'bob/app' })).rejects.toThrow(
      'not a GitHub repository of this session',
    );
  });

  it('shows what a push targets when Claude Code asks for it', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    harness.approver.autoAnswer = { decision: 'allow' };
    await ask('Bash', { command: 'git push -u origin HEAD' }, 'push-1');
    expect(harness.approver.requests.at(-1)?.gitPushes).toEqual([
      expect.objectContaining({ sessionBranchOnly: true, warnings: [] }),
    ]);
    await ask(
      'Bash',
      { command: 'git push --force origin HEAD:main' },
      'push-x',
    );
    expect(harness.approver.requests.at(-1)?.gitPushes[0].warnings).toEqual([
      'Pushes to main, not only the session branch',
      'Force push: may overwrite commits on the remote',
    ]);
    await ask('Bash', { command: 'npm test' }, 'other');
    expect(harness.approver.requests.at(-1)?.gitPushes).toEqual([]);
    expect(harness.eventsOfType(session.id, 'permission.request')).toHaveLength(
      3,
    );
  });

  it('records a push Claude made, asked or not, from the remote-tracking branch', async () => {
    const repository = await githubRepository();
    const session = await start(repository.id);
    const commit = await commitFile(session.cwd, 'work.txt', 'w');
    // What Claude's push does (here without credentials: a local remote).
    await git(
      session.cwd,
      'push',
      '--quiet',
      'origin',
      `HEAD:refs/heads/claude/${session.slug}`,
    );
    await git(session.cwd, 'fetch', '--quiet', 'origin');
    harness.runner.last.emit(
      {
        type: 'assistant',
        message: {
          id: 'm-push',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'push-1',
              name: 'Bash',
              input: { command: 'git push -u origin HEAD' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'push-1', content: 'ok' },
          ],
        },
        parent_tool_use_id: null,
      },
    );
    await waitFor(
      () =>
        harness.service.get(session.id).directories[0].pushedCommit === commit,
    );
  });
});

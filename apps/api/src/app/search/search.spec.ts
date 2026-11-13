import type { SessionDto } from '@claude-remote-manager/shared-types';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { fold, likePattern, queryTerms, snippet } from './search-text';
import { SearchService } from './search.service';

describe('search text', () => {
  it('splits queries into folded words without any syntax', () => {
    expect(queryTerms('  Fix   the LOGIN  ')).toEqual(['fix', 'the', 'login']);
    expect(queryTerms('"a AND b" OR NOT c*')).toEqual([
      '"a',
      'and',
      'b"',
      'or',
      'not',
      'c*',
    ]);
    expect(queryTerms('Größe GRÖSSE')).toEqual(['größe', 'grösse']);
    expect(queryTerms('x '.repeat(20))).toEqual(['x']);
    expect(queryTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(queryTerms('   ')).toEqual([]);
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('100%_done\\')).toBe('%100\\%\\_done\\\\%');
  });

  it('maps folded offsets back to the text', () => {
    // "İ" lower-cases to two characters.
    const { folded, map } = fold('İx');
    expect(folded).toBe('i̇x');
    expect(map[folded.indexOf('x')]).toBe(1);
  });

  it('cuts snippets around the first match and marks every word', () => {
    const text = `${'word '.repeat(40)}the Login failed after LOGIN retry ${'tail '.repeat(60)}`;
    const match = snippet('assistant', text, ['login'], 'm1');
    expect(match.snippet.startsWith('…')).toBe(true);
    expect(match.snippet.endsWith('…')).toBe(true);
    expect(
      match.highlights.map(([from, to]) => match.snippet.slice(from, to)),
    ).toEqual(['Login', 'LOGIN']);
    expect(match.anchor).toBe('m1');
  });
});

describe('SearchService', () => {
  let harness: WorkspaceHarness;
  let search: SearchService;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    search = new SearchService(
      harness.db,
      harness.service,
      harness.sessions,
      harness.transcripts,
    );
    search.onModuleInit();
  });

  afterEach(async () => {
    await search.onModuleDestroy();
    await harness.close();
  });

  /** A scratch session with a first turn: prompt and Claude's answer. */
  const session = async (
    prompt: string,
    answer: string,
    title = 'A session',
  ): Promise<SessionDto> => {
    const created = await harness.service.create({
      prompt,
      scratch: true,
      title,
    });
    await harness.prepared(created.id);
    harness.runner.last.emit(
      { type: 'system', subtype: 'init', session_id: created.id },
      {
        type: 'assistant',
        uuid: `uuid-${created.id}`,
        parent_tool_use_id: null,
        message: {
          id: `msg-${created.id}`,
          content: [{ type: 'text', text: answer }],
        },
      },
      resultMessage(10, 0.01),
    );
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    return harness.service.get(created.id);
  };

  const ids = (query: string) =>
    search.search(query).hits.map((hit) => hit.sessionId);

  it('finds the owner’s messages and Claude’s answers as they arrive', async () => {
    const first = await session(
      'Why does the login fail?',
      'The token expires after 5 minutes.',
    );
    const second = await session('Add a dark mode', 'Done: dark mode added.');

    expect(ids('login')).toEqual([first.id]);
    const hit = search.search('TOKEN expires').hits[0];
    expect(hit).toMatchObject({
      sessionId: first.id,
      matches: [
        {
          kind: 'assistant',
          anchor: `msg-${first.id}`,
          snippet: 'The token expires after 5 minutes.',
          highlights: [
            [4, 9],
            [10, 17],
          ],
        },
      ],
    });
    expect(search.search('dark').hits[0].matches[0]).toMatchObject({
      kind: 'user',
      anchor: expect.any(String),
    });
    expect(ids('dark')).toEqual([second.id]);
    // Words must occur in the same message.
    expect(ids('login dark')).toEqual([]);
  });

  it('matches titles, repositories and branches, archived sessions too', async () => {
    const repository = await harness.addRepository('acme', 'widgets');
    const created = await harness.service.create({
      prompt: 'Hello',
      title: 'Größere Knöpfe',
      repositories: [{ repositoryId: repository.id }],
    });
    await harness.prepared(created.id);
    const slug = harness.service.get(created.id).slug ?? '';

    expect(search.search('GRÖSSERE').hits).toEqual([]);
    expect(search.search('größere knöpfe').hits[0].matches[0]).toMatchObject({
      kind: 'title',
      highlights: [
        [0, 7],
        [8, 14],
      ],
    });
    expect(ids('ÄCME/widg')).toEqual([]);
    expect(ids('acme/widg')).toEqual([created.id]);
    expect(search.search(slug).hits[0].matches[0].kind).toBe('branch');

    harness.runner.last.emit(resultMessage(1, 0));
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    await harness.service.end(created.id);
    harness.service.setArchived(created.id, new Date());
    expect(search.search('widgets').hits[0]).toMatchObject({
      sessionId: created.id,
      archivedAt: expect.any(String),
    });
    await harness.service.update(created.id, { title: 'Renamed' });
    expect(ids('knöpfe')).toEqual([]);
    expect(ids('renamed')).toEqual([created.id]);
  });

  it('takes any input as plain words, never as syntax', async () => {
    const one = await session('100% done_x for "quotes" (a OR b)', 'ok');
    const hostile = [
      '"',
      '"unbalanced',
      '*',
      'NEAR(a b)',
      'a OR',
      '(',
      ')',
      '^',
      ':',
      'col:val',
      '\\',
      "' OR 1=1 --",
      '%',
      '_',
      '\0',
      '🙂',
      'x'.repeat(5000),
    ];
    for (const query of hostile) {
      expect(() => search.search(query)).not.toThrow();
    }
    expect(ids('%')).toEqual([one.id]);
    expect(ids('_x')).toEqual([one.id]);
    expect(ids('"quotes"')).toEqual([one.id]);
    expect(ids('(a or')).toEqual([one.id]);
    expect(ids('100%')).toEqual([one.id]);
    // "_" is not a wildcard: "done x" does not match "done_x".
    expect(ids('e_y')).toEqual([]);
    expect(search.search(undefined).hits).toEqual([]);
    expect(search.search(['a', 'b']).hits).toEqual([]);
    expect(search.search('').hits).toEqual([]);
    // One or two characters work too (no trigram needed).
    expect(ids('ok')).toEqual([one.id]);
  });

  it('replaces a session’s entries when its history is rebuilt, and drops them when the transcript is gone', async () => {
    const one = await session('Remember the walrus', 'Walrus noted.');
    expect(ids('walrus')).toEqual([one.id]);

    // The history as rebuilt now has no transcript (it was removed).
    const history = await harness.service.historyEvents(one.id);
    search.replace(
      one.id,
      history.events.filter(
        (event) =>
          event.type !== 'user.message' && event.type !== 'assistant.text',
      ),
    );
    expect(ids('walrus')).toEqual([]);

    // An unreadable transcript leaves the entries alone.
    search.replace(one.id, history.events);
    harness.transcripts.failing = true;
    expect(ids('walrus')).toEqual([one.id]);
  });

  it('indexes at startup what changed while the server was down', async () => {
    const one = await session('Plan the migration', 'Plan written.');
    harness.transcripts.existing.add(one.id);
    await search.reconcile();
    // Remove the entries as if the index were behind.
    search.replace(one.id, []);
    expect(ids('migration')).toEqual([]);
    // Same transcript: nothing to do.
    expect(await search.reconcile()).toBe(0);
    // The transcript changed: indexed again from the history.
    harness.transcripts.version++;
    expect(await search.reconcile()).toBe(1);
    expect(ids('migration')).toEqual([one.id]);
  });

  it('forgets deleted sessions', async () => {
    const one = await session('Delete me later', 'Sure.');
    harness.sessions.delete(one.id);
    harness.service.forget(one.id);
    expect(ids('later')).toEqual([]);
    expect(
      harness.db.$client
        .prepare('SELECT count(*) AS n FROM search_documents')
        .get(),
    ).toEqual({ n: 0 });
  });
});

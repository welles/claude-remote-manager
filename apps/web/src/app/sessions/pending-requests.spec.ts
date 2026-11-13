import {
  pendingRequestLabel,
  summarizePendingRequests,
} from '@claude-remote-manager/shared-types';

const request = (
  overrides: Partial<Parameters<typeof summarizePendingRequests>[0][number]>,
) => ({
  kind: 'tool' as const,
  toolName: 'Bash',
  gitPushes: [],
  pullRequest: null,
  questions: null,
  ...overrides,
});

const label = (requests: Parameters<typeof summarizePendingRequests>[0]) => {
  const summary = summarizePendingRequests(requests);
  return summary ? pendingRequestLabel(summary) : null;
};

describe('pending request summary', () => {
  it('names what the oldest request asks for, without details', () => {
    expect(label([request({})])).toBe('Approve command');
    expect(label([request({ toolName: 'Write' })])).toBe('Approve edit');
    expect(
      label([
        request({
          kind: 'question',
          toolName: 'AskUserQuestion',
          questions: [
            { question: 'A?', header: '', options: [], multiSelect: false },
            { question: 'B?', header: '', options: [], multiSelect: false },
          ],
        }),
      ]),
    ).toBe('2 questions');
    expect(
      label([request({ kind: 'plan', toolName: 'ExitPlanMode' }), request({})]),
    ).toBe('Plan ready · 1 more');
    expect(summarizePendingRequests([])).toBeNull();
  });
});

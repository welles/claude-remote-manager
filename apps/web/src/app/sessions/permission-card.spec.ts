import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  PermissionRequestEvent,
  PermissionResponse,
} from '@claude-remote-manager/shared-types';
import { answerOf, OTHER, PermissionCard } from './permission-card';
import { permissionRequest } from './testing/permission-events';

describe('PermissionCard', () => {
  let fixture: ComponentFixture<PermissionCard>;
  let answers: PermissionResponse[];

  const render = async (request: PermissionRequestEvent, enabled = true) => {
    await TestBed.configureTestingModule({
      imports: [PermissionCard],
    }).compileComponents();
    fixture = TestBed.createComponent(PermissionCard);
    fixture.componentRef.setInput('request', request);
    fixture.componentRef.setInput('enabled', enabled);
    answers = [];
    fixture.componentInstance.answer.subscribe((answer) =>
      answers.push(answer),
    );
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };
  const click = async (element: HTMLElement, testId: string) => {
    (
      element.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
  };
  const type = async (element: HTMLElement, testId: string, text: string) => {
    const field = element.querySelector(`[data-testid="${testId}"]`) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    field.value = text;
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };

  it('shows the command and allows once, without a session-wide allow', async () => {
    const element = await render(permissionRequest());
    expect(element.textContent).toContain('Approval needed');
    expect(element.textContent).toContain('Claude wants to run rm -r build');
    expect(element.querySelector('pre')?.textContent).toBe('rm -r build');
    expect(element.textContent).toContain('Clean the build');
    expect(element.querySelector('[data-testid="allow-session"]')).toBeNull();
    await click(element, 'allow');
    expect(answers).toEqual([{ decision: 'allow' }]);
  });

  it('offers "allow for this session" with what it allows', async () => {
    const element = await render(
      permissionRequest({
        sessionAllow: {
          rules: ['Bash(npm test:*)'],
          directories: [],
          mode: null,
        },
      }),
    );
    expect(
      element.querySelector('[data-testid="session-allow"]')?.textContent,
    ).toContain('Bash(npm test:*)');
    await click(element, 'allow-session');
    expect(answers).toEqual([{ decision: 'allow', scope: 'session' }]);
  });

  it('denies with or without a message to Claude', async () => {
    const element = await render(permissionRequest());
    await click(element, 'deny');
    await type(element, 'deny-message', '  Use the cache  ');
    await click(element, 'confirm-deny');
    await type(element, 'deny-message', '');
    await click(element, 'confirm-deny');
    expect(answers).toEqual([
      { decision: 'deny', message: 'Use the cache' },
      { decision: 'deny' },
    ]);
  });

  it('cannot answer while disabled', async () => {
    const element = await render(permissionRequest(), false);
    const allow = element.querySelector(
      '[data-testid="allow"]',
    ) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
  });

  it('warns about pushes beyond the session branch', async () => {
    const element = await render(
      permissionRequest({
        input: { command: 'git push --force origin HEAD:main' },
        gitPushes: [
          {
            command: 'git push --force origin HEAD:main',
            remote: 'origin',
            targets: [
              {
                destination: 'main',
                branch: 'main',
                forced: false,
                deletes: false,
              },
            ],
            force: true,
            deletes: false,
            everything: false,
            sessionBranchOnly: false,
            warnings: [
              'Pushes to main, not only the session branch',
              'Force push: may overwrite commits on the remote',
            ],
          },
        ],
      }),
    );
    const pushes = element.querySelector('[data-testid="git-pushes"]');
    expect(pushes?.classList).toContain('danger');
    expect(pushes?.textContent).toContain('Force push');
    expect(pushes?.textContent).toContain('write to the whole repository');
  });

  it('shows the pull request to create', async () => {
    const element = await render(
      permissionRequest({
        toolName: 'mcp__crm__create_pull_request',
        input: { title: 'Add export' },
        pullRequest: {
          repository: 'acme/app',
          title: 'Add export',
          body: 'Adds **CSV** export',
          base: 'main',
          draft: true,
        },
      }),
    );
    const pull = element.querySelector('[data-testid="pull-request"]');
    expect(pull?.textContent).toContain('acme/app');
    expect(pull?.textContent).toContain('Add export');
    expect(pull?.textContent).toContain('main');
    expect(pull?.textContent).toContain('(draft)');
    expect(pull?.querySelector('strong')?.textContent).toBe('CSV');
  });

  it('collects answers to Claude’s questions', async () => {
    const element = await render(
      permissionRequest({
        kind: 'question',
        toolName: 'AskUserQuestion',
        questions: [
          {
            question: 'Which format?',
            header: 'Format',
            options: [
              { label: 'CSV', description: 'Plain', preview: null },
              { label: 'JSON', description: 'Nested', preview: null },
            ],
            multiSelect: false,
          },
          {
            question: 'Which columns?',
            header: 'Columns',
            options: [
              { label: 'Name', description: '', preview: null },
              { label: 'Date', description: '', preview: null },
            ],
            multiSelect: true,
          },
        ],
      }),
    );
    expect(element.textContent).toContain('Claude asks');
    const send = () =>
      element.querySelector(
        '[data-testid="send-answers"]',
      ) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    const radios = element.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    radios[1].click();
    const boxes = element.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    boxes[0].click();
    boxes[1].click();
    await fixture.whenStable();
    const others = element.querySelectorAll<HTMLInputElement>(
      '[data-testid="other-answer"]',
    );
    others[1].value = 'Size';
    others[1].dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(send().disabled).toBe(false);
    send().click();
    expect(answers).toEqual([
      {
        decision: 'allow',
        answers: {
          'Which format?': 'JSON',
          'Which columns?': 'Name, Date, Size',
        },
      },
    ]);
  });

  it('builds answers from options and own words', () => {
    const single = {
      question: 'Q',
      header: '',
      options: [],
      multiSelect: false,
    };
    expect(answerOf(single, { selected: ['A'], other: '' })).toBe('A');
    expect(answerOf(single, { selected: [OTHER], other: ' mine ' })).toBe(
      'mine',
    );
    expect(answerOf(single, undefined)).toBe('');
    expect(
      answerOf({ ...single, multiSelect: true }, { selected: [], other: 'x' }),
    ).toBe('x');
  });

  it('approves a plan into the chosen mode or keeps planning', async () => {
    const element = await render(
      permissionRequest({
        kind: 'plan',
        toolName: 'ExitPlanMode',
        plan: '# Plan\n\n1. **Do** it',
      }),
    );
    expect(element.textContent).toContain('Plan for approval');
    expect(
      element.querySelector('[data-testid="plan"] strong')?.textContent,
    ).toBe('Do');
    (
      element.querySelector(
        '[data-testid="plan-accept-edits"] input',
      ) as HTMLInputElement
    ).click();
    await fixture.whenStable();
    await click(element, 'approve-plan');
    await click(element, 'deny');
    await type(element, 'deny-message', 'Add tests');
    await click(element, 'confirm-deny');
    expect(answers).toEqual([
      { decision: 'allow', mode: 'acceptEdits' },
      { decision: 'deny', message: 'Add tests' },
    ]);
    expect(element.textContent).toContain('Keep planning');
  });
});

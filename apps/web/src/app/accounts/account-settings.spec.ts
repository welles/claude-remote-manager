import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { WEBSOCKET_FACTORY } from '../sessions/session-socket';
import {
  FakeWebSocket,
  fakeWebSocketFactory,
} from '../sessions/testing/fake-websocket';
import { AccountSettings } from './account-settings';
import { accountDto } from './testing/accounts';
import { flushEngines } from '../engines/testing/engines';
import type { AgentEngineId } from '@claude-remote-manager/shared-types';
import { Toasts } from '../ui/toasts';

describe('AccountSettings', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const work = accountDto({
    id: 'a1',
    name: 'Work',
    position: 1,
    isDefault: false,
    email: 'work@example.test',
  });

  const render = (
    accounts = [accountDto(), work],
    engines: AgentEngineId[] = ['claude-code'],
  ) => {
    const fixture = TestBed.createComponent(AccountSettings);
    fixture.detectChanges();
    flushEngines(http, ...engines);
    http.expectOne('/api/accounts').flush({ accounts });
    http.expectOne('/api/limits').flush({ accounts: [] });
    fixture.detectChanges();
    return fixture;
  };
  const all = (fixture: ComponentFixture<AccountSettings>, id: string) => [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      `[data-testid="${id}"]`,
    ),
  ];
  const one = (fixture: ComponentFixture<AccountSettings>, id: string) => {
    const element = all(fixture, id)[0];
    if (!element) {
      throw new Error(`no ${id}`);
    }
    return element;
  };

  it('lists the accounts with login, plan and default', () => {
    const fixture = render([
      accountDto(),
      { ...work, loggedIn: false, email: null },
    ]);
    expect(
      all(fixture, 'account-name').map((e) => e.textContent?.trim()),
    ).toEqual(['Claude', 'Work']);
    expect(one(fixture, 'account-login').textContent).toContain(
      'me@example.test',
    );
    expect(one(fixture, 'account-login').textContent).toContain('Max');
    expect(all(fixture, 'account-default')).toHaveLength(1);
    expect(all(fixture, 'account-logged-out')).toHaveLength(1);
    // The main account cannot be removed.
    expect(all(fixture, 'account-remove')).toHaveLength(1);
  });

  it('adds an account and completes its login with the pasted code', async () => {
    const fixture = render([accountDto()]);
    one(fixture, 'account-add-claude').click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = one(fixture, 'account-name-input') as HTMLInputElement;
    input.value = 'Work';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(
      (one(fixture, 'account-name-save') as HTMLButtonElement).disabled,
    ).toBe(false);
    (fixture.nativeElement as HTMLElement)
      .querySelector('form#account-name-form')
      ?.dispatchEvent(new Event('submit'));
    const create = http.expectOne({ method: 'POST', url: '/api/accounts' });
    expect(create.request.body).toEqual({ provider: 'claude', name: 'Work' });
    create.flush({
      ...work,
      login: { status: 'starting', url: null, userCode: null, error: null },
    });
    http.expectOne('/api/accounts').flush({
      accounts: [
        accountDto(),
        {
          ...work,
          loggedIn: false,
          login: {
            status: 'waiting',
            url: 'https://claude.com/cai/oauth/authorize?x=1',
            userCode: null,
            error: null,
          },
        },
      ],
    });
    fixture.detectChanges();

    expect(one(fixture, 'account-login-url').getAttribute('href')).toBe(
      'https://claude.com/cai/oauth/authorize?x=1',
    );
    const code = one(fixture, 'account-login-code') as HTMLInputElement;
    await fixture.whenStable();
    code.value = ' abc#def ';
    code.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    one(fixture, 'account-login-submit').click();
    const submit = http.expectOne({
      method: 'POST',
      url: '/api/accounts/a1/login/code',
    });
    expect(submit.request.body).toEqual({ code: 'abc#def' });
    submit.flush(work);
    http.expectOne('/api/accounts').flush({ accounts: [accountDto(), work] });

    // Later states arrive live.
    FakeWebSocket.last.receive({
      type: 'accounts.changed',
      accounts: [
        accountDto(),
        {
          ...work,
          login: { status: 'done', url: null, userCode: null, error: null },
        },
      ],
    });
    fixture.detectChanges();
    expect(all(fixture, 'account-login-done')).toHaveLength(1);
  });

  it('reorders, makes default and removes after confirming', () => {
    const fixture = render();
    one(fixture, 'account-up').click();
    const order = http.expectOne({ method: 'PUT', url: '/api/accounts/order' });
    expect(order.request.body).toEqual({ ids: ['a1', 'main'] });
    order.flush({ accounts: [] });
    http.expectOne('/api/accounts').flush({ accounts: [accountDto(), work] });

    one(fixture, 'account-make-default').click();
    const update = http.expectOne({ method: 'PATCH', url: '/api/accounts/a1' });
    expect(update.request.body).toEqual({ isDefault: true });
    update.flush(work);
    http.expectOne('/api/accounts').flush({ accounts: [accountDto(), work] });

    one(fixture, 'account-remove').click();
    fixture.detectChanges();
    one(fixture, 'account-confirm').click();
    http
      .expectOne({ method: 'DELETE', url: '/api/accounts/a1' })
      .flush(null, { status: 204, statusText: 'No Content' });
    http.expectOne('/api/accounts').flush({ accounts: [accountDto()] });
    fixture.detectChanges();
    expect(all(fixture, 'account')).toHaveLength(1);
  });

  it("offers adding accounts only for the providers of the server's engines", () => {
    const claudeOnly = render([accountDto()]);
    expect(all(claudeOnly, 'account-add-claude')).toHaveLength(1);
    expect(all(claudeOnly, 'account-add-chatgpt')).toHaveLength(0);
    // One provider: no groups, the list as it always was.
    expect(all(claudeOnly, 'account-group-claude')).toHaveLength(0);
    expect(all(claudeOnly, 'account-provider')).toHaveLength(1);
  });

  it('groups the accounts by provider when the server has Codex too', () => {
    const chatgpt = accountDto({
      id: 'c1',
      provider: 'chatgpt',
      name: 'ChatGPT',
      position: 1,
      isDefault: true,
      main: false,
    });
    const fixture = render(
      [accountDto(), chatgpt, { ...work, position: 2 }],
      ['claude-code', 'codex'],
    );
    expect(all(fixture, 'account-add-chatgpt')).toHaveLength(1);
    expect(all(fixture, 'account-group-claude')).toHaveLength(1);
    expect(all(fixture, 'account-group-chatgpt')).toHaveLength(1);
    expect(
      all(fixture, 'account-name').map((e) => e.textContent?.trim()),
    ).toEqual(['Claude', 'Work', 'ChatGPT']);
    // Each provider has its default.
    expect(all(fixture, 'account-default')).toHaveLength(2);

    // Work moves up past the ChatGPT account, to before the main one.
    const up = all(fixture, 'account-up');
    expect(up).toHaveLength(1);
    up[0].click();
    const order = http.expectOne({ method: 'PUT', url: '/api/accounts/order' });
    expect(order.request.body).toEqual({ ids: ['a1', 'c1', 'main'] });
    order.flush({ accounts: [] });
    http.expectOne('/api/accounts').flush({ accounts: [accountDto()] });
  });

  it('shows a ChatGPT device login: the page, the code to enter, no paste form', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const toasts = TestBed.inject(Toasts);
    const show = vi.spyOn(toasts, 'show');
    const fixture = render(
      [
        accountDto(),
        accountDto({
          id: 'c1',
          provider: 'chatgpt',
          name: 'ChatGPT',
          position: 1,
          main: false,
          loggedIn: false,
          email: null,
          login: {
            status: 'waiting',
            url: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234',
            error: null,
          },
        }),
      ],
      ['claude-code', 'codex'],
    );
    expect(one(fixture, 'account-login-url').getAttribute('href')).toBe(
      'https://auth.openai.com/codex/device',
    );
    expect(one(fixture, 'account-login-user-code').textContent?.trim()).toBe(
      'ABCD-1234',
    );
    expect(one(fixture, 'account-login-flow').textContent).toContain(
      'ChatGPT account',
    );
    expect(all(fixture, 'account-login-waiting')).toHaveLength(1);
    expect(all(fixture, 'account-login-code')).toHaveLength(0);
    expect(all(fixture, 'account-login-submit')).toHaveLength(0);
    expect(all(fixture, 'account-login-cancel')).toHaveLength(1);

    one(fixture, 'account-login-copy').click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(show).toHaveBeenCalledWith({ title: 'Code copied' });
  });

  it('adds a ChatGPT account', async () => {
    const fixture = render([accountDto()], ['claude-code', 'codex']);
    one(fixture, 'account-add-chatgpt').click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = one(fixture, 'account-name-input') as HTMLInputElement;
    input.value = 'Private';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement)
      .querySelector('form#account-name-form')
      ?.dispatchEvent(new Event('submit'));
    const create = http.expectOne({ method: 'POST', url: '/api/accounts' });
    expect(create.request.body).toEqual({
      provider: 'chatgpt',
      name: 'Private',
    });
    create.flush(accountDto({ id: 'c1', provider: 'chatgpt', main: false }));
    http.expectOne('/api/accounts').flush({ accounts: [accountDto()] });
  });
});

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

  const render = (accounts = [accountDto(), work]) => {
    const fixture = TestBed.createComponent(AccountSettings);
    fixture.detectChanges();
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
    one(fixture, 'account-add').click();
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
    expect(create.request.body).toEqual({ name: 'Work' });
    create.flush({
      ...work,
      login: { status: 'starting', url: null, error: null },
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
        { ...work, login: { status: 'done', url: null, error: null } },
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
});

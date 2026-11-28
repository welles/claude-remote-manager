import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type {
  AccountDto,
  AccountLimits,
  AgentEngineId,
} from '@claude-remote-manager/shared-types';
import { accountDto } from '../accounts/testing/accounts';
import { flushEngines } from '../engines/testing/engines';
import { WEBSOCKET_FACTORY } from '../sessions/session-socket';
import {
  FakeWebSocket,
  fakeWebSocketFactory,
} from '../sessions/testing/fake-websocket';
import { LimitsIndicator } from './limits-indicator';

const limits = (accountId: string, utilization: number): AccountLimits => ({
  accountId,
  windows: [
    {
      type: 'five_hour',
      label: null,
      status: 'allowed',
      utilization,
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      source: 'usage',
      updatedAt: new Date().toISOString(),
    },
  ],
  subscriptionType: null,
  updatedAt: new Date().toISOString(),
});

describe('LimitsIndicator', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    await TestBed.configureTestingModule({
      imports: [LimitsIndicator],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const render = async (engines: AgentEngineId[], accounts: AccountDto[]) => {
    const fixture = TestBed.createComponent(LimitsIndicator);
    fixture.detectChanges();
    http.expectOne('/api/limits').flush({
      accounts: accounts.map((account) => account.limits),
    });
    http.expectOne('/api/accounts').flush({ accounts });
    flushEngines(http, ...engines);
    await fixture.whenStable();
    fixture.detectChanges();
    return [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="limits"]',
      ),
    ].map((chip) => ({
      text: [...chip.children]
        .map((child) => child.textContent?.trim())
        .filter(Boolean)
        .join(' '),
      label: chip.getAttribute('aria-label'),
      spaced: chip.classList.contains('ml-1.5'),
    }));
  };

  const claude = accountDto({ limits: limits('main', 40) });
  const chatgpt = accountDto({
    id: 'gpt',
    provider: 'chatgpt',
    name: 'ChatGPT',
    limits: limits('gpt', 80),
  });

  it('shows the Claude default account alone as before', async () => {
    const chips = await render(['claude-code'], [claude]);
    expect(chips).toEqual([
      {
        text: '5h 40%',
        label: expect.stringMatching(/^Plan limits: .* 40%, resets in/),
        spaced: false,
      },
    ]);
  });

  it('stays alone while the other engine has no accounts', async () => {
    const chips = await render(['claude-code', 'codex'], [claude]);
    expect(chips.map((chip) => chip.text)).toEqual(['5h 40%']);
  });

  it('shows the default account of each provider, named', async () => {
    const other = accountDto({
      id: 'gpt-2',
      provider: 'chatgpt',
      name: 'Second',
      position: 1,
      isDefault: false,
      limits: limits('gpt-2', 5),
    });
    const chips = await render(
      ['claude-code', 'codex'],
      [claude, chatgpt, other],
    );
    expect(chips.map((chip) => chip.text)).toEqual([
      'Claude 5h 40%',
      'ChatGPT 5h 80%',
    ]);
    expect(chips[1].label).toMatch(/^ChatGPT plan limits: .* 80%/);
    // The second chip keeps its distance from the first.
    expect(chips.map((chip) => chip.spaced)).toEqual([false, true]);
  });

  it('leaves out providers whose engine the server does not have', async () => {
    const chips = await render(['claude-code'], [claude, chatgpt]);
    expect(chips.map((chip) => chip.text)).toEqual(['5h 40%']);
  });
});

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EnginesStore, agentName, engineOf } from './engines-store';
import { engineList } from './testing/engines';

describe('EnginesStore', () => {
  let http: HttpTestingController;
  let store: EnginesStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(EnginesStore);
  });
  afterEach(() => http.verify());

  it('behaves as with Claude Code alone until the list is loaded', () => {
    expect(store.engines().map((engine) => engine.id)).toEqual(['claude-code']);
    expect(store.several()).toBe(false);
    expect(store.providers()).toEqual(['claude']);
    expect(store.capabilities(undefined).slashCommands).toBe(true);
    expect(store.capabilities('claude-code').permissionModes).toContain('auto');
    // A Codex session is shown in its own terms even before the list.
    expect(store.capabilities('codex').permissionModes).toEqual([
      'untrusted',
      'on-request',
      'never',
    ]);
    expect(store.capabilities('codex').slashCommands).toBe(false);
    expect(store.showEngine(undefined)).toBe(false);
    expect(store.showEngine('codex')).toBe(true);
  });

  it('loads the engines once and names them when there are several', () => {
    store.load();
    store.load();
    http.expectOne('/api/engines').flush(engineList('claude-code', 'codex'));
    expect(store.several()).toBe(true);
    expect(store.providers()).toEqual(['claude', 'chatgpt']);
    expect(store.engine('codex').label).toBe('Codex');
    expect(store.showEngine('claude-code')).toBe(true);
  });

  it('asks again after a failed load', () => {
    store.load();
    http
      .expectOne('/api/engines')
      .flush(null, { status: 500, statusText: 'Error' });
    expect(store.several()).toBe(false);
    store.load();
    http.expectOne('/api/engines').flush(engineList('claude-code'));
  });

  it('names the agent of a session', () => {
    expect(engineOf({})).toBe('claude-code');
    expect(engineOf({ engine: 'codex' })).toBe('codex');
    expect(agentName(undefined)).toBe('Claude');
    expect(agentName('codex')).toBe('Codex');
  });
});

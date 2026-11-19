import { SessionDrafts } from './session-drafts';

describe('SessionDrafts', () => {
  it('keeps unsent text per session and forgets empty text', () => {
    const drafts = new SessionDrafts();
    drafts.set('s1', 'half a message');
    drafts.set('s2', 'other');
    expect(drafts.get('s1')).toBe('half a message');
    drafts.set('s1', '');
    expect(drafts.get('s1')).toBe('');
    expect(drafts.get('s2')).toBe('other');
  });
});

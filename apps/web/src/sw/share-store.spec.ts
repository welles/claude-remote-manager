import {
  dropOldShares,
  readShareForm,
  sharedPrompt,
  storeShare,
  takeShare,
  type CacheLike,
} from './share-store';

/** The Cache API in memory. */
class MemoryCache implements CacheLike {
  readonly entries = new Map<string, Response>();

  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response);
  }

  async match(request: string): Promise<Response | undefined> {
    return this.entries.get(request)?.clone();
  }

  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request);
  }

  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({
      url: `https://crm.example.com${url}`,
    }));
  }
}

const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

describe('share target', () => {
  it('takes text, link and images from the form', () => {
    const form = new FormData();
    form.set('title', 'Bug report');
    form.set('text', 'The login fails');
    form.set('url', 'https://example.com/issue');
    form.append('images', png('a.png'));
    form.append('images', new File(['x'], 'notes.txt', { type: 'text/plain' }));
    const content = readShareForm(form);
    expect(content.title).toBe('Bug report');
    expect(content.text).toBe('The login fails');
    expect(content.url).toBe('https://example.com/issue');
    expect(content.files.map((file) => file.name)).toEqual(['a.png']);
  });

  it('keeps the content until the app takes it, once', async () => {
    const cache = new MemoryCache();
    await storeShare(cache, 'share-1', {
      title: '',
      text: 'Look at this',
      url: '',
      files: [png('screenshot.png')],
    });
    const taken = await takeShare(cache, 'share-1');
    expect(taken?.text).toBe('Look at this');
    expect(taken?.files).toHaveLength(1);
    expect(taken?.files[0].name).toBe('screenshot.png');
    expect(taken?.files[0].type).toBe('image/png');
    // (The bytes are not compared: jsdom's File and Node's Response differ.)
    expect(cache.entries.size).toBe(0);
    expect(await takeShare(cache, 'share-1')).toBeNull();
    expect(await takeShare(cache, '../other')).toBeNull();
  });

  it('drops shares nobody took after a day', async () => {
    const cache = new MemoryCache();
    await storeShare(
      cache,
      'old',
      { title: '', text: 'a', url: '', files: [] },
      0,
    );
    await storeShare(
      cache,
      'new',
      { title: '', text: 'b', url: '', files: [] },
      Date.now(),
    );
    await dropOldShares(cache);
    expect([...cache.entries.keys()]).toEqual(['/__share/new/meta']);
  });

  it('makes a prompt of title, text and link without repeating them', () => {
    expect(
      sharedPrompt({
        title: 'Issue',
        text: 'The login fails',
        url: 'https://example.com/1',
      }),
    ).toBe('Issue\n\nThe login fails\n\nhttps://example.com/1');
    // Android puts the link into the text.
    expect(
      sharedPrompt({
        title: '',
        text: 'Read this https://example.com/1',
        url: 'https://example.com/1',
      }),
    ).toBe('Read this https://example.com/1');
  });
});

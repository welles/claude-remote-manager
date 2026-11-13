/**
 * Content shared to the installed app (Web Share Target). The service
 * worker takes the operating system's form post (`POST /share-target`,
 * multipart) itself, keeps the content in the Cache API and opens the app
 * with `/new?share=<id>`; the new-session form then takes it as its prompt and
 * images. The post never reaches the API, so the API's request guard
 * (JSON bodies only) stays as it is.
 */

/** Cache holding shared content until the app took it. */
export const SHARE_CACHE = 'crm-share-v1';
/** Path the manifest's `share_target` posts to. */
export const SHARE_TARGET_PATH = '/share-target';
/** Shares nobody took are dropped after a day. */
export const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Like the API: at most 10 images per message. */
export const MAX_SHARED_FILES = 10;

export interface SharedContent {
  id: string;
  title: string;
  text: string;
  url: string;
  files: File[];
  createdAt: number;
}

interface StoredMeta {
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string }[];
  createdAt: number;
}

/** The subset of the Cache API used here. */
export interface CacheLike {
  put(request: string, response: Response): Promise<void>;
  match(request: string): Promise<Response | undefined>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

const metaKey = (id: string) => `/__share/${id}/meta`;
const fileKey = (id: string, index: number) => `/__share/${id}/file/${index}`;

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.slice(0, 100_000) : '';
};

/** Takes the shared fields and image files from the share target's form. */
export function readShareForm(
  form: FormData,
): Omit<SharedContent, 'id' | 'createdAt'> {
  const files = form
    .getAll('images')
    .filter((value): value is File => typeof value !== 'string')
    .filter((file) => file.type.startsWith('image/'))
    .slice(0, MAX_SHARED_FILES);
  return {
    title: field(form, 'title'),
    text: field(form, 'text'),
    url: field(form, 'url'),
    files,
  };
}

export async function storeShare(
  cache: CacheLike,
  id: string,
  content: Omit<SharedContent, 'id' | 'createdAt'>,
  now = Date.now(),
): Promise<void> {
  const meta: StoredMeta = {
    title: content.title,
    text: content.text,
    url: content.url,
    files: content.files.map((file) => ({ name: file.name, type: file.type })),
    createdAt: now,
  };
  await Promise.all(
    content.files.map((file, index) =>
      cache.put(
        fileKey(id, index),
        new Response(file, { headers: { 'Content-Type': file.type } }),
      ),
    ),
  );
  await cache.put(
    metaKey(id),
    new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/** The shared content with this ID, removed from the cache. */
export async function takeShare(
  cache: CacheLike,
  id: string,
): Promise<SharedContent | null> {
  if (!/^[\w-]{1,64}$/.test(id)) {
    return null;
  }
  const response = await cache.match(metaKey(id));
  if (!response) {
    return null;
  }
  const meta = (await response.json()) as StoredMeta;
  const files: File[] = [];
  for (const [index, file] of meta.files.entries()) {
    const stored = await cache.match(fileKey(id, index));
    if (stored) {
      files.push(
        new File([await stored.blob()], file.name || `shared-${index + 1}`, {
          type: file.type,
        }),
      );
    }
    await cache.delete(fileKey(id, index));
  }
  await cache.delete(metaKey(id));
  return { id, ...meta, files };
}

/** Removes shares older than {@link SHARE_MAX_AGE_MS}. */
export async function dropOldShares(
  cache: CacheLike,
  now = Date.now(),
): Promise<void> {
  for (const request of await cache.keys()) {
    const match = /\/__share\/([\w-]+)\/meta$/.exec(
      new URL(request.url, 'http://x').pathname,
    );
    if (!match) {
      continue;
    }
    const response = await cache.match(metaKey(match[1]));
    const meta = response ? ((await response.json()) as StoredMeta) : null;
    if (!meta || now - meta.createdAt > SHARE_MAX_AGE_MS) {
      await takeShare(cache, match[1]);
    }
  }
}

/** The prompt for a new session made from shared content. */
export function sharedPrompt(
  content: Pick<SharedContent, 'title' | 'text' | 'url'>,
): string {
  const parts: string[] = [];
  const text = content.text.trim();
  const url = content.url.trim();
  const title = content.title.trim();
  if (title && !text.includes(title)) {
    parts.push(title);
  }
  if (text) {
    parts.push(text);
  }
  if (url && !text.includes(url)) {
    parts.push(url);
  }
  return parts.join('\n\n');
}

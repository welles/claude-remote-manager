import { Pipe, type PipeTransform } from '@angular/core';
import { marked } from 'marked';

/** Attributes through which an element loads something. */
const LOADING_ATTRIBUTES = ['src', 'srcset', 'poster', 'background', 'lowsrc'];

const isDataUrl = (value: string) => /^\s*data:/i.test(value);

/**
 * Makes rendered Markdown safe to show beyond what Angular's sanitizer
 * does: no image or other resource loads from anywhere when it renders
 * (Markdown from Claude, a repository or a web page could otherwise send
 * data to any server through an image URL, without any approval). Images
 * with `data:` URLs stay; any other image, from `![]()` or from raw HTML,
 * becomes a link that opens only when clicked. Links open in a new tab
 * without referrer. Works on an inert template, so nothing loads while it
 * is processed.
 */
export function withoutRemoteResources(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    if (isDataUrl(src)) {
      image.removeAttribute('srcset');
      continue;
    }
    const link = document.createElement('a');
    if (src) {
      link.setAttribute('href', src);
    }
    link.textContent = image.getAttribute('alt')?.trim() || src || 'image';
    link.title = src;
    image.replaceWith(link);
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const name of LOADING_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && !isDataUrl(value)) {
        element.removeAttribute(name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return template.innerHTML;
}

/**
 * Renders Markdown to HTML without remote resources (see
 * {@link withoutRemoteResources}). Bind the result to `[innerHTML]`:
 * Angular's sanitizer removes scripts, event handlers and other unsafe
 * content.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    if (!text) {
      return '';
    }
    return withoutRemoteResources(
      marked.parse(text, { async: false, gfm: true, breaks: true }),
    );
  }
}

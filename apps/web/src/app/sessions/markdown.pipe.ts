import { Pipe, type PipeTransform } from '@angular/core';
import { marked } from 'marked';

/**
 * Renders Markdown to HTML. Bind the result to `[innerHTML]`: Angular's
 * sanitizer removes scripts, event handlers and other unsafe content.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    if (!text) {
      return '';
    }
    return marked.parse(text, { async: false, gfm: true, breaks: true });
  }
}

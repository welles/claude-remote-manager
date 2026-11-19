import type { ModelOption } from '@claude-remote-manager/shared-types';
import {
  modelLabel,
  modelOptionsWith,
  readableModelName,
} from './models-store';

describe('model labels', () => {
  const options: ModelOption[] = [
    {
      value: null,
      label: 'Default (recommended)',
      description: '',
      resolvedModel: null,
    },
    { value: 'opus', label: 'Opus', description: '', resolvedModel: null },
  ];

  it("shows Claude Code's `default` like no choice", () => {
    expect(modelLabel(options, 'default')).toBe('Default');
    expect(modelOptionsWith(options, 'default')).toBe(options);
  });

  it('names the model the default currently resolves to', () => {
    const resolved: ModelOption[] = [
      { ...options[0], resolvedModel: 'claude-opus-5-5' },
      options[1],
    ];
    expect(modelLabel(resolved, null)).toBe('Opus 5.5');
    expect(modelLabel(resolved, 'default')).toBe('Opus 5.5');
    expect(modelLabel(resolved, 'opus')).toBe('Opus');
  });

  it('reads model IDs as names', () => {
    expect(readableModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(readableModelName('claude-opus-5')).toBe('Opus 5');
    expect(readableModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(readableModelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(readableModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)');
    expect(readableModelName('some-other-model')).toBe('some-other-model');
  });

  it('keeps other values', () => {
    expect(modelLabel(options, 'opus')).toBe('Opus');
    expect(modelOptionsWith(options, 'claude-old').at(-1)?.label).toBe(
      'claude-old',
    );
  });
});

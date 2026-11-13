import type { ModelOption } from '@claude-remote-manager/shared-types';
import { modelLabel, modelOptionsWith } from './models-store';

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
    expect(modelLabel(options, 'default')).toBe('Default (recommended)');
    expect(modelOptionsWith(options, 'default')).toBe(options);
  });

  it('keeps other values', () => {
    expect(modelLabel(options, 'opus')).toBe('Opus');
    expect(modelOptionsWith(options, 'claude-old').at(-1)?.label).toBe(
      'claude-old',
    );
  });
});

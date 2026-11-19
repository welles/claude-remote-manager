import { maskedStrings, MASK, NO_MASKING, secretMasker } from './secret-masker';

describe('secret masking', () => {
  it('masks values and file lines of at least six characters', () => {
    const strings = maskedStrings([
      { kind: 'variable', value: 'sk-123456' },
      { kind: 'variable', value: 'short' },
      { kind: 'file', value: '{\n  "private_key": "KEYDATA"\n}\n' },
    ]);
    expect(strings).toContain('sk-123456');
    expect(strings).not.toContain('short');
    expect(strings).toContain('"private_key": "KEYDATA"');
  });

  it('masks recursively and keeps unchanged values identical', () => {
    const mask = secretMasker(['sk-123456', 'sk-123456789']);
    const event = {
      type: 'tool.result',
      output: 'token=sk-123456789 and sk-123456',
      nested: [{ text: 'none' }],
      count: 3,
    };
    const masked = mask(event);
    expect(masked.output).toBe(`token=${MASK} and ${MASK}`);
    expect(masked.nested).toBe(event.nested);
    const clean = { type: 'x', text: 'nothing secret' };
    expect(mask(clean)).toBe(clean);
  });

  it('masks nothing without secrets', () => {
    expect(secretMasker([])).toBe(NO_MASKING);
  });
});

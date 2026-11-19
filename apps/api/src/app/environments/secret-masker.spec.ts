import {
  maskedStrings,
  MASK,
  NO_MASKING,
  secretMasker,
  StreamMasker,
} from './secret-masker';

describe('secret masking', () => {
  it('masks variable values of at least six characters', () => {
    const strings = maskedStrings([
      { kind: 'variable', value: 'sk-123456' },
      { kind: 'variable', value: 'short' },
    ]);
    expect(strings).toEqual(['sk-123456']);
  });

  it('masks the values of secret files, not their ordinary lines', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
    const json = JSON.stringify(
      { type: 'service_account', private_key: pem, client_email: 'bot@x.iam' },
      null,
      2,
    );
    const strings = maskedStrings([
      { kind: 'file', value: json },
      {
        kind: 'file',
        value:
          '#!/bin/bash\napiVersion: v1\ntoken: abcdef-ghij\nPASSWORD="hunter2-x"\n',
      },
    ]);
    expect(strings).toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(strings).toContain(pem.trim());
    expect(strings).toContain('abcdef-ghij');
    expect(strings).toContain('hunter2-x');
    expect(strings).not.toContain('#!/bin/bash');
    expect(strings).not.toContain('apiVersion: v1');
    expect(strings).not.toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('masks recursively, skips structural fields and keeps unchanged values identical', () => {
    const mask = secretMasker(['sk-123456', 'sk-123456789']);
    const event = {
      type: 'tool.result',
      toolUseId: 'sk-123456',
      output: 'token=sk-123456789 and sk-123456',
      nested: [{ text: 'none' }],
      count: 3,
    };
    const masked = mask(event);
    expect(masked.output).toBe(`token=${MASK} and ${MASK}`);
    expect(masked.toolUseId).toBe('sk-123456');
    expect(masked.nested).toBe(event.nested);
    const clean = { type: 'x', text: 'nothing secret' };
    expect(mask(clean)).toBe(clean);
    expect(mask.text('a.b sk-123456')).toBe(`a.b ${MASK}`);
    expect(mask.longest).toBe(12);
  });

  it('masks nothing without secrets', () => {
    expect(secretMasker([])).toBe(NO_MASKING);
  });

  it('masks a secret split across streamed pieces', () => {
    const mask = secretMasker(['sk-123456']);
    const stream = new StreamMasker();
    const pieces = ['The key ', 'is sk-12', '3456 and', ' more text here'];
    const sent = pieces
      .map((piece) => stream.push('m:0', piece, mask))
      .join('');
    expect(sent).not.toContain('sk-12');
    expect(sent).toContain(`is ${MASK} and`);
    expect(`The key is ${MASK} and more text here`.startsWith(sent)).toBe(true);
    // What was held back comes with the end of the stream.
    const rest = stream.flush('m:0', mask);
    expect(sent + rest).toBe(`The key is ${MASK} and more text here`);
    expect(stream.flush('m:0', mask)).toBe('');
    // Without secrets pieces pass as they are.
    expect(new StreamMasker().push('m:0', 'abc', NO_MASKING)).toBe('abc');
  });
});

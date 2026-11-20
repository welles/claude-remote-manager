import { SdkTranscriptReader } from './transcript-reader';

const sdk = {
  getSessionMessages: jest.fn(),
  getSessionInfo: jest.fn(),
};

jest.mock('./sdk-agent-runner', () => ({
  loadAgentSdk: () => Promise.resolve(sdk),
}));

describe('SdkTranscriptReader', () => {
  const reader = new SdkTranscriptReader();
  const message = { type: 'user', uuid: 'u1' };

  beforeEach(() => {
    jest.resetAllMocks();
    // The transcript lives in another project folder than /first.
    sdk.getSessionMessages.mockImplementation(
      (_id: string, options?: { dir?: string }) =>
        Promise.resolve(options?.dir ? [] : [message]),
    );
    sdk.getSessionInfo.mockImplementation(
      (_id: string, options?: { dir?: string }) =>
        Promise.resolve(
          options?.dir ? undefined : { fileSize: 10, lastModified: 5 },
        ),
    );
  });

  it('reads only the first directory’s project folder of a session never switched', async () => {
    await expect(reader.read('s', '/first')).resolves.toEqual([]);
    await expect(reader.exists('s', '/first')).resolves.toBe(false);
    await expect(reader.stamp('s', '/first')).resolves.toBeNull();
    for (const call of [
      ...sdk.getSessionMessages.mock.calls,
      ...sdk.getSessionInfo.mock.calls,
    ]) {
      expect(call[1]).toEqual({ dir: '/first' });
    }
  });

  it('searches all project folders after a switch of the working directory', async () => {
    await expect(reader.read('s', '/first', true)).resolves.toEqual([message]);
    await expect(reader.exists('s', '/first', true)).resolves.toBe(true);
    await expect(reader.stamp('s', '/first', true)).resolves.toBe('10@5');
  });

  it('stays in the first directory’s folder when the transcript is there', async () => {
    sdk.getSessionMessages.mockResolvedValue([message]);
    sdk.getSessionInfo.mockResolvedValue({ fileSize: 1, lastModified: 2 });
    await expect(reader.read('s', '/first', true)).resolves.toEqual([message]);
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(1);
    await expect(reader.stamp('s', '/first', true)).resolves.toBe('1@2');
    expect(sdk.getSessionInfo).toHaveBeenCalledTimes(1);
  });
});

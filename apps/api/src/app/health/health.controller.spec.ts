import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const env = { ...process.env };
  let controller: HealthController;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('reports defaults outside of image builds', () => {
    delete process.env.APP_VERSION;
    delete process.env.APP_COMMIT;
    delete process.env.APP_COMMIT_TIME;

    expect(controller.getHealth()).toEqual({
      status: 'ok',
      version: '0.0.0',
      commit: null,
      commitTime: null,
    });
  });

  it('reports the build information from the environment', () => {
    process.env.APP_VERSION = '1.2.3';
    process.env.APP_COMMIT = 'abc123';
    process.env.APP_COMMIT_TIME = '2026-01-01T00:00:00Z';

    expect(controller.getHealth()).toEqual({
      status: 'ok',
      version: '1.2.3',
      commit: 'abc123',
      commitTime: '2026-01-01T00:00:00Z',
    });
  });
});

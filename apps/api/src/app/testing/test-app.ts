import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import {
  CLAUDE_ACCOUNT_DIRECTORIES,
  CLAUDE_CLI,
} from '../accounts/accounts.service';
import { ClaudeAccountDirectories } from '../accounts/claude-account-directories';
import { FakeClaudeCli } from '../accounts/testing/fake-claude-cli';
import { AgentRunner } from '../agent/agent-runner';
import { SINGLE_USER } from '../common/process-isolation';
import { TranscriptReader } from '../agent/transcript-reader';
import { AppModule } from '../app.module';
import {
  APP_CONFIG,
  type AppConfig,
  testAppConfig,
} from '../config/app-config';
import { configureApp } from '../configure-app';
import { gitSandbox } from '../git/testing/git-fixtures';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
} from '../sessions/testing/fake-agent';
import { TEST_IDENTITY } from '../workspaces/testing/workspace-harness';

/** The whole API on a random port, with a fake Claude Code. */
export interface TestApp {
  app: NestExpressApplication;
  runner: FakeAgentRunner;
  /** `claude auth` of the accounts. */
  claudeCli: FakeClaudeCli;
  transcripts: FakeTranscriptReader;
  config: AppConfig;
  /** Temporary directory holding the database and data directories. */
  dir: string;
  port: number;
  /** `127.0.0.1:<port>`, the default Host header. */
  host: string;
  close(): Promise<void>;
}

export async function startTestApp(
  overrides: Partial<AppConfig> = {},
  {
    identity = true,
    configure,
  }: {
    /** Set the test commit identity (sessions need one). */
    identity?: boolean;
    /** Further provider overrides, e.g. a fake GitHub. */
    configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  } = {},
): Promise<TestApp> {
  // git of the app must not depend on the machine's git configuration.
  const sandbox = gitSandbox('crm-app-git-');
  const dir = mkdtempSync(join(tmpdir(), 'crm-app-'));
  const runner = new FakeAgentRunner();
  const claudeCli = new FakeClaudeCli();
  const transcripts = new FakeTranscriptReader();
  const config: AppConfig = testAppConfig(dir, {
    dbDir: join(dir, 'db'),
    setupScriptTimeoutMs: 60_000,
    gitIdentity: identity ? TEST_IDENTITY : null,
    ...overrides,
  });
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(AgentRunner)
    .useValue(runner)
    .overrideProvider(TranscriptReader)
    .useValue(transcripts)
    .overrideProvider(CLAUDE_CLI)
    .useValue(claudeCli)
    .overrideProvider(CLAUDE_ACCOUNT_DIRECTORIES)
    .useValue(
      new ClaudeAccountDirectories(
        join(dir, 'claude'),
        SINGLE_USER,
        join(dir, 'claude', '.claude.json'),
      ),
    );
  if (configure) {
    builder = configure(builder);
  }
  const module = await builder.compile();
  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  let closed = false;
  return {
    app,
    runner,
    claudeCli,
    transcripts,
    config,
    dir,
    port,
    host: `127.0.0.1:${port}`,
    close: async () => {
      if (!closed) {
        closed = true;
        await app.close();
      }
      rmSync(dir, { recursive: true, force: true });
      sandbox.cleanup();
    },
  };
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

/**
 * Plain HTTP request with full control over headers (fetch forbids setting
 * Host and adds its own).
 */
export function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method, path, headers },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (data += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: data,
            json: <T>() => JSON.parse(data) as T,
          }),
        );
      },
    );
    request.on('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

/** POST with a JSON body. */
export function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return rawRequest(
    port,
    'POST',
    path,
    { 'content-type': 'application/json', ...headers },
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

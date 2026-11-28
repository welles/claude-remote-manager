#!/usr/bin/env node
// A stand-in for `codex app-server` (0.171) in tests: JSON-RPC, one object
// per line over stdio, with the methods, notifications and server requests
// the adapter uses. It keeps its state in $CODEX_HOME like Codex does:
//
// - `auth.json` there means logged in (its `email` is the account's).
// - The device login answers with a code and completes once a file
//   `login-approve` (or `login-deny`) appears in $CODEX_HOME.
// - Threads are written as rollouts under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl.
// - Every request is appended to $CODEX_HOME/fake-codex-requests.jsonl,
//   the process ID of every start to $CODEX_HOME/fake-codex-pids.
//
// - `fake-mcp-servers` there (JSON object) is the configuration's
//   `mcp_servers` (`config/read`); a resume that does not disable one
//   logs it as started to `fake-mcp-started`.
//
// Commands are reported wrapped in the shell, as Codex does:
// `/bin/bash -lc '<script>'`.
//
// A turn's scenario follows from the words of its last text input:
//   run-command  a command that asks for approval first; after a decline
//                the turn waits briefly for input (`turn/steer`)
//   git-push     like run-command, with `git push origin HEAD`
//   resolve-itself  asks for a command's approval, then resolves the
//                request itself (`serverRequest/resolved`) and ends
//   fast         the turn/start answer and the whole turn in one write
//   ask-user     asks the user questions (item/tool/requestUserInput)
//   stubborn     the process ignores SIGTERM and the end of its input
//   edit-file    a file change that asks for approval first
//   app-tool:<n> a call of the app's dynamic tool <n> (item/tool/call)
//   plan         a plan update
//   limit        the account's usage limit (error, failed turn)
//   slow         runs until turn/interrupt
//   subagent     a subagent thread's turn starts and ends first
//   fail-start   turn/start is refused
//   crash        the process exits (code 3) in the middle of the turn
// anything else: an agent message "Echo: <text>", streamed in two deltas.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const home = process.env.CODEX_HOME || path.join(process.cwd(), '.codex');
const threads = new Map();
const serverRequests = new Map();
const logins = new Map();
const interrupts = new Map();
const interrupted = new Set();
let stubborn = false;
let nextServerRequest = 1;
let counter = 0;

const id = (prefix) => `${prefix}-${++counter}`;
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (method, params) => send({ method, params });
const answer = (requestId, result) => send({ id: requestId, result });
const fail = (requestId, message, code = -32600) =>
  send({ id: requestId, error: { code, message } });

/** Sends a server request and waits for the client's answer. */
function ask(method, params) {
  const requestId = nextServerRequest++;
  return new Promise((resolve, reject) => {
    serverRequests.set(requestId, { resolve, reject });
    send({ id: requestId, method, params });
  });
}

function log(method, params) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(
      path.join(home, 'fake-codex-requests.jsonl'),
      `${JSON.stringify({ method, params: params ?? null })}\n`,
    );
  } catch {
    // Not for the protocol.
  }
}

function authFile() {
  return path.join(home, 'auth.json');
}

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  } catch {
    return null;
  }
}

function rateLimits() {
  return {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1764300000 },
    secondary: {
      usedPercent: 60,
      windowDurationMins: 10080,
      resetsAt: 1764900000,
    },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
  };
}

function model(name, displayName, extra = {}) {
  return {
    id: name,
    model: name,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: `${displayName} model`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
    ...extra,
  };
}

/** Runs `task` with everything it sends going out in one write. */
function oneWrite(task) {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (line) => {
    lines.push(line);
    return true;
  };
  try {
    task();
  } finally {
    process.stdout.write = write;
    write(lines.join(''));
  }
}

function shellWrapped(script) {
  return script.includes("'")
    ? `/bin/bash -lc "${script.replace(/["\\$`]/g, '\\$&')}"`
    : `/bin/bash -lc '${script}'`;
}

function readMcpServers() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(home, 'fake-mcp-servers'), 'utf8'),
    );
  } catch {
    return {};
  }
}

function threadView(thread, includeTurns) {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'full',
    modelProvider: 'openai',
    model: thread.model,
    reasoningEffort: null,
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
    recencyAt: null,
    status: { type: 'idle' },
    path: thread.path,
    cwd: thread.cwd,
    cliVersion: '0.171.0',
    originator: null,
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? thread.turns : [],
  };
}

function threadResponse(thread) {
  return {
    thread: threadView(thread, false),
    model: thread.model,
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
  };
}

function rolloutPath(threadId, date) {
  const pad = (value) => String(value).padStart(2, '0');
  const dir = path.join(
    home,
    'sessions',
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  );
  const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-');
  return path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
}

/** Writes the thread's turns as its rollout (one turn per line). */
function persist(thread) {
  if (!thread.path) {
    thread.path = rolloutPath(thread.id, new Date());
  }
  fs.mkdirSync(path.dirname(thread.path), { recursive: true });
  fs.writeFileSync(
    thread.path,
    [
      JSON.stringify({
        type: 'session_meta',
        id: thread.id,
        cwd: thread.cwd,
        tokens: thread.tokens,
      }),
      ...thread.turns.map((turn) => JSON.stringify({ type: 'turn', turn })),
    ].join('\n') + '\n',
  );
}

function findRollout(threadId, dir = path.join(home, 'sessions')) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRollout(threadId, at);
      if (found) {
        return found;
      }
    } else if (entry.name.endsWith(`-${threadId}.jsonl`)) {
      return at;
    }
  }
  return null;
}

function loadRollout(file) {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const meta = lines.find((line) => line.type === 'session_meta');
  return {
    id: meta.id,
    cwd: meta.cwd,
    tokens: meta.tokens ?? 0,
    turns: lines.filter((line) => line.type === 'turn').map((l) => l.turn),
  };
}

function turnView(turn, status, error = null) {
  return {
    id: turn.id,
    rootTurnId: null,
    items: turn.items,
    itemsView: 'full',
    status,
    error,
    startedAt: turn.startedAt,
    completedAt: status === 'inProgress' ? null : Date.now(),
    durationMs: status === 'inProgress' ? null : 5,
  };
}

function usageBreakdown(total) {
  return {
    totalTokens: total,
    inputTokens: Math.round(total * 0.8),
    cachedInputTokens: Math.round(total * 0.5),
    cacheWriteInputTokens: 0,
    outputTokens: Math.round(total * 0.2),
    reasoningOutputTokens: 0,
  };
}

async function runTurn(thread, turn, input) {
  const threadId = thread.id;
  const turnId = turn.id;
  const text = input
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
  const last = [...input].reverse().find((entry) => entry.type === 'text');
  const prompt = last ? last.text : '';
  const started = (item) =>
    notify('item/started', {
      item,
      threadId,
      turnId,
      startedAtMs: Date.now(),
    });
  const completed = (item) => {
    turn.items.push(item);
    notify('item/completed', {
      item,
      threadId,
      turnId,
      completedAtMs: Date.now(),
    });
  };
  const message = async (body) => {
    const itemId = id('msg');
    const item = (value) => ({
      type: 'agentMessage',
      id: itemId,
      text: value,
      phase: null,
      moderation: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    });
    started(item(''));
    const half = Math.ceil(body.length / 2);
    for (const delta of [body.slice(0, half), body.slice(half)]) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta });
    }
    completed(item(body));
  };

  notify('turn/started', { threadId, turn: turnView(turn, 'inProgress') });
  const user = {
    type: 'userMessage',
    id: id('user'),
    clientId: turn.clientId,
    content: input,
  };
  started(user);
  completed(user);

  if (/\bsubagent\b/.test(prompt)) {
    const child = `${threadId}-sub`;
    const childTurn = { id: id('turn'), items: [], startedAt: Date.now() };
    notify('turn/started', {
      threadId: child,
      turn: turnView(childTurn, 'inProgress'),
    });
    notify('turn/completed', {
      threadId: child,
      turn: turnView(childTurn, 'completed'),
    });
  }

  let status = 'completed';
  let error = null;
  if (/\b(run-command|git-push|resolve-itself)\b/.test(prompt)) {
    const itemId = id('cmd');
    const script = /\bgit-push\b/.test(prompt)
      ? 'git push origin HEAD'
      : "echo 'hi'";
    const command = {
      type: 'commandExecution',
      id: itemId,
      command: shellWrapped(script),
      cwd: thread.cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: script }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    started(command);
    const request = ask('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      approvalId: null,
      environmentId: null,
      reason: 'Wants to say hi',
      command: command.command,
      cwd: thread.cwd,
      commandActions: command.commandActions,
    });
    if (/\bresolve-itself\b/.test(prompt)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      notify('serverRequest/resolved', {
        threadId,
        requestId: nextServerRequest - 1,
      });
      completed({ ...command, status: 'declined', durationMs: 1 });
      await message('resolved by itself');
      request.catch(() => undefined);
      return finishTurn(thread, turn, 'completed', null);
    }
    const { decision } = await request;
    if (decision === 'decline') {
      // The model samples again: input sent meanwhile is part of the turn.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    completed({
      ...command,
      status: accepted ? 'completed' : 'declined',
      aggregatedOutput: accepted ? 'hi\n' : null,
      exitCode: accepted ? 0 : null,
      durationMs: 3,
    });
    if (decision === 'cancel') {
      status = 'interrupted';
    } else {
      await message(`decision: ${decision}`);
    }
  } else if (/\bask-user\b/.test(prompt)) {
    const answer = await ask('item/tool/requestUserInput', {
      threadId,
      turnId,
      itemId: id('ask'),
      questions: [
        {
          id: 'q1',
          header: 'Q',
          question: 'Which?',
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      isBlocking: true,
      autoResolutionMs: null,
    });
    await message(`answers: ${JSON.stringify(answer.answers)}`);
  } else if (/\bedit-file\b/.test(prompt)) {
    const itemId = id('patch');
    const change = {
      path: path.join(thread.cwd, 'notes.txt'),
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    };
    const item = {
      type: 'fileChange',
      id: itemId,
      changes: [change],
      status: 'inProgress',
    };
    started(item);
    const { decision } = await ask('item/fileChange/requestApproval', {
      threadId,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      reason: null,
      grantRoot: null,
    });
    completed({
      ...item,
      status: decision === 'accept' ? 'completed' : 'declined',
    });
    await message(`decision: ${decision}`);
  } else if (/\bapp-tool:(\S+)/.test(prompt)) {
    const tool = /\bapp-tool:(\S+)/.exec(prompt)[1];
    const callId = id('call');
    const item = {
      type: 'dynamicToolCall',
      id: callId,
      namespace: null,
      tool,
      arguments: { value: 42 },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    };
    started(item);
    const result = await ask('item/tool/call', {
      threadId,
      turnId,
      callId,
      namespace: null,
      tool,
      arguments: { value: 42 },
    });
    completed({
      ...item,
      status: result.success ? 'completed' : 'failed',
      contentItems: result.contentItems,
      success: result.success,
      durationMs: 1,
    });
    const output = result.contentItems
      .map((entry) => entry.text ?? '')
      .join('\n');
    await message(`tool said: ${output}`);
  } else if (/\bplan\b/.test(prompt)) {
    notify('turn/plan/updated', {
      threadId,
      turnId,
      explanation: null,
      plan: [
        { step: 'Read the code', status: 'completed' },
        { step: 'Write the tests', status: 'inProgress' },
        { step: 'Run them', status: 'pending' },
      ],
    });
    await message('Planned.');
  } else if (/\blimit\b/.test(prompt)) {
    error = {
      message: "You've hit your usage limit.",
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
      misalignment: null,
    };
    notify('error', { error, willRetry: false, threadId, turnId });
    status = 'failed';
  } else if (/\bcrash\b/.test(prompt)) {
    process.stderr.write('panicked: fake crash\n', () => process.exit(3));
    return;
  } else if (/\bstubborn\b/.test(prompt)) {
    stubborn = true;
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1000);
    await message('Not ending.');
  } else if (/\bslow\b/.test(prompt)) {
    await new Promise((resolve) => {
      if (interrupted.has(turnId)) {
        resolve();
        return;
      }
      interrupts.set(turnId, resolve);
      setTimeout(resolve, 10_000).unref();
    });
    interrupts.delete(turnId);
    status = 'interrupted';
  } else {
    await message(`Echo: ${text}`);
  }

  finishTurn(thread, turn, status, error);
}

function finishTurn(thread, turn, status, error) {
  const threadId = thread.id;
  const turnId = turn.id;
  thread.tokens += 1000;
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: usageBreakdown(thread.tokens),
      last: usageBreakdown(1000),
      modelContextWindow: 200000,
    },
  });
  notify('account/rateLimits/updated', { rateLimits: rateLimits() });
  // Another bucket (a single model's), and a sparse update of the main one.
  notify('account/rateLimits/updated', {
    rateLimits: {
      ...rateLimits(),
      limitId: 'codex_other',
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    },
  });
  notify('account/rateLimits/updated', {
    rateLimits: {
      ...rateLimits(),
      primary: {
        usedPercent: 30,
        windowDurationMins: 300,
        resetsAt: 1764300000,
      },
      secondary: null,
      planType: null,
    },
  });
  const view = turnView(turn, status, error);
  thread.turns.push(view);
  persist(thread);
  thread.running = null;
  notify('turn/completed', { threadId, turn: view });
}

function startLogin(requestId, params) {
  if (params?.type !== 'chatgptDeviceCode') {
    fail(requestId, `login type ${params?.type} is not supported here`);
    return;
  }
  const loginId = crypto.randomUUID();
  answer(requestId, {
    type: 'chatgptDeviceCode',
    loginId,
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'FAKE-1234',
  });
  const timer = setInterval(() => {
    const approve = path.join(home, 'login-approve');
    const deny = path.join(home, 'login-deny');
    let result = null;
    if (fs.existsSync(approve)) {
      fs.writeFileSync(authFile(), fs.readFileSync(approve));
      result = { success: true, error: null };
    } else if (fs.existsSync(deny)) {
      result = { success: false, error: fs.readFileSync(deny, 'utf8') };
    }
    if (result) {
      clearInterval(timer);
      logins.delete(loginId);
      notify('account/login/completed', {
        loginId,
        ...result,
        onboardingEntrypoint: null,
      });
    }
  }, 20);
  logins.set(loginId, timer);
}

function handle(message) {
  if (message.method === undefined) {
    // The client's answer to a server request.
    const pending = serverRequests.get(message.id);
    if (pending) {
      serverRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }
  const { method, params } = message;
  log(method, params);
  if (message.id === undefined) {
    // Notifications (`initialized`) need no answer.
    return;
  }
  const requestId = message.id;
  switch (method) {
    case 'initialize':
      return answer(requestId, {
        userAgent: 'fake-codex/0.171.0',
        codexHome: home,
        platformFamily: 'unix',
        platformOs: 'linux',
      });
    case 'account/read': {
      const auth = readAuth();
      return answer(requestId, {
        account: auth
          ? {
              type: 'chatgpt',
              email: auth.email ?? null,
              planType: auth.planType ?? 'plus',
              workspaceName: auth.workspaceName ?? null,
            }
          : null,
        userId: auth ? 'user-1' : null,
        requiresOpenaiAuth: true,
      });
    }
    case 'account/logout':
      fs.rmSync(authFile(), { force: true });
      return answer(requestId, {});
    case 'account/login/start':
      return startLogin(requestId, params);
    case 'account/login/cancel': {
      const timer = logins.get(params?.loginId);
      if (timer) {
        clearInterval(timer);
        logins.delete(params.loginId);
      }
      return answer(requestId, { status: timer ? 'canceled' : 'notFound' });
    }
    case 'model/list':
      // Two pages.
      return answer(
        requestId,
        params?.cursor === 'page-2'
          ? {
              data: [model('gpt-internal', 'Internal', { hidden: true })],
              nextCursor: null,
            }
          : {
              data: [
                model('gpt-5.5-codex', 'GPT-5.5 Codex', { isDefault: true }),
                model('gpt-5.4', 'GPT-5.4'),
              ],
              nextCursor: 'page-2',
            },
      );
    case 'config/read':
      return answer(requestId, {
        config: { mcp_servers: readMcpServers() },
        origins: {},
        layers: null,
      });
    case 'account/rateLimits/read':
      return answer(requestId, {
        ordinaryUsageAllowed: true,
        rateLimits: rateLimits(),
        rateLimitsByLimitId: {
          codex: rateLimits(),
          codex_other: { ...rateLimits(), limitId: 'codex_other' },
        },
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      });
    case 'thread/start': {
      const thread = {
        id: crypto.randomUUID(),
        cwd: params?.cwd ?? process.cwd(),
        model: params?.model ?? 'gpt-5.5-codex',
        approvalPolicy: params?.approvalPolicy ?? 'on-request',
        createdAt: Math.floor(Date.now() / 1000),
        path: null,
        turns: [],
        tokens: 0,
        running: null,
      };
      threads.set(thread.id, thread);
      return answer(requestId, threadResponse(thread));
    }
    case 'thread/resume': {
      const file = params?.path || findRollout(params?.threadId);
      if (!file || !fs.existsSync(file)) {
        return fail(
          requestId,
          `no rollout found for thread ${params?.threadId}`,
        );
      }
      const stored = loadRollout(file);
      const thread = {
        id: stored.id,
        cwd: params?.cwd ?? stored.cwd,
        model: params?.model ?? 'gpt-5.5-codex',
        approvalPolicy: params?.approvalPolicy ?? 'on-request',
        createdAt: Math.floor(Date.now() / 1000),
        path: file,
        turns: stored.turns,
        tokens: stored.tokens,
        running: null,
      };
      threads.set(thread.id, thread);
      for (const name of Object.keys(readMcpServers())) {
        if (params?.config?.[`mcp_servers.${name}.enabled`] !== false) {
          fs.appendFileSync(path.join(home, 'fake-mcp-started'), `${name}\n`);
        }
      }
      // The answer and the restored usage in one write, as Codex may send.
      oneWrite(() => {
        answer(requestId, threadResponse(thread));
        if (thread.tokens > 0) {
          // Codex restores the thread's total, with its last turn's ID.
          const last = thread.turns.at(-1);
          notify('thread/tokenUsage/updated', {
            threadId: thread.id,
            turnId: last ? last.id : 'turn-restored',
            tokenUsage: {
              total: usageBreakdown(thread.tokens),
              last: usageBreakdown(1000),
              modelContextWindow: 200000,
            },
          });
        }
      });
      return;
    }
    case 'thread/read': {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        return fail(requestId, `thread ${params?.threadId} is not loaded`);
      }
      return answer(requestId, {
        thread: threadView(thread, params?.includeTurns === true),
      });
    }
    case 'turn/start': {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        return fail(requestId, `thread ${params?.threadId} is not loaded`);
      }
      if (thread.running) {
        return fail(requestId, 'a turn is already running');
      }
      const input = params?.input ?? [];
      const last = [...input].reverse().find((entry) => entry.type === 'text');
      if (last && /\bfail-start\b/.test(last.text)) {
        return fail(requestId, 'turn refused');
      }
      const turn = {
        id: id('turn'),
        clientId: params?.clientUserMessageId ?? null,
        items: [],
        startedAt: Math.floor(Date.now() / 1000),
      };
      thread.running = turn;
      if (last && /\bfast\b/.test(last.text)) {
        // Answer and the whole turn in one write.
        oneWrite(() => {
          answer(requestId, { turn: turnView(turn, 'inProgress') });
          notify('turn/started', {
            threadId: thread.id,
            turn: turnView(turn, 'inProgress'),
          });
          const view = turnView(turn, 'completed');
          thread.turns.push(view);
          persist(thread);
          thread.running = null;
          notify('turn/completed', { threadId: thread.id, turn: view });
        });
        return;
      }
      answer(requestId, { turn: turnView(turn, 'inProgress') });
      // After the answer, as Codex does.
      setImmediate(() => {
        runTurn(thread, turn, input).catch((error) => {
          process.stderr.write(`turn failed: ${error.message}\n`);
        });
      });
      return;
    }
    case 'turn/steer': {
      const thread = threads.get(params?.threadId);
      const turn = thread?.running;
      if (!turn || turn.id !== params?.expectedTurnId) {
        return fail(requestId, 'no active turn to steer');
      }
      if (!params?.input?.length) {
        return fail(requestId, 'input must not be empty');
      }
      answer(requestId, { turnId: turn.id });
      const item = {
        type: 'userMessage',
        id: id('user'),
        clientId: params.clientUserMessageId ?? null,
        content: params.input,
      };
      turn.items.push(item);
      notify('item/started', { item, threadId: thread.id, turnId: turn.id });
      notify('item/completed', { item, threadId: thread.id, turnId: turn.id });
      return;
    }
    case 'turn/interrupt': {
      const thread = threads.get(params?.threadId);
      if (!thread?.running || thread.running.id !== params?.turnId) {
        return fail(requestId, 'no such running turn');
      }
      interrupted.add(params?.turnId);
      const resolve = interrupts.get(params?.turnId);
      if (resolve) {
        resolve();
      }
      return answer(requestId, {});
    }
    default:
      return send({
        id: requestId,
        error: { code: -32601, message: `unknown method ${method}` },
      });
  }
}

process.stderr.write('fake codex app-server ready\n');
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(path.join(home, 'fake-codex-pids'), `${process.pid}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (
    let newline = buffer.indexOf('\n');
    newline >= 0;
    newline = buffer.indexOf('\n')
  ) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on('end', () => {
  if (!stubborn) {
    process.exit(0);
  }
});

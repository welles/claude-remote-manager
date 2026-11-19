import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type {
  PermissionRequestEvent,
  SessionDto,
  SessionEvent,
} from '@claude-remote-manager/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SessionsService } from '../sessions/sessions.service';
import {
  notificationKeys,
  shorten,
  type AppNotification,
} from './notification';
import {
  approvalActions,
  approvalSummary,
  sessionContext,
} from './notification-text';
import { NotificationsService } from './notifications.service';

/** What the notifier knows about a session. */
interface Watched {
  /** `status/waitingFor` as last published. */
  state: string;
  /** Last activity of a running turn (ms). */
  lastActivity: number;
  /** A stall was reported and nothing happened since. */
  stalled: boolean;
  /** The last turn ended because it was stopped (or denied). */
  interrupted: boolean;
  /** Last assistant text of the main conversation (for "turn finished"). */
  lastText: string | null;
}

/**
 * Events that are not activity of Claude: the user's own actions and the
 * app's bookkeeping.
 */
const NOT_ACTIVITY = new Set<SessionEvent['type']>([
  'message.queued',
  'message.dequeued',
  'settings.changed',
  'session.status',
]);

const BODY_LENGTH = 200;

/**
 * Turns what happens in sessions into notifications and withdraws them when
 * they stop being current:
 *
 * - approval requests, questions and plans (`approval`); withdrawn when
 *   answered or cancelled, anywhere;
 * - a turn that ended normally with the session waiting for the next
 *   message (`turn_finished`; not after Stop or a denial), only once the
 *   background tasks Claude started ended too; withdrawn when the next
 *   turn starts or the session ends;
 * - a running turn without any event for `SESSION_STALL_MINUTES`
 *   (`stalled`), once per stall; withdrawn when activity resumes or the
 *   turn ends; reported again only after activity resumed and stalled anew;
 * - a failed session, or a setup script failure that holds the first
 *   message back (`failed`); withdrawn when the session continues.
 *
 * The explicit end of a session (status `finished`) notifies nobody.
 */
@Injectable()
export class SessionNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Notifications');
  private readonly watched = new Map<string, Watched>();
  private readonly subscriptions: Subscription[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Clock, replaceable in tests. */
  now: () => number = Date.now;

  onModuleInit(): void {
    this.subscriptions.push(
      this.sessions.events$.subscribe(({ sessionId, event }) =>
        this.guard(() => this.onEvent(sessionId, event)),
      ),
      this.sessions.updates$.subscribe((session) =>
        this.guard(() => this.onUpdate(session)),
      ),
    );
    const stallMs = this.config.notifications.stallMs;
    if (stallMs > 0) {
      this.timer = setInterval(
        () => this.guard(() => this.checkStalls()),
        Math.min(30_000, Math.max(1000, stallMs / 10)),
      );
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Reports running turns without activity for the stall time. */
  checkStalls(): void {
    const stallMs = this.config.notifications.stallMs;
    if (stallMs <= 0) {
      return;
    }
    const now = this.now();
    for (const [sessionId, watched] of this.watched) {
      if (
        watched.state === 'running/' &&
        !watched.stalled &&
        now - watched.lastActivity >= stallMs
      ) {
        watched.stalled = true;
        const session = this.session(sessionId);
        if (!session) {
          continue;
        }
        const minutes = Math.round((now - watched.lastActivity) / 60_000);
        this.notifications.notify(
          this.base(session, 'stalled', notificationKeys.stall(sessionId), {
            title: `No activity: ${shorten(session.title || 'Untitled session', 60)}`,
            body: `Running without any activity for ${minutes} minute${minutes === 1 ? '' : 's'}.\n${sessionContext(session)}`,
          }),
        );
      }
    }
  }

  private onEvent(sessionId: string, event: SessionEvent): void {
    const watched = this.watch(sessionId);
    if (!NOT_ACTIVITY.has(event.type)) {
      watched.lastActivity = this.now();
      if (watched.stalled) {
        watched.stalled = false;
        this.notifications.withdraw(notificationKeys.stall(sessionId));
      }
    }
    switch (event.type) {
      case 'permission.request':
        this.notifyApproval(sessionId, event);
        return;
      case 'permission.resolved':
        this.notifications.withdraw(notificationKeys.approval(event.requestId));
        return;
      case 'turn.result':
        watched.interrupted = event.interrupted;
        return;
      case 'assistant.text':
        if (event.parentToolUseId === null && event.text.trim()) {
          watched.lastText = event.text;
        }
        return;
      case 'user.message':
        watched.lastText = null;
        return;
    }
  }

  private onUpdate(session: SessionDto): void {
    const watched = this.watch(session.id);
    const previous = watched.state;
    const state = `${session.status}/${session.waitingFor ?? ''}`;
    if (state === previous) {
      return;
    }
    watched.state = state;
    const id = session.id;
    if (state === 'finished/') {
      // Ended on purpose: nothing of it is current any more.
      this.watched.delete(id);
    }
    if (previous === 'waiting/message') {
      this.notifications.withdraw(notificationKeys.turn(id));
    }
    if (previous === 'failed/' || previous === 'waiting/setup') {
      this.notifications.withdraw(notificationKeys.failed(id));
    }
    if (state === 'running/') {
      // A turn starts or goes on after an approval: the clock starts now.
      watched.lastActivity = this.now();
      if (previous !== 'waiting/permission') {
        watched.interrupted = false;
      }
    } else if (watched.stalled) {
      watched.stalled = false;
      this.notifications.withdraw(notificationKeys.stall(id));
    }
    if (
      state === 'waiting/message' &&
      (previous === 'running/' ||
        previous === 'waiting/permission' ||
        previous === 'waiting/background')
    ) {
      if (!watched.interrupted) {
        this.notifyTurnFinished(session, watched);
      }
    } else if (previous === '') {
      // First seen (e.g. an update of an old session): no transition.
    } else if (state === 'failed/') {
      this.notifications.notify(
        this.base(session, 'failed', notificationKeys.failed(id), {
          title: `Failed: ${shorten(session.title || 'Untitled session', 60)}`,
          body: `${shorten(session.lastError ?? 'The session failed.', BODY_LENGTH)}\n${sessionContext(session)}`,
        }),
      );
    } else if (state === 'waiting/setup') {
      this.notifications.notify(
        this.base(session, 'failed', notificationKeys.failed(id), {
          title: `Setup failed: ${shorten(session.title || 'Untitled session', 60)}`,
          body: `A setup script failed, so the first message was not sent yet.\n${sessionContext(session)}`,
        }),
      );
    }
  }

  private notifyApproval(
    sessionId: string,
    event: PermissionRequestEvent,
  ): void {
    const session = this.session(sessionId);
    if (!session) {
      return;
    }
    const { action, detail } = approvalSummary(event, session);
    const notification = this.base(
      session,
      'approval',
      notificationKeys.approval(event.requestId),
      {
        title: event.kind === 'tool' ? `Approve? ${action}` : action,
        body: [detail, sessionContext(session)].filter(Boolean).join('\n'),
      },
    );
    this.notifications.notify({
      ...notification,
      requestId: event.requestId,
      actions: approvalActions(event),
      urgent: true,
    });
  }

  private notifyTurnFinished(session: SessionDto, watched: Watched): void {
    const text = watched.lastText
      ? shorten(watched.lastText, BODY_LENGTH)
      : 'Claude waits for your next message.';
    this.notifications.notify(
      this.base(session, 'turn_finished', notificationKeys.turn(session.id), {
        title: `Finished: ${shorten(session.title || 'Untitled session', 60)}`,
        body: `${text}\n${sessionContext(session)}`,
      }),
    );
  }

  private base(
    session: SessionDto,
    type: AppNotification['type'],
    key: string,
    content: { title: string; body: string },
  ): AppNotification {
    return {
      type,
      key,
      sessionId: session.id,
      ...content,
      path: `/sessions/${session.id}`,
      requestId: null,
      actions: [],
      urgent: false,
      at: this.now(),
    };
  }

  private watch(sessionId: string): Watched {
    let watched = this.watched.get(sessionId);
    if (!watched) {
      watched = {
        state: '',
        lastActivity: this.now(),
        stalled: false,
        interrupted: false,
        lastText: null,
      };
      this.watched.set(sessionId, watched);
    }
    return watched;
  }

  private session(sessionId: string): SessionDto | null {
    try {
      return this.sessions.get(sessionId);
    } catch {
      this.watched.delete(sessionId);
      return null;
    }
  }

  /** Notifications never break the session that caused them. */
  private guard(task: () => void): void {
    try {
      task();
    } catch (error) {
      this.logger.error(`Notification handling failed: ${String(error)}`);
    }
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type {
  ApprovalActionRequest,
  ApprovalActionResult,
  NotificationStatusDto,
  PushSubscriptionDto,
  RegisterPushSubscriptionRequest,
  RemovePushSubscriptionRequest,
  TestNotificationRequest,
  TestNotificationResult,
  UpdateNotificationPreferencesRequest,
} from '@claude-remote-manager/shared-types';
import { NotificationsService } from './notifications.service';

/**
 * Notification settings, Web Push subscriptions, test notifications and
 * the actions of approval notifications. All routes are management routes:
 * they need the Access token like every other route, pass the request
 * guard, and session processes cannot call them.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  status(): NotificationStatusDto {
    return this.notifications.status();
  }

  @Put('preferences')
  updatePreferences(
    @Body() body: UpdateNotificationPreferencesRequest,
  ): NotificationStatusDto {
    return this.notifications.updatePreferences(body);
  }

  @Post('push-subscriptions')
  subscribe(
    @Body() body: RegisterPushSubscriptionRequest,
    @Headers('user-agent') userAgent: string | undefined,
  ): PushSubscriptionDto {
    return this.notifications.subscribe(body, userAgent);
  }

  /** A device removes its own subscription (it knows only the endpoint). */
  @Post('push-subscriptions/remove')
  @HttpCode(204)
  unsubscribe(@Body() body: RemovePushSubscriptionRequest): void {
    this.notifications.unsubscribeEndpoint(body);
  }

  @Delete('push-subscriptions/:id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    this.notifications.removeSubscription(id);
  }

  @Post('test')
  @HttpCode(200)
  test(@Body() body: TestNotificationRequest): Promise<TestNotificationResult> {
    return this.notifications.test(body);
  }

  /** Allow (once) or Deny from an approval notification. */
  @Post('approval-actions')
  @HttpCode(200)
  approvalAction(
    @Body() body: ApprovalActionRequest,
  ): Promise<ApprovalActionResult> {
    return this.notifications.approvalAction(body);
  }
}

import { Module } from '@nestjs/common';
import { AttachmentStore } from './attachment.store';
import { AttachmentsController } from './attachments.controller';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentStore],
  exports: [AttachmentStore],
})
export class AttachmentsModule {}

import { Module } from '@nestjs/common';
import { SessionFileAccess } from '../files/session-file-access';
import { SessionRepository } from '../sessions/session.repository';
import { ShownFilesController } from './shown-files.controller';
import { ShownFilesService } from './shown-files.service';

@Module({
  controllers: [ShownFilesController],
  providers: [ShownFilesService, SessionFileAccess, SessionRepository],
  exports: [ShownFilesService],
})
export class ShownFilesModule {}

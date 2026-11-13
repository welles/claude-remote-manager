import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DevServers } from '../dev-servers/dev-servers';
import { SessionRepository } from '../sessions/session.repository';
import { PreviewAccess } from './preview-access';
import { PreviewRepository } from './preview.repository';
import { PreviewsController } from './previews.controller';
import { PreviewsService } from './previews.service';

/**
 * Previews of dev servers: the registry and tools' backend
 * ({@link PreviewsService}, also the app's {@link DevServers}), the stop
 * route, and who may open preview hosts ({@link PreviewAccess}; `null`
 * when previews are off). The gateway in front of the HTTP server is
 * installed by `configureApp`.
 */
@Module({
  controllers: [PreviewsController],
  providers: [
    PreviewRepository,
    SessionRepository,
    PreviewsService,
    { provide: DevServers, useExisting: PreviewsService },
    {
      provide: PreviewAccess,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.previews
          ? new PreviewAccess(config.auth, config.previews, config.isolation)
          : null,
    },
  ],
  exports: [PreviewsService, DevServers, PreviewAccess],
})
export class PreviewsModule {}

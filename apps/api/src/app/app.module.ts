import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { HealthController } from './health/health.controller';

/**
 * Directory with the built web app. In the image it sits next to the API
 * bundle; during development the Angular dev server serves the app instead.
 */
const webRoot = resolve(process.env.WEB_ROOT || join(__dirname, 'public'));

@Module({
  imports: [
    ...(existsSync(webRoot)
      ? [
          ServeStaticModule.forRoot({
            rootPath: webRoot,
            exclude: ['/api/{*path}'],
          }),
        ]
      : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}

import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { ConfigModule } from '../config/config.module';
import { DATABASE, openDatabase, type AppDatabase } from './database';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AppDatabase => {
        const db = openDatabase(config.dbDir);
        new Logger('Database').log(`Using database in ${config.dbDir}`);
        return db;
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  onApplicationShutdown(): void {
    this.db.$client.close();
  }
}

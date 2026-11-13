import { Module } from '@nestjs/common';
import { GitHubReferencesController } from './github-references.controller';
import { GitHubReferencesService } from './github-references.service';

/** `#` references to GitHub issues and pull requests in messages. */
@Module({
  controllers: [GitHubReferencesController],
  providers: [GitHubReferencesService],
  exports: [GitHubReferencesService],
})
export class GitHubReferencesModule {}

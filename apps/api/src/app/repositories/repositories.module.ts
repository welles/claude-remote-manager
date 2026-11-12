import { Module } from '@nestjs/common';
import { GitService } from '../git/git.service';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';
import { RepositoryRepository } from './repository.repository';

@Module({
  controllers: [RepositoriesController],
  providers: [RepositoryRepository, RepositoriesService, GitService],
  exports: [RepositoriesService, GitService],
})
export class RepositoriesModule {}

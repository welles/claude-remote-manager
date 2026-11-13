import { Module } from '@nestjs/common';
import { GitService } from '../git/git.service';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';
import { GitHubRepositoriesController } from './github-repositories.controller';
import { RepositoryCredentials } from './repository-credentials';
import { RepositoryRepository } from './repository.repository';

@Module({
  controllers: [RepositoriesController, GitHubRepositoriesController],
  providers: [
    RepositoryRepository,
    RepositoriesService,
    RepositoryCredentials,
    GitService,
  ],
  exports: [
    RepositoriesService,
    RepositoryRepository,
    RepositoryCredentials,
    GitService,
  ],
})
export class RepositoriesModule {}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type {
  AccountDto,
  AccountListResponse,
  CreateAccountRequest,
  ReorderAccountsRequest,
  UpdateAccountRequest,
} from '@claude-remote-manager/shared-types';
import { AccountsService } from './accounts.service';

/** Claude accounts and their logins (see `AccountsService`). */
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(): AccountListResponse {
    return { accounts: this.accounts.list() };
  }

  /** Adds an account and starts its login. */
  @Post()
  create(@Body() request: CreateAccountRequest): Promise<AccountDto> {
    return this.accounts.create(request);
  }

  @Put('order')
  reorder(@Body() request: ReorderAccountsRequest): AccountListResponse {
    return { accounts: this.accounts.reorder(request) };
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() request: UpdateAccountRequest,
  ): AccountDto {
    return this.accounts.update(id, request);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.accounts.remove(id);
  }

  /** Starts a (new) login; the URL follows as `accounts.changed`. */
  @Post(':id/login')
  login(@Param('id') id: string): AccountDto {
    return this.accounts.startLogin(id);
  }

  @Post(':id/login/code')
  code(@Param('id') id: string, @Body() body: unknown): AccountDto {
    return this.accounts.submitLoginCode(id, body);
  }

  @Delete(':id/login')
  @HttpCode(204)
  cancelLogin(@Param('id') id: string): void {
    this.accounts.cancelLogin(id);
  }

  @Post(':id/logout')
  logout(@Param('id') id: string): Promise<AccountDto> {
    return this.accounts.logout(id);
  }

  /** Reads the login state again. */
  @Post(':id/refresh')
  async refresh(@Param('id') id: string): Promise<AccountDto> {
    this.accounts.get(id);
    await this.accounts.refresh(id);
    return this.accounts.get(id);
  }
}

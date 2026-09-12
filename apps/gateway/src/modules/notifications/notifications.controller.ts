import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';

/** Coerce a query param to a positive integer, throwing 400 on garbage. */
function clampPositiveInt(value: unknown, fallback: number, max?: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`Invalid numeric query parameter: ${value}`);
  }
  return max ? Math.min(Math.floor(n), max) : Math.floor(n);
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List persisted in-app notifications for the authenticated wallet' })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'unreadOnly', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async list(
    @CurrentWallet() wallet: string,
    @Query('providerId') providerId?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.notificationsService.findAll(wallet, {
      providerId,
      unreadOnly: unreadOnly === 'true' || unreadOnly === '1',
      limit: clampPositiveInt(limit, 50, 200),
      offset: clampPositiveInt(offset, 0),
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread in-app notification count (dashboard badge)' })
  async unreadCount(@CurrentWallet() wallet: string) {
    const unread = await this.notificationsService.unreadCount(wallet);
    return { unread };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all in-app notifications read' })
  async markAllRead(@CurrentWallet() wallet: string, @Body('providerId') providerId?: string) {
    const updated = await this.notificationsService.markAllRead(wallet, providerId);
    return { updated };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one in-app notification read' })
  async markRead(@CurrentWallet() wallet: string, @Param('id') id: string) {
    return this.notificationsService.markRead(wallet, id);
  }
}

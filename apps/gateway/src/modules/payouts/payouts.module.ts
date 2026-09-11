import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PayoutsService } from './payouts.service';

@Module({
  // 'PRISMA' is provided by the @Global() PrismaModule (common/prisma.module.ts)
  imports: [ScheduleModule.forRoot()],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}

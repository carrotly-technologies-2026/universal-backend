import { Module } from '@nestjs/common';
import { TransitController } from './transit.controller.js';
import { TransitService } from './transit.service.js';

@Module({
  controllers: [TransitController],
  providers: [TransitService],
  exports: [TransitService],
})
export class TransitModule {}

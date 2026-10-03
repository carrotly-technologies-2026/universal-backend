import { Module } from '@nestjs/common';
import { EscrowController } from './escrow.controller.js';
import { EscrowStore } from './escrow.store.js';
import { SolanaService } from './solana.service.js';
import { WaybillValidator } from './waybill-validator.service.js';

@Module({
  controllers: [EscrowController],
  providers: [SolanaService, EscrowStore, WaybillValidator],
})
export class EscrowModule {}

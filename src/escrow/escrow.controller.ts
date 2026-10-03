import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { detailsHash, parseDetails } from './details.js';
import { EscrowAccount } from './escrow-account.js';
import { EscrowStore } from './escrow.store.js';
import { sniffWaybillType } from './file-type.js';
import { PubkeyPipe } from './pubkey.pipe.js';
import { SolanaService } from './solana.service.js';
import { WaybillValidator } from './waybill-validator.service.js';

const MAX_WAYBILL_BYTES = 10 * 1024 * 1024;

@Controller('escrows/:address')
export class EscrowController {
  constructor(
    private readonly solana: SolanaService,
    private readonly store: EscrowStore,
    private readonly validator: WaybillValidator,
  ) {}

  @Get()
  async show(@Param('address', PubkeyPipe) address: string) {
    const onChain = await this.requireEscrow(address);
    return {
      address,
      onChain,
      details: this.store.getDetails(address),
      waybills: this.store.listWaybills(address).map((w) => ({
        ...w,
        committedOnChain: w.hash === onChain.waybillHash,
      })),
    };
  }

  @Post('details')
  async saveDetails(
    @Param('address', PubkeyPipe) address: string,
    @Body() body: unknown,
  ) {
    const details = parseDetails(body);
    const onChain = await this.requireEscrow(address);
    if (detailsHash(details) !== onChain.detailsHash) {
      throw new BadRequestException(
        'Details do not match the details_hash stored on chain.',
      );
    }
    this.store.saveDetails(address, details);
    return details;
  }

  @Post('waybills')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_WAYBILL_BYTES } }),
  )
  async uploadWaybill(
    @Param('address', PubkeyPipe) address: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Missing multipart field "file".');
    const mimeType = sniffWaybillType(file.buffer);
    if (!mimeType) {
      throw new UnsupportedMediaTypeException('Only PDF, JPEG and PNG files.');
    }
    const onChain = await this.requireEscrow(address);
    // After mark_shipped the waybill hash is fixed on chain; later uploads
    // could never be committed.
    if (onChain.statusName !== 'Funded') {
      throw new ConflictException(
        `Escrow is ${onChain.statusName}; waybills are accepted only while Funded.`,
      );
    }

    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = this.store.getWaybill(address, hash);
    // A failed check (e.g. model outage) is retried on re-upload instead of cached.
    if (existing && existing.validation.verdict !== 'unavailable') {
      return { hash, validation: existing.validation };
    }

    const validation = await this.validator.validate({
      file: file.buffer,
      mimeType,
      details: this.store.getDetails(address),
      escrowCreatedAt: onChain.createdAt,
    });
    const stored = this.store.saveWaybill(address, file.buffer, {
      hash,
      mimeType,
      size: file.size,
      validation,
    });
    return { hash, validation: stored.validation };
  }

  @Get('waybills/:hash')
  downloadWaybill(
    @Param('address', PubkeyPipe) address: string,
    @Param('hash') hash: string,
  ): StreamableFile {
    // The regex also keeps the hash from escaping the waybill directory.
    const waybill = /^[0-9a-f]{64}$/.test(hash)
      ? this.store.getWaybill(address, hash)
      : null;
    if (!waybill) throw new NotFoundException('Waybill not found.');
    return new StreamableFile(createReadStream(this.store.filePath(hash)), {
      type: waybill.mimeType,
      length: waybill.size,
    });
  }

  private async requireEscrow(address: string): Promise<EscrowAccount> {
    const escrow = await this.solana.getEscrow(address);
    if (!escrow) throw new NotFoundException('Escrow not found on chain.');
    return escrow;
  }
}

import { BadRequestException, PipeTransform } from '@nestjs/common';
import bs58 from 'bs58';

/** Accepts only a base58-encoded 32-byte Solana public key. */
export class PubkeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(value);
    } catch {
      throw new BadRequestException('Invalid escrow address.');
    }
    if (bytes.length !== 32) {
      throw new BadRequestException('Invalid escrow address.');
    }
    return value;
  }
}

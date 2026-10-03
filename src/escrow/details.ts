import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface EscrowDetails {
  itemTitle: string;
  recipientName: string;
  recipientAddress: string;
}

const MAX_LENGTH = 200;

/** Trims and checks the submitted fields; the trimmed values are what get hashed. */
export function parseDetails(body: unknown): EscrowDetails {
  const input = (body ?? {}) as Record<string, unknown>;
  const field = (name: keyof EscrowDetails): string => {
    const value = input[name];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(
        `${name} must be a non-empty string of at most ${MAX_LENGTH} characters.`,
      );
    }
    return trimmed;
  };
  return {
    itemTitle: field('itemTitle'),
    recipientName: field('recipientName'),
    recipientAddress: field('recipientAddress'),
  };
}

/** Must match the details_hash the buyer's frontend commits in create_escrow. */
export function detailsHash(d: EscrowDetails): string {
  return createHash('sha256')
    .update(`${d.itemTitle}\n${d.recipientName}\n${d.recipientAddress}`, 'utf8')
    .digest('hex');
}

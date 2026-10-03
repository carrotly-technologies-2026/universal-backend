import { createHash } from 'node:crypto';
import bs58 from 'bs58';

export const STATUS_NAMES = [
  'Funded',
  'Shipped',
  'Disputed',
  'Released',
  'Refunded',
  'Resolved',
] as const;

export type StatusName = (typeof STATUS_NAMES)[number];

export interface EscrowAccount {
  buyer: string;
  seller: string;
  arbiter: string;
  // u64 values may exceed Number.MAX_SAFE_INTEGER, so they travel as strings.
  escrowId: string;
  amount: string;
  status: number;
  statusName: StatusName | 'Unknown';
  createdAt: number;
  shipDeadline: number;
  confirmWindow: number;
  arbiterWindow: number;
  confirmDeadline: number;
  disputeDeadline: number;
  detailsHash: string;
  waybillHash: string;
  sellerShareBps: number;
  bump: number;
}

export const ESCROW_ACCOUNT_SIZE = 236;

export const ESCROW_DISCRIMINATOR = createHash('sha256')
  .update('account:Escrow')
  .digest()
  .subarray(0, 8);

/** Decodes the Anchor `Escrow` account; null if the data is not one. */
export function decodeEscrow(data: Buffer): EscrowAccount | null {
  if (data.length < ESCROW_ACCOUNT_SIZE) return null;
  if (!data.subarray(0, 8).equals(ESCROW_DISCRIMINATOR)) return null;

  const pubkey = (at: number) => bs58.encode(data.subarray(at, at + 32));
  const hex = (at: number) => data.subarray(at, at + 32).toString('hex');
  // Timestamps and windows are seconds, far below 2^53.
  const i64 = (at: number) => Number(data.readBigInt64LE(at));
  const status = data.readUInt8(120);

  return {
    buyer: pubkey(8),
    seller: pubkey(40),
    arbiter: pubkey(72),
    escrowId: data.readBigUInt64LE(104).toString(),
    amount: data.readBigUInt64LE(112).toString(),
    status,
    statusName: STATUS_NAMES[status] ?? 'Unknown',
    createdAt: i64(121),
    shipDeadline: i64(129),
    confirmWindow: i64(137),
    arbiterWindow: i64(145),
    confirmDeadline: i64(153),
    disputeDeadline: i64(161),
    detailsHash: hex(169),
    waybillHash: hex(201),
    sellerShareBps: data.readUInt16LE(233),
    bump: data.readUInt8(235),
  };
}

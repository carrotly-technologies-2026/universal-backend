import bs58 from 'bs58';
import {
  decodeEscrow,
  ESCROW_ACCOUNT_SIZE,
  ESCROW_DISCRIMINATOR,
} from './escrow-account.js';

describe('decodeEscrow', () => {
  const key = (fill: number) => Buffer.alloc(32, fill);

  function account(): Buffer {
    const data = Buffer.alloc(ESCROW_ACCOUNT_SIZE);
    ESCROW_DISCRIMINATOR.copy(data, 0);
    key(1).copy(data, 8);
    key(2).copy(data, 40);
    key(3).copy(data, 72);
    data.writeBigUInt64LE(7n, 104);
    data.writeBigUInt64LE(18_000_000_000_000_000_000n, 112);
    data.writeUInt8(1, 120);
    [1_700_000_000, 1_700_000_100, 60, 120, 1_700_000_200, -1].forEach((v, i) =>
      data.writeBigInt64LE(BigInt(v), 121 + i * 8),
    );
    Buffer.alloc(32, 0xab).copy(data, 169);
    data.writeUInt16LE(2500, 233);
    data.writeUInt8(254, 235);
    return data;
  }

  it('decodes every field', () => {
    expect(decodeEscrow(account())).toEqual({
      buyer: bs58.encode(key(1)),
      seller: bs58.encode(key(2)),
      arbiter: bs58.encode(key(3)),
      escrowId: '7',
      amount: '18000000000000000000',
      status: 1,
      statusName: 'Shipped',
      createdAt: 1_700_000_000,
      shipDeadline: 1_700_000_100,
      confirmWindow: 60,
      arbiterWindow: 120,
      confirmDeadline: 1_700_000_200,
      disputeDeadline: -1,
      detailsHash: 'ab'.repeat(32),
      waybillHash: '00'.repeat(32),
      sellerShareBps: 2500,
      bump: 254,
    });
  });

  it('rejects a wrong discriminator or short data', () => {
    const data = account();
    data[0] ^= 0xff;
    expect(decodeEscrow(data)).toBeNull();
    expect(decodeEscrow(account().subarray(0, 200))).toBeNull();
  });
});

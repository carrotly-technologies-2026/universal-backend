import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { decodeEscrow, EscrowAccount } from './escrow-account.js';

interface AccountInfoResponse {
  result?: { value: { owner: string; data: [string, string] } | null };
  error?: { message: string };
}

/** Read-only view of the escrow program's accounts. Holds no keys. */
@Injectable()
export class SolanaService {
  /** The decoded escrow, or null if the address holds no escrow account. */
  async getEscrow(address: string): Promise<EscrowAccount | null> {
    const programId = process.env.ESCROW_PROGRAM_ID;
    if (!programId) {
      throw new ServiceUnavailableException(
        'Escrow disabled: set the ESCROW_PROGRAM_ID env variable.',
      );
    }
    const rpcUrl =
      process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

    let body: AccountInfoResponse;
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [address, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      body = (await res.json()) as AccountInfoResponse;
    } catch (err) {
      throw new BadGatewayException(`Solana RPC unreachable: ${String(err)}`);
    }
    if (body.error || !body.result) {
      throw new BadGatewayException(
        `Solana RPC error: ${body.error?.message ?? 'empty response'}`,
      );
    }

    const account = body.result.value;
    // Anyone can create an account with matching bytes; only the program's
    // own accounts carry its guarantees.
    if (!account || account.owner !== programId) return null;
    return decodeEscrow(Buffer.from(account.data[0], 'base64'));
  }
}

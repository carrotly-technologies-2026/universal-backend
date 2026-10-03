import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Constant-time string comparison (both sides hashed, so lengths may differ). */
export function safeEqual(given: string, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** A way to authenticate: a request header that must equal an env variable. */
export interface SecretSource {
  header: string;
  env: string;
  /** Strip this prefix from the header value first, e.g. "Bearer ". */
  prefix?: string;
}

export const bearer = (env: string): SecretSource => ({
  header: 'authorization',
  env,
  prefix: 'Bearer ',
});

/**
 * Passes if any source matches. 503 when none of the env variables is set
 * (feature disabled), 401 otherwise.
 */
export function requireSecret(req: Request, ...sources: SecretSource[]): void {
  const configured = sources.filter((s) => process.env[s.env]);
  if (configured.length === 0) {
    throw new ServiceUnavailableException(
      `Disabled: set ${sources.map((s) => s.env).join(' or ')}.`,
    );
  }
  for (const s of configured) {
    let given = req.headers[s.header];
    if (Array.isArray(given)) given = given[0];
    if (typeof given !== 'string') continue;
    if (s.prefix) {
      if (!given.startsWith(s.prefix)) continue;
      given = given.slice(s.prefix.length);
    }
    if (safeEqual(given, process.env[s.env]!)) return;
  }
  throw new UnauthorizedException();
}

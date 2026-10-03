import { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { requireSecret, SecretSource } from './secret.js';

/** `@UseGuards(new SecretGuard(bearer('X_TOKEN')))` – see requireSecret. */
export class SecretGuard implements CanActivate {
  private readonly sources: SecretSource[];

  constructor(...sources: SecretSource[]) {
    this.sources = sources;
  }

  canActivate(context: ExecutionContext): boolean {
    requireSecret(context.switchToHttp().getRequest<Request>(), ...this.sources);
    return true;
  }
}

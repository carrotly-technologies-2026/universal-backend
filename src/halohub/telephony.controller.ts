import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { safeEqual } from '../common/secret.js';
import { SecretGuard } from '../common/secret.guard.js';
import { ContextService, dynamicVariables } from './context.service.js';
import { ConversationService, phoneSalt } from './conversation.service.js';
import { hashTelefonu, jezyk, parsePostCall, verifySignature } from './elevenlabs.js';
import { KnowledgeService } from './knowledge.service.js';

/** Endpoints called by the ElevenLabs agent during and after a phone call. */
@Controller('halohub')
export class TelephonyController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly context: ContextService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /**
   * Conversation-initiation webhook (Twilio calls). Returns the caller's
   * context from the last hour. It reveals data by phone number, so it needs
   * HALOHUB_INIT_SECRET as `x-init-secret` header or `?key=` (for setups
   * where only the URL can be configured).
   */
  @Post('webhooks/elevenlabs/init')
  @HttpCode(200)
  async init(@Req() req: Request, @Body() body: unknown, @Query('key') key?: string) {
    const secret = process.env.HALOHUB_INIT_SECRET;
    if (!secret) throw new ServiceUnavailableException('Disabled: set HALOHUB_INIT_SECRET.');
    const given = req.header('x-init-secret') ?? key;
    if (typeof given !== 'string' || !safeEqual(given, secret)) {
      throw new UnauthorizedException();
    }
    const salt = phoneSalt();

    const callerId = (body as { caller_id?: unknown })?.caller_id;
    const ctx =
      typeof callerId === 'string' && callerId
        ? await this.context.load(hashTelefonu(callerId, salt))
        : null;
    return {
      type: 'conversation_initiation_client_data',
      dynamic_variables: dynamicVariables(ctx),
    };
  }

  /**
   * Post-call webhook. With ELEVENLABS_WEBHOOK_SECRET set, only requests
   * HMAC-signed by ElevenLabs are accepted; without it anyone may post
   * (open by choice for the hackathon – fake calls then reach the stats).
   */
  @Post('webhooks/elevenlabs')
  @HttpCode(200)
  async postCall(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (secret && !verifySignature(req.header('elevenlabs-signature'), req.rawBody, secret)) {
      throw new UnauthorizedException('Invalid signature.');
    }
    phoneSalt();
    const call = parsePostCall(body);
    // Other event types (e.g. audio) are acknowledged so they are not retried.
    if (!call) return { ok: true, ignored: true };
    const saved = await this.conversations.savePostCall(call);
    return { ok: true, bariery: saved.bariery };
  }

  /** `szukaj_wiedzy` webhook tool. Errors become "no results", never 500. */
  @Post('tools/szukaj_wiedzy')
  @HttpCode(200)
  @UseGuards(new SecretGuard({ header: 'x-tool-secret', env: 'HALOHUB_TOOL_SECRET' }))
  szukajWiedzy(@Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.pytanie !== 'string' || !b.pytanie.trim()) {
      throw new BadRequestException('pytanie must be a non-empty string.');
    }
    return this.knowledge.szukaj({
      pytanie: b.pytanie,
      grupa: typeof b.grupa === 'string' ? b.grupa : null,
      jezyk: jezyk(b.jezyk),
      conversation_id: typeof b.conversation_id === 'string' ? b.conversation_id : null,
    });
  }
}

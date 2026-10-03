import { createHash, createHmac } from 'node:crypto';
import { safeEqual } from '../common/secret.js';
import {
  Bariera,
  KATEGORIE,
  Kategoria,
  Potrzeba,
  TYPY_UZYTKOWNIKA,
} from './model.js';

/**
 * ElevenLabs Agents payloads (post-call and conversation-initiation webhooks).
 * Field names per https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
 * and .../customization/personalization/twilio-personalization.
 */

/**
 * Header `ElevenLabs-Signature: t=<unix>,v0=<hex hmac-sha256("<t>.<body>")>`.
 * Rejects signatures older than toleranceS to block replays.
 */
export function verifySignature(
  header: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
  now = Date.now(),
  toleranceS = 30 * 60,
): boolean {
  if (!header || !rawBody) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');
  return typeof parts.v0 === 'string' && safeEqual(parts.v0, expected);
}

export const hashTelefonu = (numer: string, salt: string) =>
  createHash('sha256').update(numer.replace(/[^\d+]/g, '') + salt).digest('hex');

export interface PostCall {
  conversationId: string;
  callerId: string | null;
  czasTrwaniaS: number | null;
  rozpoczeto: Date | null;
  czyPowrot: boolean;
  transkrypcja: unknown;
  /** analysis.data_collection_results, flattened to their values. */
  pola: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};

/** Null unless it is a post_call_transcription event with a conversation id. */
export function parsePostCall(body: unknown): PostCall | null {
  const b = obj(body);
  if (b.type !== 'post_call_transcription') return null;
  const d = obj(b.data);
  if (typeof d.conversation_id !== 'string' || !d.conversation_id) return null;
  const meta = obj(d.metadata);
  const dynamic = obj(obj(d.conversation_initiation_client_data).dynamic_variables);
  const phone = obj(meta.phone_call);
  const results = obj(obj(d.analysis).data_collection_results);
  const pola = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, obj(v).value ?? null]),
  );
  const caller = dynamic.system__caller_id ?? phone.external_number;
  const start = Number(meta.start_time_unix_secs);
  // A previous context was offered, but the agent may have judged this a new matter.
  const kontynuacja = bool(pola.kontynuacja);
  return {
    conversationId: d.conversation_id,
    callerId: typeof caller === 'string' && caller ? caller : null,
    czasTrwaniaS: num(meta.call_duration_secs),
    rozpoczeto: Number.isFinite(start) && start > 0 ? new Date(start * 1000) : null,
    czyPowrot: dynamic.czy_powrot === 'tak' && kontynuacja !== false,
    transkrypcja: d.transcript ?? null,
    pola,
  };
}

export const str = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

export const bool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;

function num(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : null;
}

export function typUzytkownika(v: unknown): string | null {
  const s = str(v, 40)?.toLowerCase();
  if (!s) return null;
  return (TYPY_UZYTKOWNIKA as readonly string[]).includes(s) ? s : 'inny';
}

export function jezyk(v: unknown): string | null {
  const s = str(v, 10)?.toLowerCase();
  // "pl-PL" → "pl"; anything that is not a language code is dropped.
  const m = s?.match(/^([a-z]{2,3})(?:[-_][a-z]{2,4})?$/);
  return m ? m[1] : null;
}

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type NowaBariera = Pick<
  Bariera,
  'kategoria' | 'opis' | 'miejsce' | 'dzielnica' | 'powaga' | 'dotyczy'
>;

/** `problemy_json`: invalid items are dropped, unknown categories become INNE. */
export function parseBariery(v: unknown): NowaBariera[] {
  return parseJsonArray(v).flatMap((raw) => {
    const p = obj(raw);
    const miejsce = str(p.miejsce, 200);
    const opis = str(p.opis, 1000);
    if (!miejsce && !opis) return [];
    const kat = str(p.kategoria, 40)?.toUpperCase() ?? '';
    const powaga = Math.round(Number(p.powaga));
    return [
      {
        kategoria: (KATEGORIE as readonly string[]).includes(kat)
          ? (kat as Kategoria)
          : 'INNE',
        opis: opis ?? '',
        miejsce: miejsce ?? 'nieznane miejsce',
        dzielnica: str(p.dzielnica, 100),
        powaga: (powaga >= 1 && powaga <= 3 ? powaga : 1) as 1 | 2 | 3,
        dotyczy: Array.isArray(p.dotyczy)
          ? p.dotyczy.map((g) => typUzytkownika(g)).filter((g) => g !== null)
          : [],
      },
    ];
  });
}

/** `potrzeby_json`. */
export function parsePotrzeby(v: unknown): Potrzeba[] {
  return parseJsonArray(v).flatMap((raw) => {
    const p = obj(raw);
    const temat = str(p.temat, 300);
    if (!temat) return [];
    return [
      {
        temat,
        grupa: typUzytkownika(p.grupa),
        czy_znaleziono: bool(p.czy_znaleziono) ?? false,
      },
    ];
  });
}

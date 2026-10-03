import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Filter } from 'mongodb';
import { HalohubStore, parseId, toApi } from './halohub.store.js';
import { KnowledgeService } from './knowledge.service.js';
import { STATUSY, StatusTematu, Temat } from './model.js';
import {
  ETYKIETY_KATEGORII,
  kluczTematu,
  WAGI,
  wyliczTematy,
} from './priority.js';

const DAY_MS = 86_400_000;

export interface TopicFilter {
  priorytet?: string;
  status?: string;
  kategoria?: string;
  dzielnica?: string;
  jezyk?: string;
  aktywne?: boolean;
  limit?: number;
}

/** Topics and their priority score (PLAN.md 8.6). */
@Injectable()
export class TopicsService {
  private readonly logger = new Logger(TopicsService.name);

  constructor(
    private readonly store: HalohubStore,
    private readonly knowledge: KnowledgeService,
  ) {}

  private lock: Promise<unknown> = Promise.resolve();

  /** Hourly job: regroup the 30-day window, keep human-set fields. */
  recompute(now = new Date()): Promise<{ tematy: number; innowacje: number }> {
    // Serialized: the scheduler, the jobs endpoint and demo seeding may overlap.
    const run = this.lock.then(() => this.doRecompute(now));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async doRecompute(now: Date): Promise<{ tematy: number; innowacje: number }> {
    const bariery = await this.store.bariery();
    const window = await bariery
      .find(
        { utworzono: { $gte: new Date(now.getTime() - WAGI.oknoDni * DAY_MS) } },
        { projection: { opis: 0 } },
      )
      .toArray();
    const computed = wyliczTematy(window, now);
    const tematy = await this.store.tematy();

    for (const t of computed) {
      const existing = await tematy.findOne({ klucz: t.klucz });
      // A fixed topic with new reports after the fix is open again.
      const fixedAt = existing?.historia.findLast((h) => h.status === 'naprawiony')?.kiedy;
      const reopen =
        existing?.status === 'naprawiony' && fixedAt && t.ostatnie_zgloszenie > fixedAt;
      if (!existing) {
        await tematy.insertOne({
          ...t,
          aktywny: true,
          zaktualizowano: now,
          status: 'nowy',
          notatka: null,
          historia: [],
          innowacje: [],
          innowacje_odswiezono: null,
        } as unknown as Temat);
        continue;
      }
      // The first report stays the first even after it leaves the 30-day window,
      // so reaction time is measured from the real start.
      const { pierwsze_zgloszenie, ...rest } = t;
      await tematy.updateOne(
        { _id: existing._id },
        {
          $min: { pierwsze_zgloszenie },
          $set: {
            ...rest,
            aktywny: true,
            zaktualizowano: now,
            ...(reopen && { status: 'nowy' as StatusTematu }),
          },
          ...(reopen && { $push: { historia: { status: 'nowy', kiedy: now } } }),
        },
      );
    }
    await tematy.updateMany(
      { klucz: { $nin: computed.map((t) => t.klucz) }, aktywny: true },
      { $set: { aktywny: false, zaktualizowano: now } },
    );
    return { tematy: computed.length, innowacje: await this.refreshInnovations(now) };
  }

  async list(f: TopicFilter) {
    const filter: Filter<Temat> = {};
    if (f.aktywne !== false) filter.aktywny = true;
    if (f.priorytet) filter.priorytet = f.priorytet as Temat['priorytet'];
    if (f.status) filter.status = f.status as StatusTematu;
    if (f.kategoria) filter.kategoria = f.kategoria as Temat['kategoria'];
    if (f.dzielnica) filter.dzielnica = f.dzielnica;
    if (f.jezyk) filter.jezyki = f.jezyk;
    const tematy = await this.store.tematy();
    const list = await tematy
      .find(filter)
      .sort({ wynik: -1 })
      .limit(Math.min(f.limit ?? 100, 500))
      .toArray();
    return list.map(toApi);
  }

  async get(id: string) {
    const temat = await this.find(id);
    const bariery = await this.barriersOf(temat);
    return { ...toApi(temat), bariery: bariery.map(toApi) };
  }

  /** Barriers of the topic's 30-day window, newest first. */
  private async barriersOf(temat: Temat) {
    const bariery = await (await this.store.bariery())
      .find(
        {
          kategoria: temat.kategoria,
          utworzono: { $gte: new Date(Date.now() - WAGI.oknoDni * DAY_MS) },
        },
        { projection: { telefon_hash: 0, rozmowa_id: 0 } },
      )
      .sort({ utworzono: -1 })
      .toArray();
    return bariery.filter((b) => kluczTematu(b.kategoria, b.miejsce) === temat.klucz);
  }

  async update(id: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const temat = await this.find(id);
    const now = new Date();
    const $set: Partial<Temat> = { zaktualizowano: now };
    let push: Temat['historia'][number] | undefined;
    if (b.status !== undefined) {
      if (!(STATUSY as readonly unknown[]).includes(b.status)) {
        throw new BadRequestException(`status must be one of: ${STATUSY.join(', ')}.`);
      }
      if (b.status !== temat.status) {
        $set.status = b.status as StatusTematu;
        push = { status: b.status as StatusTematu, kiedy: now };
      }
    }
    if (b.notatka !== undefined) {
      if (b.notatka !== null && typeof b.notatka !== 'string') {
        throw new BadRequestException('notatka must be a string or null.');
      }
      $set.notatka = b.notatka ? b.notatka.slice(0, 2000) : null;
    }
    const tematy = await this.store.tematy();
    const updated = await tematy.findOneAndUpdate(
      { _id: temat._id },
      { $set, ...(push && { $push: { historia: push } }) },
      { returnDocument: 'after' },
    );
    return toApi(updated!);
  }

  private async find(id: string) {
    const _id = parseId(id);
    const temat = _id && (await (await this.store.tematy()).findOne({ _id }));
    if (!temat) throw new NotFoundException('Topic not found.');
    return temat;
  }

  /** RAG matches for P1/P2 topics, refreshed at most daily. */
  private async refreshInnovations(now: Date): Promise<number> {
    const tematy = await this.store.tematy();
    const stale = await tematy
      .find({
        aktywny: true,
        priorytet: { $in: ['P1', 'P2'] },
        $or: [
          { innowacje_odswiezono: null },
          // Matched before innovations were checked by the LLM.
          { innowacje_sprawdzone: { $ne: true } },
          { innowacje_odswiezono: { $lt: new Date(now.getTime() - DAY_MS) } },
        ],
      })
      .limit(20)
      .toArray();
    let n = 0;
    for (const t of stale) {
      const opisy = (await this.barriersOf(t)).slice(0, 5);
      const query = [ETYKIETY_KATEGORII[t.kategoria], ...opisy.map((o) => o.opis)]
        .join('. ')
        .slice(0, 800);
      try {
        const innowacje = await this.knowledge.innowacje(query);
        await tematy.updateOne(
          { _id: t._id },
          { $set: { innowacje, innowacje_odswiezono: now, innowacje_sprawdzone: true } },
        );
        n++;
      } catch (err) {
        this.logger.warn(`Innovation lookup failed: ${String(err)}`);
        break;
      }
    }
    return n;
  }
}

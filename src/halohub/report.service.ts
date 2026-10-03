import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ObjectId, WithId } from 'mongodb';
import { GeminiService, LlmUnavailableError } from '../llm/gemini.service.js';
import { HalohubStore, parseId } from './halohub.store.js';
import { KnowledgeService } from './knowledge.service.js';
import { Metryki } from './metrics.js';
import { MetricsService } from './metrics.service.js';
import {
  JEZYKI_RAPORTU,
  JezykRaportu,
  Publikacja,
  Raport,
  Temat,
  TematPubliczny,
  WERSJA_DEFINICJI,
} from './model.js';
import { ETYKIETY_KATEGORII } from './priority.js';

const DAY_MS = 86_400_000;

const PROMPT_RAPORTU = `Jesteś analitykiem dostępności miasta Krakowa. Poniżej lista zgłoszeń
barier z ostatnich 24 godzin w formacie JSON.

1. Połącz zgłoszenia dotyczące tego samego miejsca i tego samego problemu.
2. Wybierz 5 najpilniejszych barier. Kryteria: powaga, liczba zgłoszeń,
   to, czy dotyczą osób na wózkach, z chodzikiem lub seniorów.
3. Dla każdej podaj: miejsce, kategorię, ile razy zgłoszono, kogo dotyczy,
   w jakich językach zgłaszano, wynik priorytetu, jedną konkretną
   rekomendację dla miasta. Jeśli w INNOWACJE jest pasujące rozwiązanie,
   wskaż je z linkiem; jeśli nie ma – nie wymyślaj.
4. Osobny akapit „Języki”: czy rozmówcy spoza PL dotarli rzadziej
   i jakie bariery językowe się powtarzają (dane z METRYKI).
5. Osobny akapit „Luki w wiedzy”: o co pytano, a czego nie znaleźliśmy.
6. Na końcu 2–3 zdania o trendach.

Pisz po polsku, rzeczowo, bez ozdobników. Nie wymyślaj zgłoszeń,
których nie ma w danych. Odpowiedz w Markdown.`;

const NAZWY_JEZYKOW: Record<JezykRaportu, string> = {
  pl: 'polski',
  en: 'English',
  uk: 'українська (Ukrainian)',
};

const publicMin = () => Number(process.env.PUBLIC_MIN_ZGLOSZEN || 3);

/** Daily LLM report and the publication snapshots built from it (PLAN.md 2.4, 9.6). */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly store: HalohubStore,
    private readonly metrics: MetricsService,
    private readonly knowledge: KnowledgeService,
    private readonly gemini: GeminiService,
  ) {}

  async generateDaily(now = new Date()) {
    const dzien = { od: new Date(now.getTime() - DAY_MS), do: now };
    const tematy = await (await this.store.tematy())
      .find({ aktywny: true, status: { $ne: 'odrzucony' } })
      .sort({ wynik: -1 })
      .limit(20)
      .toArray();
    const [metryki24h, luki] = await Promise.all([
      this.metrics.compute(dzien),
      this.metrics.luki(dzien),
    ]);
    const innowacje = await this.innovationsFor(tematy.slice(0, 5));

    const { tresc, zrodlo } = await this.write(tematy, metryki24h, luki, innowacje);
    const raport: Omit<Raport, '_id'> = {
      okres_od: dzien.od,
      okres_do: dzien.do,
      tresc_md: tresc,
      zrodlo,
      utworzono: now,
    };
    const raportId = (await (await this.store.raporty()).insertOne(raport as Raport))
      .insertedId;

    // The public snapshot covers a longer window so it is not empty on quiet days.
    const days = Number(process.env.HALOHUB_PUBLICATION_DAYS || 7);
    const okres = { od: new Date(now.getTime() - days * DAY_MS), do: now };
    const metryki = await this.metrics.compute(okres);
    // k-anonymity: a topic leaves the city only once enough distinct people
    // reported it. The public text is written from these topics alone and
    // never sees callers' questions (PLAN.md 9.6).
    const jawne = tematy.filter((t) => t.liczba_osob >= publicMin());
    const publiczne = jawne.map(toPubliczny);
    const publicText =
      jawne.length === tematy.length
        ? { tresc, zrodlo }
        : await this.write(jawne, metryki, null, await this.innovationsFor(jawne.slice(0, 5)));
    const auto = process.env.AUTO_PUBLISH === 'true';
    const publikacja: Omit<Publikacja, '_id'> = {
      raport_id: raportId,
      okres_od: okres.od,
      okres_do: okres.do,
      metryki,
      tematy: publiczne,
      raport_md: publicText.tresc,
      status: auto ? 'opublikowana' : 'szkic',
      demo: metryki.demo || jawne.some((t) => t.demo),
      wersja_definicji: WERSJA_DEFINICJI,
      opublikowano: auto ? now : null,
      utworzono: now,
    };
    const publikacjaId = (
      await (await this.store.publikacje()).insertOne(publikacja as Publikacja)
    ).insertedId;
    return {
      raport_id: raportId.toHexString(),
      publikacja_id: publikacjaId.toHexString(),
      zrodlo,
      status: publikacja.status,
    };
  }

  async latestReport(lang: JezykRaportu) {
    const r = await (await this.store.raporty()).find().sort({ utworzono: -1 }).limit(1).next();
    if (!r) throw new NotFoundException('No report yet.');
    return {
      id: r._id.toHexString(),
      okres_od: r.okres_od,
      okres_do: r.okres_do,
      utworzono: r.utworzono,
      zrodlo: r.zrodlo,
      tresc_md: r.tresc_md[lang] ?? r.tresc_md.pl ?? '',
    };
  }

  async listPublications(status?: 'szkic' | 'opublikowana') {
    const list = await (await this.store.publikacje())
      .find(status ? { status } : {}, { projection: { metryki: 0, raport_md: 0 } })
      .sort({ utworzono: -1 })
      .limit(100)
      .toArray();
    return list.map((p) => skrot(p as WithId<Publikacja>));
  }

  async getPublication(id: string, lang: JezykRaportu, onlyPublished: boolean) {
    const _id = parseId(id);
    const p = _id && (await (await this.store.publikacje()).findOne({ _id }));
    if (!p || (onlyPublished && p.status !== 'opublikowana')) {
      throw new NotFoundException('Publication not found.');
    }
    return pelna(p, lang);
  }

  async latestPublished(): Promise<WithId<Publikacja>> {
    const p = await (await this.store.publikacje())
      .find({ status: 'opublikowana' })
      .sort({ opublikowano: -1 })
      .limit(1)
      .next();
    if (!p) throw new NotFoundException('Nothing published yet.');
    return p;
  }

  async publish(id: string, lang: JezykRaportu) {
    const _id = parseId(id);
    const coll = await this.store.publikacje();
    const p = _id && (await coll.findOne({ _id }));
    if (!p) throw new NotFoundException('Publication not found.');
    if (p.status === 'opublikowana') throw new ConflictException('Already published.');
    const updated = await coll.findOneAndUpdate(
      { _id: p._id },
      { $set: { status: 'opublikowana', opublikowano: new Date() } },
      { returnDocument: 'after' },
    );
    return pelna(updated!, lang);
  }

  private async innovationsFor(tematy: WithId<Temat>[]) {
    const out: { temat: string; innowacje: unknown[] }[] = [];
    for (const t of tematy) {
      let innowacje = t.innowacje;
      if (!innowacje.length) {
        try {
          innowacje = await this.knowledge.innowacje(`${ETYKIETY_KATEGORII[t.kategoria]} ${t.miejsce}`);
        } catch {
          innowacje = [];
        }
      }
      out.push({
        temat: t.tytul,
        innowacje: innowacje.map((i) => ({ tytul: i.tytul, url: i.url, streszczenie: i.glos_streszczenie })),
      });
    }
    return out;
  }

  private async write(
    tematy: WithId<Temat>[],
    metryki: Metryki,
    /** null for the public version: no callers' questions in it. */
    luki: Awaited<ReturnType<MetricsService['luki']>> | null,
    innowacje: unknown,
  ): Promise<{ tresc: Raport['tresc_md']; zrodlo: Raport['zrodlo'] }> {
    const tematyJson = tematy.map((t) => ({
      tytul: t.tytul,
      kategoria: t.kategoria,
      miejsce: t.miejsce,
      dzielnica: t.dzielnica,
      liczba_zgloszen: t.liczba_zgloszen,
      sr_powaga: t.sr_powaga,
      grupy: t.grupy,
      jezyki: t.jezyki,
      wynik: t.wynik,
      priorytet: t.priorytet,
      rozbicie: t.rozbicie,
      status: t.status,
    }));
    const metrykiJson = luki
      ? {
          ...metryki,
          luki_w_wiedzy: {
            pytania_bez_wynikow: luki.pytania_bez_wynikow.slice(0, 10),
            potrzeby_nieznalezione: luki.potrzeby_nieznalezione.slice(0, 10),
          },
        }
      : metryki;
    const publicNote = luki
      ? ''
      : '\n\nTo jest wersja publiczna dla mieszkańców: w akapicie „Luki w wiedzy” podaj tylko liczby z METRYKI (pytania_rag, odsetek_bez_wynikow), nie cytuj pytań.';
    const prompt = `${PROMPT_RAPORTU}${publicNote}

TEMATY:
${JSON.stringify(tematyJson)}

METRYKI:
${JSON.stringify(metrykiJson)}

INNOWACJE:
${JSON.stringify(innowacje)}`;

    try {
      const pl = await this.gemini.generate({
        system: 'Piszesz raporty dla Urzędu Miasta Krakowa.',
        prompt,
      });
      const tresc: Raport['tresc_md'] = { pl };
      for (const lang of JEZYKI_RAPORTU.filter((l) => l !== 'pl')) {
        try {
          tresc[lang] = await this.gemini.generate({
            system: `Przetłumacz wiernie na język: ${NAZWY_JEZYKOW[lang]}. Zachowaj Markdown, liczby, linki i nazwy miejsc (nazwy miejsc zostają po polsku). Odpowiedz samym tłumaczeniem.`,
            prompt: pl,
          });
        } catch (err) {
          this.logger.warn(`Translation to ${lang} failed: ${String(err)}`);
        }
      }
      return { tresc, zrodlo: 'llm' };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      this.logger.warn(`Report LLM unavailable, using template: ${err.message}`);
      return { tresc: { pl: szablon(tematy, metryki) }, zrodlo: 'szablon' };
    }
  }
}

function toPubliczny(t: Temat): TematPubliczny {
  return {
    tytul: t.tytul,
    kategoria: t.kategoria,
    miejsce: t.miejsce,
    dzielnica: t.dzielnica,
    liczba_zgloszen: t.liczba_zgloszen,
    priorytet: t.priorytet,
    status: t.status,
    wynik: t.wynik,
    grupy: t.grupy,
    jezyki: t.jezyki,
  };
}

function skrot(p: WithId<Publikacja>) {
  return {
    id: (p._id as ObjectId).toHexString(),
    okres_od: p.okres_od,
    okres_do: p.okres_do,
    status: p.status,
    opublikowano: p.opublikowano,
    utworzono: p.utworzono,
    demo: p.demo,
    liczba_tematow: p.tematy.length,
  };
}

export function pelna(p: WithId<Publikacja>, lang: JezykRaportu) {
  return {
    ...skrot(p),
    wersja_definicji: p.wersja_definicji,
    metryki: p.metryki as Metryki,
    tematy: p.tematy,
    raport_md: p.raport_md[lang] ?? p.raport_md.pl ?? null,
    jezyki_raportu: Object.keys(p.raport_md),
  };
}

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

/** Deterministic report used when the LLM is unavailable. */
function szablon(tematy: Temat[], m: Metryki): string {
  const top = tematy.slice(0, 5);
  const rows = top.map(
    (t) =>
      `| ${t.priorytet} | ${t.miejsce} | ${ETYKIETY_KATEGORII[t.kategoria]} | ${t.liczba_zgloszen} | ${t.grupy.join(', ') || '–'} | ${t.jezyki.join(', ') || '–'} | ${t.wynik} |`,
  );
  return [
    '# Raport dzienny (wersja automatyczna, bez modelu językowego)',
    '',
    `Okres: ${m.okres_od.slice(0, 16).replace('T', ' ')} – ${m.okres_do.slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `Rozmowy: **${m.rozmowy.razem}**, bariery: **${m.bariery.razem}**, dotarło: **${pct(m.odsetek_dotarlo.razem)}**, ponowne telefony: **${pct(m.ponowne_telefony.razem)}**.`,
    '',
    '## Najważniejsze tematy',
    '',
    top.length
      ? ['| Priorytet | Miejsce | Kategoria | Zgłoszenia | Kogo dotyczy | Języki | Wynik |', '|---|---|---|---|---|---|---|', ...rows].join('\n')
      : 'Brak aktywnych tematów.',
    '',
    '## Języki',
    '',
    `Luka dotarcia PL vs inne języki: ${m.luka_jezykowa_dotarcia === null ? 'brak danych' : `${m.luka_jezykowa_dotarcia} pp`}. Bariery językowe: ${m.bariery_jezykowe.razem}.`,
    '',
    '## Luki w wiedzy',
    '',
    `Pytania do bazy wiedzy: ${m.pytania_rag.razem}, bez wyników: ${pct(m.odsetek_bez_wynikow.razem)}.`,
  ].join('\n');
}

import * as cheerio from 'cheerio';
import { POMIJANE_PDF } from './sources.js';

/**
 * HTML extraction for rops.krakow.pl. Only the main column
 * (`.content__main`) is used: the side menu is huge and would pollute the
 * embeddings.
 */

export interface Link {
  url: string;
  text: string;
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.protocol.startsWith('http') ? u.toString() : null;
  } catch {
    return null;
  }
}

function links($: cheerio.CheerioAPI, scope: string, base: string): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  $(scope)
    .find('a[href]')
    .each((_, a) => {
      const url = absolute($(a).attr('href')!, base);
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({ url, text: ($(a).attr('title') || $(a).text()).replace(/\s+/g, ' ').trim() });
    });
  return out;
}

/** Entry pages of a library category: `{category},{slug}`. */
export function entryLinks(html: string, base: string, category: string): string[] {
  const $ = cheerio.load(html);
  const prefix = `/biblioteka-innowacji-spolecznych/${category},`;
  return links($, '.content__main', base)
    .map((l) => l.url)
    .filter((u) => new URL(u).pathname.includes(prefix));
}

/** Pagination links of a category page, if the site ever adds them. */
export function pageLinks(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  return links($, '.pagination', base).map((l) => l.url);
}

export interface Entry {
  title: string;
  text: string;
  pdfs: string[];
  contact: string | null;
}

/** A library entry: title, readable text, linked model PDFs, contact. */
export function parseEntry(html: string, base: string): Entry | null {
  const $ = cheerio.load(html);
  const main = $('.content__main').first();
  const title = main.find('.page-title').first().text().trim();
  const content = main.find('.text-content').first();
  if (!title || content.length === 0) return null;
  const pdfs = links($, '.content__main .text-content', base)
    .map((l) => l.url)
    .filter((u) => /\.pdf$/i.test(new URL(u).pathname) && !POMIJANE_PDF.test(u));
  const text = toText($, content);
  return { title, text, pdfs, contact: contact(text) };
}

/** PDF links (direct `.pdf` or `/pliki-do-pobrania/wpis,…` downloads) in the main column. */
export function documentLinks(html: string, base: string): Link[] {
  const $ = cheerio.load(html);
  return links($, '.content__main', base).filter((l) => {
    const path = new URL(l.url).pathname;
    return (
      (/\.pdf$/i.test(path) || path.startsWith('/pliki-do-pobrania/wpis,')) &&
      !POMIJANE_PDF.test(l.url)
    );
  });
}

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,div,tr,blockquote';

/** Visible text with blank lines between blocks; icon tables are dropped. */
function toText($: cheerio.CheerioAPI, el: ReturnType<cheerio.CheerioAPI>): string {
  const copy = el.clone();
  copy.find('script,style,iframe,button').remove();
  // Header tables hold download/licence/video icons with short captions.
  copy.find('table').each((_, t) => {
    const table = $(t);
    if (table.find('img').length > 0 && table.text().replace(/\s+/g, ' ').trim().length < 200) {
      table.remove();
    }
  });
  copy.find('img').remove();
  copy.find('br').replaceWith('\n');
  copy.find(BLOCKS).each((_, b) => {
    $(b).append('\n\n');
  });
  return copy
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Phone/e-mail if present, else the "Autorzy" line (who to ask). */
function contact(text: string): string | null {
  const phone = text.match(/(?:tel\.?|telefon)[:\s]*((?:\+48\s?)?\d{2,3}[\s-]?\d{3}[\s-]?\d{2,3}[\s-]?\d{0,3})/i)?.[1];
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const parts = [phone && `tel. ${phone.trim()}`, email].filter(Boolean);
  if (parts.length) return parts.join(', ');
  const authors = text
    .match(/Autorzy\s*\n+([^\n]{3,200})/)?.[1]
    ?.replace(/^[-–•\s]+/, '')
    .trim();
  return authors ? `Autorzy: ${authors}` : null;
}

/**
 * Two sentences from the first real paragraph, skipping numbered question
 * headings like "1. Na czym polega rozwiązanie?". Fallback when no LLM summary.
 */
export function extractiveSummary(text: string, maxChars = 400): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p.length >= 60 && !p.endsWith('?') && p !== p.toUpperCase()) ?? text;
  const sentences = (paragraph.match(/[^.!?]+[.!?]+/g) ?? [paragraph]).map((s) => s.trim());
  const two = sentences.slice(0, 2).join(' ');
  const out = two.length <= maxChars ? two : sentences[0];
  if (out.length <= maxChars) return out;
  return `${out.slice(0, out.lastIndexOf(' ', maxChars - 1))}…`;
}

/**
 * news-update.js
 * Bardun Stall AB — News Auto-Updater
 *
 * PURPOSE:
 *   Discovers recent Swedish trotting news mentioning Jonathan Bardun,
 *   Floripa, Metarie, Bandida, Blyger S.R.P. or Coraline, then writes
 *   the top results to news.js (consumed by the site as window.BARDUN_NEWS).
 *
 * STRATEGY (hybrid):
 *   1. Query Google News RSS for each keyword (no API key required).
 *   2. Filter by a whitelist of stall-relevant terms + allowed trav sources.
 *   3. Dedupe by canonical URL.
 *   4. Optionally enrich each article's excerpt by fetching its <meta
 *      name="description"> (best-effort, skipped on failure).
 *   5. Merge with existing news.js, keep newest N, write atomically.
 *
 * SCHEDULE: Daily at 07:00 CET  →  cron  0 7 * * *
 *
 * SETUP:
 *   npm install rss-parser cheerio
 *   node news-update.js
 *
 * DEPLOY OPTIONS:
 *   - Vercel Cron: wrap fetchNews() in an api/cron/news.js route.
 *   - Local cron:  0 7 * * * node /path/to/news-update.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, 'news.js');
const MAX_ARTICLES = 10;
const ENRICH_EXCERPTS = true;        // set false to skip per-article fetches
const ENRICH_TIMEOUT_MS = 6000;

// ── DISCOVERY KEYWORDS (used to build Google News queries) ────────────────────
const QUERIES = [
  '"Jonathan Bardun" trav',
  '"Stall Bardun" trav',
  '"Floripa" trav Bardun',
  '"Metarie" trav Bardun',
  '"Bandida" trav Bardun',
  '"Blyger S.R.P." trav',
  '"Coraline" trav Bardun'
];

// ── RELEVANCE FILTER ──────────────────────────────────────────────────────────
// An article is relevant if ANY of these conditions is true:
//
//   1. "jonathan bardun" + any horse  (metarie, floripa, bandida, blyger, coraline)
//   2. "stallbardun" or "stall bardun" is mentioned
//   3. A horse name (floripa, metarie, bandida) + a trotting term (trav, kusk, etc.)
//
// This prevents unrelated "Floripa" (Brazil) noise while keeping real coverage.

const HORSES = ['floripa', 'metarie', 'bandida', 'blyger', 'coraline'];

const TRAV_CONTEXT = [
  'trav', 'kusk', 'tränare', 'v64', 'v75', 'v85', 'v86', 'lopp',
  'sulky', 'travbana', 'mantorp', 'solvalla', 'eskilstuna', 'halmstad',
  'häst', 'sulkysport', 'travrevyn'
];

// Source allowlist — restrict to known Swedish trotting outlets + generics.
// Leave empty array to allow all sources.
const ALLOWED_HOSTS = [
  'travrevyn.com',
  'sulkysport.se',
  'nastagangare.se',
  'rekatochklart.com',
  'mantorphastsportarena.se',
  'travronden.se',
  'atg.se',
  'trav365.se',
  'sportbladet.se',
  'expressen.se',
  'svenskatravsportens.se',
  'tr.se',
  'youtube.com',
  'youtu.be'
];

// ── YOUTUBE CHANNELS ──────────────────────────────────────────────────────────
// Add channel IDs of Swedish trotting channels you want to monitor.
// To find a channel ID: open the channel page → View Source → search "channelId".
// Or paste the @handle URL into https://commentpicker.com/youtube-channel-id.php
// Each channel's RSS feed: https://www.youtube.com/feeds/videos.xml?channel_id=ID
const YOUTUBE_CHANNELS = [
  { name: 'ATG',                    id: 'UCGFdJIYoUfodfBGFYpHt4eg' },
  { name: 'Färjestads Travet',      id: 'UCkC9anQAmThgGfdJuEkArHw' },
  { name: 'Mantorp Hästsportarena', id: 'UCC_WFbMpZbRpyAoTTzHiGFA' },
];

// ── DIRECT SITE RSS FEEDS ─────────────────────────────────────────────────────
// These are crawled in full — every item is tested against the relevance filter.
// This catches articles that Google News misses (e.g. Travronden referat).
const SITE_RSS_FEEDS = [
  { name: 'Travronden',             url: 'https://www.travronden.se/rss/nyheter/rss.xml' },
  // Add more site feeds here as you find them, e.g.:
  // { name: 'Sulkysport',          url: 'https://sulkysport.se/feed/' },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  const Parser = (await import('rss-parser')).default;
  const parser = new Parser({
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BardunStallAB-NewsBot/1.0; +https://www.stallbardun.com)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
  });

  const seen = new Map(); // url → article

  // 1) Google News RSS searches
  for (const q of QUERIES) {
    const feedUrl = buildGoogleNewsUrl(q);
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        const art = normalizeItem(item);
        if (!art) continue;
        if (!isRelevant(art)) continue;
        if (ALLOWED_HOSTS.length && !hostAllowed(art.url)) continue;
        if (!seen.has(art.url)) seen.set(art.url, art);
      }
      console.log(`[OK] ${q} → ${feed.items?.length || 0} items`);
    } catch (e) {
      console.warn(`[WARN] Query failed "${q}": ${e.message}`);
    }
  }

  // 2) Direct site RSS feeds (catches articles Google News misses)
  for (const site of SITE_RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(site.url);
      let matched = 0;
      for (const item of feed.items || []) {
        const art = normalizeSiteItem(item, site);
        if (!art) continue;
        // Enrich excerpt from full description if it's short
        if (art.excerpt.length < 80) {
          await enrichExcerpt(art);
        }
        if (!isRelevant(art)) continue;
        if (!seen.has(art.url)) { seen.set(art.url, art); matched++; }
      }
      console.log(`[OK] RSS:${site.name} → ${feed.items?.length || 0} items, ${matched} matched`);
    } catch (e) {
      console.warn(`[WARN] Site RSS "${site.name}" failed: ${e.message}`);
    }
  }

  // 3) YouTube channel RSS feeds
  for (const ch of YOUTUBE_CHANNELS) {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        const art = normalizeYouTubeItem(item, ch);
        if (!art) continue;
        if (!isRelevant(art)) continue;
        if (!seen.has(art.url)) seen.set(art.url, art);
      }
      console.log(`[OK] YouTube:${ch.name} → ${feed.items?.length || 0} items`);
    } catch (e) {
      console.warn(`[WARN] YouTube channel "${ch.name}" failed: ${e.message}`);
    }
  }

  let articles = [...seen.values()].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  // Enrich top candidates only (bounded work)
  if (ENRICH_EXCERPTS) {
    const top = articles.slice(0, MAX_ARTICLES * 2);
    await Promise.all(top.map(enrichExcerpt));
  }

  // Merge with existing hand-curated entries so nothing is lost
  const existing = await loadExisting();
  for (const a of existing) {
    if (!seen.has(a.url)) seen.set(a.url, a);
  }
  articles = [...seen.values()]
    .filter(isRelevant)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ARTICLES);

  await writeNewsJs(articles);
  console.log(`[DONE] Wrote ${articles.length} articles to news.js`);
}

// ── GOOGLE NEWS RSS URL ───────────────────────────────────────────────────────
function buildGoogleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=sv&gl=SE&ceid=SE:sv`;
}

// ── NORMALIZE RSS ITEM → ARTICLE ──────────────────────────────────────────────
function normalizeItem(item) {
  const url = canonicalizeUrl(item.link);
  if (!url) return null;
  const host = safeHost(url);
  return {
    title:   cleanText(item.title || '').replace(/\s-\s[^-]+$/, ''), // strip " - Source"
    url,
    source:  host.replace(/^www\./, ''),
    date:    toISODate(item.isoDate || item.pubDate),
    excerpt: cleanText(stripTags(item.contentSnippet || item.content || ''))
  };
}

function normalizeSiteItem(item, site) {
  const url = item.link || item.guid;
  if (!url) return null;
  return {
    title:   cleanText(item.title || ''),
    url,
    source:  site.name,
    date:    toISODate(item.isoDate || item.pubDate),
    excerpt: cleanText(stripTags(item.contentSnippet || item.content || item.description || ''))
  };
}

function normalizeYouTubeItem(item, channel) {
  const url = item.link;
  if (!url) return null;
  const desc = cleanText(stripTags(
    item['media:group']?.['media:description']?.[0] ||
    item.contentSnippet || item.content || ''
  ));
  return {
    title:   cleanText(item.title || ''),
    url,
    source:  `YouTube – ${channel.name}`,
    date:    toISODate(item.isoDate || item.pubDate),
    excerpt: desc.slice(0, 300),
    type:    'video'
  };
}

function canonicalizeUrl(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    // Google News wraps links: news.google.com/rss/articles/...?url=<real>
    const real = u.searchParams.get('url');
    if (real) return real;
    return u.toString();
  } catch {
    return null;
  }
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function hostAllowed(url) {
  const host = safeHost(url).replace(/^www\./, '');
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function isRelevant({ title, excerpt }) {
  const hay = `${title} ${excerpt}`.toLowerCase();

  const hasBardun  = hay.includes('jonathan bardun') || hay.includes('j. bardun') || hay.includes('j bardun');
  const hasStall   = hay.includes('stallbardun') || hay.includes('stall bardun') || hay.includes('bardun stall');
  const hasHorse   = HORSES.some(h => hay.includes(h));
  const hasTrav    = TRAV_CONTEXT.some(k => hay.includes(k));

  // Rule 1: Jonathan Bardun + any horse name
  if (hasBardun && hasHorse) return true;

  // Rule 2: Stall Bardun mentioned anywhere
  if (hasStall) return true;

  // Rule 3: Horse name + trotting context (filters out Brazilian Floripa etc.)
  if (hasHorse && hasTrav) return true;

  return false;
}

function toISODate(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = new Date(d);
  return isNaN(dt) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}

function stripTags(s)  { return String(s).replace(/<[^>]*>/g, ''); }
function cleanText(s)  { return String(s).replace(/\s+/g, ' ').trim(); }

// ── EXCERPT ENRICHMENT (fetch <meta name="description">) ──────────────────────
async function enrichExcerpt(article) {
  if (article.excerpt && article.excerpt.length > 80) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ENRICH_TIMEOUT_MS);
    const resp = await fetch(article.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'BardunStallAB-NewsBot/1.0 (+https://www.stallbardun.com)' }
    });
    clearTimeout(timer);
    if (!resp.ok) return;
    const html = await resp.text();
    const meta =
      pick(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
      pick(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (meta) article.excerpt = cleanText(meta);
  } catch { /* ignore enrichment failures */ }
}
function pick(s, re) { const m = s.match(re); return m ? m[1] : null; }

// ── LOAD EXISTING news.js ─────────────────────────────────────────────────────
async function loadExisting() {
  try {
    const txt = await fs.readFile(OUTPUT_PATH, 'utf8');
    const m = txt.match(/articles:\s*(\[[\s\S]*?\])\s*};/);
    if (!m) return [];
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

// ── WRITE news.js ─────────────────────────────────────────────────────────────
async function writeNewsJs(articles) {
  const today = new Date().toISOString().slice(0, 10);
  const body =
`// Bardun Stall AB — News Feed
// Auto-updated daily by news-update.js. Do not edit manually.
window.BARDUN_NEWS = {
  updated: "${today}",
  articles: ${JSON.stringify(articles, null, 4)}
};
`;
  const tmp = OUTPUT_PATH + '.tmp';
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, OUTPUT_PATH);
}

// ── ENTRY ─────────────────────────────────────────────────────────────────────
run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

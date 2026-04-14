/**
 * monday-update.js
 * Bardun Stall AB — Floripa Results Auto-Updater
 *
 * PURPOSE:
 *   Fetches the latest racing results for Floripa (ts797786) from Travsport
 *   every Monday and writes them to floripa-results.json.
 *   The floripa.html page reads this JSON file on load.
 *
 * SCHEDULE: Every Monday at 08:00 (CET)
 *   Cron: 0 8 * * 1
 *
 * SETUP:
 *   1. npm install node-fetch cheerio   (or use built-in fetch if Node 18+)
 *   2. Add to cron: 0 8 * * 1 node /path/to/monday-update.js
 *   OR deploy as a serverless function (Vercel, Netlify, Cloudflare Workers)
 *   triggered on a Monday cron schedule.
 *
 * OUTPUT:
 *   Writes floripa-results.json next to floripa.html
 */

const HORSE_ID   = 'ts797786';
const RESULTS_URL = `https://sportapp.travsport.se/sportinfo/horse/${HORSE_ID}/results`;
const OUTPUT_PATH = './floripa-results.json';

// ── COLUMN MAPPING (Travsport table columns) ──────────────────────────────────
// Travsport "Tävlingsresultat" table structure:
//   Datum | Bana | Lopp | Kusk | Start nr | Distans | Tid | Plac. | Prispengar

async function fetchResults() {
  console.log(`[${new Date().toISOString()}] Starting Floripa results sync from Travsport...`);

  let fetch, cheerio, fs;
  try {
    fetch   = (await import('node-fetch')).default;
    cheerio = await import('cheerio');
    fs      = await import('fs/promises');
  } catch (e) {
    console.error('Missing dependencies. Run: npm install node-fetch cheerio');
    process.exit(1);
  }

  // Travsport is a React SPA — we need the rendered HTML.
  // Use their public JSON API endpoint if available, otherwise
  // fall back to Puppeteer/Playwright for full rendering.
  // Below targets the Travsport public data API pattern:
  const API_URL = `https://sportapp.travsport.se/api/horse/${HORSE_ID}/startlist`;

  let races = [];
  let summary = { starts: 0, wins: 0, places: 0, shows: 0, earnings: 0 };

  try {
    // Attempt 1: JSON API
    const resp = await fetch(API_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BardunStallAB-ResultsSync/1.0'
      }
    });

    if (resp.ok) {
      const data = await resp.json();
      races   = mapApiResults(data);
      summary = computeSummary(races);
      console.log(`[OK] Fetched ${races.length} results from Travsport API.`);
    } else {
      throw new Error(`API returned ${resp.status}`);
    }

  } catch (apiErr) {
    console.warn(`[WARN] API fetch failed (${apiErr.message}). Falling back to HTML scrape...`);

    // Attempt 2: HTML scrape (requires rendered page — use puppeteer in production)
    try {
      const html = await (await fetch(RESULTS_URL, {
        headers: { 'User-Agent': 'BardunStallAB-ResultsSync/1.0' }
      })).text();

      const $ = cheerio.load(html);
      races   = scrapeHtmlResults($);
      summary = computeSummary(races);
      console.log(`[OK] Scraped ${races.length} results from HTML.`);

    } catch (scrapeErr) {
      console.error(`[ERROR] Both fetch methods failed: ${scrapeErr.message}`);
      // Write error state — page will show last cached data
      await writeOutput(null, `Sync failed: ${scrapeErr.message}`);
      return;
    }
  }

  await writeOutput({ races, summary });
}

// ── MAP API RESPONSE ──────────────────────────────────────────────────────────
function mapApiResults(data) {
  if (!Array.isArray(data)) return [];
  return data.map(item => ({
    date:     item.raceDate     || item.date     || '',
    track:    item.trackName    || item.track    || '',
    race:     item.raceNumber   || item.race     || '',
    driver:   item.driverName   || item.driver   || '',
    start:    item.startNumber  || item.start    || '',
    distance: item.distance     ? item.distance + 'm' : '',
    time:     item.finishTime   || item.time     || '',
    place:    parseInt(item.finishPosition || item.place || 0, 10) || null,
    prize:    parseInt(item.prizeAmount    || item.prize || 0, 10) || 0
  }));
}

// ── SCRAPE HTML RESULTS TABLE ─────────────────────────────────────────────────
function scrapeHtmlResults($) {
  const races = [];
  // Target the results table rows — Travsport uses class-based selectors
  $('table tbody tr, [class*="result"] tr, [class*="race"] tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    races.push({
      date:     $(cells[0]).text().trim(),
      track:    $(cells[1]).text().trim(),
      race:     $(cells[2]).text().trim(),
      driver:   $(cells[3]).text().trim(),
      start:    $(cells[4]).text().trim(),
      distance: $(cells[5]).text().trim(),
      time:     $(cells[6]).text().trim(),
      place:    parseInt($(cells[7]).text().trim(), 10) || null,
      prize:    parseInt($(cells[8]).text().replace(/\s/g, ''), 10) || 0
    });
  });
  return races;
}

// ── COMPUTE SUMMARY ───────────────────────────────────────────────────────────
function computeSummary(races) {
  return races.reduce((acc, r) => {
    acc.starts++;
    if (r.place === 1) acc.wins++;
    if (r.place === 2) acc.places++;
    if (r.place === 3) acc.shows++;
    acc.earnings += (r.prize || 0);
    return acc;
  }, { starts: 0, wins: 0, places: 0, shows: 0, earnings: 0 });
}

// ── WRITE OUTPUT JSON ─────────────────────────────────────────────────────────
async function writeOutput(payload, errorMsg = null) {
  const { promises: fs } = await import('fs');
  const output = {
    horse:     'Floripa',
    horseId:   HORSE_ID,
    lastSync:  new Date().toISOString(),
    source:    RESULTS_URL,
    error:     errorMsg || null,
    summary:   payload?.summary || null,
    races:     payload?.races   || []
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[DONE] Written to ${OUTPUT_PATH} — ${output.races.length} races, last sync: ${output.lastSync}`);
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────
fetchResults().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

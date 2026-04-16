/**
 * stable-update.js
 * Bardun Stall AB — Stable Stats Auto-Updater
 *
 * PURPOSE:
 *   Fetches owner statistics and upcoming races from Travsport
 *   and writes them to stable-stats.json.
 *   The home page dashboard reads this JSON on load.
 *
 * SCHEDULE: Every Monday at 08:15 (CET), after monday-update.js finishes.
 *   Cron: 15 8 * * 1
 *   For upcoming-race freshness, also run daily:
 *   Cron: 0 7 * * *
 *
 * SETUP:
 *   1. npm install node-fetch cheerio   (or use built-in fetch if Node 18+)
 *   2. Add to cron:
 *        15 8 * * 1 node /path/to/stable-update.js
 *        0  7 * * * node /path/to/stable-update.js
 *   OR deploy alongside monday-update.js as a scheduled task.
 *
 * OUTPUT:
 *   Writes stable-stats.json to the repo root.
 */

const OWNER_ID     = 'ts854450';
const STATS_URL    = `https://sportapp.travsport.se/sportinfo/owner/${OWNER_ID}/statistics`;
const OUTPUT_PATH  = './stable-stats.json';

// Horse registry — keep in sync with the site
const HORSES = [
  { name: 'Metarie',  id: 'ts793642' },
  { name: 'Floripa',  id: 'ts797786' },
  { name: 'Bandida',  id: 'ts854451' },
];

async function fetchStableStats() {
  console.log(`[${new Date().toISOString()}] Fetching stable stats for owner ${OWNER_ID}...`);

  let fetch, cheerio, fs;
  try {
    fetch   = (await import('node-fetch')).default;
    cheerio = await import('cheerio');
    fs      = await import('fs/promises');
  } catch (e) {
    console.error('Missing dependencies. Run: npm install node-fetch cheerio');
    process.exit(1);
  }

  let yearly = [];
  let totals = { starts: 0, wins: 0, seconds: 0, thirds: 0, earnings: 0 };
  let horses = [];
  let upcoming = [];

  // ── 1. Fetch owner statistics page ──
  try {
    const resp = await fetch(STATS_URL, {
      headers: { 'User-Agent': 'BardunStallAB-StableSync/1.0' }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Parse yearly stats table
    $('table tbody tr, [class*="statistic"] tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;
      const year     = parseInt($(cells[0]).text().trim(), 10);
      const starts   = parseInt($(cells[1]).text().trim(), 10) || 0;
      const wins     = parseInt($(cells[2]).text().trim(), 10) || 0;
      const seconds  = parseInt($(cells[3]).text().trim(), 10) || 0;
      const thirds   = parseInt($(cells[4]).text().trim(), 10) || 0;
      const earnings = parseInt($(cells[cells.length - 1]).text().replace(/\s/g, ''), 10) || 0;
      const winPct   = starts > 0 ? Math.round(wins / starts * 100) : 0;

      if (year && starts > 0) {
        yearly.push({ year, starts, wins, seconds, thirds, winPct, earnings });
      }
    });

    yearly.sort((a, b) => b.year - a.year);

    // Compute totals from yearly data
    totals = yearly.reduce((acc, y) => {
      acc.starts   += y.starts;
      acc.wins     += y.wins;
      acc.seconds  += y.seconds;
      acc.thirds   += y.thirds;
      acc.earnings += y.earnings;
      return acc;
    }, { starts: 0, wins: 0, seconds: 0, thirds: 0, earnings: 0 });

    // Parse horse list (if visible on the page)
    $('[class*="horse"], [class*="animal"]').each((i, el) => {
      const name = $(el).find('[class*="name"]').text().trim();
      const prize = parseInt($(el).find('[class*="prize"], [class*="earnings"]').text().replace(/\s/g, ''), 10) || 0;
      if (name) {
        horses.push({ name, earnings: prize, starts: 0 });
      }
    });

    console.log(`[OK] Parsed ${yearly.length} year rows, totals: ${totals.starts} starts, ${totals.wins} wins, ${totals.earnings} kr`);
  } catch (err) {
    console.warn(`[WARN] Stats fetch failed: ${err.message}. Keeping existing data if available.`);
    // Try to load existing file to preserve data
    try {
      const existing = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'));
      yearly = existing.yearly || [];
      totals = existing.totals || totals;
      horses = existing.horses || [];
    } catch (_) {}
  }

  // ── 2. Fetch upcoming races ──
  // Travsport may list upcoming starts on the owner page or horse pages
  for (const horse of HORSES) {
    try {
      const url = `https://sportapp.travsport.se/sportinfo/horse/${horse.id}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'BardunStallAB-StableSync/1.0' }
      });
      const html = await resp.text();
      const $ = cheerio.load(html);

      // Look for upcoming starts section
      $('[class*="upcoming"], [class*="next"], [class*="anmal"]').each((i, el) => {
        const dateText = $(el).find('[class*="date"]').text().trim();
        const track    = $(el).find('[class*="track"], [class*="bana"]').text().trim();
        const race     = parseInt($(el).find('[class*="race"], [class*="lopp"]').text().trim(), 10) || 0;
        const driver   = $(el).find('[class*="driver"], [class*="kusk"]').text().trim();

        if (dateText) {
          upcoming.push({
            date: dateText,
            track: track || 'TBD',
            race: race || 0,
            horse: horse.name,
            driver: driver || 'Jonathan Bardun',
            horseUrl: '/' + horse.name.toLowerCase() + '/'
          });
        }
      });
    } catch (err) {
      console.warn(`[WARN] Could not check upcoming for ${horse.name}: ${err.message}`);
    }
  }

  // Sort upcoming by date
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  // ── 3. Fallback horse data if scraping didn't capture it ──
  if (horses.length === 0) {
    horses = HORSES.map(h => ({ name: h.name, points: 0, earnings: 0, starts: 0 }));
  }

  // ── 4. Write output ──
  const output = {
    lastSync: new Date().toISOString(),
    owner: 'Stall Bardun AB',
    ownerId: OWNER_ID,
    totals,
    yearly,
    horses,
    upcoming
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[DONE] Written to ${OUTPUT_PATH} — ${yearly.length} years, ${upcoming.length} upcoming races.`);
}

fetchStableStats().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

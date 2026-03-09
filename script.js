const API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'
};

// --- Rate-limited fetch helper ---

const fetchQueue = [];
let fetchInProgress = false;
const MIN_DELAY = 80; // ms between requests (~12 req/s, under the 20/s limit)

async function rateLimitedFetch(url, retries = 3) {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ url, retries, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (fetchInProgress || fetchQueue.length === 0) return;
  fetchInProgress = true;

  const { url, retries, resolve, reject } = fetchQueue.shift();

  try {
    const resp = await fetch(url);
    if (resp.status === 429 && retries > 0) {
      // Re-queue with backoff
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
      fetchQueue.unshift({ url, retries: retries - 1, resolve, reject });
    } else if (!resp.ok) {
      resolve(null); // Treat non-OK as empty rather than throwing
    } else {
      resolve(await resp.json());
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      fetchQueue.unshift({ url, retries: retries - 1, resolve, reject });
    } else {
      resolve(null);
    }
  }

  await new Promise(r => setTimeout(r, MIN_DELAY));
  fetchInProgress = false;
  processQueue();
}

// --- API fetching ---

async function fetchEventMarkets(eventTicker) {
  const data = await rateLimitedFetch(
    `${API_BASE}/events/${eventTicker}?with_nested_markets=true`
  );
  return data ? data.event : null;
}

async function fetchSeries() {
  // Fetch all politics series to discover House tickers
  const allSeries = [];
  let cursor = null;

  for (let page = 0; page < 5; page++) {
    let url = `${API_BASE}/series?limit=200`;
    if (cursor) url += `&cursor=${cursor}`;
    const data = await rateLimitedFetch(url);
    if (!data || !data.series || data.series.length === 0) break;
    allSeries.push(...data.series);
    cursor = data.cursor;
    if (!cursor) break;
  }

  return allSeries;
}

// Fetch senate races by trying known event tickers
async function fetchSenateRaces() {
  const states = Object.keys(STATE_NAMES);
  const races = [];

  // Build list of all event tickers to try
  const tickers = [];
  for (const st of states) {
    tickers.push(`SENATE${st}-26`);
  }
  // Special elections
  tickers.push('SENATEOHS-26', 'SENATENES-26');

  // Fetch all in parallel via the rate-limited queue
  const promises = tickers.map(async (ticker) => {
    const event = await fetchEventMarkets(ticker);
    if (event && event.markets && event.markets.length > 0) {
      const match = ticker.match(/^SENATE([A-Z]{2,3})-/);
      const stCode = match ? match[1].substring(0, 2) : '';
      const race = parseRace(event, 'Senate', stCode);
      if (race) races.push(race);
    }
  });

  await Promise.all(promises);
  return races.filter(Boolean);
}

// Fetch house races using series discovery
async function fetchHouseRaces() {
  const races = [];

  // Discover house series from the series endpoint
  const allSeries = await fetchSeries();
  const houseSeries = allSeries
    .filter(s => /^HOUSE[A-Z]{2}\d+$/.test(s.ticker))
    .map(s => s.ticker);

  if (houseSeries.length === 0) {
    // Fallback: try the events endpoint directly for known competitive districts
    return races;
  }

  // For each house series, try fetching the -26 event
  const promises = houseSeries.map(async (seriesTicker) => {
    const eventTicker = `${seriesTicker}-26`;
    const event = await fetchEventMarkets(eventTicker);
    if (event && event.markets && event.markets.length > 0) {
      const match = seriesTicker.match(/^HOUSE([A-Z]{2})(\d+)/);
      if (match) {
        const race = parseRace(event, 'House', match[1], match[2]);
        if (race) races.push(race);
      }
    }
  });

  await Promise.all(promises);
  return races;
}

function parseRace(event, chamber, stateCode, district = null) {
  const markets = event.markets;
  let demPrice = null;
  let repPrice = null;
  let volume = 0;

  for (const m of markets) {
    const party = (m.custom_strike && m.custom_strike.Party) ||
                  (m.yes_sub_title || '').toLowerCase();
    const price = parseFloat(m.last_price_dollars || m.yes_bid_dollars || '0');
    const vol = parseFloat(m.volume_fp || '0');
    volume += vol;

    if (/democrat/i.test(party) || /democrat/i.test(m.yes_sub_title || '') || m.ticker.endsWith('-D')) {
      demPrice = price;
    } else if (/republican/i.test(party) || /republican/i.test(m.yes_sub_title || '') || m.ticker.endsWith('-R')) {
      repPrice = price;
    }
  }

  // If we only have one side, infer the other
  if (demPrice !== null && repPrice === null) repPrice = 1 - demPrice;
  if (repPrice !== null && demPrice === null) demPrice = 1 - repPrice;
  if (demPrice === null && repPrice === null) return null;

  const stateName = STATE_NAMES[stateCode] || stateCode;
  const name = district
    ? `${stateName} District ${district}`
    : `${stateName}`;

  const spread = Math.abs(demPrice - repPrice);
  const isSpecial = event.event_ticker && /S-\d+$/.test(event.event_ticker);

  // Attach candidate names from lookup
  const ticker = event.event_ticker;
  const cand = (typeof CANDIDATES !== 'undefined') && CANDIDATES[ticker];
  let demName = cand && cand.dem ? cand.dem.name : '';
  let demUrl = cand && cand.dem ? cand.dem.url : '';
  let repName = cand && cand.rep ? cand.rep.name : '';

  // Fallback: try to extract incumbent from Kalshi subtitle field
  if (!demName || !repName) {
    for (const m of markets) {
      const incMatch = (m.subtitle || '').match(/Current incumbent:\s*(.+)/i);
      if (incMatch) {
        const incName = incMatch[1].trim();
        if (m.ticker.endsWith('-D') && !demName) demName = incName;
        else if (m.ticker.endsWith('-R') && !repName) repName = incName;
      }
    }
  }

  return {
    name,
    chamber,
    stateCode,
    district,
    isSpecial,
    demPrice,
    repPrice,
    spread,
    volume,
    eventTicker: ticker,
    title: event.title || name,
    demName: demName || 'Democrat',
    demUrl: demUrl || '',
    repName: repName || 'Republican',
  };
}

function getClosenessLabel(spread) {
  if (spread <= 0.10) return { label: 'Toss-Up', cls: 'tossup' };
  if (spread <= 0.25) return { label: 'Lean', cls: 'lean' };
  if (spread <= 0.50) return { label: 'Likely', cls: 'likely' };
  return { label: 'Safe', cls: 'safe' };
}

function formatPct(price) {
  return Math.round(price * 100) + '%';
}

function formatVolume(vol) {
  if (vol >= 1_000_000) return '$' + (vol / 1_000_000).toFixed(1) + 'M';
  if (vol >= 1_000) return '$' + (vol / 1_000).toFixed(0) + 'K';
  return '$' + vol.toFixed(0);
}

function renderRaceCard(race) {
  const { label, cls } = getClosenessLabel(race.spread);
  const demPct = Math.max(2, Math.round(race.demPrice * 100));
  const repPct = Math.max(2, Math.round(race.repPrice * 100));
  const isTossup = race.spread <= 0.10;
  const typeLabel = race.isSpecial ? `${race.chamber} \u00B7 Special` : race.chamber;

  const demLink = race.demUrl
    ? `<a href="${race.demUrl}" target="_blank" rel="noopener" class="dem-support-link">Support ${race.demName.split(' ').pop()} &rarr;</a>`
    : '';

  return `
    <div class="race-card ${isTossup ? 'tossup' : ''}">
      <span class="closeness-badge ${cls}">${label}</span>
      <div class="race-name">${race.name}</div>
      <div class="race-type">${typeLabel}</div>
      <div class="prob-bar-container">
        <div class="prob-bar">
          <div class="dem-fill" style="width:${demPct}%">
            <span>${demPct >= 15 ? formatPct(race.demPrice) : ''}</span>
          </div>
          <div class="rep-fill" style="width:${repPct}%">
            <span>${repPct >= 15 ? formatPct(race.repPrice) : ''}</span>
          </div>
        </div>
      </div>
      <div class="candidates">
        <span class="dem-label">${race.demName} (D) ${demPct < 15 ? formatPct(race.demPrice) : ''}</span>
        <span class="rep-label">${repPct < 15 ? formatPct(race.repPrice) : ''} ${race.repName} (R)</span>
      </div>
      <div class="card-footer">
        ${demLink}
        ${race.volume > 0 ? `<span class="volume">Vol: ${formatVolume(race.volume)}</span>` : ''}
      </div>
    </div>
  `;
}

function renderControlBar(controlRace, containerId) {
  const container = document.getElementById(containerId);
  if (!controlRace || !container) return;

  container.innerHTML = `
    <span class="party-odds dem">D: ${formatPct(controlRace.demPrice)}</span>
    <span class="party-odds rep">R: ${formatPct(controlRace.repPrice)}</span>
  `;
}

function renderRaces(races, gridId) {
  const grid = document.getElementById(gridId);
  if (races.length === 0) {
    grid.innerHTML = '<div class="error">No races found.</div>';
    return;
  }

  // Sort by spread (closest first)
  races.sort((a, b) => a.spread - b.spread);
  grid.innerHTML = races.map(renderRaceCard).join('');
}

// --- Chamber control markets ---
async function fetchChamberControl() {
  const results = { senate: null, house: null };

  const senateEvent = await fetchEventMarkets('CONTROLS-2026');
  const houseEvent = await fetchEventMarkets('CONTROLH-2026');

  if (senateEvent) {
    results.senate = parseRace(senateEvent, 'Senate Control', 'US');
  }
  if (houseEvent) {
    results.house = parseRace(houseEvent, 'House Control', 'US');
  }

  return results;
}

// --- Tabs ---
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.race-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });
}

// --- Init ---
async function init() {
  setupTabs();

  // Fetch sequentially: control first, then senate, then house
  // This avoids overwhelming the rate limiter

  let control = { senate: null, house: null };
  try {
    control = await fetchChamberControl();
  } catch (e) {
    console.error('Control fetch error:', e);
  }

  if (control.senate) renderControlBar(control.senate, 'senate-control');
  if (control.house) renderControlBar(control.house, 'house-control');

  try {
    const senateRaces = await fetchSenateRaces();
    renderRaces(senateRaces, 'senate-grid');
  } catch (e) {
    console.error('Senate fetch error:', e);
    document.getElementById('senate-grid').innerHTML =
      `<div class="error">Failed to load Senate races: ${e.message}</div>`;
  }

  try {
    const houseRaces = await fetchHouseRaces();
    renderRaces(houseRaces, 'house-grid');
  } catch (e) {
    console.error('House fetch error:', e);
    document.getElementById('house-grid').innerHTML =
      `<div class="error">Failed to load House races: ${e.message}</div>`;
  }
}

init();

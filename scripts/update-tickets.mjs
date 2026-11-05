#!/usr/bin/env node
// Rewrites tickets.json so the carols page can grey out a session that has reached capacity.
// Run by .github/workflows/update-tickets.yml, or by hand:
//
//   PCO_APP_ID=... PCO_SECRET=... HUMANITIX_API_KEY=... node scripts/update-tickets.mjs
//
// To see exactly what a provider returns (useful when a field mapping looks wrong):
//
//   HUMANITIX_API_KEY=... node scripts/update-tickets.mjs --dump
//
// Credentials:
//   PCO_APP_ID / PCO_SECRET  Planning Center Personal Access Token (Developer > Personal Access Tokens)
//   HUMANITIX_API_KEY        Humanitix API key (console.humanitix.com > Account > API keys)
//
// A source whose credentials are missing is skipped and its previous entry in tickets.json is
// kept, so one missing key never blanks out the other venue.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Which ticket source backs which panel.
//
// `kind: 'pco'`        one signup, one option per schedule row, joined on the row's `time:`.
// `kind: 'humanitix'`  one event, one option per night, joined on the date in `dates:` (YYYY-MM-DD).
//
// The `time` / `date` values must match index.html exactly — that is the join key.
const SOURCES = [
  {
    kind: 'pco',
    location: 'adelaide-city',
    signupId: '3996182',
    options: [
      { time: '4:00pm', match: 'FAMILY CAROLS' },
      { time: '6:00pm', match: 'CAROLS SPECTACULAR' }
    ]
  },
  {
    kind: 'humanitix',
    location: 'paradise',
    slug: 'futures-carols-at-paradise-2026',
    options: [{ date: '2026-12-12' }, { date: '2026-12-13' }]
  }
];

const OUT = new URL('../tickets.json', import.meta.url);
const DUMP = process.argv.includes('--dump');

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn('WARN: ' + msg);
}

/* ---------------------------------------------------------------- Planning Center */

async function readPco(source) {
  const appId = process.env.PCO_APP_ID;
  const secret = process.env.PCO_SECRET;
  if (!appId || !secret) {
    warn(`Skipping ${source.location}: PCO_APP_ID / PCO_SECRET not set.`);
    return null;
  }
  const auth = 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64');
  const url = `https://api.planningcenteronline.com/registrations/v2/signups/${source.signupId}?include=selection_types`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Planning Center returned ${res.status} for signup ${source.signupId}`);
  const body = await res.json();
  if (DUMP) console.log(`--- ${source.location} (planning center) ---\n` + JSON.stringify(body, null, 2));

  const signup = body.data?.attributes ?? {};
  const types = (body.included ?? []).filter((i) => i.type === 'SelectionType');

  const options = source.options.map((opt) => {
    const type = types.find((t) =>
      String(t.attributes?.name ?? '').toLowerCase().includes(opt.match.toLowerCase())
    );
    if (!type) {
      // A renamed or deleted ticket type must not silently read as "sold out".
      warn(`No ticket type matching "${opt.match}" on signup ${source.signupId}.`);
      return { time: opt.time, soldOut: false, remaining: null };
    }
    const a = type.attributes ?? {};
    const remaining = typeof a.available_capacity === 'number' ? a.available_capacity : null;
    return {
      time: opt.time,
      name: a.name ?? null,
      soldOut: a.at_maximum_capacity === true || remaining === 0,
      remaining
    };
  });

  const known = options.filter((o) => o.remaining !== null);
  return {
    soldOut:
      signup.at_maximum_capacity === true ||
      signup.closed === true ||
      (known.length === source.options.length && known.every((o) => o.soldOut)),
    options
  };
}

/* --------------------------------------------------------------------- Humanitix */

const HX = 'https://api.humanitix.com/v1';

async function hxGet(path, key) {
  const res = await fetch(HX + path, { headers: { 'x-api-key': key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Humanitix returned ${res.status} for ${path}`);
  return res.json();
}

// Humanitix spells sold-out differently in different places, so take the first explicit boolean
// we recognise. Anything unrecognised returns null, never false-as-if-known.
function explicitSoldOut(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['soldOut', 'isSoldOut', 'sold_out']) {
    if (typeof obj[key] === 'boolean') return obj[key];
  }
  const capacity = obj.quantity ?? obj.capacity ?? obj.totalCapacity;
  const sold = obj.quantitySold ?? obj.sold ?? obj.ticketsSold;
  if (typeof capacity === 'number' && typeof sold === 'number') return sold >= capacity;
  const remaining = obj.remaining ?? obj.quantityRemaining ?? obj.availableQuantity;
  if (typeof remaining === 'number') return remaining <= 0;
  return null;
}

async function readHumanitix(source) {
  const key = process.env.HUMANITIX_API_KEY;
  if (!key) {
    warn(`Skipping ${source.location}: HUMANITIX_API_KEY not set.`);
    return null;
  }

  // Resolve the slug from the event list, so nobody has to dig an internal id out of the console.
  const list = await hxGet('/events?page=1&pageSize=100', key);
  const events = list.events ?? list.data ?? [];
  const match =
    events.find((e) => e.slug === source.slug) ??
    events.find((e) => {
      const name = String(e.name ?? '').toLowerCase();
      return name.includes('carols') && name.includes('paradise');
    });
  if (!match) {
    warn(`No Humanitix event matching slug "${source.slug}".`);
    return null;
  }

  const event = (await hxGet(`/events/${match._id ?? match.id}`, key)) ?? {};
  const body = event.event ?? event;
  if (DUMP) console.log(`--- ${source.location} (humanitix) ---\n` + JSON.stringify(body, null, 2));

  const dates = body.dates ?? [];
  const options = source.options.map((opt) => {
    const night = dates.find((d) => String(d.startDate ?? d.start ?? '').slice(0, 10) === opt.date);
    if (!night) {
      warn(`No Humanitix date matching ${opt.date} on event ${source.slug}.`);
      return { date: opt.date, soldOut: false };
    }
    const sold = explicitSoldOut(night);
    if (sold === null) {
      // Better to show a night as available than to turn people away from one that is not full.
      warn(`Humanitix gave no capacity figures for ${opt.date}; leaving it on sale. Run with --dump to see the shape.`);
      return { date: opt.date, soldOut: false };
    }
    return { date: opt.date, soldOut: sold };
  });

  const eventSoldOut = explicitSoldOut(body);
  return {
    soldOut: eventSoldOut === true || options.every((o) => o.soldOut),
    options
  };
}

/* -------------------------------------------------------------------------- main */

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const sessions = { ...(previous?.sessions ?? {}) };

for (const source of SOURCES) {
  try {
    const status = source.kind === 'pco' ? await readPco(source) : await readHumanitix(source);
    // null means "could not read" — keep whatever the last good run wrote.
    if (status) sessions[source.location] = status;
  } catch (err) {
    warn(`${source.location}: ${err.message}`);
  }
}

if (DUMP) process.exit(0);

const next = { updated: new Date().toISOString(), sessions };

// Only the timestamp moves on a quiet run; rewriting it anyway would deploy the site for nothing.
if (previous && JSON.stringify(previous.sessions) === JSON.stringify(next.sessions)) {
  console.log('No change in ticket availability.');
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
console.log('Wrote tickets.json:', JSON.stringify(sessions));

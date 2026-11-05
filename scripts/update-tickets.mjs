#!/usr/bin/env node
// Rewrites tickets.json from Planning Center Registrations, so the carols page can grey out a
// session that has reached capacity. Run by .github/workflows/update-tickets.yml, or by hand:
//
//   PCO_APP_ID=... PCO_SECRET=... node scripts/update-tickets.mjs
//
// Credentials: a Planning Center Personal Access Token (Developer > Personal Access Tokens).
// Only Planning Center signups can be read this way. Paradise sells through Humanitix, so its
// panel is not covered here and stays whatever LOCATIONS in index.html says.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Which signup backs which panel, and which ticket type lines up with which schedule row.
// `time` must match the `time:` of that row in LOCATIONS exactly — that is the join key.
// `match` is matched case-insensitively against the Planning Center ticket type name.
const SIGNUPS = [
  {
    location: 'adelaide-city',
    signupId: '3996182',
    options: [
      { time: '4:00pm', match: 'FAMILY CAROLS' },
      { time: '6:00pm', match: 'CAROLS SPECTACULAR' }
    ]
  }
];

const OUT = new URL('../tickets.json', import.meta.url);

const appId = process.env.PCO_APP_ID;
const secret = process.env.PCO_SECRET;
if (!appId || !secret) {
  console.error('PCO_APP_ID and PCO_SECRET must be set.');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64');

async function getSignup(id) {
  const url = `https://api.planningcenteronline.com/registrations/v2/signups/${id}?include=selection_types`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Planning Center returned ${res.status} for signup ${id}`);
  return res.json();
}

const sessions = {};

for (const entry of SIGNUPS) {
  const body = await getSignup(entry.signupId);
  const signup = body.data?.attributes ?? {};
  const types = (body.included ?? []).filter((i) => i.type === 'SelectionType');

  const options = entry.options.map((opt) => {
    const type = types.find((t) =>
      String(t.attributes?.name ?? '').toLowerCase().includes(opt.match.toLowerCase())
    );
    if (!type) {
      // A renamed or deleted ticket type must not silently read as "sold out".
      console.warn(`No ticket type matching "${opt.match}" on signup ${entry.signupId}`);
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
  sessions[entry.location] = {
    // The whole panel only reads as sold out once every session we can actually see is full,
    // or Planning Center says the signup itself is closed or full.
    soldOut:
      signup.at_maximum_capacity === true ||
      signup.closed === true ||
      (known.length === entry.options.length && known.every((o) => o.soldOut)),
    options
  };
}

const next = { updated: new Date().toISOString(), sessions };

// Only the timestamp moves on a quiet run; rewriting it anyway would deploy the site for nothing.
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (previous && JSON.stringify(previous.sessions) === JSON.stringify(next.sessions)) {
  console.log('No change in ticket availability.');
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
console.log('Wrote tickets.json:', JSON.stringify(sessions));

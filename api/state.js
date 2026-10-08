// Single serverless endpoint: GET = read state, POST = perform an action.
// All money/odds/settlement logic lives here so browsers can't cheat.  
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const KEY = 'akward:db';

class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };
const clean = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const r2 = (n) => Math.round(n * 100) / 100;
const dec = (o) => (o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1);
const hash = (id, pin) =>
  crypto.createHash('sha256').update(`${id}:${pin}:${process.env.PIN_SALT || 'akward'}`).digest('hex');
const validOdds = (o) => Number.isInteger(o) && Math.abs(o) >= 100;

const publicState = (db) => ({
  markets: db.markets,
  users: Object.fromEntries(
    Object.entries(db.users).map(([k, u]) => [k, { id: u.id, name: u.name, balance: u.balance, wagers: u.wagers }])
  ),
});

function authUser(db, a) {
  const u = a && db.users[a.userId];
  if (!u || u.pin !== hash(u.id, clean(a.pin, 32))) fail('Please sign in again (wrong name or PIN).');
  return u;
}
function needAdmin(b) {
  if (!process.env.ADMIN_PASSWORD) fail('ADMIN_PASSWORD is not set on the server.');
  if (b.adminPassword !== process.env.ADMIN_PASSWORD) fail('Wrong admin password.');
}
const legsFor = (m) =>
  m.type === 'SPEAKER'
    ? m.options.map((o) => ({ name: o.name, odds: o.odds }))
    : [
        { name: `Over ${m.targetMins} mins`, odds: m.overOdds },
        { name: `Under ${m.targetMins} mins`, odds: m.underOdds },
      ];

const actions = {
  login(db, b) {
    const name = clean(b.name, 24);
    const pin = clean(b.pin, 32);
    const id = 'usr_' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (id === 'usr_') fail('Enter a name (letters or numbers).');
    if (pin.length < 4) fail('PIN must be at least 4 characters.');
    const u = db.users[id];
    if (!u) db.users[id] = { id, name, balance: 1000, wagers: [], pin: hash(id, pin) };
    else if (u.pin !== hash(id, pin)) fail('Wrong PIN for that name.');
    return { userId: id };
  },

  createMarket(db, b) {
    needAdmin(b);
    const m = b.market || {};
    const title = clean(m.title, 140);
    const time = clean(m.time, 60);
    if (!title || !time) fail('Title and timeframe are required.');
    const base = { id: 'mkt-' + Date.now(), title, time, creator: clean(b.creator, 24) || 'Admin', status: 'OPEN' };
    if (m.type === 'SPEAKER') {
      const options = (m.options || [])
        .map((o) => ({ name: clean(o.name, 40), odds: parseInt(o.odds, 10) }))
        .filter((o) => o.name && validOdds(o.odds));
      if (options.length < 2) fail('Need at least 2 candidates with valid odds (like -200 or +150).');
      if (new Set(options.map((o) => o.name)).size !== options.length) fail('Duplicate candidate names.');
      db.markets.unshift({ ...base, type: 'SPEAKER', category: 'Speaker Probability', options });
    } else if (m.type === 'DURATION') {
      const t = parseFloat(m.targetMins), over = parseInt(m.overOdds, 10), under = parseInt(m.underOdds, 10);
      if (!(t > 0)) fail('Enter a valid target duration.');
      if (!validOdds(over) || !validOdds(under)) fail('Odds must be like -110 or +120.');
      db.markets.unshift({ ...base, type: 'DURATION', category: 'Timeline Duration', targetMins: t, overOdds: over, underOdds: under });
    } else fail('Bad market type.');
  },

  placeBet(db, b) {
    const u = authUser(db, b.auth);
    const stake = r2(Number(b.stake));
    if (!(stake > 0)) fail('Enter a valid stake.');
    if (stake > u.balance) fail('Insufficient bankroll!');
    const sels = b.selections;
    if (!Array.isArray(sels) || !sels.length || sels.length > 10) fail('Your bet slip is invalid.');
    const seen = new Set();
    const out = [];
    let mult = 1;
    for (const s of sels) {
      const m = db.markets.find((x) => x.id === s.marketId);
      if (!m || m.status !== 'OPEN') fail('A market on your slip is no longer open.');
      if (seen.has(m.id)) fail('Only one pick per market.');
      seen.add(m.id);
      const leg = legsFor(m).find((l) => l.name === s.selection);
      if (!leg) fail('Invalid selection.');
      mult *= dec(leg.odds);
      out.push({ marketId: m.id, type: m.type, selection: leg.name, odds: leg.odds, marketTitle: m.title });
    }
    u.balance = r2(u.balance - stake);
    u.wagers.unshift({
      id: 'TKT-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      date: new Date().toISOString(),
      stake,
      potentialPayout: r2(stake * mult),
      type: out.length > 1 ? 'PARLAY' : 'SINGLE',
      selections: out,
      status: 'PENDING',
    });
  },

  settle(db, b) {
    needAdmin(b);
    const m = db.markets.find((x) => x.id === b.marketId);
    if (!m || m.status !== 'OPEN') fail('That market is not open.');
    let win;
    if (m.type === 'SPEAKER') {
      if (!m.options.some((o) => o.name === b.winner)) fail('Invalid winner.');
      win = b.winner;
    } else {
      const a = parseFloat(b.actual);
      if (!Number.isFinite(a) || a < 0) fail('Enter a valid duration.');
      m.actualResult = a;
      win = a > m.targetMins ? `Over ${m.targetMins} mins` : a < m.targetMins ? `Under ${m.targetMins} mins` : 'PUSH';
    }
    m.status = 'SETTLED';
    m.winningText = win;

    for (const u of Object.values(db.users)) {
      for (const t of u.wagers) {
        if (t.status !== 'PENDING' || !t.selections.some((s) => s.marketId === m.id)) continue;
        const res = t.selections.map((s) => {
          const mk = db.markets.find((x) => x.id === s.marketId);
          if (!mk || mk.status !== 'SETTLED') return null;
          return mk.winningText === 'PUSH' ? 'PUSH' : mk.winningText === s.selection ? 'WON' : 'LOST';
        });
        if (res.includes('LOST')) {
          t.status = 'LOST';
        } else if (!res.includes(null)) {
          if (res.every((r) => r === 'PUSH')) {
            t.status = 'PUSH';
            u.balance = r2(u.balance + t.stake);
          } else {
            const mult = t.selections.reduce((acc, s, i) => acc * (res[i] === 'PUSH' ? 1 : dec(s.odds)), 1);
            t.status = 'WON';
            t.potentialPayout = r2(t.stake * mult);
            u.balance = r2(u.balance + t.potentialPayout);
          }
        }
      }
    }
    return { winner: win };
  },

  reset(db, b) {
    needAdmin(b);
    db.markets = [];
    db.users = {};
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = (await redis.get(KEY)) || { markets: [], users: {} };
    if (req.method === 'GET') return res.status(200).json(publicState(db));
    if (req.method !== 'POST') return res.status(405).end();

    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const fn = actions[b.action];
    if (!fn) fail('Unknown action.');
    const result = fn(db, b) || {};
    await redis.set(KEY, db);
    return res.status(200).json({ ok: true, ...result, ...publicState(db) });
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ ok: false, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error. Check your Redis connection.' });
  }
};

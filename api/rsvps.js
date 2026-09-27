/**
 * /api/rsvps  —  the guest registration backend.
 *
 * Storage: Upstash Redis (the "Upstash for Redis" marketplace integration
 * in Vercel). It sets KV_REST_API_URL and KV_REST_API_TOKEN for you.
 *
 * GET    /api/rsvps                    -> public guest list (names, seats, notes only)
 * GET    /api/rsvps?key=XXXX           -> full list incl. contacts, if key === HOST_KEY
 * POST   /api/rsvps                    -> save one RSVP  { name, contact, guests, attending, note }
 * DELETE /api/rsvps?key=XXXX&id=YYYY   -> remove one RSVP, host key required
 */

const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LIST_KEY = 'rsvps';
const MAX_STORED = 1000;

async function redis(command) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel.');
  }
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('Storage request failed (' + res.status + ').');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

async function readAll() {
  const raw = (await redis(['LRANGE', LIST_KEY, 0, MAX_STORED - 1])) || [];
  return raw
    .map(item => { try { return JSON.parse(item); } catch (e) { return null; } })
    .filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    /* ------------------------------ READ ------------------------------ */
    if (req.method === 'GET') {
      const hostKey = process.env.HOST_KEY || '';
      const given = (req.query && req.query.key) || '';
      const rows = await readAll();

      if (given) {
        if (!hostKey || given !== hostKey) {
          return res.status(401).json({ error: 'Wrong host key.' });
        }
        return res.status(200).json({ rsvps: rows });
      }

      const attending = rows.filter(r => r.attending === 'yes');
      return res.status(200).json({
        guests: attending.map(r => ({ name: r.name, guests: r.guests, note: r.note })),
        seats: attending.reduce((sum, r) => sum + (r.guests || 0), 0),
        responses: rows.length
      });
    }

    /* ------------------------------ WRITE ----------------------------- */
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

      const name = clean(body.name, 60);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const guests = Math.min(Math.max(parseInt(body.guests, 10) || 1, 1), 20);

      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name: name,
        contact: clean(body.contact, 80),
        guests: guests,
        attending: body.attending === 'no' ? 'no' : 'yes',
        note: clean(body.note, 200),
        at: new Date().toISOString()
      };

      await redis(['LPUSH', LIST_KEY, JSON.stringify(entry)]);
      await redis(['LTRIM', LIST_KEY, 0, MAX_STORED - 1]);

      return res.status(201).json({ ok: true, id: entry.id });
    }

    /* ----------------------------- DELETE ------------------------------ */
    if (req.method === 'DELETE') {
      const hostKey = process.env.HOST_KEY || '';
      const given = (req.query && req.query.key) || '';
      const targetId = (req.query && req.query.id) || '';

      if (!hostKey || !given || given !== hostKey) {
        return res.status(401).json({ error: 'Wrong host key.' });
      }
      if (!targetId) return res.status(400).json({ error: 'No entry specified.' });

      const rows = await readAll();
      const remaining = rows.filter(r => r.id !== targetId);

      if (remaining.length === rows.length) {
        return res.status(404).json({ error: 'That entry is already gone.' });
      }

      await redis(['DEL', LIST_KEY]);
      if (remaining.length) {
        await redis(['RPUSH', LIST_KEY, ...remaining.map(r => JSON.stringify(r))]);
      }

      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
};

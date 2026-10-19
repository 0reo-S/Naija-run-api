const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

// On Render, set DB_PATH=/data/naijarun.db and attach a persistent disk
// at /data, or your scores vanish on every restart.
const db = new Database(process.env.DB_PATH || 'naijarun.db');
db.exec(`
CREATE TABLE IF NOT EXISTS scores(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  states INTEGER DEFAULT 0,
  mode INTEGER DEFAULT 0,
  secs INTEGER DEFAULT 0,
  ip TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_week_score ON scores(week, score DESC);
`);

// Week resets every Monday (UTC)
const wk = () => 'w' + Math.floor((Date.now() / 864e5 + 3) / 7);

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2kb' }));

app.get('/', (q, r) => r.send('Naija Run API is running'));
app.get('/api/health', (q, r) => r.json({ ok: 1 }));

// ---------- PUBLIC ----------
app.get('/api/top', (q, r) => {
  const rows = db.prepare(
    `SELECT name, MAX(score) AS score, states
     FROM scores WHERE week = ?
     GROUP BY name ORDER BY score DESC LIMIT 10`
  ).all(wk());
  r.json(rows);
});

// 40/min per IP so a whole campus on one WiFi can still play
const limiter = rateLimit({ windowMs: 60000, max: 40 });

app.post('/api/score', limiter, (q, r) => {
  let { name, score, secs, mode, state } = q.body || {};
  name = String(name || '').replace(/[^\w \-.]/g, '').trim().slice(0, 14);
  score = Math.floor(+score);
  secs = Math.floor(+secs);
  mode = Math.floor(+mode) || 0;
  state = Math.floor(+state) || 0;

  if (!name || !Number.isFinite(score) || !Number.isFinite(secs))
    return r.status(400).json({ error: 'bad data' });

  // A state gate comes every ~15-30s, and real scores stay under ~150 per second
  if (
    score < 50 ||
    secs < 5 ||
    score > secs * 150 + 500 ||
    mode < 0 || mode > 3 ||
    state < 0 || state > secs / 10
  ) return r.status(422).json({ error: 'rejected' });

  db.prepare(
    'INSERT INTO scores(week,name,score,states,mode,secs,ip,created) VALUES(?,?,?,?,?,?,?,?)'
  ).run(wk(), name, score, state, mode, secs, q.ip, Date.now());
  r.json({ ok: 1 });
});

// ---------- ADMIN (needs ADMIN_KEY) ----------
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Read routes: key in the link (?key=...) so you can open them on your phone
function admin(q, r, next) {
  if (!ADMIN_KEY || !same(q.query.key || '', ADMIN_KEY)) return r.status(401).send('no');
  next();
}

app.get('/api/admin/scores', admin, (q, r) => {
  r.json(db.prepare('SELECT * FROM scores ORDER BY created DESC LIMIT 500').all());
});

app.get('/api/admin/csv', admin, (q, r) => {
  const rows = db.prepare('SELECT * FROM scores ORDER BY created DESC').all();
  const head = 'id,week,name,score,states,mode,secs,ip,created\n';
  const body = rows.map(x => [
    x.id, x.week, '"' + x.name + '"', x.score, x.states, x.mode, x.secs, x.ip,
    new Date(x.created).toISOString()
  ].join(',')).join('\n');
  r.set('Content-Type', 'text/csv').send(head + body);
});

app.get('/api/admin/stats', admin, (q, r) => {
  r.json(db.prepare(
    'SELECT COUNT(*) AS plays, COUNT(DISTINCT name) AS players, MAX(score) AS best FROM scores'
  ).get());
});

// Delete: DELETE request with the key in a header, never in a link
app.delete('/api/admin/delete', (q, r) => {
  if (!ADMIN_KEY || !same(q.get('x-admin-key') || '', ADMIN_KEY)) return r.status(401).send('no');
  const id = +q.query.id;
  if (!Number.isInteger(id)) return r.status(400).json({ error: 'bad id' });
  db.prepare('DELETE FROM scores WHERE id = ?').run(id);
  r.json({ ok: 1 });
});

// Bad JSON etc. gets a clean reply instead of an HTML error page
app.use((err, q, r, next) => r.status(400).json({ error: 'bad request' }));

app.listen(process.env.PORT || 3000, () => console.log('Naija Run API up'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const SEED_PATH = path.join(__dirname, 'db.json');

// Vercel's filesystem is read-only except for /tmp, which is temporary and per-instance.
const DB_PATH = process.env.VERCEL ? path.join(os.tmpdir(), 'db.json') : SEED_PATH;
if (!fs.existsSync(DB_PATH)) fs.copyFileSync(SEED_PATH, DB_PATH);

// The file is the only store, so hand edits and API writes never overwrite each other.
const readDb = () => JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const writeDb = (db) => fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`);

const resourceNames = (db) => Object.keys(db).filter((name) => Array.isArray(db[name]));

const originOf = (req) => `${req.protocol}://${req.get('host')}`;

const mapStrings = (data, transform) =>
  JSON.parse(JSON.stringify(data), (key, value) =>
    typeof value === 'string' ? transform(value) : value
  );

// db.json stores "/images/..." paths; clients get full URLs for whichever host they called.
const withImageUrls = (data, req) =>
  mapStrings(data, (value) => (value.startsWith('/images/') ? originOf(req) + value : value));

// Undoes withImageUrls when a client sends back an object it fetched earlier.
const withImagePaths = (data, req) => {
  const origin = originOf(req);
  return mapStrings(data, (value) =>
    value.startsWith(`${origin}/images/`) ? value.slice(origin.length) : value
  );
};

const sendData = (res, data, status = 200) =>
  res.status(status).json({ status: 'success', data: withImageUrls(data, res.req) });

const sendError = (res, status, message) =>
  res.status(status).json({ status: 'error', message });

const toPositiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : fallback;
};

const nextId = (items) =>
  items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;

const requireObjectBody = (req, res, next) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Request body must be a JSON object');
  }
  req.body = withImagePaths(body, req);
  next();
};

// Every query param not starting with "_" is a field filter; repeat a param to match any value.
function queryItems(items, query) {
  const { _sort, _order, _page, _limit } = query;
  const filters = Object.entries(query).filter(([key]) => !key.startsWith('_'));

  const result = items.filter((item) =>
    filters.every(([key, value]) => [].concat(value).includes(String(item[key])))
  );

  if (_sort) {
    const direction = _order === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      if (a[_sort] === b[_sort]) return 0;
      return (a[_sort] > b[_sort] ? 1 : -1) * direction;
    });
  }

  if (_page === undefined && _limit === undefined) {
    return { total: result.length, data: result };
  }

  const limit = toPositiveInt(_limit, 10);
  const start = (toPositiveInt(_page, 1) - 1) * limit;
  return { total: result.length, data: result.slice(start, start + limit) };
}

const resourceRouter = express.Router({ mergeParams: true });

resourceRouter.use((req, res, next) => {
  req.db = readDb();
  if (!resourceNames(req.db).includes(req.params.resource)) {
    return sendError(res, 404, 'Not found');
  }
  req.items = req.db[req.params.resource];
  next();
});

resourceRouter.param('id', (req, res, next, id) => {
  req.index = req.items.findIndex((item) => String(item.id) === id);
  if (req.index === -1) return sendError(res, 404, 'Not found');
  next();
});

resourceRouter.get('/', (req, res) => {
  const { total, data } = queryItems(req.items, req.query);
  res.set('X-Total-Count', String(total));
  sendData(res, data);
});

resourceRouter.get('/:id', (req, res) => sendData(res, req.items[req.index]));

resourceRouter.post('/', requireObjectBody, (req, res) => {
  const created = { ...req.body, id: nextId(req.items) };
  req.items.push(created);
  writeDb(req.db);
  sendData(res, created, 201);
});

resourceRouter.put('/:id', requireObjectBody, (req, res) => {
  req.items[req.index] = { ...req.body, id: req.items[req.index].id };
  writeDb(req.db);
  sendData(res, req.items[req.index]);
});

resourceRouter.patch('/:id', requireObjectBody, (req, res) => {
  req.items[req.index] = { ...req.items[req.index], ...req.body, id: req.items[req.index].id };
  writeDb(req.db);
  sendData(res, req.items[req.index]);
});

resourceRouter.delete('/:id', (req, res) => {
  req.items.splice(req.index, 1);
  writeDb(req.db);
  res.status(204).end();
});

const app = express();
app.set('trust proxy', true); // Vercel terminates HTTPS, so req.protocol must come from its proxy.
app.use(cors({ exposedHeaders: ['X-Total-Count'] }));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public', 'images'))); // Vercel serves public/ itself.

app.get('/', (req, res) => {
  sendData(res, { resources: resourceNames(readDb()).map((name) => `/${name}`) });
});

app.use('/:resource', resourceRouter);

app.use((req, res) => sendError(res, 404, 'Not found'));

app.use((err, req, res, next) => {
  sendError(res, err.status || 500, err.message);
});

app.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
  resourceNames(readDb()).forEach((name) => console.log(`  /${name}`));
});

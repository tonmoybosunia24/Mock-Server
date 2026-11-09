const path = require('path');
const express = require('express');
const cors = require('cors');
const { db } = require('./db');

const PORT = process.env.PORT || 3000;
const WITHOUT_MONGO_ID = { projection: { _id: 0 } };
const MAX_CREATE_ATTEMPTS = 25;

const resourceNames = async () => {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return collections.map(({ name }) => name).filter((name) => !name.startsWith('system.'));
};

const originOf = (req) => `${req.protocol}://${req.get('host')}`;

const mapStrings = (data, transform) =>
  JSON.parse(JSON.stringify(data), (key, value) =>
    typeof value === 'string' ? transform(value) : value
  );

// MongoDB stores "/images/..." paths; clients get full URLs for whichever host they called.
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

const parseId = (id) => (/^\d+$/.test(id) ? Number(id) : id);

// Query strings are text, so "?likes=5" and "?active=false" must also match numbers and booleans.
const possibleValues = (text) => {
  const values = [text];
  if (text !== '' && !Number.isNaN(Number(text))) values.push(Number(text));
  if (text === 'true') values.push(true);
  if (text === 'false') values.push(false);
  return values;
};

// A "$" in a field name would be read by MongoDB as a query operator.
const isPlainField = (field) => typeof field === 'string' && !field.includes('$');

// Every query param not starting with "_" is a field filter; repeat a param to match any value.
function buildFilter(query) {
  const filter = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('_') || !isPlainField(key)) continue;
    filter[key] = { $in: [].concat(value).flatMap(possibleValues) };
  }
  return filter;
}

function buildSort({ _sort, _order }) {
  const direction = _order === 'desc' ? -1 : 1;
  if (!isPlainField(_sort)) return { id: 1 };
  return _sort === 'id' ? { id: direction } : { [_sort]: direction, id: 1 };
}

async function queryItems(collection, query) {
  const filter = buildFilter(query);
  let cursor = collection.find(filter, WITHOUT_MONGO_ID).sort(buildSort(query));

  if (query._page !== undefined || query._limit !== undefined) {
    const limit = toPositiveInt(query._limit, 10);
    cursor = cursor.skip((toPositiveInt(query._page, 1) - 1) * limit).limit(limit);
  }

  const [total, data] = await Promise.all([collection.countDocuments(filter), cursor.toArray()]);
  return { total, data };
}

async function nextId(collection) {
  const [last] = await collection.find({}, { projection: { id: 1 } }).sort({ id: -1 }).limit(1).toArray();
  return (Number(last?.id) || 0) + 1;
}

// Simultaneous creates can pick the same id; the unique index rejects all but one, so the rest retry.
async function insertWithNextId(collection, fields) {
  for (let attempt = 1; ; attempt++) {
    const id = await nextId(collection);
    try {
      await collection.insertOne({ ...fields, id });
      return { ...fields, id };
    } catch (err) {
      if (err.code !== 11000 || attempt === MAX_CREATE_ATTEMPTS) throw err;
    }
  }
}

const requireObjectBody = (req, res, next) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Request body must be a JSON object');
  }
  if (Object.keys(body).some((key) => key.startsWith('$'))) {
    return sendError(res, 400, 'Field names must not start with $');
  }
  const { _id, id, ...fields } = withImagePaths(body, req);
  req.fields = fields;
  next();
};

const resourceRouter = express.Router({ mergeParams: true });

resourceRouter.use(async (req, res, next) => {
  if (!(await resourceNames()).includes(req.params.resource)) {
    return sendError(res, 404, 'Not found');
  }
  req.collection = db.collection(req.params.resource);
  next();
});

resourceRouter.get('/', async (req, res) => {
  const { total, data } = await queryItems(req.collection, req.query);
  res.set('X-Total-Count', String(total));
  sendData(res, data);
});

resourceRouter.get('/:id', async (req, res) => {
  const item = await req.collection.findOne({ id: parseId(req.params.id) }, WITHOUT_MONGO_ID);
  return item ? sendData(res, item) : sendError(res, 404, 'Not found');
});

resourceRouter.post('/', requireObjectBody, async (req, res) => {
  sendData(res, await insertWithNextId(req.collection, req.fields), 201);
});

resourceRouter.put('/:id', requireObjectBody, async (req, res) => {
  const id = parseId(req.params.id);
  const item = await req.collection.findOneAndReplace(
    { id },
    { ...req.fields, id },
    { ...WITHOUT_MONGO_ID, returnDocument: 'after' }
  );
  return item ? sendData(res, item) : sendError(res, 404, 'Not found');
});

resourceRouter.patch('/:id', requireObjectBody, async (req, res) => {
  const item = await req.collection.findOneAndUpdate(
    { id: parseId(req.params.id) },
    { $set: req.fields },
    { ...WITHOUT_MONGO_ID, returnDocument: 'after' }
  );
  return item ? sendData(res, item) : sendError(res, 404, 'Not found');
});

resourceRouter.delete('/:id', async (req, res) => {
  const { deletedCount } = await req.collection.deleteOne({ id: parseId(req.params.id) });
  return deletedCount ? res.status(204).end() : sendError(res, 404, 'Not found');
});

const app = express();
app.set('trust proxy', true); // Vercel terminates HTTPS, so req.protocol must come from its proxy.
app.use(cors({ exposedHeaders: ['X-Total-Count'] }));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public', 'images'))); // Vercel serves public/ itself.

app.get('/', async (req, res) => {
  sendData(res, { resources: (await resourceNames()).map((name) => `/${name}`) });
});

app.use('/:resource', resourceRouter);

app.use((req, res) => sendError(res, 404, 'Not found'));

// Unexpected errors are logged only, since driver messages can reveal database details.
app.use((err, req, res, next) => {
  if (err.status) return sendError(res, err.status, err.message);
  console.error(err);
  sendError(res, 500, 'Internal server error');
});

app.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
  db.command({ ping: 1 }).then(
    () => console.log('MongoDB connected'),
    (err) => console.error(`MongoDB connection failed: ${err.message}`)
  );
});

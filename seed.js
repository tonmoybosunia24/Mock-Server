// Imports db.json into MongoDB. Non-empty collections are kept unless --reset is passed.
const data = require('./db.json');
const { client, db } = require('./db');

const reset = process.argv.includes('--reset');

async function seed() {
  for (const [name, docs] of Object.entries(data)) {
    if (!Array.isArray(docs)) continue;

    const collection = db.collection(name);
    const existing = await collection.countDocuments();
    if (existing > 0 && !reset) {
      console.log(`${name}: skipped, already has ${existing} documents (use --reset to replace)`);
      continue;
    }

    await collection.deleteMany({});
    await collection.insertMany(docs);
    await collection.createIndex({ id: 1 }, { unique: true });
    console.log(`${name}: imported ${docs.length} documents`);
  }
}

seed()
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());

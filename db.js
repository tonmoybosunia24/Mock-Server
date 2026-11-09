const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is not set. Add it to .env or the hosting environment.');
}

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db(process.env.MONGODB_DB || 'mock_server');

module.exports = { client, db };

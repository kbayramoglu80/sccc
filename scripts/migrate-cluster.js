/**
 * Eski MongoDB cluster'dan yeni cluster'a tüm koleksiyonları kopyalar
 * (haberler, ayarlar, reklamlar, GridFS: media.files + media.chunks / görseller).
 *
 * Kullanım:
 *   .env içinde MONGODB_URI = yeni cluster (hedef)
 *   Geçici olarak ilk satırda veya ortamda OLD_MONGODB_URI = eski cluster (kaynak)
 *
 *   node scripts/migrate-cluster.js
 *   node scripts/migrate-cluster.js --force   (hedef koleksiyonları silip baştan yazar)
 *
 * Eski cluster kapalıysa bu script çalışmaz; erişim sağlandığında veya yedekten restore sonrası çalıştırın.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const SOURCE_URI = process.env.OLD_MONGODB_URI || process.env.SOURCE_MONGODB_URI;
const TARGET_URI = process.env.MONGODB_URI;

const BATCH = 150;
const FORCE = process.argv.includes('--force');

async function copyIndexes(sourceCol, targetCol) {
  const indexes = await sourceCol.indexes();
  for (const idx of indexes) {
    if (idx.name === '_id_') continue;
    const key = idx.key;
    const opts = { name: idx.name };
    if (idx.unique) opts.unique = idx.unique;
    if (idx.sparse) opts.sparse = idx.sparse;
    if (idx.expireAfterSeconds != null) opts.expireAfterSeconds = idx.expireAfterSeconds;
    if (idx.partialFilterExpression) opts.partialFilterExpression = idx.partialFilterExpression;
    try {
      await targetCol.createIndex(key, opts);
    } catch (e) {
      if (!String(e.message || '').includes('already exists')) throw e;
    }
  }
}

async function copyCollection(sourceDb, targetDb, name) {
  const srcCol = sourceDb.collection(name);
  const count = await srcCol.countDocuments();
  if (count === 0) {
    console.log(`  ${name}: 0 belge (atlandı)`);
    return;
  }

  const tgtCol = targetDb.collection(name);
  if (FORCE) {
    await tgtCol.drop().catch(() => {});
  } else {
    const existing = await tgtCol.countDocuments();
    if (existing > 0) {
      console.log(`  ${name}: hedefte ${existing} belge var, atlanıyor (yeniden kopyalamak için --force)`);
      return;
    }
  }

  let inserted = 0;
  let batch = [];
  const cursor = srcCol.find({});

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH) {
      await tgtCol.insertMany(batch, { ordered: false });
      inserted += batch.length;
      batch = [];
      process.stdout.write(`\r  ${name}: ${inserted} / ${count}`);
    }
  }
  if (batch.length) {
    await tgtCol.insertMany(batch, { ordered: false });
    inserted += batch.length;
  }

  await copyIndexes(srcCol, tgtCol);
  console.log(`\r  ${name}: ${inserted} belge kopyalandı`);
}

function sortCollectionNames(names) {
  return names.sort((a, b) => {
    if (a === 'media.chunks') return -1;
    if (b === 'media.chunks') return 1;
    if (a === 'media.files') return -1;
    if (b === 'media.files') return 1;
    return a.localeCompare(b);
  });
}

async function main() {
  if (!SOURCE_URI || !TARGET_URI) {
    console.error('Eksik ortam değişkeni: OLD_MONGODB_URI (kaynak) ve MONGODB_URI (hedef) .env içinde olmalı.');
    process.exit(1);
  }
  if (SOURCE_URI === TARGET_URI) {
    console.error('Kaynak ve hedef URI aynı olamaz.');
    process.exit(1);
  }

  const sourceClient = new MongoClient(SOURCE_URI, { serverSelectionTimeoutMS: 30000 });
  const targetClient = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 30000 });

  await sourceClient.connect();
  await targetClient.connect();

  const sourceDb = sourceClient.db();
  const targetDb = targetClient.db();

  console.log('Kaynak veritabanı:', sourceDb.databaseName);
  console.log('Hedef veritabanı:', targetDb.databaseName);
  if (FORCE) console.log('Mod: --force (hedef koleksiyonlar silinip yeniden yazılır)\n');
  else console.log('Mod: hedef boş koleksiyonlar doldurulur\n');

  const cols = await sourceDb.listCollections().toArray();
  const names = sortCollectionNames(cols.map((c) => c.name).filter((n) => !n.startsWith('system.')));

  for (const name of names) {
    try {
      await copyCollection(sourceDb, targetDb, name);
    } catch (err) {
      console.error(`  ${name} HATA:`, err.message);
    }
  }

  await sourceClient.close();
  await targetClient.close();
  console.log('\nTaşıma bitti.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

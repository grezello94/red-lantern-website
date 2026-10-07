// Use the same idempotent migrations as startup and PWA readiness. Keeping a
// separate list here previously left the live order and KOT schema unprepared.
const { prepareDatabase } = require('./server');

async function initDB() {
  console.log('Preparing website, order and printing database schema…');
  const readiness = await prepareDatabase();
  console.log(`Database ready (${readiness.schemaVersion}).`);
  return readiness;
}

if (require.main === module) {
  initDB().catch((error) => {
    console.error('Database preparation failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { initDB };

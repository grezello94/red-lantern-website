require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

async function initDB() {
  const sql = neon(process.env.NEON_DATABASE_URL);
  try {
    console.log('Creating website_content table...');
    await sql`
      CREATE TABLE IF NOT EXISTS website_content (
        id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL
      );
    `;
    console.log('✅ Table website_content created successfully.');
  } catch (err) {
    console.error('❌ Error creating table:', err);
  }
}

initDB();

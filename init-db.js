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
    await sql`
      CREATE TABLE IF NOT EXISTS website_diagnostics (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        solution TEXT,
        location TEXT,
        method TEXT,
        path TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        ip_hash TEXT,
        user_agent TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `;
    console.log('✅ Table website_content created successfully.');
  } catch (err) {
    console.error('❌ Error creating table:', err);
  }
}

initDB();

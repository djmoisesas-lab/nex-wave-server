import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = [
  '00fec39a-1e89-436b-9df8-8a9455c9665b',
  'df54f0e6-a5a6-45c7-b277-e6dc4f8a632e',
  '37d2a707-f9ad-4221-9855-1b1c1c53ca65',
  '1b959fd0-9031-45d7-b2eb-c4f6ec51a97f',
  '63f4d5da-8d0b-4bad-9aa9-7d360ae00773',
  'c7945611-d6a2-4a52-9664-f57f34de7ed9',
];
const r = await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
console.log(`Deleted ${r.rowCount} users`);
await pool.end();

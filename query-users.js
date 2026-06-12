import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const r = await pool.query('SELECT id, username, email, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 20');
console.table(r.rows);
await pool.end();

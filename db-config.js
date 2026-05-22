// CI-safe config — reads from env vars only
const SUPABASE = {
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
};

const config = process.env.SUPABASE ? SUPABASE : SUPABASE;

module.exports = { SUPABASE, config };

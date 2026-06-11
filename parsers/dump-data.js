#!/usr/bin/env node
// dump-data.js v2 — Supabase REST API (fetch, no pg)
// Запуск: SUPABASE_URL=... SUPABASE_KEY=... node parsers/dump-data.js data/

const TABLES = [
  'mortgage_rates', 'housing', 'cbr_rates', 'exchange_rates',
  'news', 'macro_indicators', 'competitors', 'market_summary',
  'import_by_country', 'market_trends', 'commercial_construction',
  'energy_prices', 'raw_materials', 'cost_structure',
  'shipping_index', 'construction_index', 'tile_index',
];

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lxocykynmkhfxdekmcek.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_eOLQnTiloTF6WHfJ24wjKQ_XFalfvBW';

async function main() {
  const outDir = process.argv[2] || '/home/openclaw/.openclaw/workspace/ceramic-site/data';
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(outDir, { recursive: true });

  let count = 0, errors = 0;
  for (const table of TABLES) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=*`;
      const res = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.log(`❌ ${table}: HTTP ${res.status} ${res.statusText}`);
        errors++;
        continue;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) {
        console.log(`❌ ${table}: unexpected response`);
        errors++;
        continue;
      }
      fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 0));
      console.log(`✅ ${table}: ${rows.length} rows`);
      count++;
    } catch (e) {
      console.log(`❌ ${table}: ${e.message.slice(0, 100)}`);
      errors++;
    }
  }
  console.log(`\nDone: ${count} tables, ${errors} errors`);
  process.exit(errors > 0 && count === 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

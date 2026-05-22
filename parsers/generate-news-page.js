#!/usr/bin/env node
// Generate standalone news page: two blocks — tile market + construction/economy
const { Pool } = require('pg');
const fs = require('fs');
const { config } = require('../db-config.js');
const pool = new Pool(config);

const TILE_CATEGORIES = ['Рынок плитки'];
const CONSTR_CATEGORIES = ['Недвижимость / Стройка', 'Макроэкономика', 'Экономика', 'Импорт / Логистика'];

function rend(n) {
  const d = new Date(n.published_at).toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const color = n.importance === 'HIGH' ? '#c62828' : '#e65100';
  const img = n.image_url ? '<img src="'+n.image_url.replace(/'/g,'')+'" alt="" class="ni" onerror="this.style.display=\'none\'">' : '';
  const rel = n.relevance_score > 0 ? '<span class="ns" style="background:#2e7d32;font-size:.6rem">'+Math.round(n.relevance_score*100)+'%</span>' : '';
  const cat = '<span class="ns" style="background:#555;font-size:.6rem">'+n.category+'</span>';
  return '<div class="nc"><div class="nd"><a href="'+(n.url||'#').replace(/'/g,'')+'" target="_blank" class="nt">'+n.title.replace(/'/g,'')+'</a><div class="nm"><span class="ns" style="background:'+color+'">'+n.importance+'</span>'+rel+cat+'<span class="nx">'+n.source+'</span><span class="nx">'+d+'</span></div><div class="nx" style="margin-top:.15rem;font-size:.72rem;color:#555;line-height:1.3">'+(n.summary||'').slice(0,300)+'</div></div></div>';
}

(async () => {
  const all = (await pool.query("SELECT * FROM news ORDER BY published_at DESC")).rows;
  const tile = all.filter(n => TILE_CATEGORIES.includes(n.category));
  const constr = all.filter(n => CONSTR_CATEGORIES.includes(n.category));

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>📰 Новости рынка керамической плитки</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#222;padding:1rem}
h1{font-size:1.2rem;margin-bottom:.3rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
h1 a{font-size:.8rem;font-weight:400;color:#1565c0;text-decoration:underline;margin-left:auto}
h2{font-size:1rem;margin:.8rem 0 .4rem;padding-bottom:.2rem;border-bottom:2px solid #1565c0;display:flex;align-items:center;gap:.4rem}
.sec-1{border-left:3px solid #c62828;padding-left:.5rem;margin-top:.6rem}
.sec-2{border-left:3px solid #1565c0;padding-left:.5rem;margin-top:1.2rem}
.nc{display:flex;gap:.75rem;padding:.6rem .75rem;background:#fff;border-radius:8px;margin-bottom:.4rem;align-items:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.nc:hover{box-shadow:0 2px 6px rgba(0,0,0,.1)}
.ni{width:72px;height:56px;object-fit:cover;border-radius:4px;flex-shrink:0}
.nd{flex:1;min-width:0}
.nt{color:#1565c0;text-decoration:none;font-size:.85rem;line-height:1.3;display:block;font-weight:500}
.nt:hover{text-decoration:underline}
.nm{display:flex;gap:.35rem;margin-top:.2rem;flex-wrap:wrap}
.ns{color:#fff;font-size:.65rem;padding:1px 5px;border-radius:3px;font-weight:600}
.nx{color:#777;font-size:.7rem}
.ft{text-align:center;font-size:.7rem;color:#999;margin-top:1.5rem;padding:1rem}
@media(max-width:600px){.ni{width:56px;height:44px}}
</style>
</head>
<body>

<h1>📰 Новости рынка <a href="/">← На дашборд</a></h1>
<div style="font-size:.7rem;color:#888;margin-bottom:.6rem">Отфильтровано: ${all.length} релевантных новостей. Без нефти, лекарств, огурцов и прочего шума.</div>

<div class="sec-1">
<h2>🧱 Рынок керамической плитки</h2>
${tile.map(rend).join('\n')}
${tile.length === 0 ? '<div class="nh" style="color:#999">Нет новостей</div>' : ''}
</div>

<div class="sec-2">
<h2>🏗️ Строительство / Недвижимость / Макроэкономика</h2>
${constr.map(rend).join('\n')}
</div>

<div class="ft">Источники: Интерфакс, Прайм, РИА Новости, РИА Недвижимость, Лента.ру, АПКМ (apkm.pro), Telegram-каналы · Обновление: раз в неделю</div>
</body>
</html>`;

  fs.writeFileSync('./news.html', html);
  console.log('✅ news.html — ' + tile.length + ' tile + ' + constr.length + ' constr = ' + all.length + ' total');
  await pool.end();
})();

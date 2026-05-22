#!/usr/bin/env node
// Regenerate dashboard v6 — ECharts interactive visualizations
const { Pool } = require('pg');
const fs = require('fs');
const { config } = require('../db-config.js');

const pool = new Pool(config);

function dt(d) {
  if (!d) return '';
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

(async () => {
  const usdRow = (await pool.query("SELECT rate FROM exchange_rates WHERE pair='USDRUB' ORDER BY date DESC LIMIT 1")).rows[0];
  const usdRub = usdRow ? parseFloat(usdRow.rate) : 74.3;

  const rates = (await pool.query("SELECT * FROM exchange_rates WHERE date >= CURRENT_DATE - INTERVAL '3 years' ORDER BY pair, date")).rows;
  const macro = (await pool.query("SELECT * FROM macro_indicators WHERE year >= 2020 ORDER BY label, year DESC")).rows;
  const comp = (await pool.query("SELECT * FROM competitors ORDER BY COALESCE(production_capacity, 0) DESC")).rows;
  const ms = (await pool.query('SELECT * FROM market_summary LIMIT 1')).rows[0];
  const imp = (await pool.query('SELECT * FROM import_by_country ORDER BY share_pct DESC')).rows;
  const housing = (await pool.query("SELECT date, housing_completion as sqm FROM housing WHERE housing_completion IS NOT NULL ORDER BY date")).rows;
  const maxHousing = Math.max(...housing.map(h => parseFloat(h.sqm)));
  const izhs = (await pool.query("SELECT date, izhs, mkd FROM housing WHERE izhs IS NOT NULL ORDER BY date")).rows;
  const commercial = (await pool.query("SELECT * FROM commercial_construction ORDER BY date")).rows;
  const housingMonthly = housing;
  const trends = (await pool.query('SELECT * FROM market_trends')).rows;
  const cbr = (await pool.query("SELECT * FROM cbr_rates WHERE key_rate IS NOT NULL ORDER BY date")).rows;
  const tileProd = (await pool.query("SELECT * FROM macro_indicators WHERE label='Ceramic Tile Production' ORDER BY year")).rows;
  const energyPrices = (await pool.query("SELECT * FROM energy_prices ORDER BY date")).rows;
  const rawMaterials = (await pool.query("SELECT * FROM raw_materials ORDER BY year, material")).rows;
  const costStructure = (await pool.query("SELECT * FROM cost_structure ORDER BY component")).rows;
  const wci = (await pool.query("SELECT * FROM shipping_index WHERE index_name='WCI' ORDER BY date")).rows.map(w => ({ ...w, value: parseFloat(w.value) }));
  const mrate = (await pool.query("SELECT * FROM mortgage_rates WHERE mortgage_rate IS NOT NULL ORDER BY date")).rows;
  const TILE_CATS = ['Рынок плитки'];
  const CONSTR_CATS = ['Недвижимость / Стройка', 'Макроэкономика', 'Экономика', 'Импорт / Логистика'];
  const newsOverview = (await pool.query("SELECT * FROM news ORDER BY importance, published_at DESC LIMIT 3")).rows;
  const news = (await pool.query("SELECT * FROM news ORDER BY published_at DESC LIMIT 100")).rows;
  const tileNews = news.filter(n => TILE_CATS.includes(n.category));
  const constrNews = news.filter(n => CONSTR_CATS.includes(n.category));

  const byPair = {};
  for (const r of rates) { if (!byPair[r.pair]) byPair[r.pair] = []; byPair[r.pair].push(r); }
  const latest = {};
  for (const [p, rows] of Object.entries(byPair)) { if (rows.length) latest[p] = rows[rows.length - 1]; }
  const byMacro = {};
  for (const r of macro) { if (!byMacro[r.label]) byMacro[r.label] = []; byMacro[r.label].push(r); }
  const totalShare = comp.filter(c => c.market_share_pct > 0).reduce((s, c) => s + parseFloat(c.market_share_pct), 0);

  // ---------- ECharts option builders ----------

  function gridOpt(top, bottom, left, right) {
    return { show: true, left: left||10, right: right||10, top: top||15, bottom: bottom||35 };
  }
  function noAxis() {
    return { show: false, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { show: false } };
  }
  function barSeries(name, data, color) {
    return { name, type: 'bar', data, barMaxWidth: 36, itemStyle: { color, borderRadius: [2,2,0,0] } };
  }

  // Key rate chart — last 3 years, monthly average
  function keyRateOpt() {
    const monthly = {};
    cbr.forEach(r => {
      const key = r.date.getFullYear() + '-' + String(r.date.getMonth()+1).padStart(2,'0');
      if (!monthly[key]) monthly[key] = [];
      monthly[key].push(parseFloat(r.key_rate));
    });
    const months = Object.keys(monthly).sort().slice(-36);
    const vals = months.map(m => Math.round(monthly[m].reduce((a,b)=>a+b,0)/monthly[m].length*100)/100);
    if (vals.length < 3) return null;
    let lastYear = '';
    const yLabels = months.map(m => {
      const y = String(m).slice(0,4);
      if (y !== lastYear) { lastYear = y; return y; }
      return '';
    });
    return {
      grid: gridOpt(15,35,5,10),
      xAxis: { type: 'category', data: yLabels, axisLabel: { rotate: 45, fontSize: 9, margin: 4 },
        axisTick: { alignWithLabel: true } },
      yAxis: { type:'value', show: true, splitLine: { show: true, lineStyle: { color: '#333', type: 'dashed', opacity: 0.15 } }, axisLabel: { fontSize: 8, color: '#999' } },
      tooltip: { trigger: 'axis', formatter: p => p.map(i => `${i.axisValue}: <b>${i.value}%</b>`).join('<br>') },
      series: [{
        type: 'bar', barMaxWidth: 28,
        data: vals.map(v => ({ value: v, itemStyle: { color: v > 10 ? '#c62828' : '#2e7d32' } })),
        itemStyle: { borderRadius: [2,2,0,0] },
        markLine: { data: [{ yAxis: 10, label: { formatter: '10% порог', color:'#666', fontSize:8 }, lineStyle: { color: '#999', type: 'dashed' } }] }
      }]
    };
  }

  // Mortgage rate chart
  function mortgageOpt() {
    if (!mrate || mrate.length < 3) return null;
    const labels = getYearLabels(mrate, r => r.date);
    const rates = mrate.map(r => parseFloat(r.mortgage_rate));
    const keyR = mrate.map(r => {
      // match cbr rate closest to this mortgage month
      const ym = r.date.getFullYear()*12 + r.date.getMonth();
      const closest = cbr.filter(c => c.date.getFullYear()*12 + c.date.getMonth() <= ym);
      return closest.length ? parseFloat(closest[closest.length-1].key_rate) : null;
    });
    return {
      grid: gridOpt(15,40,5,10),
      legend: { data: ['Ипотечная ставка','Ключевая ставка ЦБ'], bottom:0, textStyle:{fontSize:9} },
      xAxis: { type:'category', data:labels, axisLabel:{rotate:45,fontSize:9,margin:4}, axisTick:{alignWithLabel:true} },
      yAxis: { ...noAxis(), splitLine:{show:false} },
      tooltip: { trigger:'axis' },
      series: [
        { name:'Ипотечная ставка', type:'line', data:rates, smooth:true,
          lineStyle:{color:'#1565c0',width:2}, itemStyle:{color:'#1565c0'},
          areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(21,101,192,0.2)'},{offset:1,color:'rgba(21,101,192,0)'}]}} },
        { name:'Ключевая ставка ЦБ', type:'line', data:keyR, smooth:true,
          lineStyle:{color:'#c62828',width:1.5,type:'dashed'}, itemStyle:{color:'#c62828'} }
      ]
    };
  }

  function yearLabel(r) {
    if (!r.date) return r.year || '';
    return String(r.date.getFullYear());
  }
  function getYearLabels(rows, getDate) {
    let lastYear = '';
    return rows.map(r => {
      const d = getDate(r);
      const y = d instanceof Date ? String(d.getFullYear()) : String(d).slice(0,4);
      if (y !== lastYear) { lastYear = y; return y; }
      return '';
    });
  }

  function chartAxisOpt(rows, color) {
    if (!rows || rows.length < 4) return null;
    const vals = rows.map(r => parseFloat(r.rate || r.value));
    const labels = getYearLabels(rows, r => r.date);
    return {
      grid: gridOpt(15,40,5,5),
      xAxis: { type: 'category', data: labels,
        axisLabel: { rotate: 45, fontSize: 9, margin: 4 }, axisTick: { alignWithLabel: true } },
      yAxis: { ...noAxis(), splitLine: { show: false } },
      tooltip: { trigger: 'axis', formatter: p => p.map(i => `${i.axisValue}: <b>${i.value.toFixed(2)}</b>`).join('<br>') },
      series: [{
        type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 1.5, color },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: color + '40' }, { offset: 1, color: color + '05' }] } },
        data: vals.map(v => ({ value: Math.round(v*100)/100 }))
      }]
    };
  }

  function macroOpt(label) {
    const rows = byMacro[label];
    if (!rows || rows.length < 2) return null;
    const sorted = [...rows].reverse();
    const mc = {'GDP Growth':'#2e7d32','Inflation CPI':'#c62828','Manufacturing Growth':'#1565c0','Construction Investment':'#6a1b9a'};
    const color = mc[label] || '#1565c0';
    return {
      grid: gridOpt(22,30,5,5),
      xAxis: { type: 'category', data: sorted.map(r => r.year),
        axisLabel: { fontSize: 10 }, axisTick: { alignWithLabel: true } },
      yAxis: noAxis(),
      tooltip: { trigger: 'axis', formatter: p => p.map(i => `${i.axisValue}: <b>${i.value.toFixed(2)}%</b>`).join('<br>') },
      series: [{
        type: 'bar', barMaxWidth: 36,
        data: sorted.map(r => ({ value: Math.round(parseFloat(r.value)*10)/10, itemStyle: { color } })),
        itemStyle: { borderRadius: [2,2,0,0] },
        label: { show: true, position: 'top', formatter: '{c}%', fontSize: 10, fontWeight: 'bold', color }
      }]
    };
  }

  function balanceOpt() {
    // Market = sales (production + import - export). Source: IndexBox (2019-20), referatbooks/BusinesStat (2021-24)
    const years = ['2019','2020','2021','2022','2023','2024'];
    const dom =   [155,   151,   189,  177,  159,  147];
    const imp =   [45.4,  44,    46.4, 46.5, 59.3, 65.3];
    const total = [200.4, 195,   235.5,224,  218,  212];
    return {
      grid: gridOpt(15,30,10,10),
      xAxis: { type: 'category', data: years, axisLabel: { fontSize: 10, fontWeight: 'bold' } },
      yAxis: noAxis(),
      tooltip: { trigger: 'axis', formatter: p => {
        const i = years.indexOf(p[0].axisValue);
        const d = +(dom[i]).toFixed(1);
        const im = +(imp[i]).toFixed(1);
        const t = total[i];
        return `<b>${p[0].axisValue}</b><br/>РФ: ${d} млн м²<br/>Импорт: ${im} млн м²<br/>Всего: ${t} млн м²`;
      }},
      series: [
        { name: 'РФ', type: 'bar', stack: 'total', barMaxWidth: 40,
          data: years.map((y,i) => ({ value: dom[i] })),
          itemStyle: { color: '#1565c0', borderRadius: [0,0,0,0] },
          label: { show: true, position: 'insideBottom', formatter: p => 'РФ ' + p.value,
            fontSize: 9, color: '#fff', fontWeight: 'bold' } },
        { name: 'Импорт', type: 'bar', stack: 'total', barMaxWidth: 40,
          data: years.map((y,i) => ({ value: imp[i] })),
          itemStyle: { color: '#e65100', borderRadius: [2,2,0,0] },
          label: { show: true, position: 'inside', formatter: p => 'Имп ' + p.value,
            fontSize: 9, color: '#fff', fontWeight: 'bold' } }
      ],
      legend: { data: ['РФ','Импорт'], bottom: 0, icon: 'roundRect', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 10 } }
    };
  }

  function priceOpt(type) {
    const data = [
      { year: 2021, imp_usd: 9.5, dom_rub: 550 },
      { year: 2022, imp_usd: 9.8, dom_rub: 590 },
      { year: 2023, imp_usd: 8.6, dom_rub: 660 },
      { year: 2024, imp_usd: 8.0, dom_rub: 725 },
      { year: 2025, imp_usd: 7.5, dom_rub: 706 },
    ];
    const col = type === 'imp' ? '#e65100' : '#6a1b9a';
    return {
      grid: gridOpt(22,30,5,10),
      xAxis: { type: 'category', data: data.map(d => d.year), axisLabel: { fontSize: 10 } },
      yAxis: noAxis(),
      tooltip: { trigger: 'axis', formatter: p => {
        const d = data[p[0].dataIndex];
        return `${d.year}: <b>${type === 'imp' ? Math.round(d.imp_usd*usdRub) : d.dom_rub} ₽</b>` +
          (type === 'imp' ? `<br/>$${d.imp_usd}` : '');
      }},
      series: [{
        type: 'bar', barMaxWidth: 40,
        data: data.map(d => ({ value: type === 'imp' ? Math.round(d.imp_usd*usdRub) : d.dom_rub })),
        itemStyle: { color: col, borderRadius: [2,2,0,0] },
        label: { show: true, position: 'top', formatter: p => p.value + ' ₽', fontSize: 10, fontWeight: 'bold', color: col }
      }]
    };
  }

  function simpleBarOpt(years, values, color, label, title) {
    const maxV = Math.max(...values);
    return {
      grid: gridOpt(22,30,5,10),
      xAxis: { type: 'category', data: years, axisLabel: { fontSize: 10 } },
      yAxis: noAxis(),
      tooltip: { trigger: 'axis', formatter: p => `${p[0].axisValue}: <b>${p[0].value}</b>` },
      series: [{
        type: 'bar', barMaxWidth: 48, name: label,
        data: values.map(v => ({ value: v, itemStyle: { color } })),
        itemStyle: { borderRadius: [2,2,0,0] },
        label: { show: true, position: 'top', formatter: p => p.value,
          fontSize: 11, fontWeight: 'bold', color }
      }]
    };
  }

  // Build all chart options
  const chartOpts = {};

  chartOpts.keyRate = keyRateOpt();
  chartOpts.mortgage = mortgageOpt();

  // Exchange rate pairs
  ['USDRUB','IMOEX','RTSI'].forEach(code => {
    const colorMap = { USDRUB: '#1565c0', IMOEX: '#6a1b9a', RTSI: '#00838f' };
    const rows = byPair[code];
    chartOpts[code] = chartAxisOpt(rows, colorMap[code]);
  });
  chartOpts.IMOEXlabel = byPair['IMOEX'] && byPair['IMOEX'].length > 6 ? 
    byPair['IMOEX'][byPair['IMOEX'].length-1].value : null;
  chartOpts.RTSIlabel = byPair['RTSI'] && byPair['RTSI'].length > 6 ?
    byPair['RTSI'][byPair['RTSI'].length-1].value : null;

  // Macro charts
  ['GDP Growth','Inflation CPI','Manufacturing Growth','Construction Investment','Real Income'].forEach(l => {
    chartOpts[l.replace(/\s+/g, '')] = macroOpt(l);
  });

  // Balance
  chartOpts.balance = balanceOpt();

  // Housing (monthly)
  chartOpts.housing = housingMonthly.length > 0 ? (() => {
    const labels = getYearLabels(housingMonthly, h => new Date(h.date));
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:40},
      xAxis: {type:'category',data:labels,axisLabel:{rotate:45,fontSize:9,margin:4},axisTick:{alignWithLabel:true}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis',formatter:p=>p[0].axisValue+': <b>'+(p[0].value/1e6).toFixed(1)+' млн м²</b>'},
      series: [{type:'bar',data:housingMonthly.map(h=>({value:parseFloat(h.sqm),itemStyle:{color:'#1565c0'}})),barMaxWidth:12,itemStyle:{borderRadius:[1,1,0,0]}}]
    };
  })() : null;

  // IZhS (individual housing) — annual
  chartOpts.izhs = izhs.length > 0 ? (() => {
    const labels = izhs.map(h => h.date.getFullYear());
    const izhsVals = izhs.map(h => parseFloat(h.izhs));
    const mkdVals = izhs.map(h => parseFloat(h.mkd));
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:40},
      xAxis: {type:'category',data:labels,axisLabel:{fontSize:9}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis',formatter:p=>p[0].axisValue+': <b>'+(p[0].value).toFixed(1)+' млн м²</b>'},
      legend: {show:true,top:0,right:0,textStyle:{fontSize:10,color:'#8b949e'}},
      series: [
        {name:'ИЖС',type:'bar',data:izhsVals.map(v=>({value:v,itemStyle:{color:'#2ea043'}})),barMaxWidth:16,itemStyle:{borderRadius:[2,2,0,0]}},
        {name:'МКД',type:'bar',data:mkdVals.map(v=>({value:v,itemStyle:{color:'#58a6ff'}})),barMaxWidth:16,itemStyle:{borderRadius:[2,2,0,0]}}
      ]
    };
  })() : null;

  // Commercial real estate — annual
  chartOpts.commercial = commercial.length > 0 ? (() => {
    const labels = commercial.map(c => c.date.getFullYear());
    const vals = commercial.map(c => parseFloat(c.total_commercial));
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:40},
      xAxis: {type:'category',data:labels,axisLabel:{fontSize:9}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis',formatter:p=>p[0].axisValue+': <b>'+(p[0].value).toFixed(1)+' млн м²</b>'},
      series: [{type:'bar',data:vals.map(v=>({value:v,itemStyle:{color:'#d2a8ff'}})),barMaxWidth:20,itemStyle:{borderRadius:[2,2,0,0]}}]
    };
  })() : null;

  // Production
  chartOpts.production = simpleBarOpt(
    tileProd.map(p => p.year), tileProd.map(p => parseFloat(p.value)),
    '#e65100', 'млн м²', 'Производство'
  );
  
  // Energy prices (from Supabase)
  chartOpts.energy = (() => {
    const eps = energyPrices.filter(e => e.electricity_price_rub != null);
    if (eps.length < 2) return null;
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:35},
      legend: {data:['Газ (тыс. м³, ₽)','Эл-во (кВт·ч, ₽)'],bottom:0,textStyle:{fontSize:9}},
      xAxis: {type:'category',data:eps.map(e=>e.date.getFullYear()),axisLabel:{fontSize:10},axisTick:{alignWithLabel:true}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis'},
      series: [
        {name:'Газ (тыс. м³, ₽)',type:'bar',barMaxWidth:28,
          data:eps.map(e=>parseFloat(e.gas_price_rub||0)),
          itemStyle:{color:'#6a1b9a',borderRadius:[2,2,0,0]}},
        {name:'Эл-во (кВт·ч, ₽)',type:'line',yAxisIndex:1,smooth:true,
          data:eps.map(e=>parseFloat(e.electricity_price_rub||0)),
          lineStyle:{color:'#00838f',width:2},
          itemStyle:{color:'#00838f'}}
      ],
      yAxis: [
        {type:'value',show:false},
        {type:'value',show:false}
      ]
    };
  })();

  // Raw materials prices
  chartOpts.rawMaterials = (() => {
    const mats = [...new Set(rawMaterials.map(r => r.material))];
    const years = [...new Set(rawMaterials.map(r => r.year))].sort();
    if (years.length < 2) return null;
    const cols = ['#d32f2f','#1976d2','#388e3c'];
    return {
      grid: {left:16,right:10,top:18,bottom:35},
      legend: {data:mats,bottom:0,textStyle:{fontSize:9}},
      xAxis: {type:'category',data:years.map(String),axisLabel:{fontSize:10}},
      yAxis: {type:'value',show:false},
      tooltip: {trigger:'axis',valueFormatter:v=>v.toFixed(0)+' руб/т'},
      series: mats.map((m,i) => ({
        name:m, type:'line', smooth:true,
        data: years.map(y => { const r = rawMaterials.find(r => r.material===m && r.year===y); return r ? r.price : null; }),
        lineStyle:{color:cols[i],width:2},
        itemStyle:{color:cols[i]},
        symbol:'circle',symbolSize:6
      }))
    };
  })();

  // Cost structure (2024, pie)
  chartOpts.costStructure = (() => {
    if (costStructure.length < 2) return null;
    const cols = ['#d32f2f','#f57c00','#1976d2','#388e3c','#7b1fa2','#616161'];
    return {
      tooltip: {trigger:'item',formatter:'{b}: {c}%'},
      series: [{
        type:'pie',radius:['30%','70%'],center:['50%','50%'],
        data: costStructure.map((c,i) => ({
          name:c.component, value:c.share,
          itemStyle:{color:cols[i]}
        })),
        label:{color:'#c9d1d9',fontSize:10,formatter:'{b}\n{d}%'},
        labelLine:{lineStyle:{color:'#484f58'}}
      }]
    };
  })();

  // WCI
  const yearly = {};
  wci.forEach(w => {
    const y = w.date.getFullYear();
    if (!yearly[y]) yearly[y] = [];
    yearly[y].push(w.value);
  });
  const annual = Object.entries(yearly).map(([y, vals]) => ({
    year: parseInt(y), value: Math.round(vals.reduce((a,b) => a+b, 0) / vals.length)
  }));
  chartOpts.wci = simpleBarOpt(
    annual.map(a => a.year), annual.map(a => a.value),
    '#00695c', '$/40ft', 'WCI'
  );
  
  // Mortgage volume
  chartOpts.mortgageVolume = mrate.length > 0 && mrate[0].mortgage_volume_rub ? (() => {
    const mv = mrate.filter(r => r.mortgage_volume_rub != null);
    if (mv.length < 3) return null;
    const labels = getYearLabels(mv, r => new Date(r.date));
    const vals = mv.map(r => parseFloat(r.mortgage_volume_rub));
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:40},
      xAxis: {type:'category',data:labels,axisLabel:{rotate:45,fontSize:9,margin:4},axisTick:{alignWithLabel:true}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis',formatter:p=>p[0].axisValue+': <b>'+(p[0].value/1e9).toFixed(1)+' млрд ₽</b>'},
      series: [{type:'bar',data:vals.map(v=>({value:v,itemStyle:{color:'#1565c0'}})),barMaxWidth:10,itemStyle:{borderRadius:[1,1,0,0]}}]
    };
  })() : null;
  
  // Mortgage count
  chartOpts.mortgageCount = mrate.length > 0 && mrate[0].mortgage_count ? (() => {
    const mc = mrate.filter(r => r.mortgage_count != null);
    if (mc.length < 3) return null;
    const labels = getYearLabels(mc, r => new Date(r.date));
    const vals = mc.map(r => r.mortgage_count);
    return {
      grid: {show:true,left:10,right:10,top:15,bottom:40},
      xAxis: {type:'category',data:labels,axisLabel:{rotate:45,fontSize:9,margin:4},axisTick:{alignWithLabel:true}},
      yAxis: {show:false,splitLine:{show:false}},
      tooltip: {trigger:'axis',formatter:p=>p[0].axisValue+': <b>'+(p[0].value/1000).toFixed(0)+' тыс.</b>'},
      series: [{type:'line',smooth:true,showSymbol:false,lineStyle:{width:1.5,color:'#e65100'},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(230,81,0,0.2)'},{offset:1,color:'rgba(230,81,0,0.0)'}]}},data:vals}]
    };
  })() : null;

  // Prices
  chartOpts.impPrice = priceOpt('imp');
  chartOpts.domPrice = priceOpt('dom');

  const macroRus = {
    'GDP Growth':'ВВП, %', 'Inflation CPI':'Инфляция, %',
    'Manufacturing Growth':'Промпроизводство, %', 'Construction Investment':'Стройка, %', 'Real Income':'Реальные доходы, %',
  };

  const factorScores = [
    {factor:'Ключевая ставка ЦБ', impact:'Высокий', lag:'6-9 мес', corr:0.82, notes:'Через ипотеку → стройка → ремонт'},
    {factor:'Ввод жилья', impact:'Прямой', lag:'3-6 мес', corr:0.75, notes:'1 м² жилья ≈ 0.5 м² плитки (кухня+ванна)'},
    {factor:'Инфляция', impact:'Средний', lag:'6-12 мес', corr:0.60, notes:'Рост цен → отложенный спрос'},
    {factor:'Курс USD/RUB', impact:'Высокий', lag:'1-3 мес', corr:0.85, notes:'Импортная плитка → цены'},
    {factor:'Реальные доходы', impact:'Средний', lag:'3-6 мес', corr:0.65, notes:'Покупательная способность'},
    {factor:'Стройка (инвестиции)', impact:'Высокий', lag:'6-12 мес', corr:0.78, notes:'Коммерческая недвижимость'},
    {factor:'Фрахт (Drewry WCI)', impact:'Средний', lag:'2-4 мес', corr:0.70, notes:'Импорт из Азии'},
  ];

  const compBarColors = ['#1565c0','#2e7d32','#6a1b9a','#00838f','#c62828','#e65100','#37474f','#558b2f'];

  const chartDataJSON = JSON.stringify(chartOpts).replace(/<\/script>/g, '<\\/script>');

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Аналитика рынка керамической плитки</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#c9d1d9;overflow-x:hidden}
.header{background:linear-gradient(135deg,#161b22,#0d1117);border-bottom:1px solid #30363d;padding:1.2rem 1rem}.header h1{font-size:1.1rem;color:#f0f6fc;word-break:break-word}
.nav{display:flex;gap:0;padding:0;flex-wrap:wrap;border-bottom:1px solid #30363d;background:#161b22;padding-left:.5rem}
.nav-btn{background:transparent;border:none;border-bottom:2px solid transparent;padding:.55rem .85rem;font-size:.75rem;cursor:pointer;color:#8b949e;font-weight:500;transition:.15s;white-space:nowrap}
.nav-btn:hover{color:#f0f6fc;background:#21262d}
.nav-btn.active{color:#f0f6fc;border-bottom-color:#58a6ff;background:transparent}
.container{max-width:1200px;margin:0;padding:.5rem;overflow-x:hidden}
.s{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.75rem;margin-bottom:.5rem;overflow-x:hidden}
.s h2{font-size:.85rem;color:#e6edf3;margin-bottom:.5rem;border-left:3px solid #58a6ff;padding-left:.4rem}
.crds{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem}
@media(min-width:600px){.crds{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.container{padding:.75rem}}
.c{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:.5rem}
.c .v{font-size:1rem;font-weight:700;color:#f0f6fc}.c .sb{font-size:.55rem;color:#8b949e;margin-top:.1rem}.c .src{font-size:.5rem;color:#484f58}.c .lb{font-size:.55rem;text-transform:uppercase;color:#8b949e}
.ct{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.75rem}
.ct h2{font-size:.75rem;color:#e6edf3;margin-bottom:.3rem}.ct h3{font-size:.7rem;color:#c9d1d9}.ct .src{font-size:.5rem;color:#484f58;margin-top:.25rem}
.chart-box{width:100%;overflow:hidden;min-width:100px}
.g2{display:grid;grid-template-columns:1fr;gap:.4rem}
@media(min-width:600px){.g2{grid-template-columns:repeat(3,1fr)}}
.mg{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem}
@media(min-width:600px){.mg{grid-template-columns:repeat(4,1fr)}}
.ig{display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem}
@media(min-width:600px){.ig{grid-template-columns:repeat(6,1fr)}}
@media(max-width:600px){.header{padding:.6rem .5rem}.header h1{font-size:.8rem}.container{padding:.3rem}.c .v{font-size:.8rem}.crds{grid-template-columns:repeat(2,1fr)}.s{padding:.4rem}.s h2{font-size:.7rem}.nav-btn{font-size:.6rem;padding:.35rem .4rem}}
.ic{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:.4rem;text-align:center}.ic .pct{font-size:1.1rem;font-weight:700;color:#58a6ff}.ic .lb2{font-size:.55rem;color:#8b949e}
.tg{display:flex;flex-wrap:wrap;gap:.25rem;margin-bottom:.35rem}
.t{background:#21262d;border:1px solid #30363d;border-radius:8px;padding:.12rem .4rem;font-size:.55rem;color:#58a6ff;font-weight:600;white-space:nowrap}
.cg{display:grid;grid-template-columns:1fr;gap:.4rem}
@media(min-width:600px){.cg{grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}}
.cp{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.6rem}
.cp h3{font-size:.75rem;color:#58a6ff}.cp .sh{display:inline-block;background:#21262d;border:1px solid #30363d;padding:.08rem .35rem;border-radius:3px;font-size:.6rem;color:#58a6ff;font-weight:600}
.cp .i{font-size:.6rem;color:#8b949e;line-height:1.3}.cp .i strong{color:#c9d1d9}
.hp{height:5px;border-radius:2px;margin:.12rem 0;max-width:100%}
progress{width:100%;height:7px;border-radius:3px;margin-bottom:.35rem}
ul{list-style:none}li{padding:.2rem 0;border-bottom:1px solid #21262d;font-size:.65rem;color:#8b949e}li:last-child{border:none}
.ft{text-align:center;padding:.6rem;color:#484f58;font-size:.6rem;line-height:1.3}.ft a{color:#58a6ff}.small{font-size:.55rem;color:#484f58}
.chart-box{width:100%}
.nc{display:flex;gap:.5rem;padding:.5rem;border-bottom:1px solid #21262d;align-items:flex-start}
.nc:last-child{border:none}
.nd{flex:1;min-width:0}
.nt{font-size:.7rem;font-weight:600;color:#58a6ff;text-decoration:none;display:block;margin-bottom:.15rem;line-height:1.2}
.nt:hover{text-decoration:underline}
.nm{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;margin-bottom:.15rem}
.ns{font-size:.5rem;color:#fff;padding:.05rem .35rem;border-radius:3px;font-weight:600;text-transform:uppercase}
.nx{font-size:.5rem;color:#484f58}
.nsm{font-size:.55rem;color:#8b949e;line-height:1.2;word-wrap:break-word}
.nh{font-size:.65rem;color:#484f58;padding:.5rem;text-align:center}
.cat-hidden{display:none!important}
</style></head><body>
<div class="header"><h1>🏠 Аналитика рынка керамической плитки</h1></div>
<div class="nav" id="nav">
<button class="nav-btn active" onclick="switchCat('all')">📊 Все</button>
<button class="nav-btn" onclick="switchCat('macro')">📈 Макроэкономика</button>
<button class="nav-btn" onclick="switchCat('competitors')">🏭 Конкуренты</button>
<button class="nav-btn" onclick="switchCat('import')">📦 Импорт</button>
<button class="nav-btn" onclick="switchCat('prices')">💵 Цены</button>
<a href="/prognosis" class="nav-btn" style="text-decoration:none">🔮 Прогноз</a>
<a href="/scraping" class="nav-btn" style="text-decoration:none">🕷️ Парсинг</a>
<button class="nav-btn" onclick="switchCat('news')">📰 Новости</button>
</div>
<div class="container">







<div class="s" data-cat="macro"><h2>📊 Ключевая ставка ЦБ</h2>
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;margin-bottom:.5rem">
<div class="c"><div class="v" style="color:#c62828">${cbr.length ? parseFloat(cbr[cbr.length-1].key_rate).toFixed(2) : '14.50'}%</div><div class="sb">${cbr.length ? dt(cbr[cbr.length-1].date) : '—'}</div><div class="lb">Текущая ставка</div></div>
<div class="c"><div class="v" style="color:#2e7d32">${cbr.length > 30 ? Math.round(cbr.slice(-30).reduce((s,r)=>s+parseFloat(r.key_rate),0)/30*100)/100 : '—'}</div><div class="sb">средняя за 30 дней</div><div class="lb">Средняя ставка</div></div>
</div>
<div id="c-keyRate" class="chart-box" style="height:250px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Банк России (cbr.ru). Последние ~3 года, среднемесячные.</div>

<div class="s" data-cat="macro"><h2>📈 Ипотечная ставка vs Ключевая ставка</h2>
<div id="c-mortgage" class="chart-box" style="height:280px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">ЦБ РФ · средневзвешенная ставка по ИЖК, ежемесячно</div></div>

<div class="s" data-cat="macro"><h2>💰 Объём выдачи ипотеки</h2>
<div id="c-mortgageVolume" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">ЦБ РФ · ежемесячный объём выданных ИЖК</div></div>

<div class="s" data-cat="macro"><h2>📋 Количество выданных ИЖК</h2>
<div id="c-mortgageCount" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">ЦБ РФ · ежемесячное количество выданных кредитов</div></div>
</div>

<div class="s" data-cat="macro"><h2>📊 Курсы валют</h2>
<div class="crds">${Object.entries(latest).slice(0,9).map(([p,r]) =>
  `<div class="c"><div class="lb">💱 ${p === 'USDRUB' ? 'Доллар (MOEX)' : p === 'EURRUB' ? 'Евро (ЦБ)' : p === 'CNYRUB' ? 'Юань (ЦБ)' : p}</div><div class="v">${parseFloat(r.rate).toFixed(p.includes('CBR')||p==='USDRUB'?2:1)}</div><div class="sb">${r.date.toISOString().slice(0,10)}<br><span class="src">${r.source.toUpperCase()}</span></div></div>`
).join('')}</div></div>

<div class="s" data-cat="macro"><h2>📈 Доллар и индексы (MOEX)</h2>
<div class="g2">
<div class="ct"><h2>💱 Доллар США (MOEX)</h2>
<div id="c-USDRUB" class="chart-box" style="height:270px"></div>
<div class="src" style="font-size:.75rem">USDRUB · ЦБ РФ · 3 года</div></div>
<div class="ct"><h2>📈 Индекс Мосбиржи</h2>
<div id="c-IMOEX" class="chart-box" style="height:270px"></div>
<div class="src" style="font-size:.75rem">IMOEX <b>${chartOpts.IMOEXlabel}</b> <span style="color:#666;font-size:.6rem">(3 года) · MOEX</span></div></div>
<div class="ct"><h2>📉 Индекс РТС</h2>
<div id="c-RTSI" class="chart-box" style="height:270px"></div>
<div class="src" style="font-size:.75rem">RTSI <b>${chartOpts.RTSIlabel}</b> <span style="color:#666;font-size:.6rem">(3 года) · MOEX</span></div></div>
</div>
</div>

<div class="s" data-cat="macro"><h2>🌍 Макроэкономика РФ</h2>
<div class="small" style="margin-bottom:.3rem">World Bank WDI · Росстат · Минэкономразвития</div>
<div class="mg">${['GDP Growth','Inflation CPI','Manufacturing Growth','Construction Investment','Real Income'].map(l => {
  const id = l.replace(/\s+/g, '');
  return `<div class="ct"><h3>${macroRus[l]||l}</h3><div id="c-${id}" class="chart-box" style="height:180px"></div><div class="src">World Bank</div></div>`;
}).join('')}</div></div>

<div class="s" data-cat="macro"><h2>🏗 Ввод жилья в РФ (млн м²)</h2>
<div id="c-housing" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Росстат (пресс-релизы). Рост +31% за 5 лет.</div>
</div>

<div class="s" data-cat="macro"><h2>🏠 Ввод жилья: ИЖС vs МКД (млн м²/год)</h2>
<div id="c-izhs" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Росстат, РБК · ИЖС растёт, МКД падает с пика 2023</div>
</div>

<div class="s" data-cat="macro"><h2>🏢 Ввод коммерческой недвижимости (млн м²)</h2>
<div id="c-commercial" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Nikoliers, РБК · Рекорд 2024 за счёт складов для e-commerce</div>
</div>

<div class="s" data-cat="macro"><h2>🧱 Цены на сырьё (руб/т)</h2>
<div id="c-rawMaterials" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Оценка по ИЦП · Доля в себестоимости: ∼22%</div>
</div>

<div class="s" data-cat="macro"><h2>⚡ Энергоносители (газ + эл-во)</h2>
<div id="c-energy" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">ФАС (газ) · Росстат (эл-во) · Доля в себестоимости: ∼28%</div>
</div>

<div class="s" data-cat="macro"><h2>📊 Структура себестоимости плитки (2024)</h2>
<div id="c-costStructure" class="chart-box" style="height:240px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Оценка на основе отраслевых данных</div>
</div>

<div class="s" data-cat="competitors,import"><h2>🏭 Объём рынка: РФ vs Импорт (млн м²)</h2>
<div id="c-balance" class="chart-box" style="height:260px"></div>
<div class="small">Импорт: 24% (2020) → 30% (2024). Европа → Азия.</div>
</div>

<div class="s" data-cat="competitors"><h2>🏭 Производители</h2>
<div class="tg">${comp.filter(c => c.market_share_pct > 0).map(c => `<span class="t">${c.market_share_pct}% ${c.name_ru}</span>`).join('')}</div>
<progress value="${totalShare}" max="100"></progress>
<div class="small">Топ-8: ${totalShare.toFixed(0)}%</div>
<div class="cg">${comp.map((c,i) =>
  `<div class="cp"><div style="display:flex;justify-content:space-between;align-items:center"><h3>${c.name_ru}</h3>${c.market_share_pct > 0 ? `<span class="sh">${c.market_share_pct}%</span>` : '<span class="sh" style="color:#8b949e;font-size:.5rem">дочерняя</span>'}</div>
  <div class="hp" style="width:${Math.min(c.market_share_pct*6,95)}%;background:${compBarColors[i%8]}"></div>
  <div class="i"><strong>Площадки:</strong> ${c.plants}</div>
  <div class="i"><strong>Объём производства:</strong> ${c.production_capacity ? c.production_capacity + ' млн м²/год' : '<span style="color:#999">нет подтверждённых данных</span>'}</div>
  ${c.id === 'unitile' ? '<div class="i" style="color:#58a6ff;font-size:.55rem">↳ Шахтинская керамика: 19.5 млн м²/год · Воронежская керамика: 8 млн м²/год</div>' : ''}
  ${c.id === 'shakhty' ? '<div class="i" style="color:#8b949e;font-size:.55rem">входит в группу компаний <strong>Unitile</strong> (доля рынка учтена в Unitile)</div><div class="hp" style="width:0"></div>' : ''}
  <div class="i"><strong>Сегменты:</strong> ${c.segments.join(', ')}</div>
  <div class="src" style="font-size:.5rem;margin-top:.15rem">${c.source || 'источник не указан'}</div></div>`
).join('')}</div>
<div class="small" style="color:#8b949e;margin-top:.4rem">* Объёмы производства из открытых источников. Данные обновляются вручную.</div></div>

<div class="s" data-cat="import"><h2>📦 Импорт по странам (2024)</h2>
<div style="font-size:.7rem;color:#555;margin-bottom:.4rem">Доля импорта на рынке: <strong>30%</strong> (2024, +26% к 2021)</div>
<div class="ig">${imp.map((ic,i) => {
  const bgs = ['#e3f2fd','#f3e5f5','#e8f5e9','#fff3e0','#fce4ec','#f5f5f5'];
  return `<div class="ic" style="background:${bgs[i%6]}"><div class="pct">${ic.share_pct}%</div><div class="lb2">${ic.country.split('(')[0].trim()}<br><span style="font-size:.5rem;color:#999">${ic.yoy_change}</span></div></div>`;
}).join('')}</div>
<div class="src">АПКМ / vc.ru</div>
</div>

<div class="s" data-cat="competitors"><h2>💵 Рынок в цифрах (2024)</h2>
<div class="mg">
<div class="ct"><h3>Объём</h3><div style="font-size:.9rem;font-weight:700;color:#1a237e">$${(ms?+ms.market_size_usd/1e9:2.82).toFixed(2)} млрд</div><div style="font-size:.7rem;color:#888">≈ ${((ms?+ms.market_size_usd*usdRub:209470)/1e9).toFixed(1)} млрд ₽</div><div class="src">Mordor Intelligence</div></div>
<div class="ct"><h3>Прогноз 2029</h3><div style="font-size:.9rem;font-weight:700;color:#2e7d32">3,23 млрд $</div><div style="font-size:.7rem;color:#888">≈ ${(3.23*usdRub).toFixed(1)} млрд ₽</div><div class="src">CAGR 3%</div></div>
<div class="ct"><h3>Розница</h3><div style="font-size:.9rem;font-weight:700;color:#6a1b9a">${ms?ms.avg_retail_rub:840} ₽/м²</div><div style="font-size:.7rem;color:#888">≈ $${((ms?+ms.avg_retail_rub/usdRub:11.3).toFixed(1))}</div><div class="src">Alto Consulting</div></div>
<div class="ct"><h3>Опт</h3><div style="font-size:.9rem;font-weight:700;color:#00838f">${ms?ms.avg_producer_rub:291} ₽/м²</div><div style="font-size:.7rem;color:#888">+8.9% (2022-24)</div><div class="src">Alto Consulting</div></div>
</div></div>

<div class="s" data-cat="prices"><h2>📈 Цены: импорт vs отечественное</h2>
<div style="font-size:.7rem;color:#555;margin-bottom:.35rem">Импорт — стоимость ввоза (CIF), пересчитана в ₽. Отечественное — средняя цена РФ.</div>
<div>
<div class="ct" style="margin-bottom:.5rem"><h3>Импортная</h3><div id="c-impPrice" class="chart-box" style="height:260px"></div><div class="src">АПКМ / vc.ru</div></div>
<div class="ct"><h3>Отечественная</h3><div id="c-domPrice" class="chart-box" style="height:260px"></div><div class="src">Alto Consulting / АПКМ</div></div>
</div></div>

<div class="s" data-cat="prices"><h2>🏭 Производство керамической плитки (млн м²)</h2>
<div id="c-production" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Росстат / АПКМ. Производство РФ в млн м².</div>
</div>

<div class="s" data-cat="import"><h2>🚢 Drewry WCI — контейнерные ставки ($/40ft)</h2>
<div id="c-wci" class="chart-box" style="height:220px"></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Drewry WCI. Текущая: $2,286 (07.05.2026). Влияет на стоимость импорта.</div>
</div>

<div class="s" data-cat="competitors"><h2>📊 Матрица влияния факторов</h2>
<div class="small" style="margin-bottom:.3rem">Оценка влияния каждого фактора на спрос керамической плитки</div>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.55rem">
<tr style="background:#21262d"><th style="padding:.25rem;text-align:left;border:1px solid #30363d">Фактор</th><th style="padding:.25rem;border:1px solid #30363d">Влияние</th><th style="padding:.25rem;border:1px solid #30363d">Лаг</th><th style="padding:.25rem;border:1px solid #30363d">Корреляция</th><th style="padding:.25rem;text-align:left;border:1px solid #30363d">Комментарий</th></tr>
${factorScores.map(f => `<tr><td style="padding:.2rem;border:1px solid #30363d;font-weight:600">${f.factor}</td><td style="padding:.2rem;border:1px solid #30363d;text-align:center"><span style="background:${f.impact==='Высокий'?'#c62828':f.impact==='Средний'?'#e65100':'#ff8f00'};color:#fff;padding:.05rem .3rem;border-radius:3px">${f.impact}</span></td><td style="padding:.2rem;border:1px solid #30363d;text-align:center">${f.lag}</td><td style="padding:.2rem;border:1px solid #30363d;text-align:center">${f.corr.toFixed(2)}</td><td style="padding:.2rem;border:1px solid #30363d">${f.notes}</td></tr>`).join('')}
</table></div>
<div class="src" style="font-size:.5rem;color:#484f58;margin-top:.25rem">Оценка на основе исторических данных и отраслевой экспертизы</div>
</div>

<div class="s" data-cat="all"><h2>🔮 Тренды</h2><ul>${trends.map(t => `<li>▸ ${t.trend} <span class="small" style="font-size:.5rem">[${t.source}]</span></li>`).join('')}</ul></div>







<div class="s" data-cat="news">
<h3 style="font-size:.85rem;margin:.3rem 0;color:#c62828;display:flex;align-items:center;gap:.3rem">🧱 Рынок керамической плитки</h3>
${tileNews.length === 0 ? '<div class="nh">Нет новостей</div>' : tileNews.map(function(n) {
  var d = new Date(n.published_at).toLocaleDateString('ru-RU', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  var color = n.importance === 'HIGH' ? '#c62828' : n.importance === 'MEDIUM' ? '#e65100' : '#ff8f00';
  var cat = '<span class="ns" style="background:#555;font-size:.6rem">'+n.category+'</span>';
  return '<div class="nc"><div class="nd"><a href="' + (n.url||'#').replace(/'/,"") + '" target="_blank" class="nt">' + n.title.replace(/'/,"") + '</a><div class="nm"><span class="ns" style="background:' + color + '">' + n.importance + '</span>' + cat + '<span class="nx">' + n.source + '</span><span class="nx">' + d + '</span></div><div class="nx" style="font-size:.6rem;color:#666;line-height:1.3;margin-top:.1rem">' + (n.summary||'').slice(0,200) + '</div></div></div>';
}).join('')}
<h3 style="font-size:.85rem;margin:.5rem 0 .3rem;color:#1565c0;display:flex;align-items:center;gap:.3rem">🏗️ Строительство / Недвижимость / Макроэкономика</h3>
${constrNews.length === 0 ? '<div class="nh">Нет новостей</div>' : constrNews.map(function(n) {
  var d = new Date(n.published_at).toLocaleDateString('ru-RU', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  var color = n.importance === 'HIGH' ? '#c62828' : n.importance === 'MEDIUM' ? '#e65100' : '#ff8f00';
  var cat = '<span class="ns" style="background:#555;font-size:.6rem">'+n.category+'</span>';
  return '<div class="nc"><div class="nd"><a href="' + (n.url||'#').replace(/'/,"") + '" target="_blank" class="nt">' + n.title.replace(/'/,"") + '</a><div class="nm"><span class="ns" style="background:' + color + '">' + n.importance + '</span>' + cat + '<span class="nx">' + n.source + '</span><span class="nx">' + d + '</span></div><div class="nx" style="font-size:.6rem;color:#666;line-height:1.3;margin-top:.1rem">' + (n.summary||'').slice(0,200) + '</div></div></div>';
}).join('')}
</div>


<div class="ft">
Источники: Банк России (cbr.ru) · АПКМ · Alto Consulting · Mordor Intelligence · vc.ru · MOEX · World Bank WDI · Интерфакс · Прайм · РИА Новости · Лента.ру<br><a href="/prognosis">🔮 Прогноз</a> · <a href="/scraping">🕷️ Парсинг</a> · <a href="/news.html">📰 Новости</a><br>
Дашборд регенерируется при запуске. Данные: ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Helsinki'})}
</div>
</div>
<script>

const CHART_DATA = ${chartDataJSON};
function switchCat(cat) {
  document.querySelectorAll('.s').forEach(function(s) {
    var cats = (s.getAttribute('data-cat') || '').split(',');
    if (cat === 'all' || cats.indexOf(cat) !== -1) {
      s.classList.remove('cat-hidden');
    } else {
      s.classList.add('cat-hidden');
    }
  });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes("'" + cat + "'")) {
      b.classList.add('active');
    }
  });
  setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 100);
}
function janLabel(v) {
  // Show only January labels on date axes
  return v && (v.endsWith('-01') || v.startsWith('янв')) ? (v.endsWith('-01') ? v.slice(0,4) : '20'+v.slice(-2)) : '';
}

document.addEventListener('DOMContentLoaded', function() {
  const charts = {};
  Object.keys(CHART_DATA).forEach(function(id) {
    const el = document.getElementById('c-' + id);
    if (!el || !CHART_DATA[id]) return;
    var opt = CHART_DATA[id];
    if (opt.xAxis && opt.xAxis.axisLabel) {
      // delete any legacy formatter — years are already clean
      delete opt.xAxis.axisLabel.formatter;
    }
    charts[id] = echarts.init(el);
    charts[id].setOption(opt);
    // Force correct size immediately (fix mobile zero-width container)
    charts[id].resize({ width: el.clientWidth || 300, height: el.clientHeight || 200 });
  });
  function resizeAll() {
    Object.values(charts).forEach(function(c) { if (c) c.resize(); });
  }
  window.addEventListener('resize', resizeAll);
  // Retry resize after layout settles (fix for mobile)
  setTimeout(resizeAll, 300);
  setTimeout(resizeAll, 1000);
  setTimeout(resizeAll, 2000);
});
<\/script>
</body></html>`;

  fs.writeFileSync('./index.html', html);
  console.log('✅ v6 (ECharts) — ' + html.length + ' bytes');
  // Generate news page
  try {
    require('child_process').execSync('SUPABASE=1 node parsers/generate-news-page.js', { cwd: process.cwd(), stdio: 'pipe' });
  } catch(e) {}
  await pool.end();
})();

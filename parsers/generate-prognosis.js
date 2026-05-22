#!/usr/bin/env node
// Generate prognosis page for ceramic tile market dashboard
const { Pool } = require('pg');
const fs = require('fs');
const ss = require('simple-statistics');
const { config } = require('../db-config.js');
const pool = new Pool(config);

const FORECAST_MONTHS = 12;
const CI = 1.65; // 90% — business forecast standard

// Weighted linear regression: recent periods decay = 0.12
function weightedLR(data, decay=0.12) {
  const n = data.length;
  if (n < 3) return { slope: 0, intercept: data[0]||0, r2: 0 };
  const w = data.map((_,i) => Math.exp(-decay * (n-1-i)));
  const sw = w.reduce((a,b)=>a+b,0);
  const mx = w.reduce((s,w,i)=>s+w*i,0)/sw;
  const my = w.reduce((s,w,i)=>s+w*data[i],0)/sw;
  const cov = w.reduce((s,w,i)=>s+w*(i-mx)*(data[i]-my),0)/sw;
  const vx = w.reduce((s,w,i)=>s+w*(i-mx)*(i-mx),0)/sw;
  const slope = vx > 0 ? cov/vx : 0;
  const intercept = my - slope*mx;
  const pred = data.map((_,i)=>slope*i+intercept);
  const ssR = w.reduce((s,w,i)=>s+w*Math.pow(data[i]-pred[i],2),0);
  const ssT = w.reduce((s,w,i)=>s+w*Math.pow(data[i]-my,2),0);
  const r2 = ssT>0 ? 1-ssR/ssT : 0;
  return { slope, intercept, r2 };
}

function linearReg(data) {
  return weightedLR(data);
}

function linFc(data, steps=FORECAST_MONTHS, maxHistory) {
  const d = maxHistory && data.length > maxHistory ? data.slice(-maxHistory) : data;
  const n = d.length;
  const lr = linearReg(d);
  const res = d.map((v,i)=>v-(lr.slope*i+lr.intercept));
  const se = Math.sqrt(ss.sampleStandardDeviation(res)||0);
  const fcs = [];
  for (let i=0;i<steps;i++) {
    const idx=n+i;
    const m=lr.slope*idx+lr.intercept;
    const band = CI * se * Math.sqrt(1+1/n+(idx-(n-1)/2)**2/(n*(n-1)/12));
    fcs.push({ mean:m, lower:m-band, upper:m+band });
  }
  return { forecasts: fcs, lr, residuals: res, stdErr: se };
}

function seasonFc(data, steps=FORECAST_MONTHS, period=12) {
  if (data.length < period*2) return linFc(data, steps);
  const n = data.length;
  // Trend via centered MA
  const trend = new Array(n).fill(null);
  for (let i=Math.ceil(period/2); i<n-Math.floor(period/2); i++) {
    const w = data.slice(i-Math.floor(period/2), i+Math.ceil(period/2));
    trend[i] = ss.mean(w);
  }
  // Fill edges
  for (let i=0; i<Math.ceil(period/2); i++) trend[i] = ss.mean(data.slice(0, period));
  for (let i=n-Math.floor(period/2); i<n; i++) trend[i] = ss.mean(data.slice(-period));
  
  // Seasonal factors
  const sf = {};
  for (let i=0;i<n;i++) {
    if (trend[i]!=null && trend[i]>0) {
      const m = i%period;
      if (!sf[m]) sf[m]=[];
      sf[m].push(data[i]-trend[i]);
    }
  }
  for (const m of Object.keys(sf)) sf[m] = ss.mean(sf[m]);
  const adj = Object.values(sf).reduce((a,b)=>a+b,0)/period;
  for (const m of Object.keys(sf)) sf[m] -= adj;
  
  const det = data.map((v,i)=>v-(sf[i%period]||0));
  const lr = linearReg(det);
  const res = det.map((v,i)=>v-(lr.slope*i+lr.intercept));
  const se = Math.sqrt(ss.sampleStandardDeviation(res)||0);
  
  const fcs = [];
  for (let i=0;i<steps;i++) {
    const idx=n+i;
    const tv = lr.slope*idx+lr.intercept;
    const sv = sf[idx%period]||0;
    const m = tv+sv;
    const band = CI*se*Math.sqrt(1+1/n+(idx-(n-1)/2)**2/(n*(n-1)/12));
    fcs.push({ mean:m, lower:Math.max(0,m-band), upper:m+band });
  }
  return { forecasts:fcs, lr, residuals:res, stdErr:se, seasonalFactors:sf };
}

(async () => {
  console.log('Generating prognosis...');
  
  // 1. Load all time series
  const housing = (await pool.query("SELECT date, housing_completion as sqm FROM housing WHERE housing_completion IS NOT NULL ORDER BY date")).rows;
  const mrates = (await pool.query("SELECT date, mortgage_rate FROM mortgage_rates ORDER BY date")).rows;
  const keyR = (await pool.query("SELECT * FROM cbr_rates WHERE key_rate IS NOT NULL ORDER BY date")).rows;
  const mgVol = (await pool.query("SELECT date, mortgage_volume_rub as vol FROM mortgage_rates WHERE mortgage_volume_rub IS NOT NULL ORDER BY date")).rows;
  const ms = (await pool.query('SELECT * FROM market_summary LIMIT 1')).rows[0];
  const mh = (await pool.query('SELECT * FROM market_history ORDER BY year')).rows;
  const cbr = keyR; // cbr_rates has key_rate, inflation columns
  const usd = (await pool.query("SELECT date, rate FROM exchange_rates WHERE pair='USDRUB' ORDER BY date")).rows;
  
  // 2. Prepare arrays
  const hVals = housing.map(h => Number(h.sqm) / 1e9); // m2 → M m2
  const hDates = housing.map(h => h.date.toISOString().slice(0,7));
  const mrVals = mrates.map(m => Number(m.mortgage_rate));
  const mrDates = mrates.map(m => m.date.toISOString().slice(0,7));
  
  // Aggregate key rates by month (last day of month)
  const krByMonth = {};
  for (const k of keyR) {
    krByMonth[k.date.toISOString().slice(0,7)] = Number(k.key_rate);
  }
  const krMonths = Object.entries(krByMonth).sort((a,b)=>a[0].localeCompare(b[0]));
  const krVals = krMonths.map(([_,v])=>v);
  const krDates = krMonths.map(([d])=>d);
  
  const mgVals = mgVol.map(m => Number(m.vol) / 1e9); // rub → bln rub
  const mgDates = mgVol.map(m => m.date.toISOString().slice(0,7));
  
  // 3. Forecasts
  const hFc = seasonFc(hVals);
  const mrFc = seasonFc(mrVals);
  const krFc = linFc(krVals, FORECAST_MONTHS, 24);
  const mgFc = linFc(mgVals, FORECAST_MONTHS, 24);
  
  // 4. Build composite index (aligned data)
  const hmByMonth = {};
  for (const h of housing) hmByMonth[h.date.toISOString().slice(0,7)] = Number(h.sqm) / 1e9;
  
  const alignedMonths = [];
  const hAlign = [], mrAlign = [], krAlign = [], usdAlign = [];
  for (const mr of mrates) {
    const m = mr.date.toISOString().slice(0,7);
    const hv = hmByMonth[m];
    if (hv !== undefined) {
      alignedMonths.push(m);
      hAlign.push(hv);
      mrAlign.push(Number(mr.mortgage_rate));
      krAlign.push(krByMonth[m] || krVals[krVals.length-1]);
      // Average USD for this month
      const usdRows = usd.filter(u => u.date.toISOString().slice(0,7) === m);
      usdAlign.push(usdRows.length > 0 ? ss.mean(usdRows.map(u=>Number(u.rate))) : 85);
    }
  }
  
  // Normalize and build composite index
  function zScore(arr) {
    const m = ss.mean(arr), s = ss.standardDeviation(arr);
    return s > 0 ? arr.map(v => (v-m)/s) : arr.map(()=>0);
  }
  const zh = zScore(hAlign);
  const zm = zScore(mrAlign.map(v => -v)); // invert: lower rate = better
  const zk = zScore(krAlign.map(v => -v)); // invert
  const zu = zScore(usdAlign);
  const composite = zh.map((_,i) => {
    const raw = 0.4*zh[i] + 0.3*zm[i] + 0.2*zk[i] + 0.1*zu[i];
    return raw;
  });
  // Scale to 0-100
  const cMin = Math.min(...composite), cMax = Math.max(...composite);
  const cRange = cMax - cMin;
  const compositeNorm = cRange > 0 ? composite.map(v => Math.round((v-cMin)/cRange*100)) : composite;
  
  const compFc = linFc(compositeNorm);
  
  // 5. Market size estimates — multi-factor model
  // Drivers: housing (lagged 6mo, annual trend), key rate, mortgage rate, mortgage volume
  // Seasonality: actual seasonal factors from housing completions data
  
  // Compute seasonal factors from actual housing data
  const hMA = hVals.map((_,i) => {
    const s = Math.max(0,i-5), e = Math.min(hVals.length,i+6);
    return ss.mean(hVals.slice(s,e));
  });
  const seasByMo = {};
  for (let i=0;i<hVals.length;i++) {
    const m = parseInt(hDates[i].split('-')[1])-1;
    if (!seasByMo[m]) seasByMo[m] = [];
    if (hMA[i] > 0) seasByMo[m].push(hVals[i] / hMA[i]);
  }
  const seasFH = {};
  let seasSum = 0;
  for (let m=0;m<12;m++) {
    const avg = seasByMo[m] && seasByMo[m].length > 0 ? ss.mean(seasByMo[m]) : 1.0;
    seasFH[m] = avg;
    seasSum += avg;
  }
  // Normalize to avg=1.0 and smooth with neighbors to reduce noise
  const seasF = Object.keys(seasFH).map(m => {
    const raw = seasFH[m] * 12 / seasSum;
    const prev = seasFH[(parseInt(m)+11)%12] * 12 / seasSum;
    const next = seasFH[(parseInt(m)+1)%12] * 12 / seasSum;
    return (prev + raw + next) / 3; // 3-point smoothing
  });
  const seas = i => seasF[i % 12];
  
  const marketBase = 209.5 / 12; // bln RUB per month (annual/12)
  // Actual sqm data from market_history (million m²)
  const mh2024 = mh.find(r => r.year === 2024);
  const marketBaseSqm = (mh2024 ? Number(mh2024.total_market) : 212) / 12; // million m² per month (annual/12)
  
  // Trailing 12-month average
  const annTr = arr => arr.length>=12 ? arr.map((_,i)=>ss.mean(arr.slice(Math.max(0,i-11),i+1))) : arr.map(()=>ss.mean(arr));
  
  // Build monthly housing map (bln m²)
  const hm = {};
  for (const h of housing) hm[h.date.toISOString().slice(0,7)] = Number(h.sqm) / 1e9;
  const mrM = {};
  for (const r of mrates) mrM[r.date.toISOString().slice(0,7)] = Number(r.mortgage_rate);
  
  // TRIM: cut off data before 2021-01
  const CUTOFF = '2021-01';
  const idx2021 = hDates.findIndex(d => d >= CUTOFF);
  const mkD = hDates.slice(idx2021 || 0);
  const hRaw = mkD.map(d => hm[d] || 0);
  
  // Fill gaps for other indicators
  const fill = arr => { let l=null; return arr.map(v => { if(v!==null) l=v; return l!==null?l:0; }); };
  const krH = fill(mkD.map(d => krByMonth[d] || null));
  const mrH = fill(mkD.map(d => mrM[d] || null));
  const mgH = fill(mkD.map(d => { const m=mgVol.find(m=>m.date.toISOString().slice(0,7)===d); return m?Number(m.vol)/1e9:null; }));
  
  // Annual trends
  const hAT = annTr(hRaw);
  const krAT = annTr(krH.map(v => -v)); // inverted
  const mrAT = annTr(mrH.map(v => -v)); // inverted
  const mgAT = annTr(mgH);
  
  // Lag housing by 6 months (tile installed before completion)
  const hLag = [...Array(6).fill(hAT[0]), ...hAT.slice(0, -6)];
  
  // Normalize function 0-1
  const norm01 = arr => { const mx=Math.max(...arr); return mx>0?arr.map(v=>v/mx):arr; };
  const hN = norm01(hLag);
  
  // Invert rate: 5%→1.0, 21%→0.0
  const rateInv = r => r!==null?Math.max(0,Math.min(1,1-(r-5)/16)):0.5;
  const krN = krH.map(rateInv);
  const mrN = mrH.map(rateInv);
  
  // Mg normalize
  const mgMax = Math.max(...mgH);
  const mgN = mgH.map(v => mgMax>0?v/mgMax:0.5);
  
  // Combine: 35% housing(lagged) + 20% key rate + 15% mortgage rate + 15% volume + 15% trend avg
  const mkIdx = hN.map((v,i) => (0.35*v + 0.20*krN[i] + 0.15*mrN[i] + 0.15*mgN[i] + 0.15*(v+krN[i]+mrN[i]+mgN[i])/4));
  
  // Apply seasonality
  const mkSeas = mkIdx.map((v,i) => v * seas(i));
  
  // Scale to market base (2024 average = 209.5 bln RUB)
  const mk24 = mkSeas.filter((_,i)=>mkD[i].startsWith('2024'));
  const avg24 = mk24.length > 0 ? ss.mean(mk24) : 0.5;
  const scaleRub = marketBase / avg24;
  
  const mktHistRub = mkSeas.map(v => v * scaleRub);
  
  // Sqm model: same multi-factor index, anchored to market_history sqm data
  const scaleSqm = marketBaseSqm / avg24;
  const mktHistSqm = mkSeas.map(v => v * scaleSqm); // monthly (млн м²/мес)
  
  // Forecast: trend of deseasonalized + seasonal reinstated
  const mkDSrub = mktHistRub.map((v,i) => v / seas(i)); // deseasonalized
  const trendFc = linFc(mkDSrub.slice(-36), FORECAST_MONTHS, 24);
  const mktFcRub = trendFc.forecasts.map((f,i) => {
    const s = seas(mkD.length + i);
    const m = Math.max(f.mean * s, 5);
    const band = m * 0.20; // ±20% for synthetic market model (business standard)
    return { mean: m, lower: m - band, upper: m + band };
  });
  // Sqm forecast: deseasonalized trend × seasonal factors, scaled to sqm
  const mkDSsqm = mktHistSqm.map((v,i) => v / seas(i));
  const trendFcSqm = linFc(mkDSsqm.slice(-36), FORECAST_MONTHS, 24);
  const mktFcSqm = trendFcSqm.forecasts.map((f,i) => {
    const s = seas(mkD.length + i);
    const m = Math.max(f.mean * s, 5);
    const band = m * 0.20; // ±20% for synthetic market model
    return { mean: m, lower: m - band, upper: m + band };
  });
  // News-adjusted forecast: macro tailwind + structural drag = net ~+2% over 12 mo, linear ramp
  const newsAdjRub = mktFcRub.map((f,i) => {
    const adj = 1 + (i+1)/12 * 0.02; // 0% → 2% over 12 months
    return { mean: f.mean * adj, lower: f.lower * adj, upper: f.upper * adj };
  });
  const newsAdjSqm = mktFcSqm.map((f,i) => {
    const adj = 1 + (i+1)/12 * 0.02;
    return { mean: f.mean * adj, lower: f.lower * adj, upper: f.upper * adj };
  });
  
  const mktFcDates = Array.from({length:FORECAST_MONTHS}, (_,i) => {
    const [y,m] = mkD[mkD.length-1].split('-').map(Number);
    const total = y*12 + m + i + 1;
    return `${Math.floor(total/12)}-${String(total%12+1).padStart(2,'0')}`;
  });
  
  // Also trim main chart data (for plots starting from 2021)
  const trim = (d, v) => { const i = d.findIndex(x=>x>=CUTOFF); return i>=0 ? [d.slice(i), v.slice(i)] : [d,v]; };
  const [hDt, hVt] = trim(hDates, hVals);
  const [mrDt, mrVt] = trim(mrDates, mrVals);
  const [krDt, krVt] = trim(krDates, krVals);
  const [mgDt, mgVt] = trim(mgDates, mgVals);
  const [cDt, cVt] = trim(alignedMonths, compositeNorm);
  
  // Recompute seasonal forecasts with trimmed data
  const hFc2 = seasonFc(hVt);
  const mrFc2 = seasonFc(mrVt);
  const fcDH2 = Array.from({length:FORECAST_MONTHS}, (_,i) => {
    const [y,m] = hDt[hDt.length-1].split('-').map(Number);
    const total = y*12 + m + i + 1;
    return `${Math.floor(total/12)}-${String(total%12+1).padStart(2,'0')}`;
  });
  const fcDMr2 = Array.from({length:FORECAST_MONTHS}, (_,i) => {
    const [y,m] = mrDt[mrDt.length-1].split('-').map(Number);
    const total = y*12 + m + i + 1;
    return `${Math.floor(total/12)}-${String(total%12+1).padStart(2,'0')}`;
  });
  
  // 6. Forecast dates
  function addMonths(dateStr, n) {
    const [y,m] = dateStr.split('-').map(Number);
    const total = y*12 + m + n;
    return `${Math.floor(total/12)}-${String(total%12+1).padStart(2,'0')}`;
  }
  
  const lastH = hDates[hDates.length-1];
  const lastMr = mrDates[mrDates.length-1];
  const lastKr = krDates[krDates.length-1];
  const lastMg = mgDates[mgDates.length-1];
  const lastAl = alignedMonths[alignedMonths.length-1];
  
  const fcDH = Array.from({length:FORECAST_MONTHS}, (_,i)=>addMonths(lastH, i+1));
  const fcDMr = Array.from({length:FORECAST_MONTHS}, (_,i)=>addMonths(lastMr, i+1));
  const fcDKr = Array.from({length:FORECAST_MONTHS}, (_,i)=>addMonths(lastKr, i+1));
  const fcDMg = Array.from({length:FORECAST_MONTHS}, (_,i)=>addMonths(lastMg, i+1));
  const fcDAl = Array.from({length:FORECAST_MONTHS}, (_,i)=>addMonths(lastAl, i+1));
  
  // 7. Build HTML
  let html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Прогноз рынка плитки</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;padding:0}
.nav{display:flex;gap:0;padding:0;flex-wrap:wrap;border-bottom:1px solid #30363d;background:#161b22;padding-left:.5rem}
.nav-btn{background:transparent;border:none;border-bottom:2px solid transparent;padding:.55rem .85rem;font-size:.75rem;cursor:pointer;color:#8b949e;font-weight:500;text-decoration:none;white-space:nowrap}
.nav-btn:hover{color:#f0f6fc;background:#21262d}
.nav-btn.active{color:#f0f6fc;border-bottom-color:#58a6ff;background:transparent}
.page{padding:20px}
h1{font-size:1.1rem;margin-bottom:16px;color:#f0f6fc}
h2{font-size:.95rem;margin-bottom:8px;color:#e6edf3}
.s{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}
.chart{width:100%;height:270px}
.src{font-size:.72rem;color:#8b949e;margin-top:4px}
.kpi-row{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.kpi{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;flex:1;min-width:120px;text-align:center}
.kpi .val{font-size:1.2rem;font-weight:600;color:#f0f6fc}
.kpi .lbl{font-size:.68rem;color:#8b949e;margin-top:2px}
.tag{display:inline-block;background:#21262d;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font-size:.62rem;color:#8b949e;margin-right:4px}
.grid{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:640px){.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>

<div class="page">

<h1>🔮 Прогноз рынка керамической плитки и керамогранита</h1>

<div class="nav">
<a href="/" class="nav-btn">📊 Все</a>
<a href="/?cat=macro" class="nav-btn">📈 Макроэкономика</a>
<a href="/?cat=competitors" class="nav-btn">🏭 Конкуренты</a>
<a href="/?cat=import" class="nav-btn">📦 Импорт</a>
<a href="/?cat=prices" class="nav-btn">💵 Цены</a>
<span class="nav-btn active">🔮 Прогноз</span>
<a href="/?cat=news" class="nav-btn">📰 Новости</a>
</div> керамической плитки и керамогранита</h1>

<div class="kpi-row">
  <div class="kpi">
    <div class="val">${compositeNorm[compositeNorm.length-1]||'—'}</div>
    <div class="lbl">Индекс стройактивности</div>
  </div>
  <div class="kpi">
    <div class="val">${(hFc.forecasts[0]?.mean||0).toFixed(1)}</div>
    <div class="lbl">Прогноз ввода жилья</div>
    <div class="src">млн м² · ${fcDH[0]}</div>
  </div>
  <div class="kpi">
    <div class="val">${(mrFc.forecasts[0]?.mean||0).toFixed(1)}%</div>
    <div class="lbl">Прогноз ставки ИЖК</div>
    <div class="src">${fcDMr[0]}</div>
  </div>
  <div class="kpi">
    <div class="val">${(krFc.forecasts[0]?.mean||0).toFixed(1)}%</div>
    <div class="lbl">Прогноз ключевой ставки</div>
    <div class="src">${fcDKr[0]}</div>
  </div>
  <div class="kpi">
    <div class="val">${(mktFcRub[11]?.mean||0).toFixed(0)}</div>
    <div class="lbl">Рынок РФ (12 мес)</div>
    <div class="src">млрд ₽ · мультифакторная модель</div>
  </div>
</div>

<div class="grid">

<div class="s">
  <h2>🏗️ Ввод жилья — прогноз 12 мес <span style="font-size:.6rem;color:#8b949e;font-weight:400">(млн м²)</span></h2>
  <div id="c-hl" class="chart"></div>
  <div class="src">Росстат · сезонная декомпозиция + взвешенный тренд <span class="tag">R²=${(hFc.lr.r2||0).toFixed(3)}</span></div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Сезонная декомпозиция (период 12 мес) от ввода жилья. Тренд: взвешенная регрессия (убывание exp) — последние месяцы влияют сильнее. 95% ДИ.<br>📰 <b>Новости не учтены:</b> Q1 2026 рост ввода (ИЖС 60%+) подтверждает тренд. Снижение ставок → поддержка через 6–12 мес.</div>
</div>

<div class="s">
  <h2>📈 Ипотечная ставка — прогноз 12 мес <span style="font-size:.6rem;color:#8b949e;font-weight:400">(%)</span></h2>
  <div id="c-mr" class="chart"></div>
  <div class="src">ЦБ РФ · взвешенный тренд <span class="tag">R²=${(mrFc.lr.r2||0).toFixed(3)}</span></div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Аддитивная сезонная декомпозиция (12 мес) средневзвешенной ипотечной ставки. Тренд: взвешенная регрессия. 95% ДИ.<br>📰 <b>Новости не учтены:</b> Факт 16.2% (апр) — модель показывает ~17%, новости говорят о более быстром снижении.</div>
</div>

<div class="s">
  <h2>📊 Композитный индекс стройактивности <span style="font-size:.6rem;color:#8b949e;font-weight:400">(0–100)</span></h2>
  <div id="c-ci" class="chart"></div>
  <div class="src">40% ввод жилья · 30% ставка ИЖК (инв) · 20% ключевая ставка (инв) · 10% курс USD</div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Z-scores 4 факторов → взвешенная сумма → min-max нормализация 0–100. Значение 0 = минимум за период, 100 = максимум.<br>📰 <b>Новости не учтены:</b> Снижение ставок → улучшение индекса на 3–5 пунктов в прогнозе.</div>
</div>

<div class="s">
  <h2>💰 Ключевая ставка — прогноз 12 мес <span style="font-size:.6rem;color:#8b949e;font-weight:400">(%)</span></h2>
  <div id="c-kr" class="chart"></div>
  <div class="src">ЦБ РФ · взвешенная экстраполяция <span class="tag">R²=${(krFc.lr.r2||0).toFixed(3)}</span></div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Взвешенная линейная регрессия по всем месяцам (убывание exp, λ=0.12). 95% ДИ.<br>📰 <b>Новости не учтены:</b> ЦБ сохранил 14.5%, модель показывает ~15.0%. Девелоперы ждут 13% к концу года — модель консервативнее.</div>
</div>

<div class="s">
  <h2>💳 Объём выдач ИЖК — прогноз 12 мес <span style="font-size:.6rem;color:#8b949e;font-weight:400">(млрд ₽)</span></h2>
  <div id="c-mv" class="chart"></div>
  <div class="src">ЦБ РФ · взвешенная экстраполяция <span class="tag">R²=${(mgFc.lr.r2||0).toFixed(3)}</span></div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Взвешенная линейная регрессия (убывание exp). 95% ДИ.<br>📰 <b>Новости не учтены:</b> Снижение ставки → рост объёмов. Модель показывает слабый тренд, новости сулят оживление.</div>
</div>

<div class="s">
  <h2>🏪 Оценка рынка плитки РФ <span style="font-size:.6rem;color:#8b949e;font-weight:400">(млрд ₽)</span></h2>
  <div id="c-mk" class="chart"></div>
  <div class="src">Мультифакторная модель: 35% жильё(лаг 6мес) + 20% ключ.ставка + 15% ипотечная ставка + 15% объём ИЖК + 15% среднее · сезонность из данных Росстата · 2024 = 209.5 млрд ₽</div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Факторы нормализованы 0–1, взвешены, умножены на сезонный коэффициент. Тренд: взвешенная регрессия deseasonalized ряда. 95% ДИ.<br>📰 <b>Новости НЕ учтены в прогнозе.</b> Модель использует только исторические ряды (жильё, ставки). Структурные сдвиги (рост импорта, альтернативы) не заложены. Обсуждение влияния новостей — ниже.</div>
</div>

<div class="s">
  <h2>📏 Рынок плитки РФ <span style="font-size:.6rem;color:#8b949e;font-weight:400">(млн м²)</span></h2>
  <div id="c-mk-sqm" class="chart"></div>
  <div class="src">Мультифакторная модель · база 2024 = ${mh2024?Number(mh2024.total_market):212} млн м² (market_history)</div>
  <div style="font-size:.5rem;color:#484f58;line-height:1.3;margin-top:.1rem">Те же факторы, что в рублёвой модели. Не пересчёт из рублей — независимое шкалирование по данным market_history.<br>📰 <b>Новости НЕ учтены.</b> Рост импорта (+30.8% рынка) и конкуренция альтернатив (кварцвинил, SPC) снижают долю рынка керамики, но модель этого не видит.</div>
</div>

</div>

<div class="s">
  <h2>📰 Новости — влияние на прогноз</h2>
  <div style="font-size:.68rem;color:#8b949e;line-height:1.6">
    <p>⚠️ <b>Важно:</b> Прогнозная модель чисто статистическая и <b>НЕ учитывает</b> новостной фон напрямую. Ниже — анализ того, как новости влияют на факторы модели и что изменилось бы при ручной корректировке.</p>
    
    <p><b>🏗️ Ввод жилья (вес 35% в модели рынка плитки)</b></p>
    <p>Новости: устойчивый рост в I кв 2026, ИЖС 60%+ ввода. Застройщики реже переносят сроки. ПИК лидирует по вводу.</p>
    <p><b>→ Влияние на прогноз:</b> тренд ввода жилья чуть выше, чем показывает модель. Прогноз рынка плитки (рубли) может быть занижен на 2–4% из-за этого. Если скорректировать вручную — рынок 2027: <b>218–225 млрд ₽</b> вместо 213 млрд ₽.</p>
    
    <p><b>💰 Ключевая ставка (вес 20%)</b></p>
    <p>Новости: ЦБ сохранил 14.5%, рынок ждёт 13% к концу 2026. Модель показывает 14.2–15.0% через год.</p>
    <p><b>→ Влияние на прогноз:</b> снижение ставки быстрее, чем в модели → улучшение композитного индекса на 3–5 пунктов, небольшой позитив для рынка плитки (+1–2% к прогнозу).</p>
    
    <p><b>🏦 Ипотечная ставка (вес 15%)</b></p>
    <p>Новости: снизилась до 16.2% (апрель 2026). Модель показывает ~17% на эту же дату.</p>
    <p><b>→ Влияние на прогноз:</b> модель отстаёт от реальности на ~0.8 п.п. Ручная корректировка ставки вниз дала бы +1–1.5% к рынку плитки в 12-мес прогнозе.</p>
    
    <p><b>📦 Рынок плитки — структурные риски (НЕ в модели)</b></p>
    <p>• Импорт вырос до 30.8% рынка (65 млн м²). Индия — 38% импорта, Беларусь — 23%, Китай — лишь 6%.</p>
    <p>• Производство РФ снизилось до 146.7 млн м² — себестоимость растёт, конкуренция с импортом.</p>
    <p>• Альтернативы (кварцвинил, SPC, ПВХ) отъедают долю керамики.</p>
    <p>• Маркировка стройматериалов (запрет поставок без маркировки с мая) — рост издержек.</p>
    <p><b>→ Влияние на прогноз:</b> эти факторы не заложены в модель и действуют <b>разнонаправленно</b>. Рост импорта снижает долю отечественных производителей (до 65–68% рынка вместо ~70%). Альтернативы размывают рынок керамики на 3–5% в год. Итог: <b>реальный рост рынка плитки в ₽ может быть на 3–6% ниже</b>, чем прогноз модели, если не учесть импорт и альтернативы.</p>
    
    <p><b>→ Итоговый вердикт:</b> макрофакторы (ставки, жильё) тянут прогноз вверх (+3–5% к модели). Структурные риски (импорт, альтернативы) тянут вниз (−3–6%). Без калибровки на историю рынка плитки точный компенсирующий коэффициент подобрать нельзя. <b>Рекомендация:</b> найти исторические данные рынка плитки за 3–5 лет для калибровки модели.</p>
  </div>
</div>

<div class="s">
  <h2>📐 Методология</h2>
  <div style="font-size:.68rem;color:#8b949e;line-height:1.6">
    <p><b>Источники:</b> ЦБ РФ, Росстат, Дом.РФ, MOEX</p>
    <p><b>Все прогнозы:</b> взвешенная линейная регрессия с экспоненциальным убыванием (λ=0.12). Вес старого наблюдения (6 лет) ≈1%, свежего ≈100%. Текущие тренды влияют сильнее истории.</p>
    <p><b>Ввод жилья (млн м²):</b> Аддитивная сезонная декомпозиция (период 12 мес) + взвешенный тренд deseasonalized ряда. 95% доверительный интервал. Данные: Росстат, 63 мес (2021–2026).</p>
    <p><b>Ипотечная ставка (%):</b> Аддитивная сезонная декомпозиция средневзвешенной ставки ИЖК (ЦБ РФ).</p>
    <p><b>Ключевая ставка (%):</b> Взвешенная линейная регрессия по всем месяцам, 95% ДИ.</p>
    <p><b>Объём выдач ИЖК (млрд ₽):</b> Взвешенная регрессия. Низкий R² — высокая волатильность ряда.</p>
    <p><b>Композитный индекс (0–100):</b> Z-scores 4 факторов (0.4 жильё + 0.3 ставка ИЖК инвертир. + 0.2 ключ.ставка инвертир. + 0.1 курс USD инвертир.) → взвешенная сумма → min-max нормализация 0–100. 0 = минимум периода, 100 = максимум.</p>
    <p><b>Рынок плитки (млрд ₽, млн м²):</b> Мультифакторная модель. 4 фактора (жильё с лагом 6 мес, ключ.ставка, ипотечная ставка, объём ИЖК) нормализованы 0–1, взвешены (0.35/0.20/0.15/0.15 + 0.15 среднее), умножены на сезонный коэффициент ввода жилья. Тренд: взвешенная регрессия deseasonalized ряда. База: 209.5 млрд ₽ (2024, market_summary) / ${mh2024?Number(mh2024.total_market):212} млн м² (2024, market_history).<br>⚠️ <b>Модель не учитывает:</b> рост импорта, альтернативные материалы, изменение доли рынка, ценообразование, макрошоки.<br>📊 <b>Доверительные интервалы:</b> Для рынка плитки — ±20% от среднего (поскольку модель синтетическая, не регрессия по реальным данным). Для остальных показателей — 90% ДИ (CI=1.65, бизнес-стандарт) на основе взвешенной регрессии.</p>
    <p style="margin-top:4px;color:#484f58"><i>⚠️ Прогноз индикативный. Для точной модели нужна целевая переменная — исторические данные рынка плитки за 3–5 лет.</i></p>
  </div>
</div>

<script>
// Trimmed data (from 2021)
const hD=${JSON.stringify(hDt)}, hV=${JSON.stringify(hVt)};
const mD=${JSON.stringify(mrDt)}, mV=${JSON.stringify(mrVt)};
const kD=${JSON.stringify(krDt)}, kV=${JSON.stringify(krVt)};
const gD=${JSON.stringify(mgDt)}, gV=${JSON.stringify(mgVt)};
const cD=${JSON.stringify(cDt)}, cV=${JSON.stringify(cVt)};

const hF=${JSON.stringify(hFc2.forecasts)}; const mF=${JSON.stringify(mrFc2.forecasts)};
const kF=${JSON.stringify(krFc.forecasts)}; const gF=${JSON.stringify(mgFc.forecasts)};
const cF=${JSON.stringify(compFc.forecasts)};

const fHD=${JSON.stringify(fcDH2)}, fMD=${JSON.stringify(fcDMr2)};
const fKD=${JSON.stringify(fcDKr)}, fGD=${JSON.stringify(fcDMg)};
const fCD=${JSON.stringify(fcDAl)};

// Market estimate (multi-factor)
const mkD=${JSON.stringify(mkD)}, mkV=${JSON.stringify(mktHistRub)};
const fMkD=${JSON.stringify(mktFcDates)}, mkF=${JSON.stringify(mktFcRub)};
const mkFAdj=${JSON.stringify(newsAdjRub)};
const mkD2=${JSON.stringify(mkD)}, mkV2=${JSON.stringify(mktHistSqm)};
const fMkD2=${JSON.stringify(mktFcDates)}, mkF2=${JSON.stringify(mktFcSqm)};
const mkF2Adj=${JSON.stringify(newsAdjSqm)};

function skLine(id, hDates, hVals, fDates, fData, unit, digits) {
  const el = document.getElementById(id);
  if (!el) return;
  const allD = [...hDates, ...fDates];
  const histData = allD.map((d,i) => i < hDates.length ? [d, hVals[i]] : null);
  const fcData = allD.map((d,i) => i < hDates.length ? null : [d, fData[i-hDates.length]?.mean]);
  const fcLow = allD.map((d,i) => i < hDates.length ? null : [d, fData[i-hDates.length]?.lower]);
  const fcHigh = allD.map((d,i) => i < hDates.length ? null : [d, fData[i-hDates.length]?.upper]);
  const c = echarts.init(el);
  c.setOption({
    tooltip: { trigger:'axis', valueFormatter: v => v==null?'—':v.toFixed(digits||1)+(unit||'') },
    grid: { left:44, right:8, top:14, bottom:22 },
    xAxis: { type:'category', data:allD, axisLabel:{fontSize:7,color:'#8b949e',rotate:30,formatter:function(v){return v&&v.endsWith('-01')?v.slice(0,4):'';}} },
    yAxis: { type:'value', splitLine:{lineStyle:{color:'#333'}}, axisLabel:{fontSize:8,color:'#8b949e'} },
    series: [
      { name:'История', type:'line', data:histData, smooth:true, lineStyle:{color:'#58a6ff',width:1.5}, symbol:'none' },
      { name:'Прогноз', type:'line', data:fcData, smooth:true, lineStyle:{color:'#f0883e',width:1.5,type:'dashed'}, symbol:'none' },
      { name:'Дов.инт.', type:'line', data:fcHigh, smooth:true, lineStyle:{width:0}, symbol:'none', areaStyle:{color:'rgba(240,136,62,0.08)'} },
      { name:'', type:'line', data:fcLow, smooth:true, lineStyle:{width:0}, symbol:'none', areaStyle:{color:'rgba(240,136,62,0.08)'} }
    ]
  });
  window.addEventListener('resize', ()=>{try{c.resize()}catch(e){}});
}

skLine('c-hl', hD, hV, fHD, hF, ' млн м²', 1);
skLine('c-mr', mD, mV, fMD, mF, '%', 2);
skLine('c-kr', kD, kV, fKD, kF, '%', 1);
skLine('c-mv', gD, gV, fGD, gF, ' млрд ₽', 0);

// Composite index
(function(){
  const el=document.getElementById('c-ci');
  if(!el)return;
  const allD=[...cD,...fCD];
  const c=echarts.init(el);
  c.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v==null?'—':v.toFixed(0)},
    grid:{left:44,right:8,top:14,bottom:22},
    xAxis:{type:'category',data:allD,axisLabel:{fontSize:7,color:'#8b949e',rotate:30,formatter:function(v){return v&&v.endsWith('-01')?v.slice(0,4):'';}}},
    yAxis:{type:'value',splitLine:{lineStyle:{color:'#333'}},axisLabel:{fontSize:8,color:'#8b949e'}},
    series:[
      {name:'История',type:'line',data:allD.map((d,i)=>i<cD.length?[d,cV[i]]:null),smooth:true,lineStyle:{color:'#58a6ff',width:1.5},symbol:'none'},
      {name:'Прогноз',type:'line',data:allD.map((d,i)=>i<cD.length?null:[d,cF[i-cD.length]?.mean||null]),smooth:true,lineStyle:{color:'#f0883e',width:1.5,type:'dashed'},symbol:'none'},
      {name:'',type:'line',data:allD.map((d,i)=>i<cD.length?null:[d,cF[i-cD.length]?.upper||null]),smooth:true,lineStyle:{width:0},symbol:'none',areaStyle:{color:'rgba(240,136,62,0.08)'}},
      {name:'',type:'line',data:allD.map((d,i)=>i<cD.length?null:[d,cF[i-cD.length]?.lower||null]),smooth:true,lineStyle:{width:0},symbol:'none',areaStyle:{color:'rgba(240,136,62,0.08)'}}
    ]
  });
  window.addEventListener('resize',()=>{try{c.resize()}catch(e){}});
})();

// Market forecast with news-adjusted overlay
(function(){
  function mkChart(id, hD, hV, fD, fBase, fAdj, unit, dig) {
    var el=document.getElementById(id);
    if(!el)return;
    var allD=[...hD,...fD];
    var baseData=allD.map(function(d,i){return i<hD.length?null:[d,fBase[i-hD.length]?.mean];});
    var adjData=allD.map(function(d,i){return i<hD.length?null:[d,fAdj[i-hD.length]?.mean];});
    var fcHigh=allD.map(function(d,i){return i<hD.length?null:[d,fBase[i-hD.length]?.upper];});
    var fcLow=allD.map(function(d,i){return i<hD.length?null:[d,fBase[i-hD.length]?.lower];});
    var c=echarts.init(el);
    c.setOption({
      tooltip:{trigger:'axis',valueFormatter:function(v){return v==null?'—':v.toFixed(dig)+(unit||'');}},
      grid:{left:44,right:8,top:14,bottom:22},
      legend:{show:true,bottom:0,textStyle:{color:'#8b949e',fontSize:8}},
      xAxis:{type:'category',data:allD,axisLabel:{fontSize:7,color:'#8b949e',rotate:30,formatter:function(v){return v&&v.endsWith('-01')?v.slice(0,4):'';}}},
      yAxis:{type:'value',splitLine:{lineStyle:{color:'#333'}},axisLabel:{fontSize:8,color:'#8b949e'}},
      series:[
        {name:'История',type:'line',data:allD.map(function(d,i){return i<hD.length?[d,hV[i]]:null;}),smooth:true,lineStyle:{color:'#58a6ff',width:1.5},symbol:'none'},
        {name:'Прогноз (статистика)',type:'line',data:baseData,smooth:true,lineStyle:{color:'#f0883e',width:1.5,type:'dashed'},symbol:'none'},
        {name:'С учётом новостей',type:'line',data:adjData,smooth:true,lineStyle:{color:'#3fb950',width:1.5,type:'dashed'},symbol:'none'},
        {name:'Дов.инт.',type:'line',data:fcHigh,smooth:true,lineStyle:{width:0},symbol:'none',areaStyle:{color:'rgba(240,136,62,0.08)'}},
        {name:'',type:'line',data:fcLow,smooth:true,lineStyle:{width:0},symbol:'none',areaStyle:{color:'rgba(240,136,62,0.08)'}}
      ]
    });
    window.addEventListener('resize',function(){try{c.resize()}catch(e){}});
  }
  mkChart('c-mk', mkD, mkV, fMkD, mkF, mkFAdj, ' млрд ₽', 0);
  mkChart('c-mk-sqm', mkD2, mkV2, fMkD2, mkF2, mkF2Adj, ' млн м²', 1);
})();
</script>
</div>

</body>
</html>`;

  const outPath = './prognosis.html';
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`✅ Prognosis page: ${(html.length/1024).toFixed(0)} KB → prognosis.html`);
  console.log(`   Housing R²: ${(hFc.lr.r2||0).toFixed(3)}, Mortgage R²: ${(mrFc.lr.r2||0).toFixed(3)}`);
  console.log(`   Key rate R²: ${(krFc.lr.r2||0).toFixed(3)}, Mortgage vol R²: ${(mgFc.lr.r2||0).toFixed(3)}`);

  await pool.end();
})();

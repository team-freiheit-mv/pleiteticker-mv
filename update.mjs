// Pleiteticker MV – wöchentliches Daten-Update (GitHub Action)
// Scraped insolvenzbekanntmachungen.de (MV · Eröffnungen · seit 01.01.2026).
// Zählung = Anker + Union der jemals gesehenen Aktenzeichen (history.txt).
// Aktualisiert NUR Datenwerte in index.html + og-image.png. Design/Framing/bigFaelle bleiben.
//
// Testlauf ohne Portal (kein Schreiben):
//   DRY_RUN=1 MOCK_SNAPSHOT=daten/snapshot_2026-07-24.txt node update.mjs
// Testlauf mit echtem Scrape, aber ohne Schreiben:
//   DRY_RUN=1 node update.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HIST = path.join(ROOT, 'history.txt');
const DATEN_DIR = path.join(ROOT, 'daten');
const INDEX = path.join(ROOT, 'index.html');
const OG = path.join(ROOT, 'og-image.png');
const DRY = !!process.env.DRY_RUN;

const PORTAL = 'https://neu.insolvenzbekanntmachungen.de/ap/suche.jsf';
const VON = '2026-01-01';

// ---------- Helfer ----------
const pad = (n) => String(n).padStart(2, '0');
function today() { return process.env.RUN_DATE ? new Date(process.env.RUN_DATE) : new Date(); }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function de(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function normAz(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}
function mondayOf(d) { const t = new Date(d); const day = (t.getDay() + 6) % 7; t.setDate(t.getDate() - day); return t; }

function branche(az, register) {
  if (register && register.trim()) return 'Unternehmen';
  if (/\bIK\b/.test(az)) return 'Privatinsolvenz';
  return 'Regelinsolvenz';
}

// ---------- history.txt lesen (Anker + Aktenzeichen-Set) ----------
function readHistory() {
  const set = new Set();
  let anchor = 0;
  if (fs.existsSync(HIST)) {
    for (const raw of fs.readFileSync(HIST, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const a = line.match(/^ANCHOR:\s*(\d+)/i);
      if (a) { anchor = parseInt(a[1], 10); continue; }
      if (line.startsWith('#')) continue;
      if (/I[NK]\s+\d+\/\d+/.test(line)) set.add(normAz(line));
    }
  }
  return { set, anchor };
}
function writeHistory(anchor, set) {
  const lines = [
    '# Pleiteticker MV – Aktenzeichen-Historie (Union-Zaehlung)',
    '# ANCHOR = bereits gezaehlte Verfahren aus aelteren, inzwischen vom Portal',
    '# ausgelaufenen Snapshots (nicht mehr einzeln enumerierbar).',
    `ANCHOR: ${anchor}`,
    ...[...set],
  ];
  fs.writeFileSync(HIST, lines.join('\n') + '\n');
  console.log('history.txt aktualisiert:', set.size, 'Aktenzeichen + Anker', anchor);
}

// ---------- 1) Scrape (Playwright) ----------
async function scrape() {
  const mock = process.env.MOCK_SNAPSHOT;
  if (mock) {
    console.log('MOCK-Modus: lese', mock);
    return parseSnapshot(fs.readFileSync(path.join(ROOT, mock), 'utf8'));
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const bis = iso(today());
  console.log('Scrape', VON, '→', bis);
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.selectOption('select[name="frm_suche:lsom_bundesland:codelist:scl_bundesland:mysom"]', 'MV');
  await page.waitForTimeout(2500);
  await page.selectOption('select[name="frm_suche:lsom_gegenstand:codelist:mysom"]', 'EROEFF');
  await page.waitForTimeout(500);
  const dates = page.locator('input[type=date]');
  await dates.nth(0).fill(VON);
  await dates.nth(1).fill(bis);
  await page.waitForTimeout(300);
  await page.click('#frm_suche\\:cbt_suchen');
  await page.waitForSelector('#tbl_ergebnis', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const rows = await page.$$eval('#tbl_ergebnis tr', (trs) =>
    trs.map((tr) => {
      const g = (suffix) => {
        const el = tr.querySelector(`span[id*="otx_${suffix}"]`);
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      return { datum: g('datum'), az: g('azAkt'), gericht: g('Gericht'), name: g('schuldner'), sitz: g('Sitz'), register: g('register') };
    }).filter((r) => r.az)
  );
  await browser.close();
  console.log('Gescrapte Zeilen:', rows.length);
  if (rows.length < 50) throw new Error(`Verdächtig wenige Treffer (${rows.length}) – Portal-Struktur geändert? Abbruch, kein Update.`);
  return rows;
}

// ---------- Snapshot parsen ----------
function parseSnapshot(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{2}\.\d{2}\.\d{4})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|(.*)$/);
    if (!m) continue;
    const az = normAz(m[2]);
    if (!/I[NK]\s+\d+\/\d+/.test(az)) continue;
    rows.push({ datum: m[1], az, gericht: m[3].trim(), name: m[4].trim(), sitz: m[5].trim(), register: (m[6] || '').replace(/\(.*?\)/g, '').trim() });
  }
  return rows;
}

// ---------- index.html aktualisieren ----------
function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function jsCases(rows) {
  return rows.map((f) => `{ name: "${esc(f.name)}", ort: "${esc(f.ort)}", branche: "${esc(f.branche)}" }`).join(',\n');
}
function updateIndex(verfahren, stand, woche, ticker) {
  let html = fs.readFileSync(INDEX, 'utf8');
  const wocheBlock =
`woche: {
label: "${woche.label}",
anzahl: ${woche.anzahl},
faelle: [
${jsCases(woche.faelle)}
]
},`;
  const tickerBlock =
`ticker: [
${jsCases(ticker)}
]`;
  const before = html;
  html = html.replace(/verfahren:\s*\d+\s*,/, `verfahren: ${verfahren},`);
  html = html.replace(/stand:\s*"[^"]*"\s*,/, `stand: "${stand}",`);
  html = html.replace(/woche:\s*\{[\s\S]*?\n\},/, wocheBlock);
  html = html.replace(/ticker:\s*\[[\s\S]*?\n\]/, tickerBlock);
  // Alle Sichttexte (Eyebrow-Datum, Kontext-Satz, "Live erfasst"-Werte) werden
  // im Browser aus DATA gerendert -> hier nur noch das Datenobjekt + Redeploy-Marke.
  html = html.replace(/<!-- redeploy-trigger:[^>]*-->/, `<!-- redeploy-trigger: ${stand} -->`);
  if (html === before) throw new Error('index.html unverändert – Muster nicht gefunden? Abbruch.');
  if (DRY) { console.log('[DRY] index.html NICHT geschrieben (Muster ok, würde aktualisieren).'); return; }
  fs.writeFileSync(INDEX, html);
  console.log('index.html aktualisiert.');
}

// ---------- og-image.png erzeugen ----------
async function makeOg(verfahren, stand) {
  if (DRY) { console.log('[DRY] og-image.png NICHT erzeugt.'); return; }
  const fontPath = path.join(ROOT, 'montserrat-latin.woff2');
  const fontB64 = fs.existsSync(fontPath) ? fs.readFileSync(fontPath).toString('base64') : '';
  const fontFace = fontB64
    ? `@font-face{font-family:Montserrat;font-style:normal;font-weight:400 900;src:url(data:font/woff2;base64,${fontB64}) format('woff2')}`
    : '';
  // CI Team Freiheit: monochrom, Montserrat, Wortmarke im Kasten (kein Logo-Bild),
  // auf Schwarz nur reines Weiß, kursive Versalien nur als Claim.
  const og = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontFace}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px}
body{font-family:Montserrat,system-ui,Arial,sans-serif;background:#000;color:#fff;width:1200px;height:630px;display:flex;flex-direction:column;justify-content:space-between;padding:54px 60px}
.top{display:flex;align-items:center;gap:22px}
.wm{display:inline-flex;align-items:center;border:3px solid #fff;padding:7px 18px;font-weight:900;text-transform:uppercase;letter-spacing:.02em;font-size:22px;line-height:1;white-space:nowrap}
.t1{font-size:30px;font-weight:900;text-transform:uppercase;letter-spacing:.5px}.t2{font-size:16px;font-weight:400;text-transform:uppercase;letter-spacing:2px;margin-top:4px}
.eyebrow{font-size:20px;font-weight:700;letter-spacing:4px;text-transform:uppercase}
.ctr{display:flex;align-items:flex-start;gap:6px;margin:4px 0}.num{font-size:250px;font-weight:900;font-style:italic;line-height:.82;letter-spacing:-.05em}.plus{font-size:120px;font-weight:900;font-style:italic;line-height:1;margin-top:14px}
.lbl{font-size:34px;font-weight:900;font-style:italic;text-transform:uppercase;line-height:1.02;max-width:900px}
.bottom{display:flex;align-items:flex-end;justify-content:space-between;gap:32px}.stat{font-size:24px;font-weight:400}
.wahl{font-style:italic;font-weight:900;text-transform:uppercase;font-size:26px;letter-spacing:-.01em;text-align:right;max-width:420px;line-height:1.05}
</style></head><body>
<div class="top"><span class="wm">Team Freiheit</span><div><div class="t1">Pleiteticker MV</div><div class="t2">Insolvenzmonitor Mecklenburg-Vorpommern</div></div></div>
<div><div class="eyebrow">Mecklenburg-Vorpommern · 2026</div><div class="ctr"><div class="num">${verfahren}</div><div class="plus">+</div></div><div class="lbl">Eröffnete Insolvenzverfahren seit Jahresbeginn</div></div>
<div class="bottom"><div class="stat">Unternehmen &amp; Privatpersonen · Stand ${stand}</div><div class="wahl">Am 20.09. Team Freiheit wählen.</div></div>
</body></html>`;
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await p.setContent(og, { waitUntil: 'networkidle' });
  await p.screenshot({ path: OG });
  await b.close();
  console.log('og-image.png erzeugt.');
}

// ---------- Snapshot schreiben (Audit) ----------
function writeSnapshot(rows, stand, verfahren) {
  if (DRY) { console.log('[DRY] Snapshot NICHT geschrieben.'); return; }
  fs.mkdirSync(DATEN_DIR, { recursive: true });
  const head =
`Suchzeitpunkt: ${stand} (GitHub Action)
Suchkriterien
Bundesland: Mecklenburg-Vorpommern
Gericht: Alle Insolvenzgerichte
Datum der Veröffentlichung: 01.01.2026 - ${stand}
Gegenstand der Veröffentlichung: Eröffnungen

Ergebnisliste (Veröffentlichungsdatum | Aktenzeichen | Gericht | Name/Bezeichnung | Sitz/Wohnsitz | Register)
Union aller Läufe nach diesem Lauf: ${verfahren}

`;
  const body = rows.map((r) => `${r.datum} | ${r.az} | ${r.gericht} | ${r.name} | ${r.sitz} | ${r.register || ''}`).join('\n');
  fs.writeFileSync(path.join(DATEN_DIR, `snapshot_${iso(today())}.txt`), head + body + '\n');
  console.log('Snapshot geschrieben.');
}

// ---------- Hauptlauf ----------
(async () => {
  if (DRY) console.log('=== DRY_RUN: keine Dateien werden geschrieben ===');
  const d = today();
  const stand = de(d);
  const { set: hist, anchor } = readHistory();
  console.log('Bekannte Aktenzeichen (history.txt):', hist.size, '+ Anker', anchor, '=', hist.size + anchor);

  const scraped = await scrape();
  const rows = scraped.map((r) => ({ ...r, az: normAz(r.az), ort: r.sitz || r.ort || '' }));

  // Neu = heutige Aktenzeichen, die history.txt noch nicht kennt
  const union = new Set(hist);
  const seen = new Set();
  const neu = [];
  for (const r of rows) {
    if (seen.has(r.az)) continue;
    seen.add(r.az);
    if (union.has(r.az)) continue;
    union.add(r.az);
    neu.push({ name: r.name, ort: r.ort, branche: branche(r.az, r.register), datum: r.datum });
  }
  const verfahren = anchor + union.size;
  console.log('Neu seit letztem Lauf:', neu.length, '| verfahren:', verfahren);

  const parseD = (s) => { const [dd, mm, yy] = s.split('.'); return new Date(+yy, +mm - 1, +dd); };
  neu.sort((a, b) => parseD(b.datum) - parseD(a.datum));

  const kw = isoWeek(d);
  const mo = mondayOf(d);
  const woche = {
    kw,
    label: `KW ${kw} · ${pad(mo.getDate())}.–${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`,
    anzahl: neu.length,
    faelle: neu.slice(0, 12).map(({ name, ort, branche }) => ({ name, ort, branche })),
  };
  const ticker = neu.slice(0, 8).map(({ name, ort, branche }) => ({ name, ort, branche }));

  updateIndex(verfahren, stand, woche, ticker);
  await makeOg(verfahren, stand);
  writeSnapshot(rows, stand, verfahren);
  if (!DRY) writeHistory(anchor, union);

  const wa =
`🚨 KW ${kw} · ${woche.anzahl} neue Insolvenzeröffnungen in MV

📊 Seit Januar: ${verfahren} eröffnete Verfahren (Unternehmen & Privatpersonen)
Quelle: insolvenzbekanntmachungen.de · Stand ${stand}

MV braucht Veränderung. 💪

Teile das mit jemandem, der das noch nicht weiß 🔁
🔗 https://pleiteticker-mv.vercel.app/?v=kw${kw}`;
  const summary = `## Pleiteticker-Update ${stand}${DRY ? ' (DRY_RUN)' : ''}\n\n- verfahren gesamt: **${verfahren}**\n- Neu diese Woche (KW ${kw}): **${woche.anzahl}**\n\n### WhatsApp-Text\n\n\`\`\`\n${wa}\n\`\`\`\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
})().catch((e) => { console.error('FEHLER:', e); process.exit(1); });

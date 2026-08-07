// Builds captioned guide videos (MP4) + PDFs for owners and tenants.
// Usage: node scripts/build-guide.mjs [--owner] [--tenant] [--pdf] [--video]
import puppeteer from 'puppeteer-core';
import fsSync from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'guide');
const SHOTS = path.join(OUT, 'shots');
const SLIDES = path.join(OUT, 'slides');
const BASE = process.env.TEST_BASE || 'http://localhost:5000';

const args = process.argv.slice(2);
const DO_OWNER = args.includes('--owner') || args.length === 0;
const DO_TENANT = args.includes('--tenant') || args.length === 0;
const DO_PDF = args.includes('--pdf') || !args.includes('--video');
const DO_VIDEO = args.includes('--video') || !args.includes('--pdf');

const EXE =
  fsSync.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');

const W = 1280, H = 720;

const FFMPEG = process.env.FFMPEG_PATH ||
  path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0-full_build', 'bin', 'ffmpeg.exe');

function ffmpeg(...a) {
  try {
    execFileSync(FFMPEG, a, { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (e) {
    console.error('ffmpeg failed:', e.message);
    process.exit(1);
  }
}

async function login(page, username, password) {
  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(async (u, p) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const d = await res.json();
    if (res.ok) {
      localStorage.setItem('token', d.token);
      localStorage.setItem('user', JSON.stringify(d.user));
    } else {
      throw new Error('login failed: ' + (d.error || res.status));
    }
  }, username, password);
}

async function shot(page, url, name, tab) {
  await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 60000 });
  if (tab) {
    await page.evaluate((t) => {
      if (typeof switchTab === 'function') switchTab(t);
      else {
        const a = document.querySelector(`[data-tab="${t}"]`);
        if (a) a.click();
      }
    }, tab);
    await new Promise(r => setTimeout(r, 1200));
  }
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('shot:', name);
}

// ─── Slide decks ───────────────────────────────────────────────
const OWNER_SLIDES = [
  { title: 'SajiloRent', text: 'Owner guide', img: null },
  { title: 'Log in', text: 'Go to sajilorent.onrender.com (or open the app). Sign in with the credentials we gave you.', img: 'owner-01-login.png' },
  { title: 'Your dashboard', text: 'All your houses and monthly stats at a glance. Pick a house to manage it.', img: 'owner-02-dashboard.png' },
  { title: 'Generate a bill', text: 'Enter this month\'s reading. The app computes electricity + rent + water + waste automatically.', img: 'owner-04-billing.png' },
  { title: 'Bill history', text: 'Every generated bill is saved. Re-open past months, mark as paid, or adjust balances.', img: 'owner-05-history.png' },
  { title: 'Post a notice', text: 'Send messages to your tenants — they appear on their app immediately.', img: 'owner-06-notices.png' },
  { title: 'Need help?', text: 'Use the Help tab to message us directly from inside the app.', img: 'owner-07-help.png' }
];

const TENANT_SLIDES = [
  { title: 'SajiloRent', text: 'Tenant guide', img: null },
  { title: 'Log in', text: 'Open the app (or the website) and sign in with the username and password your owner gave you.', img: 'tenant-01-login.png' },
  { title: 'Your current bill', text: 'See this month\'s bill with units, rent and total — as soon as your owner generates it.', img: 'tenant-02-current-bill.png' },
  { title: 'Payment & history', text: 'Track your payment status and view all past bills in one place.', img: 'tenant-03-history.png' },
  { title: 'Owner notices', text: 'Messages from your owner appear here the moment they are posted.', img: 'tenant-04-notices.png' }
];

function slideHtml(s, badge) {
  const imgSrc = s.img ? 'data:image/png;base64,' + fsSync.readFileSync(path.join(SHOTS, s.img)).toString('base64') : null;
  const img = imgSrc
    ? `<img src="${imgSrc}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"/>`
    : '';
  const overlay = s.img
    ? `<div style="position:absolute;left:0;right:0;bottom:0;height:170px;background:linear-gradient(transparent, rgba(2,6,23,.96));padding:48px 48px 26px;">
        <div style="font-size:34px;font-weight:800;color:#ffffff;">${s.title}</div>
        <div style="font-size:19px;color:#cbd5e1;max-width:86%;margin-top:8px;line-height:1.5;">${s.text}</div>
      </div>`
    : `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:#050b1a;gap:16px;">
        <div style="font-size:64px;font-weight:900;letter-spacing:-1px;color:#ffffff;">${s.title}</div>
        <div style="font-size:26px;color:#8aa0b8;font-weight:500;">${s.text}</div>
        <div style="font-size:14px;color:#475569;margin-top:8px;">made by Kali</div>
      </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:Segoe UI, system-ui, sans-serif; }
    html,body{width:${W}px;height:${H}px;overflow:hidden;}
    .deck { position:relative; width:${W}px; height:${H}px; background:#050b1a; }
    .badge{position:absolute;top:22px;left:26px;z-index:5;color:#e0f2fe;font-size:15px;font-weight:700;letter-spacing:.5px;background:rgba(37,99,235,.28);border:1px solid rgba(96,165,250,.4);border-radius:999px;padding:7px 16px;}
  </style></head><body><div class="deck"><div class="badge">${badge}</div>${img}${overlay}</div></body></html>`;
}

async function renderSlides(deck) {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  for (let i = 0; i < deck.slides.length; i++) {
    const s = deck.slides[i];
    await page.setContent(slideHtml(s, deck.badge), { waitUntil: 'load' });
    if (s.img) await page.waitForSelector('img', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(SLIDES, `${deck.name}-${String(i + 1).padStart(2, '0')}.png`) });
    console.log('slide:', deck.name, i + 1);
  }
  await browser.close();
}

async function renderPdf(deck) {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let body = '<h1>' + deck.readme.title + '</h1><p class="lead">' + deck.readme.lead + '</p>';
  deck.slides.filter(s => s.img).forEach((s, i) => {
    const imgSrc = 'data:image/png;base64,' + fsSync.readFileSync(path.join(SHOTS, s.img)).toString('base64');
    body += `<h2>${i + 1}. ${s.title}</h2><p>${s.text}</p><img src="${imgSrc}" />`;
  });
  body += '<hr/><h2>Quick start</h2>' + deck.readme.quick.map(q => `<p>• ${q}</p>`).join('');
  await page.setContent(`<html><head><style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 36px; color:#0f172a; }
    h1 { font-size:34px; color:#1d4ed8; margin-bottom:6px; }
    .lead { font-size:17px; color:#334155; margin-bottom:24px; }
    h2 { font-size:22px; margin:22px 0 6px; color:#0f172a; }
    p { font-size:15px; color:#1e293b; line-height:1.55; margin-bottom:10px; }
    img { max-width:100%; margin:6px 0; border:1px solid #e2e8f0; border-radius:10px; }
    hr { border:none; border-top:2px solid #e2e8f0; margin:30px 0; }
  </style></head><body>${body}</body></html>`, { waitUntil: 'networkidle0' });
  await page.pdf({ path: path.join(OUT, deck.name + '-guide.pdf'), format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
  console.log('pdf:', deck.name);
  await browser.close();
}

function encodeVideo(deck) {
  const n = deck.slides.length;
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const img = path.join(SLIDES, `${deck.name}-${String(i).padStart(2, '0')}.png`);
    const out = path.join(SLIDES, `${deck.name}-part-${i}.mp4`);
    ffmpeg('-y', '-loop', '1', '-i', img, '-t', '3', '-vf', `scale=${W}:${H},format=yuv420p`, '-r', '25', '-c:v', 'libx264', '-crf', '23', '-an', out);
    parts.push(out);
  }
  const list = path.join(SLIDES, `${deck.name}-list.txt`);
  fsSync.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const outMp4 = path.join(OUT, deck.name + '-guide.mp4');
  ffmpeg('-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outMp4);
  const size = fsSync.statSync(outMp4).size;
  console.log('video:', deck.name + '-guide.mp4', Math.round(size / 1024) + ' KB');
}

const DECKS = [];
if (DO_OWNER) DECKS.push({
  name: 'owner', badge: 'Owner guide',
  slides: OWNER_SLIDES,
  readme: {
    title: 'SajiloRent — Owner Guide',
    lead: 'Everything you need: houses, tenants, bills, history and notices.',
    quick: ['Log in with the credentials we sent you', 'Pick your house from the dashboard', 'Open the Bill tab and enter this month\'s electricity reading', 'Review history anytime, mark paid', 'Post notices so tenants see them instantly']
  }
});
if (DO_TENANT) DECKS.push({
  name: 'tenant', badge: 'Tenant guide',
  slides: TENANT_SLIDES,
  readme: {
    title: 'SajiloRent — Tenant Guide',
    lead: 'Your monthly bill, payment status and notices in one place.',
    quick: ['Log in with the tenant username we gave you', 'Your current bill appears as soon as the owner generates it', 'View past bills in History', 'Owner notices appear instantly in the Notices tab']
  }
});

await fs.mkdir(SHOTS, { recursive: true });
await fs.mkdir(SLIDES, { recursive: true });

// ─── Capture real screens ─────────────────────────────────────
const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const OWNER_URLS = [
  ['owner-01-login', '/login.html', null],
  ['owner-02-dashboard', '/index.html', null],
  ['owner-04-billing', '/index.html', 'tab-billing'],
  ['owner-05-history', '/index.html', 'tab-history'],
  ['owner-06-notices', '/index.html', 'tab-notices'],
  ['owner-07-help', '/index.html', 'tab-support']
];
const TENANT_URLS = [
  ['tenant-01-login', '/login.html', null],
  ['tenant-02-current-bill', '/tenant.html', null],
  ['tenant-03-history', '/tenant.html', 'tab-history'],
  ['tenant-04-notices', '/tenant.html', 'tab-dashboard']
];

if (DO_OWNER) {
  await login(page, 'demo_owner1', 'Sunny@2081');
  for (const [name, url, tab] of OWNER_URLS) await shot(page, url, name, tab);
}
if (DO_TENANT) {
  await login(page, 't_sita', 'Sita@2081');
  for (const [name, url, tab] of TENANT_URLS) await shot(page, url, name, tab);
}
await browser.close();

for (const deck of DECKS) {
  await renderSlides(deck);
  if (DO_PDF) await renderPdf(deck);
  if (DO_VIDEO) encodeVideo(deck);
}

console.log('\nDone. Files in', OUT);

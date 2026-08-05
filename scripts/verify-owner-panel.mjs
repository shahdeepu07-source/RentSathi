// Headless render of the owner panel (index.html) as admin on a LOCAL server.
// Reports: overlay visibility, any visible bordered/shadowed box (stray UI), fixed elements.
import puppeteer from 'puppeteer-core';

const BRAVE = 'C:/Users/shahd/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 41241);

const browser = await puppeteer.launch({ executablePath: BRAVE, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const token = await page.evaluate(async (origin) => {
        const r = await fetch(origin + '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: '5545' })
        });
        const d = await r.json();
        return { token: d.token, user: d.user };
    }, BASE);
    console.log('login ok:', !!token.token);

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate((t) => { localStorage.setItem('token', t.token); localStorage.setItem('user', JSON.stringify(t.user)); }, token);

    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const audit = await page.evaluate(() => {
        const out = { url: location.href, overlays: [], strayBoxes: [], fixedEls: [], visibleBoxes: 0 };
        document.querySelectorAll('[id]').forEach(el => {
            if (el.id.endsWith('overlay')) {
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                out.overlays.push({ id: el.id, display: cs.display, visible: cs.display !== 'none', w: Math.round(r.width), h: Math.round(r.height) });
            }
        });
        document.querySelectorAll('div').forEach(el => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
            const r = el.getBoundingClientRect();
            if (r.width < 150 || r.height < 40 || r.top > 3000) return;
            const hasBorder = cs.borderTopWidth !== '0px' && parseInt(cs.borderTopWidth) > 0;
            const hasShadow = cs.boxShadow !== 'none';
            const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            out.visibleBoxes++;
            if (hasBorder || hasShadow) {
                out.strayBoxes.push({
                    id: el.id || el.className || '(anon)',
                    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                    border: cs.borderTopWidth, shadow: hasShadow, txt
                });
            }
        });
        document.querySelectorAll('*').forEach(el => {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed' && cs.display !== 'none') {
                const r = el.getBoundingClientRect();
                out.fixedEls.push({ tag: el.tagName, id: el.id || el.className || '', rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
            }
        });
        return out;
    });

    console.log('URL:', audit.url);
    console.log('OVERLAYS:', JSON.stringify(audit.overlays));
    console.log('STRAY BOXES (' + audit.strayBoxes.length + '):');
    for (const b of audit.strayBoxes) console.log('  ', JSON.stringify(b));
    console.log('FIXED ELEMENTS:');
    for (const f of audit.fixedEls) console.log('  ', JSON.stringify(f));

    const shot = process.env.TEMP + '\\sajilo-owner-panel.png';
    await page.screenshot({ path: shot });
    console.log('screenshot:', shot);
} finally {
    await browser.close();
}
// Generates Android launcher icons from the SajiloRent logo.
// Run: node scripts/make-icons.mjs
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const NAVY = '#00386f';

const svg = await fs.readFile(path.join(__dirname, '..', 'public', 'assets', 'logo.svg'), 'utf8');
const whiteSvg = svg.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#ffffff"');

async function renderLogo(sizePx) {
    return sharp(Buffer.from(whiteSvg), { density: 300 })
        .trim({ threshold: 10 })
        .resize(sizePx, sizePx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
}

async function solid(size, bg) {
    return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
        .png()
        .toBuffer();
}

async function circleMask(size) {
    return sharp(Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#000"/></svg>`))
        .png()
        .toBuffer();
}

const NAVY_BG = { r: 0, g: 56, b: 111, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

async function squareIcon(size, logoFraction) {
    const logo = await renderLogo(Math.round(size * logoFraction));
    return sharp(await solid(size, NAVY_BG))
        .composite([{ input: logo, gravity: 'center' }])
        .png()
        .toBuffer();
}

async function roundIcon(size, logoFraction) {
    const base = await squareIcon(size, logoFraction);
    const mask = await circleMask(size);
    return sharp(base).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function foreground(size, logoFraction) {
    const logo = await renderLogo(Math.round(size * logoFraction));
    return sharp(await solid(size, CLEAR))
        .composite([{ input: logo, gravity: 'center' }])
        .png()
        .toBuffer();
}

const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [density, size] of Object.entries(legacy)) {
    const dir = path.join(RES, `mipmap-${density}`);
    await fs.writeFile(path.join(dir, 'ic_launcher.png'), await squareIcon(size, 0.62));
    await fs.writeFile(path.join(dir, 'ic_launcher_round.png'), await roundIcon(size, 0.62));
    console.log(`✔ mipmap-${density} (${size}px)`);
}

for (const [density, size] of Object.entries(fg)) {
    const dir = path.join(RES, `mipmap-${density}`);
    await fs.writeFile(path.join(dir, 'ic_launcher_foreground.png'), await foreground(size, 0.46));
    console.log(`✔ foreground ${density} (${size}px)`);
}

await fs.writeFile(path.join(RES, 'values', 'colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#00386F</color>\n</resources>\n`);

console.log('🎨 Icons generated.');

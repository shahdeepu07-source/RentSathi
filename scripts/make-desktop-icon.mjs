import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

const svg = await fs.readFile('public/assets/logo.svg', 'utf8');
const white = svg.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#ffffff"');

const emblem = await sharp(Buffer.from(white), { density: 400 })
    .trim({ threshold: 10 })
    .resize(160, 160, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();

const icon = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 56, b: 111, alpha: 255 } }
}).composite([{ input: emblem, left: 48, top: 48 }]).png().toBuffer();

await fs.writeFile(path.join('desktop', 'icon.png'), icon);
console.log('desktop/icon.png written', (await sharp(icon).metadata()).width + 'x' + (await sharp(icon).metadata()).width);
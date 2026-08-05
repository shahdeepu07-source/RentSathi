// Generates the 1200x630 social share card for SajiloRent.
// Run: node scripts/make-og-image.mjs
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0b1120"/>
  <circle cx="230" cy="210" r="300" fill="rgba(37,99,235,0.18)"/>
  <circle cx="980" cy="470" r="360" fill="rgba(37,99,235,0.10)"/>
  <circle cx="600" cy="225" r="90" fill="#2563eb"/>
  <circle cx="600" cy="225" r="90" fill="none" stroke="#60a5fa" stroke-opacity="0.4" stroke-width="14"/>
  <text x="600" y="276" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="800" fill="#ffffff">S</text>
  <text x="600" y="395" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="66" font-weight="700" fill="#ffffff">SajiloRent</text>
  <text x="600" y="455" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" fill="#aab6c7">Simple house billing &amp; property management</text>
  <rect x="390" y="500" width="420" height="54" rx="27" fill="#1e293b"/>
  <text x="600" y="535" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" fill="#93c5fd">Free 30-day trial · No card required</text>
</svg>`;

const out = path.join(__dirname, '..', 'public', 'assets', 'og-image.png');
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`OG image written: ${path.relative(process.cwd(), out)}`);

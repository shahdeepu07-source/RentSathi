// CLI: seed demo data (owners, houses, tenants, bills) + plaintext store.
// Run against a local server's data/ (JSON mode) or Neon (set DATABASE_URL).
// Usage: node scripts/seed-demo.mjs
import { seedDemoData } from '../server/seed-demo.js';

const r = await seedDemoData();

console.log('\n=== DEMO SEED RESULT ===');
console.log(`Created: ${r.created.users} users, ${r.created.houses} houses, ${r.created.tenants} tenants, ${r.created.bills} bills`);
console.log(`Skipped (already exist): ${r.skipped.users} users, ${r.skipped.houses} houses, ${r.skipped.tenants} tenants\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log('CREDENTIALS (test-only):');
console.log('────────────────────────────────────────────────────────────────────');
console.log(`${pad('Username', 14)} | ${pad('Password', 14)} | ${pad('Role', 8)} | House`);
console.log('────────────────────────────────────────────────────────────────────');
for (const a of r.accounts) {
    console.log(`${pad(a.username, 14)} | ${pad(a.password, 14)} | ${pad(a.role, 8)} | ${a.house || '—'}`);
}
console.log('────────────────────────────────────────────────────────────────────');
console.log('Built-ins: Super_Admin / Kali_5545, admin / 5545');
console.log('\nPlaintext store written to server data dir (data/demo-passwords.json).');

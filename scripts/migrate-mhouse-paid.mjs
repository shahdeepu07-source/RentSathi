import { readTenants, writeTenants } from '../server/db.js';

const house = 'M_house';
const tenants = await readTenants(house);
const now = new Date().toISOString();
let changed = 0;

for (const t of tenants) {
  if (t.deleted) continue;
  let tChanged = false;
  for (const b of (t.history || [])) {
    if (!b.paid_status) {
      b.paid_status = true;
      b.payment_type = 'equal';
      b.payment_amount = b.total;
      b.payment_reason = 'Cleared - balance equalized';
      b.paid_at = now;
      tChanged = true;
    }
  }
  if (Number(t.balance) !== 0) { t.balance = 0; tChanged = true; }
  if (t.isVacant) { t.isVacant = false; tChanged = true; }
  if (tChanged) changed++;
}

await writeTenants(house, tenants);
console.log(`Updated ${changed} tenants in ${house}; all bills marked paid, balances set to 0.`);
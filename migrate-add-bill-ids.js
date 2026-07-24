// migrate-add-bill-ids.js
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data', 'clients');

async function addBillIds() {
    try {
        const files = await fs.readdir(DATA_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
            const filePath = path.join(DATA_DIR, file);
            const raw = await fs.readFile(filePath, 'utf8');
            let tenants = JSON.parse(raw);

            let modified = false;
            for (const tenant of tenants) {
                if (tenant.history && tenant.history.length) {
                    for (const bill of tenant.history) {
                        if (!bill.id) {
                            bill.id = Date.now() + Math.floor(Math.random() * 10000);
                            modified = true;
                            console.log(`➕ Added ID ${bill.id} to bill for ${tenant.name} (${bill.month})`);
                        }
                    }
                }
            }

            if (modified) {
                await fs.writeFile(filePath, JSON.stringify(tenants, null, 2));
                console.log(`✅ Updated ${file}`);
            } else {
                console.log(`ℹ️ No changes needed in ${file}`);
            }
        }
        console.log('🎉 Migration complete!');
    } catch (err) {
        console.error('❌ Error:', err);
    }
}

addBillIds();
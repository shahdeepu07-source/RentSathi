import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

const files = process.argv.slice(2);
for (const f of files) {
    const html = await fs.readFile(f, 'utf8');
    const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
    let i = 0, bad = 0;
    for (const b of blocks) {
        const p = path.join(os.tmpdir(), `check-${process.pid}-${i++}.mjs`);
        await fs.writeFile(p, b);
        const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
        if (r.status !== 0) { bad++; console.log(`err ${f} block#${i}: ${r.stderr.split('\n').slice(0, 3).join(' | ')}`); }
        await fs.unlink(p).catch(() => {});
    }
    console.log(`${f}: ${i} script blocks, ${bad} with errors`);
}
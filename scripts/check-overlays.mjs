import { promises as fs } from 'fs';
for (const f of ['admin.html', 'index.html', 'superadmin.html', 'tenant.html', 'login.html']) {
    const c = await fs.readFile('public/' + f, 'utf8');
    const ids = [...c.matchAll(/<div[^>]*\bid="([^"]+)/g)].map(m => m[1]);
    for (const id of new Set(ids)) {
        if (!/^[a-z-]+$/.test(id) || id.startsWith('tab-')) continue;
        const isOverlay = id.endsWith('overlay');
        if (!isOverlay) continue;
        const base = new RegExp('#' + id + '\\s*\\{\\s*display:none').test(c);
        const act = new RegExp('#' + id + '\\.active').test(c);
        console.log(f + ' #' + id + ': base-display-none=' + base + ' .active-rule=' + act);
    }
}
// =============================================================================
// guncelle-gorev-alanlar.js — Mevcut görevlerin 'alan' etiketini seed CSV'deki
// tema bazlı değerlere günceller (SATIS/MALI/IDARI/ORTAKLAR → NAKIT/YENIDEN_YAPILANMA/...).
// Kullanım: node guncelle-gorev-alanlar.js
// Eşleştirme: (sahip, baslik) — import-gorevler.js ile aynı mantık. Idempotent.
// =============================================================================
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5, idleTimeoutMillis: 30000
});

const SAHIP_EMAIL = {
    'Yunus':  'yunus@aterko.com',
    'Yakup':  'yakup@aterko.com',
    'Mahmut': 'mahmut@aterko.com',
    'Ömer':   'ofb@aterko.com',
    'Mehmet': 'mehmetuysal@aterko.com'
};

function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
            if (c === '\r' && text[i + 1] === '\n') i++;
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

async function main() {
    const csv = fs.readFileSync(__dirname + '/gorevler-seed.csv', 'utf8');
    const rows = parseCsv(csv);
    const header = rows.shift().map(h => h.trim());
    const col = n => header.indexOf(n);

    const client = await pool.connect();
    try {
        const ur = await client.query(
            "SELECT id, email FROM kullanicilar WHERE LOWER(email) = ANY($1)",
            [Object.values(SAHIP_EMAIL).map(e => e.toLowerCase())]);
        const idByEmail = {};
        ur.rows.forEach(u => idByEmail[u.email.toLowerCase()] = u.id);

        let guncellendi = 0, ayni = 0, bulunamadi = 0;
        for (const r of rows) {
            if (!r.length || !r[col('baslik')]) continue;
            const email = SAHIP_EMAIL[(r[col('sahip')] || '').trim()];
            if (!email || !idByEmail[email.toLowerCase()]) continue;
            const sahipId = idByEmail[email.toLowerCase()];
            const baslik = r[col('baslik')].trim();
            const alan = (r[col('alan')] || 'GENEL').trim().toUpperCase();

            const res = await client.query(
                "UPDATE yonetim_gorevleri SET alan=$1 WHERE sahip_id=$2 AND baslik=$3 AND alan <> $1 RETURNING id",
                [alan, sahipId, baslik]);
            if (res.rowCount) { guncellendi += res.rowCount; console.log(`✅ ${baslik} → ${alan}`); }
            else {
                const varMi = await client.query(
                    "SELECT 1 FROM yonetim_gorevleri WHERE sahip_id=$1 AND baslik=$2", [sahipId, baslik]);
                if (varMi.rowCount) ayni++; else { bulunamadi++; console.log(`⚠️  DB'de bulunamadı: ${baslik}`); }
            }
        }
        console.log(`\n✨ Tamamlandı: ${guncellendi} güncellendi, ${ayni} zaten doğruydu${bulunamadi ? `, ${bulunamadi} bulunamadı` : ''}.`);
    } catch (e) {
        console.error('❌ Hata:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}
main();

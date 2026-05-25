// =============================================================================
// TEDARİKÇİ MIGRATION
// tedarikci-import.tsv → tedarikciler tablosu
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const TSV_PATH = path.join(__dirname, 'tedarikci-import.tsv');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU');
    console.log('═'.repeat(60));

    const raw = fs.readFileSync(TSV_PATH, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const header = lines[0].split('\t').map(s => s.trim());
    console.log('Başlıklar:', header.join(' | '));

    const idx = {
        firma: header.indexOf('Tedarikçi Adı'),
        email: header.indexOf('E-posta Adresi'),
        yetkili: header.indexOf('Yetkili'),
        not: header.indexOf('Not')
    };
    if (idx.firma < 0) {
        console.error('❌ Tedarikçi Adı sütunu bulunamadı.');
        process.exit(1);
    }

    const veri = lines.slice(1).map(l => l.split('\t'));
    console.log(`Toplam satır: ${veri.length}`);

    // Mevcut firmaları al (çakışma engellemek için)
    const mevcutRes = await pool.query("SELECT LOWER(firma_adi) as ad FROM tedarikciler");
    const mevcutSet = new Set(mevcutRes.rows.map(r => r.ad.trim()));
    console.log(`DB'de mevcut: ${mevcutSet.size}`);

    const kayitlar = [];
    let bos = 0, dup = 0;
    for (const r of veri) {
        const firma = (r[idx.firma] || '').trim();
        if (!firma) { bos++; continue; }
        if (mevcutSet.has(firma.toLowerCase())) { dup++; continue; }
        kayitlar.push({
            firma_adi: firma,
            email: (r[idx.email] || '').trim() || null,
            yetkili_kisi: (r[idx.yetkili] || '').trim() || null,
            adres: (r[idx.not] || '').trim() || null   // Not → adres alanı
        });
    }

    console.log(`\n📋 İşlenecek: ${kayitlar.length}, Atlanan (zaten var): ${dup}, Boş satır: ${bos}`);
    console.log('\nÖrnek (ilk 3):');
    kayitlar.slice(0, 3).forEach(k => console.log(`  • ${k.firma_adi} | ${k.email || '-'} | ${k.yetkili_kisi || '-'}`));

    if (!APPLY) {
        console.log(`\n💡 Aktarmak için: node migrate-tedarikci.js --apply`);
        await pool.end();
        return;
    }

    let basarili = 0, hata = 0;
    for (const k of kayitlar) {
        try {
            await pool.query(`
                INSERT INTO tedarikciler (firma_adi, email, yetkili_kisi, adres, durum)
                VALUES ($1,$2,$3,$4,'AKTİF')
            `, [k.firma_adi, k.email, k.yetkili_kisi, k.adres]);
            basarili++;
        } catch (e) {
            hata++;
            console.log(`  ❌ ${k.firma_adi}: ${e.message.substring(0,80)}`);
        }
    }
    console.log(`\n✅ Eklendi: ${basarili}, ❌ Hata: ${hata}`);
    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

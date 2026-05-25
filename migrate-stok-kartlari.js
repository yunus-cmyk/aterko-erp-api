// =============================================================================
// STOK KARTLARI MIGRATION
// stok-kartlari-import.tsv → Supabase stok_kartlari tablosu
//
// Kullanım:
//   node migrate-stok-kartlari.js          → DRY RUN (sadece gösterim)
//   node migrate-stok-kartlari.js --apply  → GERÇEK GÖÇ
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const TSV_PATH = path.join(__dirname, 'stok-kartlari-import.tsv');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------- Yardımcı ----------
function parseTRNumber(str) {
    if (!str) return 0;
    return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0;
}

function normalizeStokTipi(s) {
    if (!s) return null;
    const t = s.trim().toLowerCase();
    if (t.startsWith('hammadde')) return 'Hammadde';
    if (t.startsWith('yarı') || t.startsWith('yari')) return 'Yarımamül';
    if (t.includes('direkt') || t.includes('malzeme')) return 'Direkt Malzeme';
    return s.trim();
}

// Stok kodu üretici: TIP-KAT-SIRA (örn. HAM-VID-001)
function uretStokKodu(tip, kategori, sira) {
    const tipKisa = (tip || 'X').substring(0, 3).toUpperCase();
    const katKisa = (kategori || 'X').replace(/[^A-Za-zĞÜŞİÖÇğüşıöç]/g, '').substring(0, 3).toUpperCase();
    return `${tipKisa}-${katKisa}-${String(sira).padStart(4, '0')}`;
}

async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU');
    console.log('═'.repeat(60));

    const raw = fs.readFileSync(TSV_PATH, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const header = lines[0].split('\t');
    console.log('Başlıklar:', header.join(' | '));

    const data = lines.slice(1).map(l => l.split('\t'));
    console.log(`📊 Okunan satır sayısı: ${data.length}`);

    // Sütun indekslerini bul
    const idx = {
        tip:    header.indexOf('Stok Tipi'),
        kat:    header.indexOf('Kategori'),
        kod:    header.indexOf('Stok Kodu'),
        ad:     header.indexOf('Stok Adı'),
        birim:  header.indexOf('Birim'),
        kritik: header.indexOf('Kritik Stok Miktarı'),
        para:   header.indexOf('Para Birimi'),
        acilis: header.indexOf('Açılış Stoğu')
    };
    if (idx.tip < 0 || idx.kat < 0 || idx.ad < 0 || idx.birim < 0) {
        console.error('❌ Zorunlu başlıklar eksik (Stok Tipi/Kategori/Stok Adı/Birim).');
        process.exit(1);
    }

    // Mevcut stok kodlarını al (çakışma engellemek için)
    const mevcutKodlar = new Set();
    const eskiKayitlar = await pool.query('SELECT stok_kodu FROM stok_kartlari');
    eskiKayitlar.rows.forEach(r => mevcutKodlar.add(r.stok_kodu));
    console.log(`💾 Veritabanında zaten ${mevcutKodlar.size} kayıt var (çakışan kodlar atlanacak).`);

    // Tip+Kategori bazında sıralama sayacı (otomatik kod üretimi için)
    const sayac = {};
    function siradakiSira(tip, kat) {
        const k = `${tip}|${kat}`;
        sayac[k] = (sayac[k] || 0) + 1;
        return sayac[k];
    }

    // Veriyi hazırla
    const kayitlar = [];
    const hatalar = [];
    for (let i = 0; i < data.length; i++) {
        const r = data[i];
        const tip = normalizeStokTipi(r[idx.tip]);
        const kat = (r[idx.kat] || '').trim();
        const ad = (r[idx.ad] || '').trim();
        const birim = (r[idx.birim] || '').trim() || 'ADET';

        if (!tip) { hatalar.push({ satir: i + 2, sebep: 'Stok Tipi boş' }); continue; }
        if (!kat) { hatalar.push({ satir: i + 2, sebep: 'Kategori boş' }); continue; }
        if (!ad)  { hatalar.push({ satir: i + 2, sebep: 'Stok Adı boş' });  continue; }

        let kod = idx.kod >= 0 ? (r[idx.kod] || '').trim() : '';
        if (!kod) {
            kod = uretStokKodu(tip, kat, siradakiSira(tip, kat));
        }

        kayitlar.push({
            stok_tipi: tip,
            kategori: kat,
            stok_kodu: kod,
            stok_adi: ad,
            birim: birim,
            kritik_stok_miktari: idx.kritik >= 0 ? parseTRNumber(r[idx.kritik]) : 0,
            para_birimi: (idx.para >= 0 && r[idx.para] ? r[idx.para].trim() : 'TL'),
            guncel_stok_miktari: idx.acilis >= 0 ? parseTRNumber(r[idx.acilis]) : 0
        });
    }

    // Tip ve Kategori bazlı özet
    const tipOzet = {};
    kayitlar.forEach(k => { tipOzet[k.stok_tipi] = (tipOzet[k.stok_tipi] || 0) + 1; });
    console.log('\n📋 Stok Tipi Dağılımı:');
    Object.entries(tipOzet).forEach(([t, n]) => console.log(`  ${t}: ${n}`));
    console.log(`\n⚠️  Hatalı satır: ${hatalar.length}`);
    hatalar.slice(0, 5).forEach(h => console.log(`  • Satır ${h.satir}: ${h.sebep}`));

    console.log('\n📋 ÖRNEK (ilk 3):');
    kayitlar.slice(0, 3).forEach(k => {
        console.log(`  • [${k.stok_tipi}] ${k.kategori} > ${k.stok_kodu} = ${k.stok_adi} (${k.birim})`);
    });

    if (!APPLY) {
        console.log(`\n💡 ${kayitlar.length} kayıt yüklemek için: node migrate-stok-kartlari.js --apply`);
        await pool.end();
        return;
    }

    // Gerçek aktarım
    let basarili = 0, atlanan = 0, hata = 0;
    for (const k of kayitlar) {
        if (mevcutKodlar.has(k.stok_kodu)) {
            // Kod çakışmasında suffix ekle
            let yeniKod = k.stok_kodu;
            let n = 2;
            while (mevcutKodlar.has(yeniKod)) {
                yeniKod = `${k.stok_kodu}-${n++}`;
            }
            k.stok_kodu = yeniKod;
        }
        try {
            await pool.query(`
                INSERT INTO stok_kartlari
                (stok_tipi, kategori, stok_kodu, stok_adi, birim,
                 kritik_stok_miktari, para_birimi, guncel_stok_miktari)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [k.stok_tipi, k.kategori, k.stok_kodu, k.stok_adi, k.birim,
                k.kritik_stok_miktari, k.para_birimi, k.guncel_stok_miktari]);
            mevcutKodlar.add(k.stok_kodu);
            basarili++;
            if (basarili % 100 === 0) console.log(`  ⏳ ${basarili} kayıt yüklendi...`);
        } catch (e) {
            hata++;
            console.log(`  ❌ ${k.stok_kodu} (${k.stok_adi}): ${e.message}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`✅ Eklendi: ${basarili}`);
    console.log(`❌ Hata:    ${hata}`);
    console.log('═'.repeat(60));
    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

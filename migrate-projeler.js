// =============================================================================
// AT ERKO PROJELER MIGRATION SCRIPT
// Eski Google Sheets verisini Supabase'e taşır.
//
// Kullanım:
//   node migrate-projeler.js          → DRY RUN (sadece gösterir, kaydetmez)
//   node migrate-projeler.js --apply  → GERÇEK GÖÇÜ YAPAR
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const CSV_PATH = path.join(__dirname, 'projeler-import.csv');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------- CSV Parser ----------
function parseCsvLine(line) {
    const result = []; let cur = ''; let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
            else inQuote = !inQuote;
        } else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
        else cur += c;
    }
    result.push(cur);
    return result;
}

// ---------- Format Dönüştürücüler ----------
function parseTurkishNumber(str) {
    if (!str) return 0;
    return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0;
}

function parseTurkishDate(str) {
    // "03.04.2026" veya "03.04.2026 00:00" → "2026-04-03"
    if (!str) return null;
    const m = String(str).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

function normalizeBinaTuru(str) {
    if (!str) return null;
    const t = str.trim();
    if (/^Hafif\s*Çelik/i.test(t)) return 'Hafif Çelik';
    if (/^Prefabrik/i.test(t)) return 'Prefabrik';
    if (/Konteyner/i.test(t)) return 'Konteyner';
    if (/Y\.?\s*Çelik|Yapısal\s*Çelik/i.test(t)) return 'Yapısal Çelik';
    return t;
}

function normalizeDurum(str) {
    if (!str) return 'BEKLEMEDE';
    const d = str.trim().toUpperCase();
    if (d === 'TESLİM') return 'TESLİM EDİLDİ';
    return d;
}

// ---------- Ana İşlem ----------
async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU (sadece gösterim)');
    console.log('═'.repeat(60));

    const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n').slice(1).filter(l => l.trim());

    // Önce satırları gruplandır: proje kodu → { proje, teslimatlar[] }
    const projeMap = new Map();

    for (const line of lines) {
        const c = parseCsvLine(line);
        const projeKodu = (c[3] || '').trim();
        if (!/^\d{5}$/.test(projeKodu)) continue;

        let ekVeriler = {};
        try { if (c[23]) ekVeriler = JSON.parse(c[23]); } catch (e) {}

        if (!projeMap.has(projeKodu)) {
            projeMap.set(projeKodu, {
                proje: {
                    proje_kodu: projeKodu,
                    musteri_adi: (c[4] || '').trim(),
                    proje_adi: (c[5] || '').trim(),
                    sozlesme_tarihi: parseTurkishDate(c[10]),
                    satis_turu: ekVeriler['Satış Türü'] || 'Yurtiçi',
                    nakliye: (c[13] || 'Aterko').trim(),
                    para_birimi: (c[17] || 'TL').trim(),
                    kdv_orani: parseInt(c[18]) || 20,
                    aset_link: (c[14] || '').trim() || null,
                    dokumanlar_link: (c[15] || '').trim() || null
                },
                teslimatlar: []
            });
        }

        const teslimat = {
            bina_adi: (c[6] || '').trim(),
            bina_turu: normalizeBinaTuru(c[7]),
            bina_tipi: (c[8] || '').trim(),
            buyukluk_m2: parseTurkishNumber(c[9]),
            sevkiyat_baslangici: parseTurkishDate(c[11]),
            bina_yeri: (c[12] || '').trim(),
            kdvsiz_tutar: parseTurkishNumber(c[16]),
            durum: normalizeDurum(c[2]),
            kat_yuksekligi: ekVeriler['Kat Yüksekliği'] || null,
            kat_adedi: ekVeriler['Kat Adedi'] || null,
            bina_adedi: parseInt(ekVeriler['Bina Adedi']) || null,
            konteyner_ebadi: ekVeriler['Konteyner Ebadı'] || null,
            konteyner_miktari: parseInt(ekVeriler['Konteyner Miktarı']) || null,
            dis_duvar_kesiti: ekVeriler['Dış Duvar Kesiti'] || null,
            ic_duvar_kesiti: ekVeriler['İç Duvar Kesiti'] || null
        };

        projeMap.get(projeKodu).teslimatlar.push(teslimat);
    }

    console.log(`📊 Toplam ${projeMap.size} eşsiz proje, ${lines.length} teslimat hazırlandı.\n`);

    // Mevcut projeleri çek (çakışma kontrolü için)
    const existing = await pool.query('SELECT proje_kodu FROM projeler');
    const existingKodlar = new Set(existing.rows.map(r => r.proje_kodu));
    console.log(`💾 Veritabanında zaten ${existingKodlar.size} proje var.`);

    let yeni = 0, atlanan = 0, hata = 0;
    const ornekYeni = [];
    let islenen = 0;

    for (const [kodu, { proje, teslimatlar }] of projeMap) {
        if (existingKodlar.has(kodu)) {
            atlanan++;
            continue;
        }
        yeni++;
        if (ornekYeni.length < 5) ornekYeni.push({ proje, sayi: teslimatlar.length });

        if (!APPLY) continue;

        try {
            // Daha hızlı: doğrudan pool.query (transaction yok), arada ilerleme bildirimi
            const r = await pool.query(`
                INSERT INTO projeler (proje_kodu, musteri_adi, proje_adi, sozlesme_tarihi,
                                      satis_turu, nakliye, para_birimi, kdv_orani)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
            `, [proje.proje_kodu, proje.musteri_adi, proje.proje_adi, proje.sozlesme_tarihi,
                proje.satis_turu, proje.nakliye, proje.para_birimi, proje.kdv_orani]);
            const projeId = r.rows[0].id;

            for (const t of teslimatlar) {
                await pool.query(`
                    INSERT INTO proje_teslimatlari
                    (proje_id, bina_adi, bina_turu, bina_tipi, kat_yuksekligi, kat_adedi, bina_adedi,
                     konteyner_ebadi, konteyner_miktari, dis_duvar_kesiti, ic_duvar_kesiti,
                     buyukluk_m2, sevkiyat_baslangici, bina_yeri, kdvsiz_tutar, durum)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                `, [projeId, t.bina_adi, t.bina_turu, t.bina_tipi, t.kat_yuksekligi, t.kat_adedi, t.bina_adedi,
                    t.konteyner_ebadi, t.konteyner_miktari, t.dis_duvar_kesiti, t.ic_duvar_kesiti,
                    t.buyukluk_m2, t.sevkiyat_baslangici, t.bina_yeri, t.kdvsiz_tutar, t.durum]);
            }
            islenen++;
            if (islenen % 20 === 0) console.log(`  ⏳ ${islenen} proje yüklendi...`);
        } catch (e) {
            hata++;
            console.log(`  ❌ ${kodu}: ${e.message}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📋 ÖRNEK YENİ EKLENECEK PROJELER (ilk 5):');
    ornekYeni.forEach(({ proje, sayi }) => {
        console.log(`  • [${proje.proje_kodu}] ${proje.musteri_adi} - ${proje.proje_adi} (${sayi} teslimat)`);
    });
    console.log('═'.repeat(60));
    console.log(`✅ Eklenecek: ${yeni} yeni proje`);
    console.log(`⏭️  Atlanacak: ${atlanan} (zaten var)`);
    if (APPLY) console.log(`❌ Hata: ${hata}`);
    console.log('═'.repeat(60));

    if (!APPLY && yeni > 0) {
        console.log('\n💡 Gerçekten taşımak için:  node migrate-projeler.js --apply');
    }

    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

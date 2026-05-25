// =============================================================================
// FORM TANIMLARI MIGRATION
// "FormTanimlari" Google Sheet → Supabase form_tanimlari tablosu
//
// Kullanım:
//   node migrate-form-tanimlari.js          → DRY RUN
//   node migrate-form-tanimlari.js --apply  → GERÇEK GÖÇ
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const CSV_PATH = path.join(__dirname, 'form-tanimlari-import.csv');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU');
    console.log('═'.repeat(60));

    // 1. Tabloyu oluştur (yoksa)
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS form_tanimlari (
            id SERIAL PRIMARY KEY,
            bina_turu TEXT NOT NULL,
            bolum_sirasi INT,
            bolum_adi TEXT,
            soru_sirasi INT,
            soru TEXT NOT NULL,
            giris_tipi TEXT,
            secenekler JSONB,
            zorunlu BOOLEAN DEFAULT false,
            kurallar TEXT,
            kosullar TEXT,
            kayit_tarihi TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_form_tanimlari_bina_turu ON form_tanimlari(bina_turu);
    `;

    if (APPLY) {
        console.log('📦 form_tanimlari tablosu kontrol ediliyor / oluşturuluyor...');
        await pool.query(createTableSQL);
        console.log('✅ Tablo hazır.');
    } else {
        console.log('📦 (Dry-run) Şu tablo oluşturulacak:');
        console.log('   form_tanimlari (bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru, giris_tipi, secenekler, zorunlu, kurallar, kosullar)');
    }

    // 2. CSV oku
    const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n').slice(1).filter(l => l.trim());

    const kayitlar = [];
    for (const line of lines) {
        const c = parseCsvLine(line);
        const binaTuruRaw = (c[0] || '').trim();
        const soru = (c[4] || '').trim();
        if (!binaTuruRaw || !soru) continue;

        // Birden fazla bina türü olabilir: "Prefabrik,Konteyner"
        const turler = binaTuruRaw.split(',').map(s => s.trim()).filter(Boolean);
        const secenekler = (c[6] || '').trim()
            ? (c[6] || '').split(',').map(s => s.trim()).filter(Boolean)
            : [];

        for (const tur of turler) {
            kayitlar.push({
                bina_turu: tur,
                bolum_sirasi: parseInt(c[1]) || 0,
                bolum_adi: (c[2] || '').trim(),
                soru_sirasi: parseInt(c[3]) || 0,
                soru: soru,
                giris_tipi: (c[5] || 'METIN').trim(),
                secenekler: secenekler,
                zorunlu: (c[7] || '').trim().toUpperCase() === 'EVET',
                kurallar: (c[8] || '').trim() || null,
                kosullar: (c[9] || '').trim() || null
            });
        }
    }

    console.log(`📊 Toplam ${kayitlar.length} form alanı hazırlandı.`);

    // Bina türlerine göre özet
    const turOzet = {};
    const bolumOzet = {};
    kayitlar.forEach(k => {
        turOzet[k.bina_turu] = (turOzet[k.bina_turu] || 0) + 1;
        const key = k.bina_turu + ' > ' + k.bolum_adi;
        bolumOzet[key] = (bolumOzet[key] || 0) + 1;
    });
    console.log('\nBina Türlerine Göre:');
    Object.entries(turOzet).forEach(([k, v]) => console.log(`  ${k}: ${v} alan`));

    if (APPLY) {
        // Önce mevcut kayıtları temizle (idempotent)
        await pool.query('DELETE FROM form_tanimlari');
        console.log('\n🧹 Mevcut form tanımları silindi (yeniden yüklenecek).');

        let basarili = 0, hata = 0;
        for (const k of kayitlar) {
            try {
                await pool.query(`
                    INSERT INTO form_tanimlari
                    (bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru, giris_tipi, secenekler, zorunlu, kurallar, kosullar)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                `, [k.bina_turu, k.bolum_sirasi, k.bolum_adi, k.soru_sirasi, k.soru,
                    k.giris_tipi, JSON.stringify(k.secenekler), k.zorunlu, k.kurallar, k.kosullar]);
                basarili++;
            } catch (e) {
                hata++;
                console.log(`  ❌ ${k.bina_turu} / ${k.soru}: ${e.message}`);
            }
        }
        console.log(`\n✅ Eklendi: ${basarili} | ❌ Hata: ${hata}`);
    } else {
        console.log('\n📋 ÖRNEK (ilk 3):');
        kayitlar.slice(0, 3).forEach(k => {
            console.log(`  • [${k.bina_turu}] ${k.bolum_adi} > "${k.soru}" (${k.giris_tipi})`);
            if (k.secenekler.length) console.log(`    Seçenekler: ${k.secenekler.join(', ').substring(0, 80)}...`);
        });
        console.log('\n💡 Gerçek göç için:  node migrate-form-tanimlari.js --apply');
    }

    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

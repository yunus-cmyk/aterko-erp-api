// =============================================================================
// FAZ B-0 MIGRATION
// Üretim / Sevkiyat / Montaj modülleri için veri modeli omurgası
// =============================================================================
// Çalıştırma:
//   node migrate-faz-b.js          → DRY RUN (sadece neyi değiştireceğini gösterir)
//   node migrate-faz-b.js --apply  → Gerçek değişiklikleri uygula
//
// IDEMPOTENT: defalarca çalıştırılabilir, var olan kolon/tabloyu tekrar oluşturmaz.
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Sırayla çalıştırılacak DDL adımları
const adimlar = [
    {
        ad: '1) teslimat_urunleri → sayaç sütunları',
        sql: `
            ALTER TABLE teslimat_urunleri
                ADD COLUMN IF NOT EXISTS uretilen_miktar       NUMERIC DEFAULT 0,
                ADD COLUMN IF NOT EXISTS stoktan_ayrilan_miktar NUMERIC DEFAULT 0,
                ADD COLUMN IF NOT EXISTS sevk_edilen_miktar    NUMERIC DEFAULT 0,
                ADD COLUMN IF NOT EXISTS saha_teslim_miktar    NUMERIC DEFAULT 0,
                ADD COLUMN IF NOT EXISTS uygulanan_miktar      NUMERIC DEFAULT 0,
                ADD COLUMN IF NOT EXISTS teslim_edilen_miktar  NUMERIC DEFAULT 0;
        `
    },
    {
        ad: '2) teslimat_urunleri → ek ürün & revizyon alanları',
        sql: `
            ALTER TABLE teslimat_urunleri
                ADD COLUMN IF NOT EXISTS is_ek_urun            BOOLEAN DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS ek_urun_onay_durumu  VARCHAR(20),
                ADD COLUMN IF NOT EXISTS revizyon_notu         TEXT;
        `
    },
    {
        ad: '3) proje_teslimatlari → Ürün Listesi yayın akışı alanları',
        sql: `
            ALTER TABLE proje_teslimatlari
                ADD COLUMN IF NOT EXISTS urun_listesi_yayin_durumu VARCHAR(20) DEFAULT 'TASLAK',
                ADD COLUMN IF NOT EXISTS yayin_onay_gonderen_email VARCHAR(255),
                ADD COLUMN IF NOT EXISTS yayin_onay_gonderme_tarihi TIMESTAMP,
                ADD COLUMN IF NOT EXISTS yayinlayan_email           VARCHAR(255),
                ADD COLUMN IF NOT EXISTS yayinlama_tarihi           TIMESTAMP,
                ADD COLUMN IF NOT EXISTS yayin_red_notu             TEXT;
        `
    },
    {
        ad: '4) uretim_is_emirleri tablosu',
        sql: `
            CREATE TABLE IF NOT EXISTS uretim_is_emirleri (
                id              SERIAL PRIMARY KEY,
                emir_no         VARCHAR(30) UNIQUE NOT NULL,
                ustabasi_adi    VARCHAR(150),
                durum           VARCHAR(20) DEFAULT 'HAZIR',  -- HAZIR / UYGULANIYOR / TAMAMLANDI / IPTAL
                olusturan_email VARCHAR(255),
                olusturma_tarihi TIMESTAMP DEFAULT NOW(),
                tamamlanma_tarihi TIMESTAMP,
                notlar          TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ie_durum ON uretim_is_emirleri(durum);
        `
    },
    {
        ad: '5) uretim_is_emri_kalemleri tablosu (cross-teslimat çoklu kalem)',
        sql: `
            CREATE TABLE IF NOT EXISTS uretim_is_emri_kalemleri (
                id                 SERIAL PRIMARY KEY,
                is_emri_id         INTEGER NOT NULL REFERENCES uretim_is_emirleri(id) ON DELETE CASCADE,
                teslimat_urun_id   INTEGER NOT NULL REFERENCES teslimat_urunleri(id),
                atanan_miktar      NUMERIC NOT NULL,
                tamamlanan_miktar  NUMERIC DEFAULT 0,
                kayit_tarihi       TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_iek_is_emri ON uretim_is_emri_kalemleri(is_emri_id);
            CREATE INDEX IF NOT EXISTS idx_iek_tu     ON uretim_is_emri_kalemleri(teslimat_urun_id);
        `
    },
    {
        ad: '6) sevkiyat_belgeleri tablosu',
        sql: `
            CREATE TABLE IF NOT EXISTS sevkiyat_belgeleri (
                id              SERIAL PRIMARY KEY,
                sevkiyat_no     VARCHAR(30) UNIQUE NOT NULL,
                plaka           VARCHAR(20),
                sofor_adi       VARCHAR(150),
                sofor_telefon   VARCHAR(30),
                irsaliye_no     VARCHAR(50),
                sevk_tarihi     DATE,
                durum           VARCHAR(20) DEFAULT 'HAZIRLANIYOR',  -- HAZIRLANIYOR / YOLDA / TESLIM / IPTAL
                ek_dosyalar     JSONB DEFAULT '[]'::jsonb,
                olusturan_email VARCHAR(255),
                olusturma_tarihi TIMESTAMP DEFAULT NOW(),
                notlar          TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sb_durum ON sevkiyat_belgeleri(durum);
            CREATE INDEX IF NOT EXISTS idx_sb_tarih ON sevkiyat_belgeleri(sevk_tarihi);
        `
    },
    {
        ad: '7) sevkiyat_kalemleri tablosu (cross-teslimat çoklu kalem)',
        sql: `
            CREATE TABLE IF NOT EXISTS sevkiyat_kalemleri (
                id                SERIAL PRIMARY KEY,
                sevkiyat_id       INTEGER NOT NULL REFERENCES sevkiyat_belgeleri(id) ON DELETE CASCADE,
                teslimat_urun_id  INTEGER NOT NULL REFERENCES teslimat_urunleri(id),
                miktar            NUMERIC NOT NULL,
                kayit_tarihi      TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_sk_sevk ON sevkiyat_kalemleri(sevkiyat_id);
            CREATE INDEX IF NOT EXISTS idx_sk_tu   ON sevkiyat_kalemleri(teslimat_urun_id);
        `
    },
    {
        ad: '8) montaj_hareketleri tablosu (sahaya teslim / uygulama / müşteri teslim logu)',
        sql: `
            CREATE TABLE IF NOT EXISTS montaj_hareketleri (
                id               SERIAL PRIMARY KEY,
                teslimat_urun_id INTEGER NOT NULL REFERENCES teslimat_urunleri(id),
                hareket_tipi     VARCHAR(30) NOT NULL,  -- SAHA_TESLIM / UYGULANDI / MUSTERIYE_TESLIM
                miktar           NUMERIC NOT NULL,
                hareket_tarihi   DATE DEFAULT CURRENT_DATE,
                kullanici_email  VARCHAR(255),
                notlar           TEXT,
                kayit_tarihi     TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_mh_tu    ON montaj_hareketleri(teslimat_urun_id);
            CREATE INDEX IF NOT EXISTS idx_mh_tip   ON montaj_hareketleri(hareket_tipi);
            CREATE INDEX IF NOT EXISTS idx_mh_tarih ON montaj_hareketleri(hareket_tarihi);
        `
    }
];

async function main() {
    console.log(APPLY ? '🔴 GERÇEK MIGRATION MODU' : '🟢 DRY RUN MODU (--apply ile çalıştır)');
    console.log('═'.repeat(70));

    for (const adim of adimlar) {
        console.log(`\n📋 ${adim.ad}`);
        if (APPLY) {
            try {
                await pool.query(adim.sql);
                console.log('   ✅ Uygulandı');
            } catch (e) {
                console.log('   ❌ HATA: ' + e.message);
                console.log('   Devam ediliyor...');
            }
        } else {
            // DRY RUN: SQL'in kısa özetini göster
            const ozet = adim.sql.replace(/\s+/g, ' ').substring(0, 130) + '...';
            console.log(`   📝 SQL: ${ozet}`);
        }
    }

    // Doğrulama: sonuç şemasını göster (sadece APPLY sonrası)
    if (APPLY) {
        console.log('\n' + '═'.repeat(70));
        console.log('📊 DOĞRULAMA — Yeni şema durumu');
        const tu = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name='teslimat_urunleri'
            AND column_name IN ('uretilen_miktar','stoktan_ayrilan_miktar','sevk_edilen_miktar',
                                'saha_teslim_miktar','uygulanan_miktar','teslim_edilen_miktar',
                                'is_ek_urun','ek_urun_onay_durumu','revizyon_notu')
            ORDER BY column_name`);
        console.log('teslimat_urunleri eklenen sütunlar (' + tu.rowCount + '/9):',
            tu.rows.map(r => r.column_name).join(', '));

        const pt = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name='proje_teslimatlari'
            AND column_name LIKE '%yayin%' OR column_name LIKE 'urun_listesi%'
            ORDER BY column_name`);
        console.log('proje_teslimatlari yayın sütunları (' + pt.rowCount + '/6):',
            pt.rows.map(r => r.column_name).join(', '));

        const tablolar = await pool.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema='public'
            AND table_name IN ('uretim_is_emirleri','uretim_is_emri_kalemleri',
                              'sevkiyat_belgeleri','sevkiyat_kalemleri','montaj_hareketleri')
            ORDER BY table_name`);
        console.log('Yeni tablolar (' + tablolar.rowCount + '/5):',
            tablolar.rows.map(r => r.table_name).join(', '));
    } else {
        console.log('\n💡 Gerçek değişiklik için:  node migrate-faz-b.js --apply');
    }

    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

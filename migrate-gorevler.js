// =============================================================================
// migrate-gorevler.js — Görev Takip Modülü (Yönetim / Çekirdek Ekip) şeması + seed
// Kullanım: node migrate-gorevler.js
// Idempotent: tekrar çalıştırmak güvenlidir (IF NOT EXISTS / ON CONFLICT).
// =============================================================================
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5, idleTimeoutMillis: 30000
});

// Çekirdek ekip (deploy sırasında DB'den doğrulandı — 2026-07)
const CEKIRDEK_EMAILLER = [
    'yunus@aterko.com',        // Yunus Asım Aksoy (ADMIN)
    'yakup@aterko.com',        // Yakup Karakelle (YONETIM)
    'mahmut@aterko.com',       // Mahmut Akdağcık (SATIS)
    'mehmetuysal@aterko.com',  // Mehmet Uysal (YONETIM)
    'ofb@aterko.com'           // Ömer Faruk Bozömer (MUHASEBE)
];

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1) kullanicilar.cekirdek_ekip
        await client.query("ALTER TABLE kullanicilar ADD COLUMN IF NOT EXISTS cekirdek_ekip BOOLEAN DEFAULT FALSE");

        // 2) yonetim_gorevleri
        await client.query(`
            CREATE TABLE IF NOT EXISTS yonetim_gorevleri (
                id SERIAL PRIMARY KEY,
                baslik TEXT NOT NULL,
                aciklama TEXT,
                sahip_id INTEGER NOT NULL REFERENCES kullanicilar(id),
                olusturan_id INTEGER NOT NULL REFERENCES kullanicilar(id),
                alan TEXT NOT NULL DEFAULT 'GENEL',
                oncelik TEXT NOT NULL DEFAULT 'NORMAL',
                durum TEXT NOT NULL DEFAULT 'ACIK',
                bitis_tarihi DATE NOT NULL,
                tamamlanma_tarihi TIMESTAMPTZ,
                taahhut BOOLEAN DEFAULT FALSE,
                olusturma_tarihi TIMESTAMPTZ DEFAULT NOW()
            )`);
        // Sık kullanılan filtreler için indeksler
        await client.query("CREATE INDEX IF NOT EXISTS idx_gorev_sahip ON yonetim_gorevleri(sahip_id)");
        await client.query("CREATE INDEX IF NOT EXISTS idx_gorev_durum ON yonetim_gorevleri(durum)");
        await client.query("CREATE INDEX IF NOT EXISTS idx_gorev_bitis ON yonetim_gorevleri(bitis_tarihi)");
        // Taahhüt vadesi (30 / 90 gün) — yalnızca taahhut=TRUE görevlerde anlamlı
        await client.query("ALTER TABLE yonetim_gorevleri ADD COLUMN IF NOT EXISTS taahhut_vade INTEGER");

        // 3) gorev_notlari
        await client.query(`
            CREATE TABLE IF NOT EXISTS gorev_notlari (
                id SERIAL PRIMARY KEY,
                gorev_id INTEGER NOT NULL REFERENCES yonetim_gorevleri(id) ON DELETE CASCADE,
                yazan_id INTEGER NOT NULL REFERENCES kullanicilar(id),
                not_metni TEXT NOT NULL,
                olusturma_tarihi TIMESTAMPTZ DEFAULT NOW()
            )`);
        await client.query("CREATE INDEX IF NOT EXISTS idx_gorevnot_gorev ON gorev_notlari(gorev_id)");

        // 4) Seed — çekirdek ekip işaretle
        const up = await client.query(
            "UPDATE kullanicilar SET cekirdek_ekip=TRUE WHERE email = ANY($1) RETURNING id, ad_soyad, email, rol",
            [CEKIRDEK_EMAILLER]);

        await client.query('COMMIT');

        console.log('✅ Görev Takip şeması hazır (yonetim_gorevleri, gorev_notlari, kullanicilar.cekirdek_ekip).');
        console.log(`✅ Çekirdek ekip işaretlendi (${up.rowCount}/${CEKIRDEK_EMAILLER.length}):`);
        up.rows.forEach(u => console.log(`   #${u.id}  ${u.ad_soyad}  <${u.email}>  ${u.rol}`));
        const bulunmayan = CEKIRDEK_EMAILLER.filter(e => !up.rows.some(u => u.email === e));
        if (bulunmayan.length) console.log('⚠️  Bulunamayan e-postalar:', bulunmayan.join(', '));
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Migration hatası:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}
main();

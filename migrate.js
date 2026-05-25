require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10, // Bağlantı havuzunu optimize ediyoruz
    idleTimeoutMillis: 30000
});

function parseCsvLine(line, delimiter) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === delimiter && !inQuotes) {
            result.push(current.trim().replace(/^"|"$/g, ''));
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
}

// İnternet kopmalarına karşı gecikmeli tekrar deneme fonksiyonu
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startMigration() {
    console.log("🚀 Aterko ERP Ağ Hatasına Dayanıklı Göç Başlıyor...");
    const csvPath = path.join(__dirname, 'veriler.csv');

    if (!fs.existsSync(csvPath)) {
        console.error("❌ HATA: 'veriler.csv' dosyası bulunamadı!");
        process.exit(1);
    }

    const fileContent = fs.readFileSync(csvPath, 'utf-8');
    const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
    lines.shift(); // Başlığı atla
    
    console.log(`📊 Toplam ${lines.length} satır işlenecek. (Daha önce eklenenler otomatik atlanacaktır...) \n`);

    let basariliKontrol = 0;
    const ProjeHaritasi = new Map();

    for (let i = 0; i < lines.length; i++) {
        const row = parseCsvLine(lines[i], ',');
        if (!row[3] || row[3].trim() === "" || row[3].toLowerCase().includes("proje no")) continue;

        const safeRow = Array.from({ length: 24 }, (_, idx) => row[idx] || "");

        const projeDurumu   = safeRow[2].trim() || 'BEKLEMEDE';
        const projeNo       = safeRow[3].trim();
        const musteriAdi    = safeRow[4].trim();
        const projeAdi      = safeRow[5].trim();
        const binaAdi       = safeRow[6].trim();
        const binaTuru      = safeRow[7].trim();
        const binaTipi      = safeRow[8].trim();
        const buyukluk      = safeRow[9].trim();
        const sozlesmeTarihi = safeRow[10].trim();
        const sevkiyatBasl  = safeRow[11].trim();
        const binaYeri      = safeRow[12].trim();
        const nakliye       = safeRow[13].trim();
        const asetLink      = safeRow[14].trim();
        const dokumanLink   = safeRow[15].trim();
        const tutarKdvsizRaw = safeRow[16].trim();
        const paraBirimi    = safeRow[17].trim() || 'TL';
        const kdvOrani      = safeRow[18].trim() || '%20';
        const tutarKdvli    = safeRow[19].trim();
        const tutarKdvliTL  = safeRow[20].trim();
        const satirId       = safeRow[22].trim() || 'MIG-' + Math.random().toString(36).substring(2, 11).toUpperCase();
        
        let ekVeriler = {};
        try { if (safeRow[23]) ekVeriler = JSON.parse(safeRow[23]); } catch (e) {}

        let dbProjeId;
        let attempts = 0;
        let success = false;

        // Ağ hatası durumunda satırı 3 kez yeniden deneme döngüsü
        while (attempts < 3 && !success) {
            try {
                // 1. Projeyi Kaydet / Getir
                if (ProjeHaritasi.has(projeNo)) {
                    dbProjeId = ProjeHaritasi.get(projeNo);
                } else {
                    const projeSorgu = `
                        INSERT INTO projeler (proje_kodu, musteri_adi, proje_adi, sozlesme_tarihi, nakliye, para_birimi, kdv_orani, aset_link, dokumanlar_link, proje_durumu)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (proje_kodu) DO UPDATE SET musteri_adi = EXCLUDED.musteri_adi
                        RETURNING id;
                    `;
                    // Pool.query kullanımı ağ kopmalarında otomatik yeni hat açılmasını sağlar
                    const projeRes = await pool.query(projeSorgu, [
                        projeNo, musteriAdi, projeAdi, sozlesmeTarihi, nakliye, paraBirimi, kdvOrani, asetLink, dokumanLink, projeDurumu
                    ]);
                    dbProjeId = projeRes.rows[0].id;
                    ProjeHaritasi.set(projeNo, dbProjeId);
                }

                // 2. Teslimatı Kaydet
                const kdvsizTutar = parseFloat(tutarKdvsizRaw.replace(/\./g, '').replace(',', '.')) || 0;
                const teslimatSorgu = `
                    INSERT INTO proje_teslimatlari (satir_id, proje_id, bina_adi, bina_turu, bina_tipi, buyukluk, sozlesme_tutari_kdvsiz, sozlesme_tutari_kdvli, sozlesme_tutari_kdvli_tl, durum, sevkiyat_takvimi, ek_veriler)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (satir_id) DO NOTHING;
                `;
                const sevkiyatTakvimi = ekVeriler.sevkiyatlar || (sevkiyatBasl ? [{ sira: 1, tarih: sevkiyatBasl, not: "" }] : []);

                await pool.query(teslimatSorgu, [
                    satirId, dbProjeId, binaAdi, binaTuru, binaTipi, buyukluk,
                    kdvsizTutar, tutarKdvli, tutarKdvliTL, projeDurumu, JSON.stringify(sevkiyatTakvimi), JSON.stringify(ekVeriler)
                ]);

                basariliKontrol++;
                success = true; // Döngüden çıkış
            } catch (error) {
                attempts++;
                console.log(`⚠️ Hat kesintisi algılandı (Satır: ${basariliKontrol + 1}). Yeniden deneniyor... (${attempts}/3)`);
                await sleep(2000); // 2 saniye bekle ve tekrar dene
                if (attempts >= 3) {
                    console.error(`❌ Satır işlenirken kalıcı hata: ${error.message}`);
                }
            }
        }

        if (basariliKontrol % 50 === 0 || i === lines.length - 1) {
            console.log(`▓⏳ İlerleme: %${Math.round((basariliKontrol / lines.length) * 100)} (${basariliKontrol} / ${lines.length} satır güvenle işlendi...)`);
        }
    }

    console.log(`\n✨ BAŞARIYLA TAMAMLANDI: Toplam ${basariliKontrol} satır Supabase SQL veritabanına nakledildi! 🎉`);
    await pool.end();
}

startMigration();
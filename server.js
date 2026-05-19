require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fetch = require('node-fetch'); // Canlı döviz kurları için terminalde otomatik kullanılacak

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// YARDIMCI FONKSİYON: Canlı Döviz Kuru Getir (Apps Script'teki GOOGLEFINANCE alternatifi)
async function getDovizKuru(birim) {
    if (!birim || birim === 'TL') return 1;
    try {
        // Ücretsiz ve anahtarsız açık kur servisinden TRY paritelerini çekiyoruz
        const response = await fetch(`https://open.er-api.com/v6/latest/USD`);
        const data = await response.json();
        if (data && data.rates) {
            const usdToTry = data.rates.TRY;
            if (birim === 'USD') return usdToTry;
            if (birim === 'EUR') {
                const usdToEur = data.rates.EUR;
                return usdToTry / usdToEur; // Çapraz kur hesabı
            }
        }
        return 1;
    } catch (error) {
        console.error("Döviz kuru çekilemedi, 1 varsayılıyor:", error.message);
        return 1;
    }
}

// YARDIMCI FONKSİYON: Türk Lirası Formatlama (Örn: 1.250.500,00)
function formatTurkishNumber(num) {
    if (!num || isNaN(num)) return "0,00";
    return num.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================================
// API 1: TÜM PROJE VE TESLİMAT LİSTESİNİ GETİRME (getLists Karşılığı)
// ============================================================================
app.get('/api/get-lists', async (req, res) => {
    try {
        // SQL JOIN kullanarak Projeleri ve onlara bağlı Teslimatları tek seferde çekiyoruz
        const sorgu = `
            SELECT 
                p.id as proje_id, p.proje_kodu, p.musteri_adi, p.proje_adi, p.sozlesme_tarihi, 
                p.nakliye, p.para_birimi, p.kdv_orani, p.aset_link, p.dokumanlar_link, p.proje_durumu, p.ek_veriler as proje_ek,
                t.satir_id, t.bina_adi, t.bina_turu, t.bina_tipi, t.buyukluk, t.sozlesme_tutari_kdvsiz,
                t.sozlesme_tutari_kdvli, t.sozlesme_tutari_kdvli_tl, t.durum as teslimat_durumu, t.sevkiyat_takvimi, t.ek_veriler as teslimat_ek,
                p.kayit_tarihi
            FROM projeler p
            LEFT JOIN proje_teslimatlari t ON p.id = t.proje_id
            ORDER BY p.kayit_tarihi DESC;
        `;
        const { rows } = await pool.query(sorgu);
        
        // Frontend'in (Admin.html) beklediği Google Sheets array formatına geri dönüştürüyoruz (Geriye uyumluluk için)
        const flatProjelerArray = rows.map(r => {
            const projeNoVeAdi = `${r.proje_kodu} / ${r.musteri_adi} - ${r.proje_adi}`;
            const teslimatAdi = `${projeNoVeAdi} [ ${r.bina_adi} / ${r.bina_turu} ] ${r.bina_tipi} – ${r.buyukluk} m²`;
            
            // Reçeteler veya tarih logları için birleşik ek veriyi birleştiriyoruz
            const birlesikEkVeri = { ...(r.proje_ek || {}), ...(r.teslimat_ek || {}), sevkiyatlar: r.sevkiyat_takvimi || [] };

            return [
                projeNoVeAdi,                      // [0] Proje No ve Adı
                teslimatAdi,                       // [1] Teslimat Adı
                r.teslimat_durumu || 'BEKLEMEDE', // [2] Proje Durumu (Teslimat bazlı)
                r.proje_kodu,                      // [3] Proje No
                r.musteri_adi,                     // [4] Müşteri Adı
                r.proje_adi,                       // [5] Proje Adı
                r.bina_adi,                        // [6] Bina Adı
                r.bina_turu,                       // [7] Bina Türü
                r.bina_tipi,                       // [8] Bina Tipi
                r.buyukluk,                        // [9] Büyüklük (m²)
                r.sozlesme_tarihi,                 // [10] Sözleşme Tarihi
                (r.sevkiyat_takvimi && r.sevkiyat_takvimi[0]) ? r.sevkiyat_takvimi[0].tarih : '', // [11] Sevkiyat Başlangıcı
                r.bina_yeri || '',                 // [12] Bina Yeri
                r.nakliye,                         // [13] Nakliye
                r.aset_link || '',                 // [14] ASET
                r.dokumanlar_link || '',           // [15] Dokümanlar (Drive klasör linki)
                formatTurkishNumber(r.sozlesme_tutari_kdvsiz), // [16] Sözleşme Tutarı (KDVsiz)
                r.para_birimi,                     // [17] Para Birimi
                r.kdv_orani,                       // [18] KDV (%)
                r.sozlesme_tutari_kdvli,           // [19] Sözleşme Tutarı (KDVli)
                r.sozlesme_tutari_kdvli_tl,        // [20] Sözleşme Tutarı TL (KDVli)
                r.kayit_tarihi,                    // [21] Kayıt Tarihi
                r.satir_id,                        // [22] Satır ID (UUID)
                JSON.stringify(birlesikEkVeri)     // [23] Ek Veriler (JSON Metni)
            ];
        });

        res.json({
            kullanici: { email: "user@aterko.com", adSoyad: "Aterko Personeli", admin: true },
            projeler: flatProjelerArray,
            version: Math.floor(Date.now() / 1000),
            formTanimlari: [], // Gelecek aşamada veritabanına taşınabilir
            teknikSartnameFormu: {}
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ hata: error.message });
    }
});

// ============================================================================
// API 2: YENİ PROJE VE TESLİMATLARI KAYDETME (projeKaydet Karşılığı)
// ============================================================================
app.post('/api/proje-kaydet', async (req, res) => {
    const client = await pool.connect(); // İşlemler toplu (Transaction) yapılacak, hata olursa geri alınacak
    try {
        await client.query('BEGIN');
        const { proje, teslimatlar } = req.body;

        // 1. Canlı Döviz Kurunu Öğrenelim
        const kur = await getDovizKuru(proje.paraBirimi);
        const kdvOraniTemiz = parseFloat(proje.kdv.replace('%', '').replace(',', '.')) || 0;

        // 2. Proje Bilgilerini Ekle veya Güncelle
        const projeSorgu = `
            INSERT INTO projeler (proje_kodu, musteri_adi, proje_adi, sozlesme_tarihi, nakliye, para_birimi, kdv_orani, aset_link, ek_veriler)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (proje_kodu) DO UPDATE SET
                musteri_adi = EXCLUDED.musteri_adi,
                proje_adi = EXCLUDED.proje_adi,
                sozlesme_tarihi = EXCLUDED.sozlesme_tarihi,
                nakliye = EXCLUDED.nakliye,
                para_birimi = EXCLUDED.para_birimi,
                kdv_orani = EXCLUDED.kdv_orani,
                ek_veriler = EXCLUDED.ek_veriler
            RETURNING id;
        `;
        
        const asetLink = `https://aset.aterko.com/entity/project/${proje.projeNo}`;
        const projeRes = await client.query(projeSorgu, [
            proje.projeNo, proje.musteriAdi, proje.projeAdi, proje.sozlesmeTarihi, 
            proje.nakliye, proje.paraBirimi || 'TL', proje.kdv, asetLink, JSON.stringify(proje.ekVeriler || {})
        ]);
        const dbProjeId = projeRes.rows[0].id;

        // 3. Teslimatları Ekle döngüsü
        for (let t of teslimatlar) {
            const kdvsizTutar = parseFloat(t.sozlesmeTutari.replace(/\./g, '').replace(',', '.')) || 0;
            const kdvliTutar = kdvsizTutar * (1 + kdvOraniTemiz / 100);
            const kdvliTutarTL = kdvliTutar * kur;

            const teslimatSorgu = `
                INSERT INTO proje_teslimatlari (satir_id, proje_id, bina_adi, bina_turu, bina_tipi, buyukluk, sozlesme_tutari_kdvsiz, sozlesme_tutari_kdvli, sozlesme_tutari_kdvli_tl, durum, sevkiyat_takvimi, ek_veriler)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (satir_id) DO UPDATE SET
                    bina_adi = EXCLUDED.bina_adi,
                    bina_turu = EXCLUDED.bina_turu,
                    bina_tipi = EXCLUDED.bina_tipi,
                    buyukluk = EXCLUDED.buyukluk,
                    sozlesme_tutari_kdvsiz = EXCLUDED.sozlesme_tutari_kdvsiz,
                    sozlesme_tutari_kdvli = EXCLUDED.sozlesme_tutari_kdvli,
                    sozlesme_tutari_kdvli_tl = EXCLUDED.sozlesme_tutari_kdvli_tl,
                    durum = EXCLUDED.durum,
                    sevkiyat_takvimi = EXCLUDED.sevkiyat_takvimi,
                    ek_veriler = EXCLUDED.ek_veriler;
            `;

            // Satır ID yoksa yeni üret (UUID karşılığı rastgele bir ID üretiyoruz)
            const satirId = t.satirID || 'UID-' + Math.random().toString(36).substring(2, 11).toUpperCase();
            const sevkiyatLoglari = t.ekVeriler && t.ekVeriler.sevkiyatlar ? t.ekVeriler.sevkiyatlar : [];

            await client.query(teslimatSorgu, [
                satirId, dbProjeId, t.binaAdi, t.binaTuru, t.binaTipi, t.buyukluk,
                kdvsizTutar, formatTurkishNumber(kdvliTutar), formatTurkishNumber(kdvliTutarTL),
                t.durum || 'BEKLEMEDE', JSON.stringify(sevkiyatLoglari), JSON.stringify(t.ekVeriler || {})
            ]);
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: "Proje ve tüm teslimatlar başarıyla SQL veritabanına işlendi." });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ ok: false, hata: error.message });
    } finally {
        client.release();
    }
});

// Sunucuyu başlatma
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Aterko ERP Arka Uç Sistemi http://localhost:${PORT} adresinde yayında...`);
});
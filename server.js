const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { Pool } = require('pg');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const pdfsDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir);
app.use('/pdfs', express.static(pdfsDir));
app.use(express.static(__dirname));

// Gmail SMTP transporter (sipariş bildirimi için)
const mailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    })
    : null;
if (!mailTransporter) console.warn('⚠️ GMAIL_USER / GMAIL_APP_PASSWORD eksik — e-posta gönderimi devre dışı.');

// Supabase Storage istemcisi (dosya yükleme için)
const supabaseStorage = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;
if (!supabaseStorage) console.warn('⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY eksik — dosya yükleme devre dışı.');

// Multer (dosya 25MB sınırı, bellekte tut → Supabase'e at)
const dosyaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "147823112806-t1er1p9uka98t04i26riqp5mtpp2ejri.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || "aterko-gizli-anahtar-2026";
if (!process.env.JWT_SECRET) {
    console.warn("⚠️  JWT_SECRET ortam değişkeni tanımlı değil — fallback değer kullanılıyor. Üretim ortamında MUTLAKA ayarla!");
}
// Üretim ortamında kritik ortam değişkenleri kontrolü
['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach(k => {
    if (!process.env[k]) console.error(`❌ Eksik ortam değişkeni: ${k}`);
});

const yetkiKontrol = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ ok: false, hata: "Yetkisiz erişim. Lütfen giriş yapın." });
    }
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ ok: false, hata: "Oturum süreniz dolmuş." });
    }
};

app.post('/api/auth/google', async (req, res, next) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const email = ticket.getPayload().email;

        const userRes = await pool.query("SELECT * FROM kullanicilar WHERE email = $1", [email]);
        if (userRes.rowCount === 0) return res.status(401).json({ ok: false, hata: "Sisteme giriş yetkiniz yok." });
        
        const user = userRes.rows[0];
        if (user.durum !== 'AKTIF') return res.status(401).json({ ok: false, hata: "Hesabınız pasif durumdadır." });

        await pool.query("UPDATE kullanicilar SET son_giris = NOW() WHERE id = $1", [user.id]);
        const token = jwt.sign({ id: user.id, email: user.email, rol: user.rol, adSoyad: user.ad_soyad }, JWT_SECRET, { expiresIn: '12h' });

        res.json({ ok: true, token: token, kullanici: { adSoyad: user.ad_soyad, yetki: user.rol, email: user.email } });
    } catch (error) {
        console.error("🔥 GİZLİ LOGIN HATASI:", error);
        res.status(401).json({ ok: false, hata: "Google ile giriş başarısız." });
    }
});

// Stok Kartlarını Getir
app.get('/api/stok-kartlari', yetkiKontrol, async (req, res, next) => {
    try {
        const result = await pool.query('SELECT * FROM stok_kartlari ORDER BY stok_tipi ASC NULLS LAST, kategori ASC, stok_adi ASC');
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// Stok Kartı Kaydet / Güncelle
app.post('/api/stok-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, stok_kodu, stok_adi, kategori, birim, kritik_stok, para_birimi, stok_tipi, ozellikler } = req.body;
        const ozJSON = ozellikler ? JSON.stringify(ozellikler) : null;
        if (id) {
            await pool.query(
                'UPDATE stok_kartlari SET stok_tipi=$1, stok_kodu=$2, stok_adi=$3, kategori=$4, birim=$5, kritik_stok_miktari=$6, para_birimi=$7, ozellikler=$8 WHERE id=$9',
                [stok_tipi || null, stok_kodu, stok_adi, kategori, birim, kritik_stok, para_birimi, ozJSON, id]
            );
        } else {
            await pool.query(
                'INSERT INTO stok_kartlari (stok_tipi, stok_kodu, stok_adi, kategori, birim, kritik_stok_miktari, para_birimi, ozellikler) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [stok_tipi || null, stok_kodu, stok_adi, kategori, birim, kritik_stok, para_birimi, ozJSON]
            );
        }
        res.json({ ok: true });
    } catch (error) {
        if(error.code === '23505') return res.json({ok: false, hata: "Bu Stok Kodu zaten kullanılıyor!"});
        next(error);
    }
});

// =================================================================
// DEPOLAR
// =================================================================
app.get('/api/depolar', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query("SELECT * FROM depolar WHERE durum='AKTİF' ORDER BY ad ASC");
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

app.post('/api/depo-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, ad, adres, durum } = req.body;
        if (id) {
            await pool.query('UPDATE depolar SET ad=$1, adres=$2, durum=$3 WHERE id=$4',
                [ad, adres || null, durum || 'AKTİF', id]);
        } else {
            await pool.query('INSERT INTO depolar (ad, adres, durum) VALUES ($1,$2,$3)',
                [ad, adres || null, durum || 'AKTİF']);
        }
        res.json({ ok: true });
    } catch (e) {
        if (e.code === '23505') return res.json({ ok: false, hata: 'Bu depo adı zaten kayıtlı.' });
        next(e);
    }
});

// =================================================================
// STOK HAREKETLERİ
// =================================================================
// Hareketleri listele (filtreleme query string'le: ?tip=Giriş&stok_kart_id=12&depo_id=2)
app.get('/api/stok-hareketleri', yetkiKontrol, async (req, res, next) => {
    try {
        const { tip, stok_kart_id, depo_id, proje_id, limit, offset } = req.query;
        const params = [];
        const where = [];
        if (tip)            { params.push(tip); where.push(`h.tip = $${params.length}`); }
        if (stok_kart_id)   { params.push(parseInt(stok_kart_id)); where.push(`h.stok_kart_id = $${params.length}`); }
        if (depo_id)        { params.push(parseInt(depo_id)); where.push(`h.depo_id = $${params.length}`); }
        if (proje_id)       { params.push(parseInt(proje_id)); where.push(`h.proje_id = $${params.length}`); }
        const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const limitN = Math.min(parseInt(limit) || 100, 500);
        const offsetN = parseInt(offset) || 0;

        const q = `
            SELECT h.*,
                   sk.stok_kodu, sk.stok_adi, sk.birim, sk.stok_tipi, sk.kategori,
                   p.proje_kodu, p.musteri_adi, p.proje_adi,
                   d.ad as depo_adi
            FROM stok_hareketleri h
            LEFT JOIN stok_kartlari sk ON h.stok_kart_id = sk.id
            LEFT JOIN projeler p ON h.proje_id = p.id
            LEFT JOIN depolar d ON h.depo_id = d.id
            ${whereSQL}
            ORDER BY h.tarih DESC, h.id DESC
            LIMIT ${limitN} OFFSET ${offsetN}
        `;
        const r = await pool.query(q, params);

        // Toplam sayım (sayfalama için)
        const sayim = await pool.query(`SELECT COUNT(*) FROM stok_hareketleri h ${whereSQL}`, params);

        res.json({ ok: true, data: r.rows, toplam: parseInt(sayim.rows[0].count), limit: limitN, offset: offsetN });
    } catch (e) { next(e); }
});

// Yeni hareket kaydet (stok miktarını da güncelle)
app.post('/api/stok-hareket-kaydet', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { stok_kart_id, tip, miktar, proje_id, depo_id, aciklama } = req.body;
        if (!stok_kart_id || !tip || !miktar) {
            return res.json({ ok: false, hata: 'Stok, tip ve miktar zorunlu.' });
        }
        const miktarF = parseFloat(miktar);
        if (isNaN(miktarF) || miktarF <= 0) {
            return res.json({ ok: false, hata: 'Miktar 0\'dan büyük olmalıdır.' });
        }

        // Çıkışta stok yeterli mi kontrol et
        if (tip === 'Çıkış') {
            const stokR = await client.query('SELECT guncel_stok_miktari, stok_adi FROM stok_kartlari WHERE id=$1', [stok_kart_id]);
            if (stokR.rowCount === 0) return res.json({ ok: false, hata: 'Stok kartı bulunamadı.' });
            const mevcut = parseFloat(stokR.rows[0].guncel_stok_miktari) || 0;
            if (miktarF > mevcut) {
                return res.json({ ok: false, hata: `Yetersiz stok! Mevcut: ${mevcut} (${stokR.rows[0].stok_adi})` });
            }
        }

        // Hareketi ekle
        await client.query(`
            INSERT INTO stok_hareketleri
            (stok_kart_id, tip, miktar, proje_id, depo_id, aciklama, kullanici_email, kullanici_adsoyad)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [stok_kart_id, tip, miktarF, proje_id || null, depo_id || null, aciklama || null,
            req.user.email, req.user.adSoyad]);

        // Stok kartının güncel miktarını güncelle
        const delta = tip === 'Giriş' ? miktarF : -miktarF;
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [delta, stok_kart_id]);

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Hareket kaydedildi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// Hareket güncelle (sadece admin) — stok bakiyesini doğru şekilde yeniden hesapla
app.post('/api/stok-hareket-guncelle', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Bu işlem sadece Yöneticiler için.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id, stok_kart_id, tip, miktar, proje_id, depo_id, aciklama } = req.body;
        const eskiR = await client.query('SELECT stok_kart_id, tip, miktar FROM stok_hareketleri WHERE id=$1', [id]);
        if (eskiR.rowCount === 0) return res.json({ ok: false, hata: 'Hareket bulunamadı.' });
        const eski = eskiR.rows[0];

        // Eski etkiyi geri al
        const eskiDelta = eski.tip === 'Giriş' ? -parseFloat(eski.miktar) : parseFloat(eski.miktar);
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [eskiDelta, eski.stok_kart_id]);

        // Yeni etkiyi uygula
        const yeniMiktar = parseFloat(miktar);
        const yeniDelta = tip === 'Giriş' ? yeniMiktar : -yeniMiktar;
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [yeniDelta, stok_kart_id]);

        // Hareketi güncelle
        await client.query(`
            UPDATE stok_hareketleri SET stok_kart_id=$1, tip=$2, miktar=$3,
                   proje_id=$4, depo_id=$5, aciklama=$6 WHERE id=$7
        `, [stok_kart_id, tip, yeniMiktar, proje_id || null, depo_id || null, aciklama || null, id]);

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Hareket güncellendi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// Hareket sil (sadece admin) — stok bakiyesini geri al
app.delete('/api/stok-hareket-sil/:id', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Bu işlem sadece Yöneticiler için.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query('SELECT stok_kart_id, tip, miktar FROM stok_hareketleri WHERE id=$1', [req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Hareket bulunamadı.' });
        const h = r.rows[0];
        const delta = h.tip === 'Giriş' ? -parseFloat(h.miktar) : parseFloat(h.miktar);
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [delta, h.stok_kart_id]);
        await client.query('DELETE FROM stok_hareketleri WHERE id=$1', [req.params.id]);
        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Hareket silindi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// =================================================================
// 4. PROJE TAKİP MOTORU
// =================================================================

// Yeni Proje Kaydet
// YENİ: Proje ve Alt Teslimatları (Binaları) Tek Seferde Kaydet
app.post('/api/proje-kaydet', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { proje, teslimatlar } = req.body;
        if (!/^[0-9]{5}$/.test(proje.proje_kodu)) {
            return res.json({ ok: false, hata: "Proje kodu 5 haneli bir sayı olmalıdır!" });
        }

        const check = await client.query("SELECT id FROM projeler WHERE proje_kodu = $1", [proje.proje_kodu]);
        if (check.rowCount > 0) return res.json({ ok: false, hata: "Bu Proje Kodu zaten sistemde kullanılıyor!" });

        const projeRes = await client.query(`
            INSERT INTO projeler (proje_kodu, musteri_adi, proje_adi, sozlesme_tarihi, satis_turu, nakliye, para_birimi, kdv_orani)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
        `, [
            proje.proje_kodu, proje.musteri_adi, proje.proje_adi, proje.sozlesme_tarihi || null, 
            proje.satis_turu, proje.nakliye, proje.para_birimi, parseInt(proje.kdv_orani)
        ]);

        const yeniProjeId = projeRes.rows[0].id;

        if (teslimatlar && teslimatlar.length > 0) {
            for (const t of teslimatlar) {
                await client.query(`
                    INSERT INTO proje_teslimatlari 
                    (proje_id, bina_adi, bina_turu, bina_tipi, kat_yuksekligi, kat_adedi, bina_adedi, 
                     konteyner_ebadi, konteyner_miktari, dis_duvar_kesiti, ic_duvar_kesiti, 
                     buyukluk_m2, sevkiyat_baslangici, bina_yeri, kdvsiz_tutar)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `, [
                    yeniProjeId, t.bina_adi, t.bina_turu, t.bina_tipi, t.kat_yuksekligi, t.kat_adedi, t.bina_adedi,
                    t.konteyner_ebadi, t.konteyner_miktari, t.dis_duvar_kesiti, t.ic_duvar_kesiti,
                    parseFloat(t.buyukluk_m2 || 0), t.sevkiyat_baslangici || null, t.bina_yeri, parseFloat(t.kdvsiz_tutar || 0)
                ]);
            }
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: "Proje ve bağlı teslimatları başarıyla mühürlendi." });
    } catch (error) {
        await client.query('ROLLBACK');
        next(error);
    } finally {
        client.release();
    }
});

// YENİ: Projeleri, Teslimat Sayılarını, Toplam Tutarları ve Hesaplanmış Durumu Birlikte Çek
app.get('/api/projeler', yetkiKontrol, async (req, res, next) => {
    try {
        // Durum öncelik sıralaması (en ileri aşama → 8)
        const query = `
            SELECT p.*,
                   COALESCE(t.teslimat_sayisi, 0) as teslimat_sayisi,
                   COALESCE(t.kdvsiz_toplam, 0) as kdvsiz_toplam,
                   COALESCE(t.kdvli_toplam, 0) as kdvli_toplam,
                   t.hesaplanmis_durum
            FROM projeler p
            LEFT JOIN (
                SELECT pt.proje_id,
                       COUNT(*) as teslimat_sayisi,
                       SUM(CASE WHEN COALESCE(pt.durum,'BEKLEMEDE') <> 'İPTAL' THEN COALESCE(pt.kdvsiz_tutar,0) ELSE 0 END) as kdvsiz_toplam,
                       SUM(CASE WHEN COALESCE(pt.durum,'BEKLEMEDE') <> 'İPTAL' THEN COALESCE(pt.kdvsiz_tutar,0) * (1 + COALESCE(p2.kdv_orani,20)/100.0) ELSE 0 END) as kdvli_toplam,
                       (
                         SELECT durum FROM proje_teslimatlari pt2
                         WHERE pt2.proje_id = pt.proje_id AND COALESCE(pt2.durum,'BEKLEMEDE') <> 'İPTAL'
                         ORDER BY CASE COALESCE(pt2.durum,'BEKLEMEDE')
                           WHEN 'TESLİM EDİLDİ' THEN 8
                           WHEN 'MONTAJ' THEN 7
                           WHEN 'ÜRETİM' THEN 6
                           WHEN 'PROJE' THEN 5
                           WHEN 'İŞ EMRİ' THEN 4
                           WHEN 'SÖZLEŞME' THEN 3
                           WHEN 'BEKLEMEDE' THEN 2
                           ELSE 1
                         END DESC LIMIT 1
                       ) as hesaplanmis_durum,
                       (
                         SELECT array_agg(DISTINCT pt3.bina_turu) FROM proje_teslimatlari pt3
                         WHERE pt3.proje_id = pt.proje_id AND pt3.bina_turu IS NOT NULL
                       ) as bina_turleri
                FROM proje_teslimatlari pt
                JOIN projeler p2 ON pt.proje_id = p2.id
                GROUP BY pt.proje_id
            ) t ON p.id = t.proje_id
            ORDER BY
                CASE COALESCE(t.hesaplanmis_durum, p.durum, 'BEKLEMEDE')
                    WHEN 'BEKLEMEDE'      THEN 1
                    WHEN 'SÖZLEŞME'       THEN 2
                    WHEN 'İŞ EMRİ'        THEN 3
                    WHEN 'PROJE'          THEN 4
                    WHEN 'ÜRETİM'         THEN 5
                    WHEN 'MONTAJ'         THEN 6
                    WHEN 'TESLİM EDİLDİ'  THEN 7
                    WHEN 'İPTAL'          THEN 8
                    ELSE 9
                END ASC,
                p.sozlesme_tarihi DESC NULLS LAST,
                p.id DESC
        `;
        const result = await pool.query(query);
        // hesaplanmis_durum varsa onu kullan, yoksa p.durum
        const data = result.rows.map(r => ({
            ...r,
            durum: r.hesaplanmis_durum || r.durum || 'BEKLEMEDE'
        }));
        res.json({ ok: true, data });
    } catch (error) { next(error); }
});

// YENİ: Proje Detayını ve Bağlı Teslimatları Getir
app.get('/api/proje-detay/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.params;
        
        // Ana Projeyi Çek
        const projeRes = await pool.query("SELECT * FROM projeler WHERE id = $1", [id]);
        if(projeRes.rowCount === 0) return res.json({ ok: false, hata: "Proje bulunamadı." });
        
        // Projeye Bağlı Teslimatları (Binaları) Çek
        const teslimatRes = await pool.query("SELECT * FROM proje_teslimatlari WHERE proje_id = $1 ORDER BY id ASC", [id]);
        
        res.json({ ok: true, proje: projeRes.rows[0], teslimatlar: teslimatRes.rows });
    } catch (error) { next(error); }
});

// YENİ: Proje ve Teslimatlarını Topluca Güncelle (Düzenle butonu için)
app.post('/api/proje-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { proje, teslimatlar } = req.body;
        if (!proje || !proje.id) return res.json({ ok: false, hata: 'Geçersiz proje ID' });

        // 1. Projeyi güncelle
        await client.query(`
            UPDATE projeler SET musteri_adi=$1, proje_adi=$2, sozlesme_tarihi=$3,
                                satis_turu=$4, nakliye=$5, para_birimi=$6, kdv_orani=$7
            WHERE id=$8
        `, [proje.musteri_adi, proje.proje_adi, proje.sozlesme_tarihi || null,
            proje.satis_turu, proje.nakliye, proje.para_birimi, parseInt(proje.kdv_orani), proje.id]);

        // 2. Mevcut teslimat ID'lerini al
        const mevcutRes = await client.query('SELECT id FROM proje_teslimatlari WHERE proje_id = $1', [proje.id]);
        const mevcutIds = new Set(mevcutRes.rows.map(r => r.id));
        const gonderilenIds = new Set();

        // 3. Her teslimatı işle (ID varsa güncelle, yoksa ekle)
        for (const t of teslimatlar || []) {
            // ek_veriler — sevkiyatlar dizisi varsa içine koy
            let ekVeriler = t.ek_veriler || {};
            if (Array.isArray(t.sevkiyatlar) && t.sevkiyatlar.length > 0) {
                ekVeriler.sevkiyatlar = t.sevkiyatlar;
            }
            const sevkiyatBaslangici = (Array.isArray(t.sevkiyatlar) && t.sevkiyatlar.length > 0)
                ? t.sevkiyatlar[0].tarih || null
                : (t.sevkiyat_baslangici || null);

            if (t.id && mevcutIds.has(t.id)) {
                // Güncelle (mevcut ek_veriler'i koru, yeni sevkiyatlar üzerine yaz)
                const eskiRes = await client.query('SELECT ek_veriler FROM proje_teslimatlari WHERE id=$1', [t.id]);
                const eskiVeri = eskiRes.rows[0]?.ek_veriler || {};
                const birlesik = { ...eskiVeri, ...ekVeriler };
                await client.query(`
                    UPDATE proje_teslimatlari SET
                        bina_adi=$1, bina_turu=$2, bina_tipi=$3,
                        kat_yuksekligi=$4, kat_adedi=$5, bina_adedi=$6,
                        konteyner_ebadi=$7, konteyner_miktari=$8,
                        dis_duvar_kesiti=$9, ic_duvar_kesiti=$10,
                        buyukluk_m2=$11, sevkiyat_baslangici=$12,
                        bina_yeri=$13, kdvsiz_tutar=$14, ek_veriler=$15
                    WHERE id=$16
                `, [
                    t.bina_adi, t.bina_turu, t.bina_tipi,
                    t.kat_yuksekligi || null, t.kat_adedi || null, parseInt(t.bina_adedi) || null,
                    t.konteyner_ebadi || null, parseInt(t.konteyner_miktari) || null,
                    t.dis_duvar_kesiti || null, t.ic_duvar_kesiti || null,
                    parseFloat(t.buyukluk_m2) || null, sevkiyatBaslangici,
                    t.bina_yeri || null, parseFloat(t.kdvsiz_tutar) || 0,
                    JSON.stringify(birlesik), t.id
                ]);
                gonderilenIds.add(t.id);
            } else {
                // Yeni ekle
                await client.query(`
                    INSERT INTO proje_teslimatlari
                    (proje_id, bina_adi, bina_turu, bina_tipi, kat_yuksekligi, kat_adedi, bina_adedi,
                     konteyner_ebadi, konteyner_miktari, dis_duvar_kesiti, ic_duvar_kesiti,
                     buyukluk_m2, sevkiyat_baslangici, bina_yeri, kdvsiz_tutar, ek_veriler)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                `, [
                    proje.id, t.bina_adi, t.bina_turu, t.bina_tipi,
                    t.kat_yuksekligi || null, t.kat_adedi || null, parseInt(t.bina_adedi) || null,
                    t.konteyner_ebadi || null, parseInt(t.konteyner_miktari) || null,
                    t.dis_duvar_kesiti || null, t.ic_duvar_kesiti || null,
                    parseFloat(t.buyukluk_m2) || null, sevkiyatBaslangici,
                    t.bina_yeri || null, parseFloat(t.kdvsiz_tutar) || 0,
                    JSON.stringify(ekVeriler)
                ]);
            }
        }

        // 4. Gönderilmeyen mevcut teslimatları sil
        const silinecek = [...mevcutIds].filter(id => !gonderilenIds.has(id));
        if (silinecek.length > 0) {
            await client.query('DELETE FROM proje_teslimatlari WHERE id = ANY($1::integer[])', [silinecek]);
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Proje güncellendi.', silinen_teslimat: silinecek.length });
    } catch (error) {
        await client.query('ROLLBACK');
        next(error);
    } finally {
        client.release();
    }
});

// YENİ: Teslimat (Bina) Durumunu Manuel Güncelleme (İPTAL, BEKLEMEDE vb. için)
app.post('/api/teslimat-durum-guncelle', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, yeni_durum } = req.body;
        await pool.query("UPDATE proje_teslimatlari SET durum = $1 WHERE id = $2", [yeni_durum, teslimat_id]);
        res.json({ ok: true, mesaj: "Bina statüsü başarıyla güncellendi." });
    } catch (error) { next(error); }
});

// Teslimata ait ürün listesini getir (Stok Miktarı Eklendi)
app.get('/api/teslimat-urunleri/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;
        // Ürün listesi + stok bilgisi + bağlı talep (varsa)
        const query = `
            SELECT tu.*,
                   sk.stok_kodu, sk.stok_adi, sk.stok_tipi, sk.birim as stok_birim,
                   sk.guncel_stok_miktari, sk.kritik_stok_miktari,
                   tlpu.id as bagli_talep_urun_id,
                   tlp.talep_no as bagli_talep_no,
                   tlpu.durum as bagli_talep_durum
            FROM teslimat_urunleri tu
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            LEFT JOIN talep_urunleri tlpu ON tu.talep_urun_id = tlpu.id
            LEFT JOIN satinalma_talepleri tlp ON tlpu.talep_id = tlp.id
            WHERE tu.teslimat_id = $1
            ORDER BY tu.sira ASC, tu.id ASC
        `;
        const result = await pool.query(query, [teslimatId]);

        // Her ürün için stok durumunu hesaplayıp döndür
        const data = result.rows.map(r => {
            let stokDurumu = '-';
            if (r.stok_kart_id) {
                const guncel = parseFloat(r.guncel_stok_miktari) || 0;
                const ihtiyac = parseFloat(r.miktar) || 0;
                if (guncel >= ihtiyac) stokDurumu = 'YETERLI';
                else if (guncel > 0) stokDurumu = 'YETERSIZ';
                else stokDurumu = 'YOK';
            }
            return { ...r, hesaplanan_stok_durumu: stokDurumu };
        });
        res.json({ ok: true, data });
    } catch (error) { next(error); }
});

// ÜRÜN VALIDATION MOTORU: Stok kartının özellikleri teslimatın teknik şartnamesi ile uyumlu mu?
// Geri döner: { uyumlu: bool, hatalar: [string] }
async function urunUyumKontrol(stokKartId, teslimatId) {
    if (!stokKartId || !teslimatId) return { uyumlu: true, hatalar: [] };

    const skR = await pool.query('SELECT stok_adi, ozellikler FROM stok_kartlari WHERE id=$1', [stokKartId]);
    if (skR.rowCount === 0) return { uyumlu: true, hatalar: [] };
    const ozellikler = skR.rows[0].ozellikler;
    if (!ozellikler || !ozellikler.kosullar || ozellikler.kosullar.length === 0) {
        return { uyumlu: true, hatalar: [] }; // Koşul yok → her şeye uyumlu
    }

    const tR = await pool.query('SELECT bina_adi, ek_veriler FROM proje_teslimatlari WHERE id=$1', [teslimatId]);
    if (tR.rowCount === 0) return { uyumlu: true, hatalar: [] };
    const ekVeriler = tR.rows[0].ek_veriler || {};

    const hatalar = [];
    for (const k of ozellikler.kosullar) {
        const mevcut = ekVeriler[k.alan];
        const mevcutStr = mevcut == null ? '' : String(mevcut).trim();
        const beklenenStr = String(k.deger || '').trim();
        const tokenlar = mevcutStr.split(',').map(s => s.trim()).filter(Boolean);
        const icerir = tokenlar.includes(beklenenStr);

        let sagladi = true;
        switch (k.operator) {
            case '=':  sagladi = (mevcutStr === beklenenStr); break;
            case '!=': sagladi = (mevcutStr !== beklenenStr); break;
            case '~=': sagladi = icerir; break;
            case '!~': sagladi = !icerir; break;
            case 'var': sagladi = (mevcutStr !== '' && mevcutStr !== 'Yok'); break;
            case 'yok': sagladi = (mevcutStr === '' || mevcutStr === 'Yok'); break;
        }

        if (!sagladi) {
            const opMetin = { '=': 'eşit olmalı', '!=': 'eşit olmamalı', '~=': 'içermeli', '!~': 'içermemeli', 'var': 'dolu olmalı', 'yok': 'boş olmalı' }[k.operator] || k.operator;
            hatalar.push(`"${k.alan}" alanı ${opMetin}: "${beklenenStr}" — mevcut: "${mevcutStr || 'boş'}"`);
        }
    }
    return { uyumlu: hatalar.length === 0, hatalar };
}

// Endpoint: ürün eklemeden önce kontrol et (frontend uyarısı için)
app.get('/api/urun-uyum-kontrol', yetkiKontrol, async (req, res, next) => {
    try {
        const { stok_kart_id, teslimat_id } = req.query;
        const sonuc = await urunUyumKontrol(parseInt(stok_kart_id), parseInt(teslimat_id));
        res.json({ ok: true, ...sonuc });
    } catch (e) { next(e); }
});

// Teslimata (Ürün Listesine) ürün ekle — opsiyonel zorla onay
app.post('/api/teslimat-urun-ekle', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim,
                miktar, aciklama, kullanim_amaci, zorla } = req.body;

        // VALIDATION — eğer stok kartında koşul varsa ve zorla=true değilse uyarı dön
        if (stok_kart_id) {
            const kontrol = await urunUyumKontrol(stok_kart_id, teslimat_id);
            if (!kontrol.uyumlu && !zorla) {
                return res.json({
                    ok: false,
                    hata: 'Ürün, teslimatın teknik şartnamesine uygun değil.',
                    uyumsuzluk: true,
                    hatalar: kontrol.hatalar
                });
            }
        }

        const ekleyen = req.user.adSoyad;
        const r = await pool.query(
            `INSERT INTO teslimat_urunleri
             (teslimat_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama,
              ekleyen_kullanici, kullanim_amaci, durum)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TASLAK') RETURNING id`,
            [teslimat_id, stok_kart_id || null, ozel_urun_adi, ozel_urun_birim,
             miktar, aciklama, ekleyen, kullanim_amaci || 'URETIM']
        );
        res.json({ ok: true, id: r.rows[0].id });
    } catch (error) { next(error); }
});

// Ürün listesinden seçili kalemler için satınalma talebi oluştur
// Body: { teslimat_id, kalem_idler: [int], istenen_tarih, teslim_yeri, genel_aciklama }
app.post('/api/teslimat-urun-talep-olustur', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { teslimat_id, kalem_idler, istenen_tarih, teslim_yeri, genel_aciklama } = req.body;
        if (!teslimat_id || !Array.isArray(kalem_idler) || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }

        // Teslimatın projesini bul
        const tR = await client.query('SELECT proje_id FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        if (tR.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const projeId = tR.rows[0].proje_id;

        // Yeni talep no üret
        const countRes = await client.query('SELECT COUNT(*) FROM satinalma_talepleri');
        const talep_no = `SAT-T-${1001 + parseInt(countRes.rows[0].count)}`;

        // Talep başlığı
        const talepInsert = await client.query(`
            INSERT INTO satinalma_talepleri (talep_no, proje_id, talep_eden, istenen_tarih, teslim_yeri, genel_aciklama, durum)
            VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR') RETURNING id
        `, [talep_no, projeId, req.user.adSoyad, istenen_tarih || null,
            teslim_yeri || 'Merkez Depo', genel_aciklama || `Otomatik: Teslimat #${teslimat_id} ürün listesinden`]);
        const yeniTalepId = talepInsert.rows[0].id;

        // Seçilen ürün listesi kalemlerini al, her biri için talep_urunleri kaydı + teslimat_urunleri.talep_urun_id bağı kur
        let kayitliKalem = 0;
        for (const tuId of kalem_idler) {
            const luR = await client.query(`
                SELECT * FROM teslimat_urunleri WHERE id=$1 AND teslimat_id=$2
            `, [tuId, teslimat_id]);
            if (luR.rowCount === 0) continue;
            const ku = luR.rows[0];

            const yeniKalem = await client.query(`
                INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR') RETURNING id
            `, [yeniTalepId, ku.stok_kart_id, ku.ozel_urun_adi, ku.ozel_urun_birim,
                ku.miktar, ku.aciklama || `Teslimat #${teslimat_id}`]);

            // Ürün listesini bağla
            await client.query(`
                UPDATE teslimat_urunleri SET talep_urun_id=$1, durum='TALEP EDILDI' WHERE id=$2
            `, [yeniKalem.rows[0].id, tuId]);
            kayitliKalem++;
        }

        await client.query('COMMIT');
        res.json({
            ok: true,
            mesaj: `${talep_no} oluşturuldu, ${kayitliKalem} kalem talebe eklendi.`,
            talep_no, talep_id: yeniTalepId
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Teslimat ürün listesinden ürün sil
app.delete('/api/teslimat-urun-sil/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.params;
        // Talebe bağlıysa engelle
        const r = await pool.query('SELECT talep_urun_id FROM teslimat_urunleri WHERE id=$1', [id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Kalem bulunamadı.' });
        if (r.rows[0].talep_urun_id) {
            return res.json({ ok: false, hata: 'Bu kalem bir satınalma talebine bağlı. Önce talebi iptal/sil.' });
        }
        await pool.query('DELETE FROM teslimat_urunleri WHERE id = $1', [id]);
        res.json({ ok: true });
    } catch (error) { next(error); }
});

// Ürün listesi kaleminin miktar / amaç güncelle
app.post('/api/teslimat-urun-guncelle', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, miktar, aciklama, kullanim_amaci } = req.body;
        await pool.query(`
            UPDATE teslimat_urunleri SET miktar=$1, aciklama=$2, kullanim_amaci=$3
            WHERE id=$4
        `, [parseFloat(miktar) || 0, aciklama || null, kullanim_amaci || 'URETIM', id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Dropdown için gerçek Proje ve Teslimat (Bina) listesini getir
app.get('/api/teslimat-secenekleri', yetkiKontrol, async (req, res, next) => {
    try {
        // Sadece "PROJE" durumundaki teslimatlar Ürün Listesi modülünde işlenebilir.
        // (TESLİM EDİLDİ / MONTAJ / İPTAL durumundakiler düzenlemeye kapalı.)
        // Query param ile esneklik: ?durum=hepsi → tümünü getirir (admin amaçlı).
        const durumFilter = req.query.durum === 'hepsi'
            ? `COALESCE(pt.durum,'BEKLEMEDE') <> 'İPTAL'`
            : `pt.durum = 'PROJE'`;
        const query = `
            SELECT pt.id as teslimat_id, pt.bina_adi, pt.bina_turu, pt.proje_id, pt.durum,
                   p.proje_kodu, p.musteri_adi, p.proje_adi
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id = p.id
            WHERE ${durumFilter}
            ORDER BY p.id DESC, pt.id ASC
        `;
        const result = await pool.query(query);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// GÜNCELLEME: Satınalma Talepleri Listesini ve Projeleri Esnek Biçimde Getir
app.get('/api/satinalma-listesi', yetkiKontrol, async (req, res, next) => {
    try {
        // Esnek sorgu: Proje tablosu boş olsa veya eşleşme olmasa bile talepleri listeler (COALESCE korumalı)
        const taleplerRes = await pool.query(`
            SELECT t.id, t.talep_no, t.talep_eden, t.istenen_tarih, t.durum, t.kayit_tarihi,
                   COALESCE(p.proje_adi, 'Genel / Belirsiz') as proje_adi,
                   COALESCE(p.proje_kodu, 'GENEL') as proje_kodu,
                   COALESCE(p.musteri_adi, '') as musteri_adi,
                   COALESCE(COUNT(tu.id), 0) as urun_sayisi
            FROM satinalma_talepleri t
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN talep_urunleri tu ON t.id = tu.talep_id
            WHERE COALESCE(t.arsiv, false) = false
            GROUP BY t.id, p.proje_adi, p.proje_kodu, p.musteri_adi
            ORDER BY t.kayit_tarihi DESC NULLS LAST, t.id DESC
        `);
        
        // Dropdown'lar için aktif projeleri getir (Proje No / Müşteri - Proje Adı formatı için)
        const projelerRes = await pool.query('SELECT id, proje_kodu, musteri_adi, proje_adi FROM projeler ORDER BY id DESC');
        
        res.json({ ok: true, talepler: taleplerRes.rows, projeler: projelerRes.rows });
    } catch (error) { next(error); }
});

// Yeni Satınalma Talebini Veritabanına Kaydet (Transaction Korumalı)
app.post('/api/yeni-talep', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { proje_id, istenen_tarih, teslim_yeri, genel_aciklama, kalemler } = req.body;
        const talep_eden = req.user.adSoyad;

        const countRes = await client.query('SELECT COUNT(*) FROM satinalma_talepleri');
        const siradakiNo = 1001 + parseInt(countRes.rows[0].count);
        const talep_no = `SAT-T-${siradakiNo}`;

        const talepInsert = await client.query(`
            INSERT INTO satinalma_talepleri (talep_no, proje_id, talep_eden, istenen_tarih, teslim_yeri, genel_aciklama)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
        `, [talep_no, proje_id || null, talep_eden, istenen_tarih || null, teslim_yeri, genel_aciklama]);

        const yeniTalepId = talepInsert.rows[0].id;

        for (const kalem of kalemler) {
            await client.query(`
                INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                yeniTalepId,
                kalem.stok_kart_id || null,
                kalem.ozel_urun_adi || null,
                kalem.ozel_urun_birim || 'ADET',
                kalem.miktar,
                kalem.aciklama
            ]);
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: `Talep başarıyla oluşturuldu: ${talep_no}` });
    } catch (error) {
        await client.query('ROLLBACK');
        next(error);
    } finally {
        client.release();
    }
});

// YENİ: Belirli Bir Talebin Kalemlerini (İçindeki Ürünleri) Getir
app.get('/api/satinalma-detay/:talepId', yetkiKontrol, async (req, res, next) => {
    try {
        const { talepId } = req.params;
        // Talep başlığı + kalemler
        const talepR = await pool.query(`
            SELECT t.*, p.proje_kodu, p.musteri_adi, p.proje_adi
            FROM satinalma_talepleri t
            LEFT JOIN projeler p ON t.proje_id = p.id
            WHERE t.id = $1
        `, [talepId]);
        if (talepR.rowCount === 0) return res.json({ ok: false, hata: 'Talep bulunamadı.' });

        const kalemler = await pool.query(`
            SELECT tu.*, sk.stok_kodu, sk.stok_adi, sk.birim as stok_birim
            FROM talep_urunleri tu
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            WHERE tu.talep_id = $1
            ORDER BY tu.id ASC
        `, [talepId]);
        res.json({ ok: true, talep: talepR.rows[0], data: kalemler.rows });
    } catch (error) { next(error); }
});

// YENİ: Seçilen Talep Kalemlerinin Durumunu Toplu Güncelle (Onay/Red/İşleme Al)
app.post('/api/talep-durum-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kalem_idler, yeni_durum } = req.body; // kalem_idler bir dizi (array) olacak

        if (!kalem_idler || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: "İşlem yapılacak ürün seçilmedi." });
        }

        // Seçilen tüm talep kalemlerinin durumunu güncelle
        await client.query(`
            UPDATE talep_urunleri 
            SET durum = $1 
            WHERE id = ANY($2::integer[])
        `, [yeni_durum, kalem_idler]);

        // EĞER bir talepteki tüm ürünlerin durumu değiştiyse, ana talebin durumunu da güncelle
        // (Bu zeki kontrol mimariyi temiz tutar)
        for (const id of kalem_idler) {
            const talepIdRes = await client.query('SELECT talep_id FROM talep_urunleri WHERE id = $1', [id]);
            if (talepIdRes.rowCount > 0) {
                const talepId = talepIdRes.rows[0].talep_id;
                
                // Bu talebe ait başka "ONAY BEKLİYOR" kalemi kaldı mı?
                const kalanRes = await client.query("SELECT COUNT(*) FROM talep_urunleri WHERE talep_id = $1 AND durum = 'ONAY BEKLİYOR'", [talepId]);
                
                if (parseInt(kalanRes.rows[0].count) === 0) {
                    // Kalan yoksa ana talebi de 'İŞLEME ALINDI' veya ilgili duruma çek
                    await client.query('UPDATE satinalma_talepleri SET durum = $1 WHERE id = $2', [yeni_durum, talepId]);
                }
            }
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: `Seçilen ${kalem_idler.length} kalemin durumu '${yeni_durum}' olarak güncellendi.` });
    } catch (error) {
        await client.query('ROLLBACK');
        next(error);
    } finally {
        client.release();
    }
});

// =================================================================
// TEDARİKÇİLER — Tam CRUD
// =================================================================
// Tüm tedarikçileri getir (yönetim ekranı için) — query: ?sadece_aktif=1
app.get('/api/tedarikciler', yetkiKontrol, async (req, res, next) => {
    try {
        const sadeceAktif = req.query.sadece_aktif === '1';
        const wh = sadeceAktif ? "WHERE t.durum = 'AKTİF'" : '';
        const result = await pool.query(`
            SELECT t.*,
                   COUNT(s.id) FILTER (WHERE COALESCE(s.arsiv,false) = false) as aktif_siparis_sayisi,
                   COUNT(s.id) as toplam_siparis_sayisi,
                   MAX(s.siparis_tarihi) as son_siparis_tarihi
            FROM tedarikciler t
            LEFT JOIN satinalma_siparisleri s ON s.tedarikci_id = t.id
            ${wh}
            GROUP BY t.id
            ORDER BY t.firma_adi ASC
        `);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// Tek tedarikçi getir
app.get('/api/tedarikci/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query('SELECT * FROM tedarikciler WHERE id=$1', [req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Tedarikçi bulunamadı.' });
        res.json({ ok: true, data: r.rows[0] });
    } catch (e) { next(e); }
});

// Yeni / Güncelle
app.post('/api/tedarikci-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, firma_adi, yetkili_kisi, email, telefon, vergi_no, vergi_dairesi, adres, durum } = req.body;
        if (!firma_adi || !firma_adi.trim()) return res.json({ ok: false, hata: 'Firma adı zorunlu.' });
        if (id) {
            await pool.query(`
                UPDATE tedarikciler SET firma_adi=$1, yetkili_kisi=$2, email=$3, telefon=$4,
                                        vergi_no=$5, vergi_dairesi=$6, adres=$7, durum=$8
                WHERE id=$9
            `, [firma_adi.trim(), yetkili_kisi || null, email || null, telefon || null,
                vergi_no || null, vergi_dairesi || null, adres || null, durum || 'AKTİF', id]);
            res.json({ ok: true, mesaj: 'Tedarikçi güncellendi.' });
        } else {
            const r = await pool.query(`
                INSERT INTO tedarikciler (firma_adi, yetkili_kisi, email, telefon, vergi_no, vergi_dairesi, adres, durum)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
            `, [firma_adi.trim(), yetkili_kisi || null, email || null, telefon || null,
                vergi_no || null, vergi_dairesi || null, adres || null, durum || 'AKTİF']);
            res.json({ ok: true, id: r.rows[0].id, mesaj: 'Tedarikçi eklendi.' });
        }
    } catch (e) { next(e); }
});

// Tedarikçi sil (siparişe bağlıysa engellenir)
app.delete('/api/tedarikci-sil/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const bagli = await pool.query('SELECT COUNT(*) FROM satinalma_siparisleri WHERE tedarikci_id=$1', [req.params.id]);
        if (parseInt(bagli.rows[0].count) > 0) {
            return res.json({ ok: false, hata: `Bu tedarikçi ${bagli.rows[0].count} siparişte kullanılmış, silinemez. Pasif yapabilirsiniz.` });
        }
        await pool.query('DELETE FROM tedarikciler WHERE id=$1', [req.params.id]);
        res.json({ ok: true, mesaj: 'Tedarikçi silindi.' });
    } catch (e) { next(e); }
});

// YENİ: Sipariş Kaydet ve Kısmi Sipariş (Split-Order) Bölünme Motoru
app.post('/api/siparis-kaydet', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // İşlemi kilitle ve başlat

        const { tedarikci_id, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani, kalemler } = req.body;

        // KURAL: Tek bir siparişte sadece aynı talepten gelen kalemler olabilir
        if (Array.isArray(kalemler) && kalemler.length > 0) {
            const talepIdResp = await client.query(
                'SELECT DISTINCT talep_id FROM talep_urunleri WHERE id = ANY($1::integer[])',
                [kalemler.map(k => parseInt(k.talep_urun_id))]
            );
            if (talepIdResp.rowCount > 1) {
                throw new Error('Bir siparişte sadece aynı talepten kalemler olabilir. Farklı taleplerden seçim yaptınız.');
            }
        }

        // 1. Otomatik Sipariş No Üret (Örn: SAT-S-1001)
        const countRes = await client.query('SELECT COUNT(*) FROM satinalma_siparisleri');
        const siradakiNo = 1001 + parseInt(countRes.rows[0].count);
        const siparis_no = `SAT-S-${siradakiNo}`;

        // 2. Ana Sipariş Başlığını Kaydet
        const siparisInsert = await client.query(`
            INSERT INTO satinalma_siparisleri (siparis_no, tedarikci_id, siparis_tarihi, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani)
            VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9) RETURNING id
        `, [siparis_no, tedarikci_id, termin_tarihi || null, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi || 'TL', kdv_orani || 20]);

        const yeniSiparisId = siparisInsert.rows[0].id;

        // 3. Kalemleri Tek Tek İncele ve Kısmi Bölünme Algoritmasını Çalıştır
        for (const kalem of kalemler) {
            // Mevcut talep kaleminin orijinal bilgilerini çek
            const origRes = await client.query('SELECT miktar, talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, aciklama, durum FROM talep_urunleri WHERE id = $1', [kalem.talep_urun_id]);
            if (origRes.rowCount === 0) continue;

            // KURAL: Sipariş açılabilmesi için kalem 'İŞLEME ALINDI' veya 'TEKLİF İSTENDİ' olmalı
            const kalemDurum = (origRes.rows[0].durum || '').trim();
            if (kalemDurum !== 'İŞLEME ALINDI' && kalemDurum !== 'TEKLİF İSTENDİ') {
                throw new Error(`Bu kalem siparişe alınamaz. Mevcut durum: "${kalemDurum}". Önce talebi "İŞLEME ALINDI" durumuna getirmelisiniz.`);
            }

            const origMiktar = parseFloat(origRes.rows[0].miktar);
            const sipMiktar = parseFloat(kalem.siparis_miktari);

            if (sipMiktar > 0 && sipMiktar < origMiktar) {
                // --- APPS SCRIPT BÖLÜNME ZEKASI BAŞLADI ---
                // İstetilen miktar: 100, Sipariş verilen: 40. Kalan 60 için YENİ satır kopyala
                const kalanMiktar = origMiktar - sipMiktar;
                
                await client.query(`
                    INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                    VALUES ($1, $2, $3, $4, $5, $6, 'İŞLEME ALINDI')
                `, [origRes.rows[0].talep_id, origRes.rows[0].stok_kart_id, origRes.rows[0].ozel_urun_adi, origRes.rows[0].ozel_urun_birim, kalanMiktar, origRes.rows[0].aciklama]);

                // Mevcut satırı sipariş verilen miktara (40) çek ve durumunu güncelle
                await client.query(`
                    UPDATE talep_urunleri 
                    SET miktar = $1, durum = 'SİPARİŞ OLUŞTURULDU' 
                    WHERE id = $2
                `, [sipMiktar, kalem.talep_urun_id]);

            } else {
                // Tam sipariş verildiyse miktar değiştirme, sadece durumu 'SİPARİŞ OLUŞTURULDU' yap
                await client.query(`
                    UPDATE talep_urunleri SET durum = 'SİPARİŞ OLUŞTURULDU' WHERE id = $1
                `, [kalem.talep_urun_id]);
            }

            // 4. Sipariş Edilen Ürünü Fiyatıyla Sipariş Kalemlerine Ekle
            await client.query(`
                INSERT INTO siparis_kalemleri (siparis_id, talep_urun_id, birim_fiyat, siparis_miktari)
                VALUES ($1, $2, $3, $4)
            `, [yeniSiparisId, kalem.talep_urun_id, kalem.birim_fiyat, sipMiktar]);
        }

        await client.query('COMMIT'); // Tüm işlemleri tek seferde veritabanına mühürle
        res.json({ ok: true, mesaj: `Sipariş başarıyla oluşturuldu: ${siparis_no}` });
    } catch (error) {
        await client.query('ROLLBACK'); // En ufak hatada şantiyeyi ve talepleri eski haline döndür
        next(error);
    } finally {
        client.release();
    }
});

// YENİ: Kesilen Tüm Siparişleri Finansal Özetleri ve Kalem Sayılarıyla Listele
app.get('/api/siparis-listesi', yetkiKontrol, async (req, res, next) => {
    try {
        const query = `
            SELECT s.id, s.siparis_no, s.siparis_tarihi, s.termin_tarihi, s.para_birimi, s.kdv_orani,
                   COALESCE(s.durum, 'SİPARİŞ VERİLDİ') as durum,
                   t.firma_adi as tedarikci_adi,
                   COALESCE(SUM(sk.siparis_miktari * sk.birim_fiyat), 0) as ara_toplam,
                   COUNT(sk.id) as kalem_sayisi
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            LEFT JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            WHERE COALESCE(s.arsiv, false) = false
            GROUP BY s.id, t.firma_adi
            ORDER BY s.siparis_tarihi DESC NULLS LAST, s.id DESC
        `;
        const result = await pool.query(query);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// YENİ: Teslim Alınacak Siparişin İçindeki Ürünleri ve İlişkili Stok Bilgilerini Getir
app.get('/api/siparis-detay/:siparisId', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparisId } = req.params;
        const query = `
            SELECT sk.id as siparis_kalem_id, sk.siparis_miktari, sk.birim_fiyat,
                   COALESCE(sk.teslim_alinan_miktar, 0) as teslim_alinan_miktar,
                   sk.durum as kalem_durum,
                   tu.stok_kart_id, tu.ozel_urun_adi, tu.ozel_urun_birim,
                   COALESCE(s_kart.stok_adi, tu.ozel_urun_adi) as urun_adi,
                   COALESCE(s_kart.stok_kodu, 'ÖZEL') as stok_kodu,
                   COALESCE(s_kart.birim, tu.ozel_urun_birim) as birim
            FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            LEFT JOIN stok_kartlari s_kart ON tu.stok_kart_id = s_kart.id
            WHERE sk.siparis_id = $1
            ORDER BY sk.id ASC
        `;
        const result = await pool.query(query, [siparisId]);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// Bir talep'e bağlı tüm siparişleri getir (çapraz navigasyon için)
app.get('/api/talep/:talepId/siparisler', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT DISTINCT s.id, s.siparis_no, s.durum, s.siparis_tarihi, s.termin_tarihi, t.firma_adi as tedarikci_adi
            FROM satinalma_siparisleri s
            JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            WHERE tu.talep_id = $1
            ORDER BY s.siparis_tarihi DESC NULLS LAST, s.id DESC
        `, [req.params.talepId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Bir siparişin bağlı olduğu talep bilgisini getir
app.get('/api/siparis/:siparisId/talep', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT DISTINCT t.id, t.talep_no, t.durum
            FROM satinalma_talepleri t
            JOIN talep_urunleri tu ON tu.talep_id = t.id
            JOIN siparis_kalemleri sk ON sk.talep_urun_id = tu.id
            WHERE sk.siparis_id = $1
            LIMIT 1
        `, [req.params.siparisId]);
        res.json({ ok: true, data: r.rows[0] || null });
    } catch (e) { next(e); }
});

// =================================================================
// TEKLİF HAVUZU — TEKLİF İSTENDİ durumundaki kalemleri listele
// =================================================================
app.get('/api/teklif-havuzu', yetkiKontrol, async (req, res, next) => {
    try {
        const result = await pool.query(`
            SELECT tu.id as kalem_id, tu.miktar, tu.aciklama, tu.durum,
                   tu.teklif_notlari,
                   t.id as talep_id, t.talep_no, t.istenen_tarih, t.kayit_tarihi,
                   COALESCE(p.proje_kodu,'GENEL') as proje_kodu,
                   COALESCE(p.musteri_adi,'') as musteri_adi,
                   COALESCE(p.proje_adi,'Genel') as proje_adi,
                   sk.stok_kodu, sk.stok_adi, sk.birim as stok_birim,
                   tu.ozel_urun_adi, tu.ozel_urun_birim
            FROM talep_urunleri tu
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            WHERE tu.durum IN ('TEKLİF İSTENDİ','İŞLEME ALINDI') AND COALESCE(t.arsiv,false) = false
            ORDER BY t.kayit_tarihi DESC NULLS LAST, t.id DESC, tu.id ASC
        `);
        res.json({ ok: true, data: result.rows });
    } catch (e) { next(e); }
});

// =================================================================
// ARŞİV LİSTESİ (hem talep hem sipariş)
// =================================================================
app.get('/api/satinalma-arsiv', yetkiKontrol, async (req, res, next) => {
    try {
        const talepler = await pool.query(`
            SELECT t.id, t.talep_no, t.talep_eden, t.istenen_tarih, t.durum, t.kayit_tarihi,
                   COALESCE(p.proje_adi, 'Genel / Belirsiz') as proje_adi,
                   COALESCE(p.proje_kodu, 'GENEL') as proje_kodu,
                   COALESCE(p.musteri_adi, '') as musteri_adi,
                   COALESCE(COUNT(tu.id), 0) as urun_sayisi
            FROM satinalma_talepleri t
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN talep_urunleri tu ON t.id = tu.talep_id
            WHERE COALESCE(t.arsiv, false) = true
            GROUP BY t.id, p.proje_adi, p.proje_kodu, p.musteri_adi
            ORDER BY t.kayit_tarihi DESC NULLS LAST, t.id DESC
        `);
        const siparisler = await pool.query(`
            SELECT s.id, s.siparis_no, s.siparis_tarihi, s.termin_tarihi, s.para_birimi, s.kdv_orani,
                   COALESCE(s.durum, 'SİPARİŞ VERİLDİ') as durum,
                   t.firma_adi as tedarikci_adi,
                   COALESCE(SUM(sk.siparis_miktari * sk.birim_fiyat), 0) as ara_toplam,
                   COUNT(sk.id) as kalem_sayisi
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            LEFT JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            WHERE COALESCE(s.arsiv, false) = true
            GROUP BY s.id, t.firma_adi
            ORDER BY s.siparis_tarihi DESC NULLS LAST, s.id DESC
        `);
        res.json({ ok: true, talepler: talepler.rows, siparisler: siparisler.rows });
    } catch (e) { next(e); }
});

// Arşivden geri çıkar (talep veya sipariş)
app.post('/api/arsivden-cikar', yetkiKontrol, async (req, res, next) => {
    try {
        const { tur, id } = req.body; // tur: 'talep' | 'siparis'
        if (tur === 'talep') {
            await pool.query("UPDATE satinalma_talepleri SET arsiv=false WHERE id=$1", [id]);
        } else if (tur === 'siparis') {
            await pool.query("UPDATE satinalma_siparisleri SET arsiv=false WHERE id=$1", [id]);
        } else {
            return res.json({ ok: false, hata: 'Geçersiz tür.' });
        }
        res.json({ ok: true, mesaj: 'Arşivden çıkarıldı.' });
    } catch (e) { next(e); }
});

// =================================================================
// TALEP DURUM GEÇİŞLERİ
// =================================================================

// Talebi onayla — tüm kalemleri ONAYLANDI yapar
app.post('/api/talep-onayla', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { talep_id, kalem_idler } = req.body;
        if (!talep_id) return res.json({ ok: false, hata: 'Talep ID gerekli.' });

        if (Array.isArray(kalem_idler) && kalem_idler.length > 0) {
            await client.query("UPDATE talep_urunleri SET durum='ONAYLANDI' WHERE id = ANY($1::integer[])", [kalem_idler]);
        } else {
            await client.query("UPDATE talep_urunleri SET durum='ONAYLANDI' WHERE talep_id=$1 AND durum='ONAY BEKLİYOR'", [talep_id]);
        }

        // Hepsi ONAYLANDI ise talebin de durumunu güncelle
        const kalan = await client.query("SELECT COUNT(*) FROM talep_urunleri WHERE talep_id=$1 AND durum='ONAY BEKLİYOR'", [talep_id]);
        if (parseInt(kalan.rows[0].count) === 0) {
            await client.query("UPDATE satinalma_talepleri SET durum='ONAYLANDI', onaylayan=$1, onay_tarihi=NOW() WHERE id=$2",
                [req.user.adSoyad, talep_id]);
        }
        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Talep onaylandı.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Talebi reddet (gerekçeyle) — geriye dönük uyumluluk için
app.post('/api/talep-reddet', yetkiKontrol, async (req, res, next) => {
    // Reddet artık İptal'e dönüştürülüyor (akış sadeleştirildi)
    req.url = '/api/talep-iptal';
    return app._router.handle(req, res, next);
});

// Talebi iptal et (REDDET butonu da buraya gider artık)
app.post('/api/talep-iptal', yetkiKontrol, async (req, res, next) => {
    try {
        const { talep_id, kalem_idler, gerekce } = req.body;
        if (!talep_id) return res.json({ ok: false, hata: 'Talep ID gerekli.' });
        if (Array.isArray(kalem_idler) && kalem_idler.length > 0) {
            await pool.query("UPDATE talep_urunleri SET durum='İPTAL' WHERE id = ANY($1::integer[])", [kalem_idler]);
        } else {
            await pool.query("UPDATE talep_urunleri SET durum='İPTAL' WHERE talep_id=$1", [talep_id]);
        }
        await pool.query("UPDATE satinalma_talepleri SET durum='İPTAL', red_gerekce=$1 WHERE id=$2",
            [gerekce || null, talep_id]);
        res.json({ ok: true, mesaj: 'Talep iptal edildi.' });
    } catch (e) { next(e); }
});

// Talebi arşivle — bağlı siparişler de arşivlenir
app.post('/api/talep-arsivle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { talep_id } = req.body;
        await client.query("UPDATE satinalma_talepleri SET arsiv=true WHERE id=$1", [talep_id]);
        // Bağlı siparişleri de arşivle
        const sR = await client.query(`
            UPDATE satinalma_siparisleri SET arsiv=true
            WHERE id IN (
                SELECT DISTINCT s.id FROM satinalma_siparisleri s
                JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
                JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
                WHERE tu.talep_id = $1
            )
            RETURNING id
        `, [talep_id]);
        await client.query('COMMIT');
        const mesaj = sR.rowCount > 0
            ? `Talep ve bağlı ${sR.rowCount} sipariş arşivlendi.`
            : 'Talep arşivlendi.';
        res.json({ ok: true, mesaj });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Talep düzenleme — sadece ONAY BEKLİYOR durumunda
app.post('/api/talep-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id, proje_id, istenen_tarih, teslim_yeri, genel_aciklama, kalemler } = req.body;
        if (!id) return res.json({ ok: false, hata: 'Talep ID gerekli.' });

        // Sadece ONAY BEKLİYOR durumunda düzenlenebilir
        const dR = await client.query('SELECT durum FROM satinalma_talepleri WHERE id=$1', [id]);
        if (dR.rowCount === 0) return res.json({ ok: false, hata: 'Talep bulunamadı.' });
        if (dR.rows[0].durum !== 'ONAY BEKLİYOR') {
            return res.json({ ok: false, hata: `Sadece "ONAY BEKLİYOR" durumundaki talepler düzenlenebilir. Mevcut durum: ${dR.rows[0].durum}` });
        }

        // Ana talebi güncelle
        await client.query(`
            UPDATE satinalma_talepleri
            SET proje_id=$1, istenen_tarih=$2, teslim_yeri=$3, genel_aciklama=$4
            WHERE id=$5
        `, [proje_id || null, istenen_tarih || null, teslim_yeri || null, genel_aciklama || null, id]);

        // Mevcut kalemleri yükle
        const mevcut = await client.query('SELECT id FROM talep_urunleri WHERE talep_id=$1', [id]);
        const mevcutIds = new Set(mevcut.rows.map(r => r.id));
        const gonderilenIds = new Set();

        // Her kalem için işle (id varsa güncelle, yoksa ekle)
        for (const k of (kalemler || [])) {
            if (k.id && mevcutIds.has(k.id)) {
                await client.query(`
                    UPDATE talep_urunleri
                    SET stok_kart_id=$1, ozel_urun_adi=$2, ozel_urun_birim=$3, miktar=$4, aciklama=$5
                    WHERE id=$6
                `, [
                    k.stok_kart_id || null, k.ozel_urun_adi || null, k.ozel_urun_birim || 'ADET',
                    parseFloat(k.miktar) || 0, k.aciklama || null, k.id
                ]);
                gonderilenIds.add(k.id);
            } else {
                await client.query(`
                    INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                    VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR')
                `, [
                    id, k.stok_kart_id || null, k.ozel_urun_adi || null, k.ozel_urun_birim || 'ADET',
                    parseFloat(k.miktar) || 0, k.aciklama || null
                ]);
            }
        }

        // Gönderilmeyen mevcut kalemleri sil
        const silinecek = [...mevcutIds].filter(id => !gonderilenIds.has(id));
        if (silinecek.length > 0) {
            await client.query('DELETE FROM talep_urunleri WHERE id = ANY($1::integer[])', [silinecek]);
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Talep güncellendi.', silinen_kalem: silinecek.length });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Sipariş düzenleme — sadece SİPARİŞ OLUŞTURULDU durumunda
app.post('/api/siparis-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id, tedarikci_id, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi,
                siparis_notu, para_birimi, kdv_orani, kalemler } = req.body;
        if (!id) return res.json({ ok: false, hata: 'Sipariş ID gerekli.' });

        const dR = await client.query('SELECT durum FROM satinalma_siparisleri WHERE id=$1', [id]);
        if (dR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        if (dR.rows[0].durum !== 'SİPARİŞ OLUŞTURULDU') {
            return res.json({ ok: false, hata: `Sadece "SİPARİŞ OLUŞTURULDU" durumundaki siparişler düzenlenebilir. Mevcut: ${dR.rows[0].durum}` });
        }

        // Ana siparişi güncelle
        await client.query(`
            UPDATE satinalma_siparisleri
            SET tedarikci_id=$1, termin_tarihi=$2, odeme_vade=$3, teslim_nakliye=$4,
                teslim_adresi=$5, siparis_notu=$6, para_birimi=$7, kdv_orani=$8
            WHERE id=$9
        `, [
            tedarikci_id || null, termin_tarihi || null, odeme_vade || null, teslim_nakliye || null,
            teslim_adresi || null, siparis_notu || null, para_birimi || 'TL', parseInt(kdv_orani) || 20, id
        ]);

        // Sipariş kalemlerini güncelle (birim_fiyat, siparis_miktari değişebilir)
        for (const k of (kalemler || [])) {
            if (!k.siparis_kalem_id) continue;
            await client.query(`
                UPDATE siparis_kalemleri
                SET birim_fiyat=$1, siparis_miktari=$2
                WHERE id=$3
            `, [parseFloat(k.birim_fiyat) || 0, parseFloat(k.siparis_miktari) || 0, k.siparis_kalem_id]);
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Sipariş güncellendi.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// TEKLİF İSTE — kalem listesini TEKLİF İSTENDİ durumuna geçir
// Body: { kalem_idler: [int], tedarikci_idler: [int], aciklama }
app.post('/api/teklif-iste', yetkiKontrol, async (req, res, next) => {
    try {
        const { kalem_idler, tedarikci_idler, aciklama } = req.body;
        if (!Array.isArray(kalem_idler) || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: 'En az bir kalem seçilmelidir.' });
        }
        // Kalemlerin İŞLEME ALINDI veya TEKLİF İSTENDİ olduğunu kontrol et
        const ctrl = await pool.query(
            "SELECT id, durum FROM talep_urunleri WHERE id = ANY($1::integer[])", [kalem_idler]
        );
        const gecersiz = ctrl.rows.filter(r => !['İŞLEME ALINDI','TEKLİF İSTENDİ'].includes((r.durum||'').trim()));
        if (gecersiz.length > 0) {
            return res.json({ ok: false, hata: `${gecersiz.length} kalem uygun durumda değil (İŞLEME ALINDI veya TEKLİF İSTENDİ olmalı).` });
        }

        // Kalemleri TEKLİF İSTENDİ'ye çek
        await pool.query("UPDATE talep_urunleri SET durum='TEKLİF İSTENDİ' WHERE id = ANY($1::integer[])", [kalem_idler]);

        // Ana talep durumunu kontrol et — eğer tüm kalemler TEKLİF İSTENDİ ise talep durumunu da güncelle
        const ilgiliR = await pool.query(`
            SELECT DISTINCT talep_id FROM talep_urunleri WHERE id = ANY($1::integer[])
        `, [kalem_idler]);
        for (const t of ilgiliR.rows) {
            const kalanR = await pool.query(`
                SELECT COUNT(*) FROM talep_urunleri
                WHERE talep_id = $1 AND durum NOT IN ('TEKLİF İSTENDİ','İPTAL','TAM TESLİM')
            `, [t.talep_id]);
            if (parseInt(kalanR.rows[0].count) === 0) {
                await pool.query("UPDATE satinalma_talepleri SET durum='TEKLİF İSTENDİ' WHERE id=$1", [t.talep_id]);
            }
        }

        // Teklif kaydını JSONB olarak talep notlarına veya ek tabloya yazabiliriz — şimdilik aciklama sadece dönüş mesajında
        const tedariliciSayisi = Array.isArray(tedarikci_idler) ? tedarikci_idler.length : 0;
        res.json({
            ok: true,
            mesaj: `${kalem_idler.length} kalem TEKLİF İSTENDİ durumuna geçirildi.${tedariliciSayisi > 0 ? ` (${tedariliciSayisi} tedarikçi)` : ''}`
        });
    } catch (e) { next(e); }
});

// Talebi geri al (önceki duruma çek)
app.post('/api/talep-gerial', yetkiKontrol, async (req, res, next) => {
    try {
        const { talep_id, hedef_durum } = req.body;
        const yeniDurum = hedef_durum || 'ONAY BEKLİYOR';
        await pool.query("UPDATE talep_urunleri SET durum=$1 WHERE talep_id=$2", [yeniDurum, talep_id]);
        await pool.query("UPDATE satinalma_talepleri SET durum=$1, arsiv=false WHERE id=$2", [yeniDurum, talep_id]);
        res.json({ ok: true, mesaj: 'Talep geri alındı.' });
    } catch (e) { next(e); }
});

// =================================================================
// SİPARİŞ DURUM GEÇİŞLERİ
// =================================================================
app.post('/api/siparis-onayla', yetkiKontrol, async (req, res, next) => {
    try {
        await pool.query("UPDATE satinalma_siparisleri SET durum='SİPARİŞ ONAYLANDI', onaylanma_tarihi=NOW() WHERE id=$1",
            [req.body.siparis_id]);
        res.json({ ok: true, mesaj: 'Sipariş onaylandı.' });
    } catch (e) { next(e); }
});

app.post('/api/siparis-gonder', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparis_id, ek_alici, ek_mesaj } = req.body;

        // Tedarikçi mail bilgisini al
        const sR = await pool.query(`
            SELECT s.siparis_no, s.para_birimi, s.kdv_orani, t.firma_adi, t.email as tedarikci_email
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            WHERE s.id = $1
        `, [siparis_id]);
        if (sR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        const sip = sR.rows[0];

        if (!sip.tedarikci_email && !ek_alici) {
            return res.json({ ok: false, hata: `Tedarikçi "${sip.firma_adi || '-'}" için kayıtlı e-posta yok. Tedarikçiler sekmesinden ekleyin veya alt alıcı yazın.` });
        }

        // 1) Sipariş durumunu güncelle
        await pool.query("UPDATE satinalma_siparisleri SET durum='SİPARİŞ GÖNDERİLDİ', gonderim_tarihi=NOW() WHERE id=$1", [siparis_id]);

        // 2) Mail gönder (varsa)
        let mailDurum = 'gönderilmedi';
        if (mailTransporter) {
            try {
                // PDF üret (mevcut endpoint mantığını burada inline kullanalım)
                const pdfBuffer = await siparisPDFUret(siparis_id, req.user);

                const aliciListe = [sip.tedarikci_email, ek_alici].filter(Boolean).join(', ');
                const konu = `Sipariş Bildirimi — ${sip.siparis_no} | Aterko`;
                const govdeHTML = `
                    <div style="font-family:Arial,sans-serif;color:#212529;">
                      <p>Sayın <strong>${sip.firma_adi || 'İlgili Yetkili'}</strong>,</p>
                      <p>Aşağıda detayları bulunan sipariş tarafınıza iletilmiştir. Detaylar ekteki PDF'tedir.</p>
                      <table style="border-collapse:collapse;font-size:14px;">
                        <tr><td style="padding:4px 10px;color:#6c757d;">Sipariş No:</td><td style="padding:4px 10px;"><strong>${sip.siparis_no}</strong></td></tr>
                      </table>
                      ${ek_mesaj ? `<p style="margin-top:12px;padding:10px;background:#fff8e1;border-left:3px solid #ffc107;">${ek_mesaj.replace(/\n/g, '<br>')}</p>` : ''}
                      <p>Termin tarihinden önce teslimat planınızı bildirmenizi rica ederiz. Sorularınız için cevap mailimizden ulaşabilirsiniz.</p>
                      <p style="margin-top:18px;color:#6c757d;font-size:12px;">İyi çalışmalar,<br><strong>Aterko Satın Alma</strong></p>
                    </div>
                `;

                await mailTransporter.sendMail({
                    from: `"Aterko Satın Alma" <${process.env.GMAIL_USER}>`,
                    to: aliciListe,
                    cc: process.env.GMAIL_USER,
                    subject: konu,
                    html: govdeHTML,
                    attachments: [{
                        filename: `Siparis-${sip.siparis_no}.pdf`,
                        content: pdfBuffer
                    }]
                });
                mailDurum = `gönderildi (${aliciListe})`;
            } catch (e) {
                console.error('Mail gönderme hatası:', e.message);
                mailDurum = `gönderilemedi: ${e.message}`;
            }
        }

        res.json({ ok: true, mesaj: `Sipariş "GÖNDERİLDİ" olarak işaretlendi. E-posta: ${mailDurum}.` });
    } catch (e) { next(e); }
});

// PDF üretim helper — yukarıdaki /api/siparis-pdf endpoint'inin core'u
async function siparisPDFUret(siparisId, user) {
    const sR = await pool.query(`
        SELECT s.*, t.firma_adi as tedarikci_adi, t.adres as tedarikci_adres
        FROM satinalma_siparisleri s LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
        WHERE s.id = $1
    `, [siparisId]);
    if (sR.rowCount === 0) throw new Error('Sipariş bulunamadı.');
    const s = sR.rows[0];
    const kR = await pool.query(`
        SELECT sk.siparis_miktari, sk.birim_fiyat,
               COALESCE(sc.stok_adi, tu.ozel_urun_adi) as urun_adi,
               COALESCE(sc.stok_kodu, 'ÖZEL') as stok_kodu,
               COALESCE(sc.birim, tu.ozel_urun_birim) as birim
        FROM siparis_kalemleri sk
        JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
        LEFT JOIN stok_kartlari sc ON tu.stok_kart_id = sc.id
        WHERE sk.siparis_id = $1 ORDER BY sk.id ASC
    `, [siparisId]);

    const trNum = n => {
        const v = parseFloat(n) || 0;
        const p = v.toFixed(2).split('.');
        return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1];
    };
    const trTarih = d => {
        if (!d) return '-';
        const dt = new Date(d);
        return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;
    };

    const para = s.para_birimi || 'TL';
    const kdv = parseInt(s.kdv_orani) || 20;
    let araToplam = 0;
    const kalemSatirlari = kR.rows.map((k, i) => {
        const tutar = parseFloat(k.siparis_miktari) * parseFloat(k.birim_fiyat);
        araToplam += tutar;
        return `<tr>
            <td class="text-center">${i+1}</td>
            <td>${k.stok_kodu || '-'}</td>
            <td>${k.urun_adi || '-'}</td>
            <td class="text-center">${trNum(k.siparis_miktari)}</td>
            <td class="text-center">${k.birim || ''}</td>
            <td class="text-end">${trNum(k.birim_fiyat)} ${para}</td>
            <td class="text-end">${trNum(tutar)} ${para}</td>
        </tr>`;
    }).join('');
    const kdvTutar = araToplam * kdv / 100;
    const genelToplam = araToplam + kdvTutar;

    const degerler = {
        'Sipariş No': s.siparis_no,
        'Sipariş Tarihi': trTarih(s.siparis_tarihi),
        'Tedarikçi Adı': s.tedarikci_adi || '-',
        'Termin Tarihi': trTarih(s.termin_tarihi),
        'Ödeme Vadesi': s.odeme_vade || '-',
        'Teslim Nakliye': s.teslim_nakliye || '-',
        'Teslim Adresi': s.teslim_adresi || s.tedarikci_adres || '-',
        'Ara Toplam': `${trNum(araToplam)} ${para}`,
        'KDV Oranı': String(kdv),
        'KDV Tutarı': `${trNum(kdvTutar)} ${para}`,
        'Genel Toplam': `${trNum(genelToplam)} ${para}`,
        'Sipariş Notu': s.siparis_notu || '',
        'Sipariş Notu Var?': s.siparis_notu ? 'Evet' : 'Hayır',
        'Hazırlayan': (user && user.adSoyad) || '-'
    };

    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'templates', 'siparis.html'), 'utf8');
    html = html.replace('{{KALEM_SATIRLARI}}', kalemSatirlari);
    const tempPath = path.join(__dirname, 'templates', `__siparis_mail_${Date.now()}.html`);
    fs.writeFileSync(tempPath, html);
    const tempName = path.basename(tempPath, '.html');
    const pdf = await pdfRender(tempName, degerler);
    try { fs.unlinkSync(tempPath); } catch (e) {}
    return pdf;
}

app.post('/api/siparis-iptal', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { siparis_id } = req.body;
        // Siparişin kalemlerine bağlı talep ürünlerini İŞLEME ALINDI durumuna geri çevir
        await client.query(`
            UPDATE talep_urunleri SET durum='ONAYLANDI'
            WHERE id IN (SELECT talep_urun_id FROM siparis_kalemleri WHERE siparis_id=$1)
        `, [siparis_id]);
        await client.query("UPDATE satinalma_siparisleri SET durum='İPTAL' WHERE id=$1", [siparis_id]);
        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Sipariş iptal edildi, talepler geri alındı.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

app.post('/api/siparis-arsivle', yetkiKontrol, async (req, res, next) => {
    try {
        await pool.query("UPDATE satinalma_siparisleri SET arsiv=true WHERE id=$1", [req.body.siparis_id]);
        res.json({ ok: true, mesaj: 'Sipariş arşivlendi.' });
    } catch (e) { next(e); }
});

app.post('/api/siparis-gerial', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparis_id, hedef_durum } = req.body;
        const hedef = hedef_durum || 'SİPARİŞ OLUŞTURULDU';
        // SİPARİŞ ONAYLANDI'ya geri çekilince gonderim_tarihi null
        if (hedef === 'SİPARİŞ ONAYLANDI') {
            await pool.query("UPDATE satinalma_siparisleri SET durum=$1, gonderim_tarihi=NULL WHERE id=$2",
                [hedef, siparis_id]);
        } else if (hedef === 'SİPARİŞ OLUŞTURULDU') {
            await pool.query("UPDATE satinalma_siparisleri SET durum=$1, gonderim_tarihi=NULL, onaylanma_tarihi=NULL WHERE id=$2",
                [hedef, siparis_id]);
        } else {
            await pool.query("UPDATE satinalma_siparisleri SET durum=$1 WHERE id=$2", [hedef, siparis_id]);
        }
        res.json({ ok: true, mesaj: 'Sipariş geri alındı.' });
    } catch (e) { next(e); }
});

// SİPARİŞ OLUŞTURULDU → tamamen geri al = siparişi SİL, talep kalemlerini İŞLEME ALINDI'ya çevir
// ve aynı stok_kart_id'li bölünmüş kalemleri birleştir (tek kalemde topla)
app.post('/api/siparis-tamamen-sil', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { siparis_id } = req.body;
        const dR = await client.query("SELECT durum FROM satinalma_siparisleri WHERE id=$1", [siparis_id]);
        if (dR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        if (dR.rows[0].durum !== 'SİPARİŞ OLUŞTURULDU') {
            return res.json({ ok: false, hata: 'Sadece "SİPARİŞ OLUŞTURULDU" durumundaki siparişler tamamen geri alınabilir.' });
        }

        // 1) Sipariş kalemlerine bağlı talep ürünlerini çek (birleştirme için lazım)
        const skR = await client.query(`
            SELECT sk.talep_urun_id, sk.siparis_miktari, tu.talep_id, tu.stok_kart_id, tu.ozel_urun_adi
            FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            WHERE sk.siparis_id = $1
        `, [siparis_id]);

        // 2) Sipariş kalemleri ve siparişi sil
        await client.query('DELETE FROM siparis_kalemleri WHERE siparis_id=$1', [siparis_id]);
        await client.query('DELETE FROM satinalma_siparisleri WHERE id=$1', [siparis_id]);

        // 3) Önce sipariş kalemlerini İŞLEME ALINDI'ya çevir
        const tuIds = skR.rows.map(r => r.talep_urun_id);
        if (tuIds.length > 0) {
            await client.query("UPDATE talep_urunleri SET durum='İŞLEME ALINDI' WHERE id = ANY($1::integer[])", [tuIds]);
        }

        // 4) BİRLEŞTİRME: Aynı talep_id + stok_kart_id (veya ozel_urun_adi) olan İŞLEME ALINDI kalemleri tek kalemde topla
        // (sipariş bölünmüşse, bölünen kalem zaten talep_urunleri'nde kalan miktar olarak duruyordu)
        let birlesen = 0;
        for (const sk of skR.rows) {
            // Bu talep + ürün için tüm İŞLEME ALINDI kalemleri bul (bizim eski kalem + bölünmüş kardeşi)
            const benzerR = await client.query(`
                SELECT id, miktar FROM talep_urunleri
                WHERE talep_id = $1 AND durum = 'İŞLEME ALINDI'
                  AND (
                    ($2::integer IS NOT NULL AND stok_kart_id = $2)
                    OR ($2::integer IS NULL AND ozel_urun_adi = $3)
                  )
                ORDER BY id ASC
            `, [sk.talep_id, sk.stok_kart_id, sk.ozel_urun_adi]);
            if (benzerR.rows.length > 1) {
                // İlk satıra topla, diğerlerini sil
                const ilkId = benzerR.rows[0].id;
                const toplam = benzerR.rows.reduce((s, r) => s + parseFloat(r.miktar), 0);
                const silinecekIds = benzerR.rows.slice(1).map(r => r.id);
                await client.query('UPDATE talep_urunleri SET miktar=$1 WHERE id=$2', [toplam, ilkId]);
                await client.query('DELETE FROM talep_urunleri WHERE id = ANY($1::integer[])', [silinecekIds]);
                birlesen += silinecekIds.length;
            }
        }

        await client.query('COMMIT');
        res.json({
            ok: true,
            mesaj: `Sipariş silindi. Talep kalemleri İŞLEME ALINDI durumuna döndü${birlesen > 0 ? ` ve ${birlesen} bölünmüş kalem birleştirildi` : ''}.`
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// MAL KABUL: Otomatik Stok Hareketi + Kısmi Teslim + Tam Teslim Otomasyonu
// Body: { siparis_id, depo_id (opsiyonel), kalemler: [{ siparis_kalem_id, miktar, stok_kart_id, aciklama }] }
app.post('/api/siparis-teslim-al', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { siparis_id, depo_id, kalemler } = req.body;
        if (!siparis_id || !Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Sipariş ve kalem listesi gerekli.' });
        }

        // Siparişe bağlı bilgileri çek (stok hareketi açıklaması için)
        const sR = await client.query(`
            SELECT s.siparis_no, s.tedarikci_id, t.firma_adi as tedarikci_adi
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            WHERE s.id = $1
        `, [siparis_id]);
        if (sR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        const siparisBilgi = sR.rows[0];

        // Talep'in proje_id'sini bul (stok hareketi için)
        const projeR = await client.query(`
            SELECT DISTINCT t.proje_id FROM satinalma_siparisleri s
            JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            WHERE s.id = $1 LIMIT 1
        `, [siparis_id]);
        const projeId = projeR.rows[0]?.proje_id || null;

        // Her kalemi işle
        for (const kalem of kalemler) {
            const teslimMiktar = parseFloat(kalem.miktar) || 0;
            if (teslimMiktar <= 0) continue;

            // 1. Sipariş kalemini güncelle (kümülatif teslim alınan)
            const skR = await client.query(`
                SELECT siparis_miktari, teslim_alinan_miktar, talep_urun_id
                FROM siparis_kalemleri WHERE id = $1
            `, [kalem.siparis_kalem_id]);
            if (skR.rowCount === 0) continue;
            const sk = skR.rows[0];
            const eskiTeslim = parseFloat(sk.teslim_alinan_miktar) || 0;
            const yeniToplamTeslim = eskiTeslim + teslimMiktar;
            const siparisMiktari = parseFloat(sk.siparis_miktari) || 0;
            const tamMi = yeniToplamTeslim >= siparisMiktari;

            await client.query(`
                UPDATE siparis_kalemleri
                SET teslim_alinan_miktar = $1, son_teslim_tarihi = NOW(),
                    durum = $2
                WHERE id = $3
            `, [yeniToplamTeslim, tamMi ? 'TAM TESLİM' : 'KISMİ TESLİM', kalem.siparis_kalem_id]);

            // 2. Talep ürününün durumunu da güncelle
            await client.query(`
                UPDATE talep_urunleri SET durum = $1 WHERE id = $2
            `, [tamMi ? 'TAM TESLİM' : 'KISMİ TESLİM', sk.talep_urun_id]);

            // 3. MAL KABUL LOGU — HER HALÜKARDA at (stoğa girsin/girmesin)
            // Yönlendirme: STOĞA / ÜRETİME / DİREKT_SEVKIYAT
            const yonlendirme = (kalem.yonlendirme || (kalem.stoga_isle !== false ? 'STOĞA' : 'DİREKT_SEVKIYAT')).toUpperCase();
            const stogaIslendi = (yonlendirme === 'STOĞA');
            await client.query(`
                INSERT INTO mal_kabul_loglari
                (siparis_kalem_id, teslim_alinan_miktar, depo_id, yonlendirme,
                 hedef_teslimat_id, stoga_islendi_mi, teslimat_notu,
                 kullanici_email, kullanici_adsoyad)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [kalem.siparis_kalem_id, teslimMiktar, depo_id || null, yonlendirme,
                kalem.hedef_teslimat_id || null, stogaIslendi,
                kalem.aciklama || null, req.user.email, req.user.adSoyad]);

            // 4. STOK HAREKETİ KAYDET — sadece STOĞA yönlendirilenler
            if (kalem.stok_kart_id && stogaIslendi) {
                const aciklama = `Sipariş ${siparisBilgi.siparis_no}${siparisBilgi.tedarikci_adi ? ' / ' + siparisBilgi.tedarikci_adi : ''}${kalem.aciklama ? ' - ' + kalem.aciklama : ''}`;
                await client.query(`
                    INSERT INTO stok_hareketleri
                    (stok_kart_id, tip, miktar, proje_id, depo_id, aciklama, kullanici_email, kullanici_adsoyad)
                    VALUES ($1, 'Giriş', $2, $3, $4, $5, $6, $7)
                `, [kalem.stok_kart_id, teslimMiktar, projeId, depo_id || null, aciklama,
                    req.user.email, req.user.adSoyad]);

                await client.query(`
                    UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1
                    WHERE id = $2
                `, [teslimMiktar, kalem.stok_kart_id]);
            }
        }

        // 4. Sipariş durumunu kontrol et — hepsi TAM TESLİM olduysa siparişi de TAM TESLİM yap
        const kalanR = await client.query(`
            SELECT COUNT(*) as kalan FROM siparis_kalemleri
            WHERE siparis_id = $1 AND durum != 'TAM TESLİM'
        `, [siparis_id]);
        const yeniSiparisDurum = parseInt(kalanR.rows[0].kalan) === 0 ? 'TAM TESLİM' : 'KISMİ TESLİM';
        await client.query('UPDATE satinalma_siparisleri SET durum = $1 WHERE id = $2',
            [yeniSiparisDurum, siparis_id]);

        await client.query('COMMIT');
        res.json({
            ok: true,
            mesaj: `Mal kabul tamamlandı. Sipariş durumu: ${yeniSiparisDurum}. Stok ve hareketler güncellendi.`,
            siparis_durumu: yeniSiparisDurum
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('🔥 Mal Kabul Hatası:', error);
        next(error);
    } finally {
        client.release();
    }
});

// =================================================================
// TEKNİK ŞARTNAME — Form Tanımları ve Kayıt
// =================================================================

// Bina türüne göre form tanımlarını getir
app.get('/api/form-tanimlari/:binaTuru', yetkiKontrol, async (req, res, next) => {
    try {
        const { binaTuru } = req.params;
        const result = await pool.query(`
            SELECT id, bolum_sirasi, bolum_adi, soru_sirasi, soru, giris_tipi,
                   secenekler, zorunlu, kurallar, kosullar
            FROM form_tanimlari
            WHERE bina_turu = $1
            ORDER BY bolum_sirasi ASC, soru_sirasi ASC
        `, [binaTuru]);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// Teslimatın mevcut teknik şartname verisini getir
app.get('/api/teknik-sartname/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;
        const result = await pool.query(`
            SELECT id, bina_adi, bina_turu, bina_tipi, kat_adedi, kat_yuksekligi,
                   bina_adedi, buyukluk_m2, bina_yeri, ek_veriler
            FROM proje_teslimatlari WHERE id = $1
        `, [teslimatId]);
        if (result.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const t = result.rows[0];
        // SALT_OKUNUR alanlar için otomatik değerler — kullanıcı kayıtta girmiş olanlardan gelir
        const otomatikDegerler = {
            'Bina Tipi': t.bina_tipi || '',
            'Kat Adedi': t.kat_adedi || '',
            'Kat Yüksekliği (mm)': t.kat_yuksekligi || ''
        };
        res.json({
            ok: true,
            teslimat: t,
            ek_veriler: t.ek_veriler || {},
            otomatik_degerler: otomatikDegerler
        });
    } catch (error) { next(error); }
});

// =================================================================
// SİPARİŞ DOSYALARI (irsaliye, fatura, vb.) — Supabase Storage
// =================================================================
const SIPARIS_BUCKET = 'siparis-ekleri';

// Bir siparişin tüm dosyalarını listele
app.get('/api/siparis-dosyalari/:siparisId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(
            'SELECT * FROM siparis_dosyalari WHERE siparis_id=$1 ORDER BY kayit_tarihi DESC',
            [req.params.siparisId]
        );
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Dosya yükle (multipart/form-data)
app.post('/api/siparis-dosya-yukle/:siparisId', yetkiKontrol, dosyaUpload.single('dosya'), async (req, res, next) => {
    if (!supabaseStorage) return res.status(500).json({ ok: false, hata: 'Storage yapılandırılmamış.' });
    try {
        const { siparisId } = req.params;
        if (!req.file) return res.json({ ok: false, hata: 'Dosya bulunamadı.' });

        // Sipariş var mı kontrol
        const sR = await pool.query('SELECT siparis_no FROM satinalma_siparisleri WHERE id=$1', [siparisId]);
        if (sR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        const siparisNo = sR.rows[0].siparis_no;

        // Storage path: SAT-S-1001/2026-05-25-Faturaxxx.pdf
        const safeName = req.file.originalname.replace(/[^A-Za-z0-9._\-]/g, '_');
        const ts = Date.now();
        const storagePath = `${siparisNo}/${ts}-${safeName}`;

        // Supabase Storage'a yükle
        const { error: upErr } = await supabaseStorage.storage
            .from(SIPARIS_BUCKET)
            .upload(storagePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });
        if (upErr) return res.json({ ok: false, hata: 'Yükleme hatası: ' + upErr.message });

        // Public URL al
        const { data: urlData } = supabaseStorage.storage.from(SIPARIS_BUCKET).getPublicUrl(storagePath);

        // DB'ye kaydet
        const r = await pool.query(`
            INSERT INTO siparis_dosyalari
            (siparis_id, dosya_adi, storage_path, public_url, mime_type, boyut, yukleyen_adsoyad, yukleyen_email)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [siparisId, req.file.originalname, storagePath, urlData.publicUrl,
            req.file.mimetype, req.file.size, req.user.adSoyad, req.user.email]);

        res.json({ ok: true, mesaj: 'Dosya yüklendi.', data: r.rows[0] });
    } catch (e) { console.error('Dosya yükleme:', e); next(e); }
});

// Dosya sil
app.delete('/api/siparis-dosya-sil/:dosyaId', yetkiKontrol, async (req, res, next) => {
    if (!supabaseStorage) return res.status(500).json({ ok: false, hata: 'Storage yapılandırılmamış.' });
    try {
        const r = await pool.query('SELECT storage_path FROM siparis_dosyalari WHERE id=$1', [req.params.dosyaId]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Dosya bulunamadı.' });

        // Storage'tan sil
        const { error: delErr } = await supabaseStorage.storage
            .from(SIPARIS_BUCKET)
            .remove([r.rows[0].storage_path]);
        if (delErr) console.warn('Storage sil uyarı:', delErr.message);

        // DB'den sil
        await pool.query('DELETE FROM siparis_dosyalari WHERE id=$1', [req.params.dosyaId]);
        res.json({ ok: true, mesaj: 'Dosya silindi.' });
    } catch (e) { next(e); }
});

// Sipariş PDF üret ve indir
const { renderToPDF: pdfRender } = require('./lib/pdf-generator');
app.get('/api/siparis-pdf/:siparisId', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparisId } = req.params;
        // Sipariş + tedarikçi + kalemler
        const sR = await pool.query(`
            SELECT s.*, t.firma_adi as tedarikci_adi, t.adres as tedarikci_adres
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            WHERE s.id = $1
        `, [siparisId]);
        if (sR.rowCount === 0) return res.status(404).json({ ok: false, hata: 'Sipariş bulunamadı.' });
        const s = sR.rows[0];

        const kR = await pool.query(`
            SELECT sk.siparis_miktari, sk.birim_fiyat,
                   COALESCE(sc.stok_adi, tu.ozel_urun_adi) as urun_adi,
                   COALESCE(sc.stok_kodu, 'ÖZEL') as stok_kodu,
                   COALESCE(sc.birim, tu.ozel_urun_birim) as birim
            FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            LEFT JOIN stok_kartlari sc ON tu.stok_kart_id = sc.id
            WHERE sk.siparis_id = $1
            ORDER BY sk.id ASC
        `, [siparisId]);
        const kalemler = kR.rows;

        // Türkçe sayı formatı
        const trNum = n => {
            const v = parseFloat(n) || 0;
            const parts = v.toFixed(2).split('.');
            return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + parts[1];
        };
        const trTarih = d => {
            if (!d) return '-';
            const dt = new Date(d);
            return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;
        };

        const para = s.para_birimi || 'TL';
        const kdv = parseInt(s.kdv_orani) || 20;
        let araToplam = 0;
        const kalemSatirlari = kalemler.map((k, i) => {
            const tutar = parseFloat(k.siparis_miktari) * parseFloat(k.birim_fiyat);
            araToplam += tutar;
            return `<tr>
                <td class="text-center">${i+1}</td>
                <td>${k.stok_kodu || '-'}</td>
                <td>${k.urun_adi || '-'}</td>
                <td class="text-center">${trNum(k.siparis_miktari)}</td>
                <td class="text-center">${k.birim || ''}</td>
                <td class="text-end">${trNum(k.birim_fiyat)} ${para}</td>
                <td class="text-end">${trNum(tutar)} ${para}</td>
            </tr>`;
        }).join('');
        const kdvTutar = araToplam * kdv / 100;
        const genelToplam = araToplam + kdvTutar;

        const degerler = {
            'Sipariş No': s.siparis_no,
            'Sipariş Tarihi': trTarih(s.siparis_tarihi),
            'Tedarikçi Adı': s.tedarikci_adi || '-',
            'Termin Tarihi': trTarih(s.termin_tarihi),
            'Ödeme Vadesi': s.odeme_vade || '-',
            'Teslim Nakliye': s.teslim_nakliye || '-',
            'Teslim Adresi': s.teslim_adresi || s.tedarikci_adres || '-',
            'Ara Toplam': `${trNum(araToplam)} ${para}`,
            'KDV Oranı': String(kdv),
            'KDV Tutarı': `${trNum(kdvTutar)} ${para}`,
            'Genel Toplam': `${trNum(genelToplam)} ${para}`,
            'Sipariş Notu': s.siparis_notu || '',
            'Sipariş Notu Var?': s.siparis_notu ? 'Evet' : 'Hayır',
            'Hazırlayan': req.user.adSoyad || '-',
            'KALEM_SATIRLARI': kalemSatirlari // özel placeholder, raw HTML
        };

        // Şablonu işle (KALEM_SATIRLARI'nı pre-process et)
        const { renderTemplate } = require('./lib/pdf-generator');
        const fs = require('fs');
        const path = require('path');
        let html = fs.readFileSync(path.join(__dirname, 'templates', 'siparis.html'), 'utf8');
        // {{KALEM_SATIRLARI}} özel — raw HTML olduğu için escape etmiyoruz
        html = html.replace('{{KALEM_SATIRLARI}}', kalemSatirlari);
        // Tempfile'a yaz
        fs.writeFileSync(path.join(__dirname, 'templates', '__siparis_temp.html'), html);

        const pdfBuffer = await pdfRender('__siparis_temp', degerler);
        // Tempfile'ı temizle
        try { fs.unlinkSync(path.join(__dirname, 'templates', '__siparis_temp.html')); } catch (e) {}

        const dosyaAdi = `Siparis-${s.siparis_no}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${dosyaAdi}"`);
        res.send(pdfBuffer);
    } catch (e) {
        console.error('🔥 Sipariş PDF Hatası:', e);
        res.status(500).json({ ok: false, hata: e.message });
    }
});

// Teknik şartname PDF üret ve indir
const { renderToPDF } = require('./lib/pdf-generator');
const SABLON_HARITASI = {
    'Prefabrik': 'prefabrik'
    // İleride: 'Konteyner': 'konteyner', 'Hafif Çelik': 'hafif-celik', ...
};
app.get('/api/teknik-sartname-pdf/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;
        const r = await pool.query(`
            SELECT pt.*, p.proje_kodu, p.musteri_adi, p.proje_adi, p.nakliye
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id = p.id
            WHERE pt.id = $1
        `, [teslimatId]);
        if (r.rowCount === 0) return res.status(404).json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const t = r.rows[0];
        const sablonAdi = SABLON_HARITASI[t.bina_turu];
        if (!sablonAdi) return res.status(400).json({ ok: false, hata: `${t.bina_turu} için PDF şablonu tanımlı değil.` });

        // Şablon için tüm değerleri hazırla
        const degerler = {
            // Proje bilgileri
            'Proje No': t.proje_kodu,
            'Müşteri Adı': t.musteri_adi,
            'Proje Adı': t.proje_adi,
            'Bina Yeri': t.bina_yeri || '',
            'Nakliye': t.nakliye || '',
            // Teslimat bilgileri
            'Bina Adı': t.bina_adi || '',
            'Bina Tipi': t.bina_tipi || '',
            'Kat Yüksekliği': t.kat_yuksekligi || '',
            'Kat Adedi': t.kat_adedi || '',
            'Büyüklük': t.buyukluk_m2 ? `${t.buyukluk_m2} m²` : '',
            // Sistem
            'TARİH': new Date().toLocaleDateString('tr-TR'),
            'DÜZENLEYEN': req.user.adSoyad || '',
            'KOD': `${t.proje_kodu}-${t.id}`,
            // Form verisi (ek_veriler içindeki tüm alanlar — Dış Duvar Kalınlığı (mm), İç Cephe Boyası vb.)
            ...(t.ek_veriler || {})
        };

        const pdfBuffer = await renderToPDF(sablonAdi, degerler);
        const dosyaAdi = `${t.proje_kodu}-${t.bina_adi}-Teknik-Sartname.pdf`.replace(/[^a-zA-Z0-9\-_.]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${dosyaAdi}"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('🔥 PDF Hatası:', error);
        res.status(500).json({ ok: false, hata: error.message });
    }
});

// Teknik şartname formunu kaydet (ek_veriler JSONB'ye yaz)
app.post('/api/teknik-sartname-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, form_verisi } = req.body;
        if (!teslimat_id) return res.json({ ok: false, hata: 'Teslimat ID gerekli.' });

        // Mevcut ek_veriler'i çek, üzerine yaz
        const mevcut = await pool.query(
            'SELECT ek_veriler FROM proje_teslimatlari WHERE id = $1', [teslimat_id]
        );
        if (mevcut.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });

        const eskiVeri = mevcut.rows[0].ek_veriler || {};
        const yeniVeri = { ...eskiVeri, ...form_verisi };

        await pool.query(
            'UPDATE proje_teslimatlari SET ek_veriler = $1 WHERE id = $2',
            [JSON.stringify(yeniVeri), teslimat_id]
        );
        res.json({ ok: true, mesaj: 'Teknik şartname kaydedildi.' });
    } catch (error) { next(error); }
});

// =================================================================
// SEVKİYAT PLANI
// =================================================================
app.get('/api/sevkiyat-plani', yetkiKontrol, async (req, res, next) => {
    try {
        const query = `
            SELECT pt.id, pt.bina_adi, pt.bina_turu, pt.bina_tipi, pt.buyukluk_m2,
                   pt.bina_yeri, pt.sevkiyat_baslangici, pt.durum,
                   p.proje_kodu, p.musteri_adi, p.proje_adi, p.para_birimi
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id = p.id
            WHERE pt.sevkiyat_baslangici IS NOT NULL
              AND COALESCE(pt.durum, 'BEKLEMEDE') NOT IN ('İPTAL', 'TESLİM EDİLDİ')
            ORDER BY pt.sevkiyat_baslangici ASC
        `;
        const result = await pool.query(query);
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// =================================================================
// ÖZET DASHBOARD
// =================================================================
app.get('/api/ozet', yetkiKontrol, async (req, res, next) => {
    try {
        const [projeSayisi, teslimatDurum, toplamTutar, yaklasanSevkiyat] = await Promise.all([
            pool.query('SELECT COUNT(*) as toplam FROM projeler'),
            pool.query(`
                SELECT COALESCE(durum, 'BEKLEMEDE') as durum, COUNT(*) as sayi
                FROM proje_teslimatlari
                GROUP BY COALESCE(durum, 'BEKLEMEDE')
                ORDER BY sayi DESC
            `),
            pool.query(`
                SELECT COALESCE(p.para_birimi, 'TL') as para_birimi,
                       SUM(COALESCE(pt.kdvsiz_tutar, 0)) as toplam
                FROM proje_teslimatlari pt
                JOIN projeler p ON pt.proje_id = p.id
                WHERE COALESCE(pt.durum, 'BEKLEMEDE') != 'İPTAL'
                GROUP BY p.para_birimi
            `),
            pool.query(`
                SELECT COUNT(*) as sayi FROM proje_teslimatlari
                WHERE sevkiyat_baslangici IS NOT NULL
                  AND sevkiyat_baslangici <= CURRENT_DATE + INTERVAL '7 days'
                  AND COALESCE(durum, 'BEKLEMEDE') NOT IN ('İPTAL', 'TESLİM EDİLDİ')
            `)
        ]);

        res.json({
            ok: true,
            toplam_proje: parseInt(projeSayisi.rows[0].toplam),
            teslimat_durumlari: teslimatDurum.rows,
            tutar_ozet: toplamTutar.rows,
            yaklasan_sevkiyat: parseInt(yaklasanSevkiyat.rows[0].sayi)
        });
    } catch (error) { next(error); }
});

// --- ESKİ PROJE ROTALARI ---
app.get('/api/get-lists', yetkiKontrol, async (req, res, next) => {
    try {
        const [projelerRes, teslimatlarRes] = await Promise.all([
            pool.query('SELECT * FROM projeler ORDER BY id DESC'),
            pool.query('SELECT * FROM proje_teslimatlari ORDER BY id ASC')
        ]);
        const birlesikProjeler = [];
        teslimatlarRes.rows.forEach(t => {
            const p = projelerRes.rows.find(pr => pr.id === t.proje_id);
            if (p) {
                birlesikProjeler.push([
                    p.proje_kodu, "", t.durum || p.proje_durumu, p.proje_kodu, p.musteri_adi, p.proje_adi,
                    t.bina_adi, t.bina_turu, t.bina_tipi, t.buyukluk, p.sozlesme_tarihi, "", t.bina_yeri, p.nakliye,
                    p.aset_link, p.dokumanlar_link, t.sozlesme_tutari_kdvsiz, p.para_birimi, p.kdv_orani,
                    t.sozlesme_tutari_kdvli, t.sozlesme_tutari_kdvli_tl, p.guncelleme_tarihi || p.kayit_tarihi,
                    t.satir_id, t.ek_veriler ? JSON.stringify(t.ek_veriler) : "{}"
                ]);
            }
        });
        res.json({ ok: true, version: Date.now(), kullanici: req.user, projeler: birlesikProjeler, formTanimlari: [], teknikSartnameFormu: {} });
    } catch (error) { next(error); }
});

app.post('/api/durum-guncelle', yetkiKontrol, async (req, res, next) => { res.json({ok:true}); });

app.use((err, req, res, next) => {
    console.error("🔥 Hata:", err.message);
    res.status(500).json({ ok: false, hata: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API Sunucusu ${PORT} portunda Korumalı modda çalışıyor!`));
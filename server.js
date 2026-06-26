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
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
        connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000
    })
    : null;
if (!mailTransporter) console.warn('⚠️ GMAIL_USER / GMAIL_APP_PASSWORD eksik — e-posta gönderimi devre dışı.');
// Gönderen adresi: MAIL_FROM_EMAIL tanımlıysa onu kullan (örn satinalma@aterko.com),
// yoksa kimlik doğrulayan hesabın adresi. NOT: farklı bir adres kullanmak için o adres
// Gmail'de "Send mail as" (alias) olarak eklenmiş VEYA ayrı bir gönderim hesabı olmalı.
const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER;

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
        // Token'dan gelen kullaniciYansit header'ı varsa (admin simülasyon için)
        const yansit = req.headers['x-yansit-rol'];
        if (yansit && (req.user.rol === 'ADMIN' || req.user.rol === 'Admin')) {
            req.user.gercek_rol = req.user.rol;
            req.user.rol = yansit;
            req.user.simulasyon = true;
        }
        // İzin middleware'ini çağır (genelIzinMiddleware tanımlı olmalı)
        if (typeof genelIzinMiddleware === 'function') {
            return genelIzinMiddleware(req, res, next);
        }
        next();
    } catch (err) {
        return res.status(401).json({ ok: false, hata: "Oturum süreniz dolmuş." });
    }
};

app.post('/api/auth/google', async (req, res, next) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        const email = (ticket.getPayload().email || '').toLowerCase();

        // Ekstra güvenlik: sadece @aterko.com domain'i kabul
        if (!email.endsWith('@aterko.com')) {
            return res.status(401).json({ ok: false, hata: "Sadece @aterko.com e-posta hesapları sisteme giriş yapabilir." });
        }

        const userRes = await pool.query("SELECT * FROM kullanicilar WHERE LOWER(email) = $1", [email]);
        if (userRes.rowCount === 0) return res.status(401).json({ ok: false, hata: "Sisteme giriş yetkiniz yok. ADMIN ile iletişime geçin." });
        
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

        // Stok kart bilgisini al (kontrol + birim_maliyet snapshot için)
        const stokR = await client.query('SELECT guncel_stok_miktari, stok_adi, ortalama_alis_fiyati FROM stok_kartlari WHERE id=$1', [stok_kart_id]);
        if (stokR.rowCount === 0) return res.json({ ok: false, hata: 'Stok kartı bulunamadı.' });
        const stokRow = stokR.rows[0];

        // Çıkışta stok yeterli mi kontrol et
        if (tip === 'Çıkış') {
            const mevcut = parseFloat(stokRow.guncel_stok_miktari) || 0;
            if (miktarF > mevcut) {
                return res.json({ ok: false, hata: `Yetersiz stok! Mevcut: ${mevcut} (${stokRow.stok_adi})` });
            }
        }

        // Birim maliyet snapshot — çıkışta o anki ortalama alış fiyatı kaydedilir
        // (sonradan stok kartının fiyatı değişse bile bu kayıt doğru kalır → karlılık raporu için kritik)
        const birimMaliyet = parseFloat(stokRow.ortalama_alis_fiyati) || 0;

        // Hareketi ekle
        const insR = await client.query(`
            INSERT INTO stok_hareketleri
            (stok_kart_id, tip, miktar, proje_id, depo_id, aciklama, kullanici_email, kullanici_adsoyad, birim_maliyet)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
        `, [stok_kart_id, tip, miktarF, proje_id || null, depo_id || null, aciklama || null,
            req.user.email, req.user.adSoyad, birimMaliyet]);

        // Stok kartının güncel miktarını güncelle
        const delta = tip === 'Giriş' ? miktarF : -miktarF;
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [delta, stok_kart_id]);

        await client.query('COMMIT');
        await auditLogla(req, { eylem: 'CREATE', tablo: 'stok_hareketleri', kayit_id: insR.rows[0].id,
            ozet: `${tip} • ${miktarF} ${stokRow.stok_adi}${aciklama ? ' • ' + aciklama : ''}` });
        res.json({ ok: true, mesaj: 'Hareket kaydedildi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// Hareket güncelle (sadece admin) — stok bakiyesini doğru şekilde yeniden hesapla
app.post('/api/stok-hareket-guncelle', yetkiKontrol, izinGerekli('stok', 'TAM'), async (req, res, next) => {
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
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'stok_hareketleri', kayit_id: id,
            ozet: `Düzeltildi: ${eski.tip} ${eski.miktar} → ${tip} ${yeniMiktar}` });
        res.json({ ok: true, mesaj: 'Hareket güncellendi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// Hareket sil (sadece admin) — stok bakiyesini geri al
app.delete('/api/stok-hareket-sil/:id', yetkiKontrol, izinGerekli('stok', 'TAM'), async (req, res, next) => {
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
        await auditLogla(req, { eylem: 'DELETE', tablo: 'stok_hareketleri', kayit_id: parseInt(req.params.id),
            ozet: `Silindi: ${h.tip} ${h.miktar}` });
        res.json({ ok: true, mesaj: 'Hareket silindi.' });
    } catch (e) {
        await client.query('ROLLBACK');
        next(e);
    } finally {
        client.release();
    }
});

// Bir stok hareketinin işlem geçmişi (kim, ne zaman, ne yaptı) — stok OKUMA yetkisi yeter
// (Suistimal şeffaflığı: hareketi düzenleyemeyenler de geçmişi görebilsin)
app.get('/api/stok-hareket-audit/:id', yetkiKontrol, izinGerekli('stok', 'OKUMA'), async (req, res, next) => {
    try {
        const r = await pool.query(
            `SELECT kullanici_adsoyad, kullanici_email, eylem, ozet, kayit_tarihi
             FROM audit_log WHERE tablo='stok_hareketleri' AND kayit_id=$1 ORDER BY kayit_tarihi ASC`,
            [req.params.id]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
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
                        bina_yeri=$13, kdvsiz_tutar=$14, ek_veriler=$15,
                        montaj_gerekli=$16
                    WHERE id=$17
                `, [
                    t.bina_adi, t.bina_turu, t.bina_tipi,
                    t.kat_yuksekligi || null, t.kat_adedi || null, parseInt(t.bina_adedi) || null,
                    t.konteyner_ebadi || null, parseInt(t.konteyner_miktari) || null,
                    t.dis_duvar_kesiti || null, t.ic_duvar_kesiti || null,
                    parseFloat(t.buyukluk_m2) || null, sevkiyatBaslangici,
                    t.bina_yeri || null, parseFloat(t.kdvsiz_tutar) || 0,
                    JSON.stringify(birlesik), !!t.montaj_gerekli, t.id
                ]);
                gonderilenIds.add(t.id);
            } else {
                // Yeni ekle
                await client.query(`
                    INSERT INTO proje_teslimatlari
                    (proje_id, bina_adi, bina_turu, bina_tipi, kat_yuksekligi, kat_adedi, bina_adedi,
                     konteyner_ebadi, konteyner_miktari, dis_duvar_kesiti, ic_duvar_kesiti,
                     buyukluk_m2, sevkiyat_baslangici, bina_yeri, kdvsiz_tutar, ek_veriler, montaj_gerekli)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                `, [
                    proje.id, t.bina_adi, t.bina_turu, t.bina_tipi,
                    t.kat_yuksekligi || null, t.kat_adedi || null, parseInt(t.bina_adedi) || null,
                    t.konteyner_ebadi || null, parseInt(t.konteyner_miktari) || null,
                    t.dis_duvar_kesiti || null, t.ic_duvar_kesiti || null,
                    parseFloat(t.buyukluk_m2) || null, sevkiyatBaslangici,
                    t.bina_yeri || null, parseFloat(t.kdvsiz_tutar) || 0,
                    JSON.stringify(ekVeriler), !!t.montaj_gerekli
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

// ============================================================================
// FAZ B-1: ÜRÜN LİSTESİ YAYIN AKIŞI
// Durumlar: TASLAK → ONAY BEKLİYOR → YAYINDA (veya TASLAK'a geri red ile)
// ============================================================================

// Listeyi ADMIN onayına gönder (Proje ekibi basar)
app.post('/api/urun-listesi-onaya-gonder', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id } = req.body;
        if (!teslimat_id) return res.json({ ok: false, hata: 'Teslimat seçilmedi.' });

        // En az 1 ürün olmalı
        const c = await pool.query('SELECT COUNT(*)::int as n FROM teslimat_urunleri WHERE teslimat_id=$1', [teslimat_id]);
        if (c.rows[0].n === 0) return res.json({ ok: false, hata: 'Boş liste onaya gönderilemez. Önce ürün ekleyin.' });

        // Sadece TASLAK durumundan gönderilebilir
        const t = await pool.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        if (t.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const mevcut = t.rows[0].urun_listesi_yayin_durumu || 'TASLAK';
        if (mevcut !== 'TASLAK') return res.json({ ok: false, hata: `Liste şu an "${mevcut}" durumunda — onaya gönderilemez.` });

        await pool.query(`
            UPDATE proje_teslimatlari
            SET urun_listesi_yayin_durumu='ONAY BEKLİYOR',
                yayin_onay_gonderen_email=$1,
                yayin_onay_gonderme_tarihi=NOW(),
                yayin_red_notu=NULL
            WHERE id=$2
        `, [req.user.email, teslimat_id]);

        await auditLogla(req, {
            eylem: 'SUBMIT', tablo: 'proje_teslimatlari', kayit_id: teslimat_id,
            ozet: 'Ürün Listesi onaya gönderildi'
        });
        res.json({ ok: true, mesaj: 'Liste ADMIN onayına gönderildi.' });
    } catch (error) { next(error); }
});

// ADMIN onayla (yayınla)
app.post('/api/urun-listesi-onayla', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
            return res.json({ ok: false, hata: 'Sadece ADMIN onaylayabilir.' });
        }
        const { teslimat_id } = req.body;
        const t = await pool.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        if (t.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const mevcut = t.rows[0].urun_listesi_yayin_durumu || 'TASLAK';
        if (mevcut !== 'ONAY BEKLİYOR') return res.json({ ok: false, hata: `Sadece "ONAY BEKLİYOR" durumundaki listeler onaylanabilir (şu an: ${mevcut}).` });

        await pool.query(`
            UPDATE proje_teslimatlari
            SET urun_listesi_yayin_durumu='YAYINDA',
                yayinlayan_email=$1,
                yayinlama_tarihi=NOW()
            WHERE id=$2
        `, [req.user.email, teslimat_id]);

        await auditLogla(req, {
            eylem: 'PUBLISH', tablo: 'proje_teslimatlari', kayit_id: teslimat_id,
            ozet: 'Ürün Listesi YAYINLANDI'
        });
        // Versiyon snapshot: yayın anında listenin tam fotoğrafını kaydet
        await urunListesiVersiyonAl(teslimat_id, 'YAYIN', 'Liste yayınlandı', req);
        res.json({ ok: true, mesaj: 'Liste YAYINLANDI — üretim, sevkiyat ve montaj modüllerinde görünür.' });
    } catch (error) { next(error); }
});

// ADMIN reddet (TASLAK'a geri al + not)
app.post('/api/urun-listesi-reddet', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
            return res.json({ ok: false, hata: 'Sadece ADMIN reddedebilir.' });
        }
        const { teslimat_id, red_notu } = req.body;
        if (!red_notu || !red_notu.trim()) return res.json({ ok: false, hata: 'Red notu zorunlu — ekip neyi düzelteceğini bilmeli.' });

        const t = await pool.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        if (t.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const mevcut = t.rows[0].urun_listesi_yayin_durumu || 'TASLAK';
        if (mevcut !== 'ONAY BEKLİYOR') return res.json({ ok: false, hata: `Sadece "ONAY BEKLİYOR" durumundaki listeler reddedilebilir (şu an: ${mevcut}).` });

        await pool.query(`
            UPDATE proje_teslimatlari
            SET urun_listesi_yayin_durumu='TASLAK',
                yayin_red_notu=$1
            WHERE id=$2
        `, [red_notu.trim(), teslimat_id]);

        await auditLogla(req, {
            eylem: 'REJECT', tablo: 'proje_teslimatlari', kayit_id: teslimat_id,
            ozet: `Ürün Listesi reddedildi: ${red_notu.trim().substring(0,200)}`
        });
        await urunListesiVersiyonAl(teslimat_id, 'YAYIN_RED', `Reddedildi: ${red_notu.trim().substring(0,200)}`, req);
        res.json({ ok: true, mesaj: 'Liste reddedildi, taslak durumuna alındı.' });
    } catch (error) { next(error); }
});

// Ek ürünü ADMIN onayla (yayınlı listede sonradan eklenen)
app.post('/api/urun-listesi-ek-urun-onayla', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
            return res.json({ ok: false, hata: 'Sadece ADMIN onaylayabilir.' });
        }
        const { teslimat_urun_id } = req.body;
        const u = await pool.query('SELECT is_ek_urun, ek_urun_onay_durumu FROM teslimat_urunleri WHERE id=$1', [teslimat_urun_id]);
        if (u.rowCount === 0) return res.json({ ok: false, hata: 'Ürün bulunamadı.' });
        if (!u.rows[0].is_ek_urun) return res.json({ ok: false, hata: 'Bu ürün ek ürün değil — onay gerekmez.' });

        await pool.query(`UPDATE teslimat_urunleri SET ek_urun_onay_durumu='ONAYLI' WHERE id=$1`, [teslimat_urun_id]);
        res.json({ ok: true, mesaj: 'Ek ürün onaylandı.' });
    } catch (error) { next(error); }
});

// Ek ürünü reddet (sil)
app.post('/api/urun-listesi-ek-urun-reddet', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
            return res.json({ ok: false, hata: 'Sadece ADMIN reddedebilir.' });
        }
        const { teslimat_urun_id } = req.body;
        const u = await pool.query('SELECT is_ek_urun FROM teslimat_urunleri WHERE id=$1', [teslimat_urun_id]);
        if (u.rowCount === 0) return res.json({ ok: false, hata: 'Ürün bulunamadı.' });
        if (!u.rows[0].is_ek_urun) return res.json({ ok: false, hata: 'Bu ürün ek ürün değil.' });

        await pool.query(`DELETE FROM teslimat_urunleri WHERE id=$1`, [teslimat_urun_id]);
        res.json({ ok: true, mesaj: 'Ek ürün reddedildi (silindi).' });
    } catch (error) { next(error); }
});

// Teslimata ait ürün listesini getir (Stok Miktarı Eklendi)
app.get('/api/teslimat-urunleri/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;

        // Teslimatın yayın durumunu da getir (frontend kilidini uygulayabilsin diye)
        const yR = await pool.query(`
            SELECT urun_listesi_yayin_durumu, yayin_onay_gonderen_email, yayin_onay_gonderme_tarihi,
                   yayinlayan_email, yayinlama_tarihi, yayin_red_notu
            FROM proje_teslimatlari WHERE id=$1`, [teslimatId]);
        const yayinBilgisi = yR.rows[0] || { urun_listesi_yayin_durumu: 'TASLAK' };

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
        res.json({ ok: true, data, yayin: yayinBilgisi });
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

        // YAYIN AKIŞI: liste yayındaysa eklenenler "ek ürün" olarak ONAY BEKLİYOR durumunda kayda girer
        const yR = await pool.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        const yayinDurumu = (yR.rows[0]?.urun_listesi_yayin_durumu) || 'TASLAK';
        const isEkUrun = yayinDurumu === 'YAYINDA';
        const ekUrunOnay = isEkUrun ? 'ONAY BEKLİYOR' : null;
        if (yayinDurumu === 'ONAY BEKLİYOR') {
            return res.json({ ok: false, hata: 'Liste şu an onay bekliyor — yeni ürün eklenemez. ADMIN onay/red verene kadar bekleyin.' });
        }

        const ekleyen = req.user.adSoyad;
        const r = await pool.query(
            `INSERT INTO teslimat_urunleri
             (teslimat_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama,
              ekleyen_kullanici, kullanim_amaci, durum, is_ek_urun, ek_urun_onay_durumu)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TASLAK', $9, $10) RETURNING id`,
            [teslimat_id, stok_kart_id || null, ozel_urun_adi, ozel_urun_birim,
             miktar, aciklama, ekleyen, kullanim_amaci || 'URETIM', isEkUrun, ekUrunOnay]
        );
        res.json({ ok: true, id: r.rows[0].id, ek_urun: isEkUrun });
    } catch (error) { next(error); }
});

// Ürün listesinden seçili kalemler için satınalma talebi oluştur
// Body: { teslimat_id, kalem_idler: [int], istenen_tarih, teslim_yeri, genel_aciklama }
app.post('/api/teslimat-urun-talep-olustur', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { teslimat_id, kalem_idler, kalem_miktarlari, istenen_tarih, teslim_yeri, genel_aciklama } = req.body;
        if (!teslimat_id || !Array.isArray(kalem_idler) || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }
        // kalem_miktarlari: { kalem_id: miktar } — kullanıcı talep miktarını listedeki değerden farklı isteyebilir
        const miktarOverride = (kalem_miktarlari && typeof kalem_miktarlari === 'object') ? kalem_miktarlari : {};

        // Teslimatın projesini ve proje kodunu bul
        const tR = await client.query(`
            SELECT pt.proje_id, p.proje_kodu
            FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id=p.id
            WHERE pt.id=$1
        `, [teslimat_id]);
        if (tR.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const projeId = tR.rows[0].proje_id;
        const projeKodu = tR.rows[0].proje_kodu || 'GENEL';

        // Yeni talep no üret: ProjeNo-T-NNNN (sequence'tan)
        const seqRes = await client.query("SELECT nextval('talep_no_seq') as no");
        const talep_no = `${projeKodu}-T-${seqRes.rows[0].no}`;

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

            // Talep miktarı: override varsa onu, yoksa ürün listesindeki miktarı kullan
            const talepMiktari = (miktarOverride[tuId] !== undefined && miktarOverride[tuId] > 0)
                ? Number(miktarOverride[tuId]) : ku.miktar;
            const yeniKalem = await client.query(`
                INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR') RETURNING id
            `, [yeniTalepId, ku.stok_kart_id, ku.ozel_urun_adi, ku.ozel_urun_birim,
                talepMiktari, ku.aciklama || `Teslimat #${teslimat_id}`]);

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
        const r = await pool.query(`
            SELECT tu.talep_urun_id, tu.is_ek_urun, tu.ek_urun_onay_durumu,
                   pt.urun_listesi_yayin_durumu as yayin
            FROM teslimat_urunleri tu
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            WHERE tu.id=$1`, [id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Kalem bulunamadı.' });
        const k = r.rows[0];
        if (k.talep_urun_id) return res.json({ ok: false, hata: 'Bu kalem bir satınalma talebine bağlı. Önce talebi iptal/sil.' });

        // YAYIN KİLİDİ: yayında ise sadece onaylanmamış ek ürünler silinebilir
        if (k.yayin === 'YAYINDA' && !(k.is_ek_urun && k.ek_urun_onay_durumu !== 'ONAYLI')) {
            return res.json({ ok: false, hata: 'Yayında olan listeden kalem silinemez. (Sadece onaylanmamış ek ürünler silinebilir.)' });
        }
        if (k.yayin === 'ONAY BEKLİYOR') {
            return res.json({ ok: false, hata: 'Liste onay bekliyor — silme yapılamaz.' });
        }
        await pool.query('DELETE FROM teslimat_urunleri WHERE id = $1', [id]);
        res.json({ ok: true });
    } catch (error) { next(error); }
});

// Ürün listesi kaleminin miktar / amaç güncelle
app.post('/api/teslimat-urun-guncelle', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, miktar, aciklama, kullanim_amaci } = req.body;

        // YAYIN KİLİDİ: Yayında ise miktar değiştirilemez (sadece açıklama/amaç olabilir).
        // Onay bekleyen ek ürünler de henüz onaylanmadığı için düzenlenebilir.
        const r = await pool.query(`
            SELECT tu.is_ek_urun, tu.ek_urun_onay_durumu, pt.urun_listesi_yayin_durumu as yayin
            FROM teslimat_urunleri tu JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            WHERE tu.id=$1`, [id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Kalem bulunamadı.' });
        const k = r.rows[0];

        if (k.yayin === 'YAYINDA' && !(k.is_ek_urun && k.ek_urun_onay_durumu !== 'ONAYLI')) {
            // Yayında bir kalem → sadece aciklama güncellenebilir (miktar/amaç kilitli)
            await pool.query(`UPDATE teslimat_urunleri SET aciklama=$1 WHERE id=$2`, [aciklama || null, id]);
            return res.json({ ok: true, mesaj: 'Sadece açıklama güncellendi (yayında miktar değiştirilemez).' });
        }
        if (k.yayin === 'ONAY BEKLİYOR') {
            return res.json({ ok: false, hata: 'Liste onay bekliyor — düzenleme yapılamaz.' });
        }

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
            SELECT pt.id as teslimat_id, pt.bina_adi, pt.bina_turu, pt.bina_tipi,
                   pt.buyukluk_m2, pt.bina_adedi, pt.konteyner_miktari,
                   pt.proje_id, pt.durum,
                   p.proje_kodu, p.musteri_adi, p.proje_adi
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id = p.id
            WHERE ${durumFilter}
            ORDER BY p.id DESC, pt.id ASC
        `;
        const result = await pool.query(query);
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, data: result.rows });
    } catch (error) { next(error); }
});

// GÜNCELLEME: Satınalma Talepleri Listesini ve Projeleri Esnek Biçimde Getir
app.get('/api/satinalma-listesi', yetkiKontrol, async (req, res, next) => {
    try {
        // Esnek sorgu: Proje tablosu boş olsa veya eşleşme olmasa bile talepleri listeler (COALESCE korumalı)
        const taleplerRes = await pool.query(`
            SELECT t.id, t.talep_no, t.talep_eden, t.istenen_tarih, t.durum, t.kayit_tarihi,
                   t.parent_talep_id, t.alt_sira, t.bolunme_tarihi,
                   COALESCE(p.proje_adi, 'Genel / Belirsiz') as proje_adi,
                   COALESCE(p.proje_kodu, 'GENEL') as proje_kodu,
                   COALESCE(p.musteri_adi, '') as musteri_adi,
                   COALESCE(COUNT(tu.id), 0) as urun_sayisi,
                   STRING_AGG(DISTINCT NULLIF(TRIM(sk.kategori), ''), ', ') as kategoriler,
                   COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                       'stok_kart_id', tu.stok_kart_id, 'stok_adi', sk.stok_adi, 'stok_kodu', sk.stok_kodu,
                       'stok_birim', sk.birim, 'kategori', sk.kategori, 'ozel_urun_adi', tu.ozel_urun_adi,
                       'ozel_urun_birim', tu.ozel_urun_birim, 'miktar', tu.miktar, 'aciklama', tu.aciklama, 'durum', tu.durum
                   ) ORDER BY tu.id) FILTER (WHERE tu.id IS NOT NULL), '[]') as kalemler,
                   (SELECT COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', td.id, 'dosya_adi', td.dosya_adi, 'public_url', td.public_url) ORDER BY td.id), '[]')
                    FROM talep_dosyalari td WHERE td.talep_id = t.id) as dosyalar
            FROM satinalma_talepleri t
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN talep_urunleri tu ON t.id = tu.talep_id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            WHERE COALESCE(t.arsiv, false) = false
            GROUP BY t.id, p.proje_adi, p.proje_kodu, p.musteri_adi
            ORDER BY t.kayit_tarihi DESC NULLS LAST, t.id DESC
        `);
        
        // Dropdown'lar için projeleri getir + hesaplanmış aşama (en ileri teslimat durumu)
        // hesaplanmis_durum: PROJE/ÜRETİM/MONTAJ vb. — yeni talep dropdown'ı bunlara göre süzülür
        const projelerRes = await pool.query(`
            SELECT p.id, p.proje_kodu, p.musteri_adi, p.proje_adi,
                   COALESCE((
                     SELECT pt.durum FROM proje_teslimatlari pt
                     WHERE pt.proje_id = p.id AND COALESCE(pt.durum,'BEKLEMEDE') <> 'İPTAL'
                     ORDER BY CASE COALESCE(pt.durum,'BEKLEMEDE')
                       WHEN 'TESLİM EDİLDİ' THEN 8 WHEN 'MONTAJ' THEN 7 WHEN 'ÜRETİM' THEN 6
                       WHEN 'PROJE' THEN 5 WHEN 'İŞ EMRİ' THEN 4 WHEN 'SÖZLEŞME' THEN 3
                       WHEN 'BEKLEMEDE' THEN 2 ELSE 1 END DESC LIMIT 1
                   ), p.durum, 'BEKLEMEDE') as hesaplanmis_durum
            FROM projeler p
            ORDER BY p.id DESC
        `);

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

        // Proje kodunu al (numara formatı için)
        let projeKodu = 'GENEL';
        if (proje_id) {
            const pR = await client.query('SELECT proje_kodu FROM projeler WHERE id=$1', [proje_id]);
            if (pR.rowCount > 0) projeKodu = pR.rows[0].proje_kodu || 'GENEL';
        }
        // Yeni format: ProjeNo-T-NNNN (sequence'tan)
        const seqRes = await client.query("SELECT nextval('talep_no_seq') as no");
        const talep_no = `${projeKodu}-T-${seqRes.rows[0].no}`;

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
        await auditLogla(req, { eylem: 'CREATE', tablo: 'satinalma_talepleri', kayit_id: yeniTalepId, kayit_no: talep_no, ozet: `Talep oluşturuldu — ${(kalemler || []).length} kalem` });
        // Bildirim: onaylayacak role + talebi açana
        await bildirimGonder('TALEP_ONAYA_GONDERILDI', {
            talepId: yeniTalepId,
            konu: `Aterko Workspace - Yeni talep onay bekliyor (${talep_no})`,
            baslik: 'Yeni talep onay bekliyor',
            mesaj: `${talep_eden} tarafından ${talep_no} numaralı yeni bir satınalma talebi oluşturuldu ve onay bekliyor.`,
            detaylar: [{ label: 'Talep No', value: talep_no }, { label: 'Talep eden', value: talep_eden }, { label: 'Kalem sayısı', value: String((kalemler || []).length) }],
            talepEdenAd: talep_eden
        });
        res.json({ ok: true, mesaj: `Talep başarıyla oluşturuldu: ${talep_no}`, id: yeniTalepId });
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
// ============================================================================
// Talep başlık durumunu kalemlerinden TÜRET (tek doğruluk kaynağı)
// Aktif (İPTAL olmayan) kalemlerin durumları:
//   - hiç aktif kalem yok  → İPTAL
//   - hepsi aynı durumda   → o durum
//   - farklı durumlar      → KARIŞIK
// Bu fonksiyon kalem durumu değişen HER yerde çağrılmalı.
// ============================================================================
async function talepBaslikDurumGuncelle(client, talepId) {
    if (!talepId) return;
    const r = await client.query(
        `SELECT durum, COUNT(*)::int as n FROM talep_urunleri
         WHERE talep_id = $1 AND COALESCE(durum,'') <> 'İPTAL'
         GROUP BY durum`,
        [talepId]
    );
    let yeni;
    if (r.rowCount === 0) {
        yeni = 'İPTAL';                 // tüm kalemler iptal
    } else if (r.rowCount === 1) {
        yeni = r.rows[0].durum;         // hepsi aynı aşamada
    } else {
        yeni = 'KARIŞIK';               // kalemler farklı aşamalarda
    }
    await client.query('UPDATE satinalma_talepleri SET durum = $1 WHERE id = $2', [yeni, talepId]);
    return yeni;
}

app.post('/api/talep-durum-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kalem_idler, yeni_durum } = req.body; // kalem_idler bir dizi (array) olacak

        if (!kalem_idler || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: "İşlem yapılacak ürün seçilmedi." });
        }

        // Etkilenen talepleri bul (başlık durumunu sonra güncellemek için)
        const talepRes = await client.query(
            'SELECT DISTINCT talep_id FROM talep_urunleri WHERE id = ANY($1::integer[])',
            [kalem_idler]
        );

        // Seçilen kalemlerin durumunu güncelle
        await client.query(
            `UPDATE talep_urunleri SET durum = $1 WHERE id = ANY($2::integer[])`,
            [yeni_durum, kalem_idler]
        );

        // Her etkilenen talebin başlık durumunu kalemlerinden yeniden türet
        for (const row of talepRes.rows) {
            await talepBaslikDurumGuncelle(client, row.talep_id);
        }

        await client.query('COMMIT');
        for (const row of talepRes.rows) {
            await auditLogla(req, { eylem: 'UPDATE', tablo: 'satinalma_talepleri', kayit_id: row.talep_id, ozet: `Kalem durumu → ${yeni_durum}` });
        }
        // Bildirim: yalnızca İŞLEME ALINDI geçişinde, her etkilenen talebin sahibine
        if (yeni_durum === 'İŞLEME ALINDI') {
            for (const row of talepRes.rows) {
                const t = (await pool.query("SELECT talep_no, talep_eden FROM satinalma_talepleri WHERE id=$1", [row.talep_id])).rows[0];
                if (t) await bildirimGonder('TALEP_ISLEME_ALINDI', {
                    talepId: row.talep_id,
                    konu: `Aterko Workspace - Talebiniz işleme alındı (${t.talep_no})`,
                    baslik: 'Talebiniz işleme alındı',
                    mesaj: `${t.talep_no} numaralı talebiniz satınalma tarafından işleme alındı; teklif/sipariş süreci başladı.`,
                    detaylar: [{ label: 'Talep No', value: t.talep_no }],
                    talepEdenAd: t.talep_eden
                });
            }
        }
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

// ============================================================================
// SİPARİŞ İLETİŞİM NOTLARI
// ============================================================================
app.get('/api/siparis/:siparisId/notlar', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT id, yazan_email, yazan_adsoyad, not_metni, kayit_tarihi
            FROM siparis_notlari
            WHERE siparis_id = $1
            ORDER BY kayit_tarihi DESC
        `, [req.params.siparisId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

app.post('/api/siparis/:siparisId/not-ekle', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparisId } = req.params;
        const { not_metni } = req.body;
        if (!not_metni || !not_metni.trim()) return res.json({ ok: false, hata: 'Not boş olamaz.' });
        const r = await pool.query(`
            INSERT INTO siparis_notlari (siparis_id, yazan_email, yazan_adsoyad, not_metni)
            VALUES ($1, $2, $3, $4) RETURNING id, kayit_tarihi
        `, [siparisId, req.user.email, req.user.adSoyad || req.user.email, not_metni.trim()]);
        res.json({ ok: true, id: r.rows[0].id, kayit_tarihi: r.rows[0].kayit_tarihi, mesaj: 'Not eklendi.' });
    } catch (e) { next(e); }
});

app.delete('/api/siparis-not-sil/:id', yetkiKontrol, async (req, res, next) => {
    try {
        // Sadece kendi notunu sil (ADMIN her notu)
        const not = await pool.query('SELECT yazan_email FROM siparis_notlari WHERE id=$1', [req.params.id]);
        if (not.rowCount === 0) return res.json({ ok: false, hata: 'Not bulunamadı.' });
        const isOwner = (not.rows[0].yazan_email || '').toLowerCase() === (req.user.email || '').toLowerCase();
        const isAdmin = (req.user.gercek_rol || req.user.rol) === 'ADMIN';
        if (!isOwner && !isAdmin) return res.json({ ok: false, hata: 'Bu notu silme yetkiniz yok.' });
        await pool.query('DELETE FROM siparis_notlari WHERE id=$1', [req.params.id]);
        res.json({ ok: true, mesaj: 'Not silindi.' });
    } catch (e) { next(e); }
});

// ============================================================================
// TCMB Döviz Kuru Cache (günlük effektif satış kurları)
// 1 saatlik in-memory cache. Hata olursa son başarılı kuru kullan.
// ============================================================================
let _kurCache = { data: null, fetchedAt: 0 };
async function getDovizKurlari() {
    const SAAT = 60 * 60 * 1000;
    if (_kurCache.data && (Date.now() - _kurCache.fetchedAt) < SAAT) {
        return _kurCache.data;
    }
    try {
        const https = require('https');
        const xml = await new Promise((resolve, reject) => {
            https.get('https://www.tcmb.gov.tr/kurlar/today.xml', (res) => {
                let buf = '';
                res.on('data', c => buf += c);
                res.on('end', () => resolve(buf));
            }).on('error', reject);
        });
        // Basit regex parser (USD, EUR, GBP için <ForexSelling> ve <BanknoteSelling>)
        const parse = (currCode) => {
            const blockMatch = xml.match(new RegExp(`<Currency[^>]*CurrencyCode="${currCode}"[^>]*>([\\s\\S]*?)</Currency>`));
            if (!blockMatch) return null;
            const block = blockMatch[1];
            // ForexSelling = döviz satış (en yaygın kullanılan)
            const fs = block.match(/<ForexSelling>([\d.,]+)<\/ForexSelling>/);
            return fs ? parseFloat(fs[1]) : null;
        };
        const kurlar = {
            TL: 1,
            TRY: 1,
            USD: parse('USD'),
            EUR: parse('EUR'),
            GBP: parse('GBP')
        };
        // Geçerli en az 1 değer varsa cache'le
        if (kurlar.USD && kurlar.EUR) {
            _kurCache = { data: kurlar, fetchedAt: Date.now() };
            console.log('💱 Döviz kurları güncellendi:', { USD: kurlar.USD, EUR: kurlar.EUR, GBP: kurlar.GBP });
            return kurlar;
        }
        throw new Error('Kur ayrıştırılamadı');
    } catch (e) {
        console.warn('⚠️ TCMB kur çekilemedi:', e.message);
        // Son başarılı cache varsa onu döndür; yoksa fallback
        if (_kurCache.data) return _kurCache.data;
        return { TL: 1, TRY: 1, USD: 34, EUR: 37, GBP: 43 }; // kaba fallback
    }
}

// Döviz kurlarını dışarıdan görmek için
app.get('/api/doviz-kurlari', yetkiKontrol, async (req, res, next) => {
    try {
        const kurlar = await getDovizKurlari();
        res.json({ ok: true, kurlar, kaynak: 'TCMB Forex Selling', guncelleme: new Date(_kurCache.fetchedAt).toISOString() });
    } catch (e) { next(e); }
});

// Satınalma Genel Bakış — filtreli özet (proje, durum, tedarikçi, tarih, arama)
// Query: ?arama=...&proje_id=...&durum=...&tedarikci_id=...&tarih_bas=...&tarih_bit=...
app.get('/api/satinalma-genel-ozet', yetkiKontrol, async (req, res, next) => {
    try {
        const { arama, proje_id, durum, tedarikci_id, tarih_bas, tarih_bit } = req.query;
        const params = [];
        const kosul = [`COALESCE(s.durum, '') <> 'İPTAL'`];

        if (proje_id) { params.push(parseInt(proje_id)); kosul.push(`t.proje_id = $${params.length}`); }
        if (durum) { params.push(durum); kosul.push(`s.durum = $${params.length}`); }
        if (tedarikci_id) { params.push(parseInt(tedarikci_id)); kosul.push(`s.tedarikci_id = $${params.length}`); }
        if (tarih_bas) { params.push(tarih_bas); kosul.push(`s.siparis_tarihi >= $${params.length}`); }
        if (tarih_bit) { params.push(tarih_bit); kosul.push(`s.siparis_tarihi <= $${params.length}`); }
        if (arama && arama.trim()) {
            params.push('%' + arama.trim().toLowerCase() + '%');
            kosul.push(`(
                LOWER(s.siparis_no) LIKE $${params.length}
                OR LOWER(COALESCE(p.proje_kodu, '')) LIKE $${params.length}
                OR LOWER(COALESCE(p.proje_adi, '')) LIKE $${params.length}
                OR LOWER(COALESCE(p.musteri_adi, '')) LIKE $${params.length}
            )`);
        }

        const where = kosul.join(' AND ');

        // Sipariş bazlı liste
        const siparislerR = await pool.query(`
            SELECT
                s.id, s.siparis_no, s.durum, s.termin_tarihi, s.para_birimi, s.siparis_tarihi,
                COALESCE(s.arsiv, false) as arsiv,
                COALESCE(tdr.firma_adi, '-') as tedarikci_adi,
                COALESCE(p.proje_kodu, '-') as proje_kodu,
                COALESCE(p.proje_adi, '-') as proje_adi,
                COALESCE(p.musteri_adi, '') as musteri_adi,
                p.id as proje_id,
                SUM(COALESCE(sk.siparis_miktari,0) * COALESCE(sk.birim_fiyat,0))::numeric as siparis_tutari,
                SUM(COALESCE(sk.teslim_alinan_miktar,0) * COALESCE(sk.birim_fiyat,0))::numeric as teslim_tutari,
                COUNT(sk.id)::int as kalem_sayisi
            FROM satinalma_siparisleri s
            JOIN siparis_kalemleri sk ON sk.siparis_id = s.id
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN tedarikciler tdr ON s.tedarikci_id = tdr.id
            WHERE ${where}
            GROUP BY s.id, tdr.firma_adi, p.id, p.proje_kodu, p.proje_adi, p.musteri_adi
            ORDER BY COALESCE(s.arsiv, false) ASC, s.siparis_tarihi DESC NULLS LAST, s.id DESC
            LIMIT 500
        `, params);

        // Para birimi bazlı özet (aynı filtre ile)
        const ozetR = await pool.query(`
            WITH filtered_orders AS (
                SELECT DISTINCT s.id, s.para_birimi
                FROM satinalma_siparisleri s
                JOIN siparis_kalemleri sk ON sk.siparis_id = s.id
                JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
                JOIN satinalma_talepleri t ON tu.talep_id = t.id
                LEFT JOIN projeler p ON t.proje_id = p.id
                LEFT JOIN tedarikciler tdr ON s.tedarikci_id = tdr.id
                WHERE ${where}
            )
            SELECT
                COALESCE(fo.para_birimi, 'TL') as para_birimi,
                COUNT(DISTINCT fo.id)::int as siparis_sayisi,
                SUM(COALESCE(sk.siparis_miktari,0) * COALESCE(sk.birim_fiyat,0))::numeric as siparis_tutari,
                SUM(COALESCE(sk.teslim_alinan_miktar,0) * COALESCE(sk.birim_fiyat,0))::numeric as teslim_tutari
            FROM filtered_orders fo
            JOIN siparis_kalemleri sk ON sk.siparis_id = fo.id
            GROUP BY fo.para_birimi
            ORDER BY siparis_tutari DESC NULLS LAST
        `, params);

        const siparisler = siparislerR.rows.map(s => {
            const sip = parseFloat(s.siparis_tutari || 0);
            const tes = parseFloat(s.teslim_tutari || 0);
            return {
                ...s,
                siparis_tutari: sip,
                teslim_tutari: tes,
                bekleyen_tutari: sip - tes,
                teslim_yuzdesi: sip > 0 ? Math.round((tes / sip) * 100) : 0
            };
        });

        const kurlar = await getDovizKurlari();
        const para_birimi_ozet = ozetR.rows.map(r => {
            const sip = parseFloat(r.siparis_tutari || 0);
            const tes = parseFloat(r.teslim_tutari || 0);
            const kur = kurlar[r.para_birimi] || 1;
            return {
                para_birimi: r.para_birimi,
                siparis_sayisi: r.siparis_sayisi,
                siparis_tutari: sip,
                teslim_tutari: tes,
                bekleyen_tutari: sip - tes,
                teslim_yuzdesi: sip > 0 ? Math.round((tes / sip) * 100) : 0,
                kur_tl: kur,
                tl_siparis: sip * kur,
                tl_teslim: tes * kur,
                tl_bekleyen: (sip - tes) * kur
            };
        });

        // Tüm para birimlerinin TL eşdeğer toplamı
        const tl_toplam = para_birimi_ozet.reduce((acc, p) => ({
            siparis: acc.siparis + p.tl_siparis,
            teslim: acc.teslim + p.tl_teslim,
            bekleyen: acc.bekleyen + p.tl_bekleyen,
            siparis_sayisi: acc.siparis_sayisi + p.siparis_sayisi
        }), { siparis: 0, teslim: 0, bekleyen: 0, siparis_sayisi: 0 });
        tl_toplam.teslim_yuzdesi = tl_toplam.siparis > 0 ? Math.round((tl_toplam.teslim / tl_toplam.siparis) * 100) : 0;

        // Eğer proje filtresi varsa: o projedeki açık talepleri de dön
        let acik_talep_bilgisi = null;
        if (proje_id) {
            const acikR = await pool.query(`
                SELECT
                    t.id as talep_id, t.talep_no, t.durum as talep_durum, t.istenen_tarih,
                    COUNT(tu.id)::int as kalem_sayisi
                FROM satinalma_talepleri t
                JOIN talep_urunleri tu ON tu.talep_id = t.id
                WHERE t.proje_id = $1
                  AND COALESCE(t.arsiv, false) = false
                  AND tu.durum IN ('ONAY BEKLİYOR','ONAYLANDI','İŞLEME ALINDI','TEKLİF İSTENDİ')
                GROUP BY t.id
                ORDER BY t.kayit_tarihi DESC
            `, [parseInt(proje_id)]);
            acik_talep_bilgisi = {
                talep_sayisi: acikR.rowCount,
                toplam_kalem: acikR.rows.reduce((sum, r) => sum + r.kalem_sayisi, 0),
                talepler: acikR.rows
            };
        }

        // ---- Dashboard grafik verileri (aynı filtre) ----
        const JOINS = `
            FROM satinalma_siparisleri s
            JOIN siparis_kalemleri sk ON sk.siparis_id = s.id
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN tedarikciler tdr ON s.tedarikci_id = tdr.id
            LEFT JOIN stok_kartlari skart ON tu.stok_kart_id = skart.id`;
        const [durumDag, tedarikciDag, kategoriDag, aylikDag] = await Promise.all([
            // Durum dağılımı (sipariş adedi)
            pool.query(`SELECT COALESCE(s.durum,'-') as ad, COUNT(DISTINCT s.id)::int as deger
                ${JOINS} WHERE ${where} GROUP BY s.durum ORDER BY deger DESC`, params),
            // Tedarikçi dağılımı (tutar, ilk 8)
            pool.query(`SELECT COALESCE(tdr.firma_adi,'-') as ad,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} GROUP BY tdr.firma_adi ORDER BY deger DESC NULLS LAST LIMIT 8`, params),
            // Kategori dağılımı (tutar, ilk 8)
            pool.query(`SELECT COALESCE(NULLIF(TRIM(skart.kategori),''),'Diğer') as ad,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} GROUP BY 1 ORDER BY deger DESC NULLS LAST LIMIT 8`, params),
            // Aylık harcama (tutar, kronolojik)
            pool.query(`SELECT TO_CHAR(DATE_TRUNC('month', s.siparis_tarihi),'YYYY-MM') as ad,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} AND s.siparis_tarihi IS NOT NULL GROUP BY 1 ORDER BY 1 ASC`, params)
        ]);
        const grafikler = {
            durum:     durumDag.rows.map(r => ({ ad: r.ad, deger: r.deger })),
            tedarikci: tedarikciDag.rows.map(r => ({ ad: r.ad, deger: parseFloat(r.deger || 0) })),
            kategori:  kategoriDag.rows.map(r => ({ ad: r.ad, deger: parseFloat(r.deger || 0) })),
            aylik:     aylikDag.rows.map(r => ({ ad: r.ad, deger: parseFloat(r.deger || 0) }))
        };

        res.json({ ok: true, siparisler, para_birimi_ozet, tl_toplam, kurlar, acik_talep_bilgisi, grafikler });
    } catch (e) { next(e); }
});

// Madde 5: Verilen talep'in projesindeki diğer sipariş-edilebilir kalemleri getir
// (cross-talep sipariş için "başka talep ekle" havuzu)
app.get('/api/talep/:talepId/proje-kalem-havuzu', yetkiKontrol, async (req, res, next) => {
    try {
        const { talepId } = req.params;
        const projeR = await pool.query('SELECT proje_id FROM satinalma_talepleri WHERE id=$1', [talepId]);
        if (projeR.rowCount === 0) return res.json({ ok: false, hata: 'Talep bulunamadı.' });
        const projeId = projeR.rows[0].proje_id;

        const r = await pool.query(`
            SELECT
                tu.id as talep_urun_id, tu.miktar, tu.durum,
                tu.ozel_urun_adi, tu.ozel_urun_birim,
                t.id as talep_id, t.talep_no, t.parent_talep_id,
                COALESCE(sk.stok_adi, tu.ozel_urun_adi, '-') as urun_adi,
                COALESCE(sk.stok_kodu, 'ÖZEL') as stok_kodu,
                COALESCE(sk.birim, tu.ozel_urun_birim, 'ADET') as birim
            FROM talep_urunleri tu
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            WHERE t.proje_id = $1
              AND t.id <> $2
              AND COALESCE(t.arsiv, false) = false
              AND tu.durum IN ('İŞLEME ALINDI', 'TEKLİF İSTENDİ')
            ORDER BY t.id ASC, tu.id ASC
        `, [projeId, talepId]);

        res.json({ ok: true, proje_id: projeId, kalemler: r.rows });
    } catch (e) { next(e); }
});

// ============================================================================
// TALEP BÖLME HELPER (Madde 6)
// Bir talepteki bazı kalemler kısmi sipariş alınca, kalan miktarlar yeni bir
// alt-talebe taşınır. Orijinal talep, sipariş edilen miktarları (durum=SİPARİŞ
// OLUŞTURULDU) tutar. Yeni alt-talep, kalan miktarları (durum=İŞLEME ALINDI)
// tutar ve talep_no'su ProjeNo-T-NNNN-(MAX+1) şeklinde olur.
//
// Örnek: T-1084'ten kısmi sipariş → T-1084 (sipariş) + T-1084-2 (kalan)
//        T-1084-2'den tekrar kısmi sipariş → T-1084-2 (sipariş) + T-1084-3 (kalan)
// ============================================================================
async function talepBol(client, orijinalTalepId, kalanKalemler) {
    if (!Array.isArray(kalanKalemler) || kalanKalemler.length === 0) return null;

    // 1) Orijinal talep bilgilerini al
    const oR = await client.query('SELECT * FROM satinalma_talepleri WHERE id=$1', [orijinalTalepId]);
    if (oR.rowCount === 0) throw new Error('Bölünecek orijinal talep bulunamadı.');
    const orig = oR.rows[0];

    // 2) Root talep id (parent yoksa kendisi)
    const rootId = orig.parent_talep_id || orig.id;
    const rootR = await client.query('SELECT talep_no FROM satinalma_talepleri WHERE id=$1', [rootId]);
    const rootTalepNo = rootR.rows[0].talep_no || orig.talep_no;
    // ProjeNo-T-NNNN şeklinde base (root'ta -N olmamalı ama güvenli olsun)
    const baseTalepNo = rootTalepNo.replace(/-\d+$/, '');

    // 3) Sıradaki alt_sira (artan numara)
    const mxR = await client.query(`
        SELECT COALESCE(MAX(alt_sira), 1) as mx
        FROM satinalma_talepleri
        WHERE id=$1 OR parent_talep_id=$1
    `, [rootId]);
    const yeniAltSira = parseInt(mxR.rows[0].mx) + 1;
    const yeniTalepNo = `${baseTalepNo}-${yeniAltSira}`;

    // 4) Yeni alt-talep oluştur (orijinal başlık verilerini kopyala)
    const ins = await client.query(`
        INSERT INTO satinalma_talepleri
            (talep_no, proje_id, talep_eden, istenen_tarih, teslim_yeri, genel_aciklama, durum,
             parent_talep_id, alt_sira, bolunme_tarihi)
        VALUES ($1, $2, $3, $4, $5, $6, 'ONAYLANDI', $7, $8, NOW())
        RETURNING id
    `, [
        yeniTalepNo, orig.proje_id, orig.talep_eden, orig.istenen_tarih, orig.teslim_yeri,
        `[BÖLÜNDÜ — ${orig.talep_no}'den ayrıldı] ${orig.genel_aciklama || ''}`.trim(),
        rootId, yeniAltSira
    ]);
    const yeniTalepId = ins.rows[0].id;

    // 5) Kalan kalemleri yeni talebe ekle
    for (const k of kalanKalemler) {
        await client.query(`
            INSERT INTO talep_urunleri
                (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            yeniTalepId, k.stok_kart_id, k.ozel_urun_adi, k.ozel_urun_birim,
            k.miktar, k.aciklama, k.durum || 'İŞLEME ALINDI'
        ]);
    }

    return { yeniTalepId, yeniTalepNo, altSira: yeniAltSira };
}

app.post('/api/siparis-kaydet', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // İşlemi kilitle ve başlat

        const { tedarikci_id, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani, kalemler } = req.body;

        // KURAL (Madde 5): Bir siparişe AYNI PROJE'den birden fazla talep eklenebilir
        // (alt-talepler dahil). Farklı projeden talepler aynı siparişe konamaz.
        // Tedarikçi zaten siparişin tek alanı — implicit olarak tek tedarikçi.
        let kaynakTalepIdler = []; // tüm distinct talep_id'ler
        let kaynakProjeId = null;
        if (Array.isArray(kalemler) && kalemler.length > 0) {
            const talepIdResp = await client.query(`
                SELECT DISTINCT t.id as talep_id, t.proje_id, t.talep_no
                FROM talep_urunleri tu
                JOIN satinalma_talepleri t ON tu.talep_id = t.id
                WHERE tu.id = ANY($1::integer[])
                ORDER BY t.id ASC
            `, [kalemler.map(k => parseInt(k.talep_urun_id))]);
            if (talepIdResp.rowCount === 0) throw new Error('Geçerli talep kalemi bulunamadı.');
            // Proje tekilliği kontrolü
            const projeler = [...new Set(talepIdResp.rows.map(r => r.proje_id))];
            if (projeler.length > 1) {
                throw new Error('Bir siparişe sadece AYNI PROJE\'nin talepleri eklenebilir. Farklı projelerden seçim yaptınız.');
            }
            kaynakProjeId = projeler[0];
            kaynakTalepIdler = talepIdResp.rows.map(r => r.talep_id);
        }

        // 1. Sipariş No Üret: en küçük talep no'sundan türet (T → S)
        // Cross-talep durumunda: ProjeNo-S-NNNN (en küçük talep no'ya göre)
        // Var olan aynı base ile başlayan sipariş varsa: -2, -3 ... şeklinde artar.
        let siparis_no;
        if (kaynakTalepIdler.length > 0) {
            // En küçük root talep numarasını bul (alt-talepler için root'a bak)
            const baseR = await client.query(`
                SELECT t.talep_no, t.parent_talep_id,
                       COALESCE(p.talep_no, t.talep_no) as root_no
                FROM satinalma_talepleri t
                LEFT JOIN satinalma_talepleri p ON t.parent_talep_id = p.id
                WHERE t.id = ANY($1::integer[])
                ORDER BY COALESCE(p.id, t.id) ASC, t.id ASC
                LIMIT 1
            `, [kaynakTalepIdler]);
            // Talep no'yu olduğu gibi al (sayıyı KORU), yalnızca -T- → -S- çevir
            // Örn: 72738-T-5851 → 72738-S-5851
            const enKucukRootNo = (baseR.rows[0]?.root_no || baseR.rows[0]?.talep_no || '');
            const baseSiparisNo = enKucukRootNo.replace('-T-', '-S-');
            const c = await client.query(
                `SELECT COUNT(*)::int as n FROM satinalma_siparisleri WHERE siparis_no = $1 OR siparis_no LIKE $1 || '-%'`,
                [baseSiparisNo]
            );
            const adet = c.rows[0].n;
            siparis_no = adet === 0 ? baseSiparisNo : `${baseSiparisNo}-${adet + 1}`;
        } else {
            // Fallback (talep yoksa eski format)
            const countRes = await client.query('SELECT COUNT(*) FROM satinalma_siparisleri');
            siparis_no = `SAT-S-${1001 + parseInt(countRes.rows[0].count)}`;
        }

        // 2. Ana Sipariş Başlığını Kaydet
        const siparisInsert = await client.query(`
            INSERT INTO satinalma_siparisleri (siparis_no, tedarikci_id, siparis_tarihi, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani, olusturan_adsoyad, olusturan_email)
            VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
        `, [siparis_no, tedarikci_id, termin_tarihi || null, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi || 'TL', kdv_orani || 20, req.user.adSoyad || null, req.user.email || null]);

        const yeniSiparisId = siparisInsert.rows[0].id;

        // 3. Önce kalemleri doğrula + sipariş_kalemleri kaydı oluştur + kalan listesini topla
        //    (Kalan miktarlar her kaynak talep için AYRI alt-talebe taşınacak — Madde 6 + 5)
        const kalanlarByTalep = new Map(); // talep_id => [kalanKalem...]
        for (const kalem of kalemler) {
            const origRes = await client.query(
                'SELECT miktar, talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, aciklama, durum FROM talep_urunleri WHERE id = $1',
                [kalem.talep_urun_id]
            );
            if (origRes.rowCount === 0) continue;
            const orig = origRes.rows[0];

            // KURAL: Sipariş açılabilmesi için kalem 'İŞLEME ALINDI' veya 'TEKLİF İSTENDİ' olmalı
            const kalemDurum = (orig.durum || '').trim();
            if (kalemDurum !== 'İŞLEME ALINDI' && kalemDurum !== 'TEKLİF İSTENDİ') {
                throw new Error(`Bu kalem siparişe alınamaz. Mevcut durum: "${kalemDurum}". Önce talebi "İŞLEME ALINDI" durumuna getirmelisiniz.`);
            }

            const origMiktar = parseFloat(orig.miktar);
            const sipMiktar = parseFloat(kalem.siparis_miktari);
            if (!(sipMiktar > 0)) throw new Error('Sipariş miktarı 0 olamaz.');
            if (sipMiktar > origMiktar) throw new Error(`Sipariş miktarı (${sipMiktar}) talep miktarından (${origMiktar}) büyük olamaz.`);

            if (sipMiktar < origMiktar) {
                // Kısmi sipariş: kalan miktarı kaynak talebe göre grupla
                if (!kalanlarByTalep.has(orig.talep_id)) kalanlarByTalep.set(orig.talep_id, []);
                kalanlarByTalep.get(orig.talep_id).push({
                    stok_kart_id: orig.stok_kart_id,
                    ozel_urun_adi: orig.ozel_urun_adi,
                    ozel_urun_birim: orig.ozel_urun_birim,
                    miktar: origMiktar - sipMiktar,
                    aciklama: orig.aciklama,
                    durum: 'İŞLEME ALINDI'
                });
                // Orijinal kalemi sipariş miktarına indir + durum güncelle
                await client.query(
                    `UPDATE talep_urunleri SET miktar=$1, durum='SİPARİŞ OLUŞTURULDU' WHERE id=$2`,
                    [sipMiktar, kalem.talep_urun_id]
                );
            } else {
                // Tam sipariş: sadece durum güncelle
                await client.query(
                    `UPDATE talep_urunleri SET durum='SİPARİŞ OLUŞTURULDU' WHERE id=$1`,
                    [kalem.talep_urun_id]
                );
            }

            // Sipariş kalem kaydı
            await client.query(`
                INSERT INTO siparis_kalemleri (siparis_id, talep_urun_id, birim_fiyat, siparis_miktari)
                VALUES ($1, $2, $3, $4)
            `, [yeniSiparisId, kalem.talep_urun_id, kalem.birim_fiyat, sipMiktar]);
        }

        // 3b. Kalan miktarlar varsa her kaynak talep için AYRI alt-talep oluştur
        const bolunmeler = []; // [{kaynakTalepId, yeniTalepNo, ...}]
        for (const [talepId, kalanKalemler] of kalanlarByTalep.entries()) {
            const bi = await talepBol(client, talepId, kalanKalemler);
            if (bi) bolunmeler.push({ kaynakTalepId: talepId, ...bi });
        }

        // 3c. Sipariş açılan tüm kaynak taleplerin başlık durumunu kalemlerinden yeniden türet
        // (bazı kalemler SİPARİŞ OLUŞTURULDU, diğerleri farklı aşamada kalabilir → KARIŞIK)
        for (const tId of kaynakTalepIdler) {
            await talepBaslikDurumGuncelle(client, tId);
        }

        await client.query('COMMIT'); // Tüm işlemleri tek seferde veritabanına mühürle
        const ekMesaj = bolunmeler.length > 0
            ? ` Kısmi sipariş — ${bolunmeler.length} talep bölündü: ${bolunmeler.map(b=>b.yeniTalepNo).join(', ')}.`
            : '';
        const cross = kaynakTalepIdler.length > 1 ? ` (${kaynakTalepIdler.length} taleple cross-sipariş)` : '';
        try {
            await auditLogla(req, {
                eylem: 'CREATE', tablo: 'satinalma_siparisleri', kayit_id: yeniSiparisId, kayit_no: siparis_no,
                ozet: `Sipariş oluşturuldu${cross}${bolunmeler.length ? ` + ${bolunmeler.length} talep bölündü` : ''}`
            });
        } catch(_) {}
        // Taslak (imzasız) sipariş formunu bildirim mailine ekle — o an durum "OLUŞTURULDU"
        let olusturuldukEkler;
        try {
            const taslakPdf = await siparisPDFUret(yeniSiparisId, req.user);
            olusturuldukEkler = [{ filename: `Siparis-${siparis_no}-Taslak.pdf`, content: taslakPdf }];
        } catch (pe) { console.error('⚠️ Taslak PDF (bildirim eki):', pe.message); }
        await bildirimGonder('SIPARIS_OLUSTURULDU', {
            siparisId: yeniSiparisId,
            konu: `Aterko Workspace - Yeni sipariş oluşturuldu (${siparis_no})`,
            baslik: 'Yeni sipariş oluşturuldu',
            mesaj: `${req.user.adSoyad} tarafından ${siparis_no} numaralı yeni bir satınalma siparişi oluşturuldu.`,
            detaylar: [{ label: 'Sipariş No', value: siparis_no }],
            ekler: olusturuldukEkler
        });
        res.json({ ok: true, mesaj: `Sipariş başarıyla oluşturuldu: ${siparis_no}.${ekMesaj}`, bolunmeler });
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
                   s.tedarikci_id,
                   t.firma_adi as tedarikci_adi,
                   COALESCE(SUM(sk.siparis_miktari * sk.birim_fiyat), 0) as ara_toplam,
                   COUNT(sk.id) as kalem_sayisi,
                   s.fatura_nolari, s.fatura_onay_durumu, s.fatura_onay_tarihi,
                   s.fatura_onaylayan_email, s.fatura_notu,
                   STRING_AGG(DISTINCT NULLIF(TRIM(skart.kategori), ''), ', ') as kategoriler,
                   COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                       'urun_adi', COALESCE(skart.stok_adi, tu.ozel_urun_adi), 'stok_kodu', COALESCE(skart.stok_kodu, 'ÖZEL'),
                       'birim', COALESCE(skart.birim, tu.ozel_urun_birim), 'kategori', skart.kategori,
                       'siparis_miktari', sk.siparis_miktari, 'teslim_alinan_miktar', COALESCE(sk.teslim_alinan_miktar, 0), 'birim_fiyat', sk.birim_fiyat
                   ) ORDER BY sk.id) FILTER (WHERE sk.id IS NOT NULL), '[]') as kalemler,
                   (SELECT JSON_BUILD_OBJECT('kodu', p.proje_kodu, 'musteri', p.musteri_adi, 'adi', p.proje_adi)
                    FROM siparis_kalemleri sk2
                    JOIN talep_urunleri tu2 ON sk2.talep_urun_id = tu2.id
                    JOIN satinalma_talepleri t2 ON tu2.talep_id = t2.id
                    JOIN projeler p ON t2.proje_id = p.id
                    WHERE sk2.siparis_id = s.id LIMIT 1) as proje
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            LEFT JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            LEFT JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            LEFT JOIN stok_kartlari skart ON tu.stok_kart_id = skart.id
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
            SELECT tu.id as kalem_id, tu.id as id, tu.miktar, tu.aciklama, tu.durum, tu.stok_kart_id,
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
                   s.tedarikci_id,
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

// Bir talebin AÇIK kalemi kalmadıysa (tüm kalemleri ya arşivlenmiş siparişte ya
// İPTAL/REDDEDİLDİ) talebi otomatik arşivler. Sipariş arşivlendiğinde çağrılır.
// Talep arşivi BUNUN DIŞINDA sadece İPTAL talepler için manuel yapılabilir.
async function talepArsivSenkron(client, talepId) {
    const r = await client.query(`
        SELECT COUNT(*)::int AS acik FROM talep_urunleri tu
        WHERE tu.talep_id = $1
          AND tu.durum NOT IN ('İPTAL', 'REDDEDİLDİ')
          AND NOT EXISTS (
              SELECT 1 FROM siparis_kalemleri sk
              JOIN satinalma_siparisleri s ON sk.siparis_id = s.id
              WHERE sk.talep_urun_id = tu.id AND COALESCE(s.arsiv, false) = true
          )
    `, [talepId]);
    if (r.rows[0].acik === 0) {
        const u = await client.query(
            "UPDATE satinalma_talepleri SET arsiv=true WHERE id=$1 AND COALESCE(arsiv,false)=false", [talepId]);
        return u.rowCount > 0;
    }
    return false;
}

// Arşivden geri çıkar (talep veya sipariş)
app.post('/api/arsivden-cikar', yetkiKontrol, async (req, res, next) => {
    try {
        const { tur, id } = req.body; // tur: 'talep' | 'siparis'
        if (tur === 'talep') {
            await pool.query("UPDATE satinalma_talepleri SET arsiv=false WHERE id=$1", [id]);
        } else if (tur === 'siparis') {
            await pool.query("UPDATE satinalma_siparisleri SET arsiv=false WHERE id=$1", [id]);
            // Simetri: sipariş arşivden çıkınca, onunla birlikte arşive gitmiş talepleri de geri getir
            await pool.query(`
                UPDATE satinalma_talepleri SET arsiv=false
                WHERE COALESCE(arsiv,false)=true AND id IN (
                    SELECT DISTINCT tu.talep_id FROM siparis_kalemleri sk
                    JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
                    WHERE sk.siparis_id = $1
                )
            `, [id]);
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
        await auditLogla(req, {
            eylem: 'APPROVE', tablo: 'satinalma_talepleri', kayit_id: talep_id,
            ozet: 'Talep onaylandı'
        });
        // Bildirim: talebi açana + SATINALMA'ya
        const tBil = (await pool.query("SELECT talep_no, talep_eden FROM satinalma_talepleri WHERE id=$1", [talep_id])).rows[0];
        if (tBil) await bildirimGonder('TALEP_ONAYLANDI', {
            talepId: talep_id,
            konu: `Aterko Workspace - Talebiniz onaylandı (${tBil.talep_no})`,
            baslik: 'Talebiniz onaylandı ✓',
            mesaj: `${tBil.talep_no} numaralı talebiniz ${req.user.adSoyad} tarafından onaylandı ve satınalma sürecine alındı.`,
            detaylar: [{ label: 'Talep No', value: tBil.talep_no }, { label: 'Onaylayan', value: req.user.adSoyad }],
            talepEdenAd: tBil.talep_eden
        });
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
        await auditLogla(req, {
            eylem: 'CANCEL', tablo: 'satinalma_talepleri', kayit_id: talep_id,
            ozet: gerekce ? `Talep iptal: ${gerekce.substring(0,200)}` : 'Talep iptal edildi'
        });
        // Bildirim: talebi açana (reddedildi/iptal)
        const tBilR = (await pool.query("SELECT talep_no, talep_eden FROM satinalma_talepleri WHERE id=$1", [talep_id])).rows[0];
        if (tBilR) await bildirimGonder('TALEP_REDDEDILDI', {
            talepId: talep_id,
            konu: `Aterko Workspace - Talebiniz reddedildi (${tBilR.talep_no})`,
            baslik: 'Talebiniz reddedildi',
            mesaj: `${tBilR.talep_no} numaralı talebiniz ${req.user.adSoyad} tarafından reddedildi/iptal edildi.`,
            detaylar: [{ label: 'Talep No', value: tBilR.talep_no }, { label: 'İşlem yapan', value: req.user.adSoyad }]
                .concat(gerekce ? [{ label: 'Gerekçe', value: gerekce }] : []),
            talepEdenAd: tBilR.talep_eden
        });
        res.json({ ok: true, mesaj: 'Talep iptal edildi.' });
    } catch (e) { next(e); }
});

// Talebi arşivle — bağlı siparişler de arşivlenir
app.post('/api/talep-arsivle', yetkiKontrol, async (req, res, next) => {
    try {
        const { talep_id } = req.body;
        // Talep arşivi YALNIZCA İPTAL durumundaki talepler için manuel yapılabilir.
        // Aktif talepler, tüm kalemleri siparişe dönüp arşivlendiğinde otomatik
        // arşive gider (siparis-arsivle → talepArsivSenkron).
        const dR = await pool.query("SELECT durum FROM satinalma_talepleri WHERE id=$1", [talep_id]);
        if (dR.rowCount === 0) return res.json({ ok: false, hata: 'Talep bulunamadı.' });
        if ((dR.rows[0].durum || '').trim() !== 'İPTAL') {
            return res.json({ ok: false, hata: 'Yalnızca İPTAL durumundaki talepler arşivlenebilir. Aktif talepler, tüm kalemleri siparişe dönüp arşivlendiğinde kendiliğinden arşive gider.' });
        }
        await pool.query("UPDATE satinalma_talepleri SET arsiv=true WHERE id=$1", [talep_id]);
        await auditLogla(req, { eylem: 'ARCHIVE', tablo: 'satinalma_talepleri', kayit_id: talep_id, ozet: 'İptal edilen talep arşivlendi' });
        res.json({ ok: true, mesaj: 'İptal edilen talep arşivlendi.' });
    } catch (e) { next(e); }
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

// ============================================================================
// TEKLİF KAYITLARI (Madde 4 — yapılandırılmış teklif)
// ============================================================================
// Bir kaleme tedarikçi teklifi ekle/güncelle
// Body: { id, talep_urun_id, tedarikci_id, birim_fiyat, miktar, para_birimi,
//         vade, termin_tarihi, alternatif_urun, yorum, durum }
app.post('/api/teklif-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const {
            id, talep_urun_id, tedarikci_id, birim_fiyat, miktar, para_birimi,
            vade, termin_tarihi, alternatif_urun, yorum, durum
        } = req.body;
        if (!talep_urun_id) return res.json({ ok: false, hata: 'Kalem ID gerekli.' });

        if (id) {
            await pool.query(`
                UPDATE teklif_kayitlari SET
                    tedarikci_id=$1, birim_fiyat=$2, miktar=$3, para_birimi=$4,
                    vade=$5, termin_tarihi=$6, alternatif_urun=$7, yorum=$8, durum=$9
                WHERE id=$10
            `, [tedarikci_id || null, birim_fiyat || null, miktar || null, para_birimi || 'TL',
                vade || null, termin_tarihi || null, alternatif_urun || null, yorum || null,
                durum || 'BEKLEMEDE', id]);
            await auditLogla(req, { eylem:'UPDATE', tablo:'teklif_kayitlari', kayit_id:id,
                ozet:`Teklif güncellendi (kalem #${talep_urun_id})` });
            return res.json({ ok: true, mesaj: 'Teklif güncellendi.' });
        }
        const ins = await pool.query(`
            INSERT INTO teklif_kayitlari
              (talep_urun_id, tedarikci_id, birim_fiyat, miktar, para_birimi,
               vade, termin_tarihi, alternatif_urun, yorum, durum, olusturan_email)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
        `, [talep_urun_id, tedarikci_id || null, birim_fiyat || null, miktar || null,
            para_birimi || 'TL', vade || null, termin_tarihi || null,
            alternatif_urun || null, yorum || null, durum || 'BEKLEMEDE', req.user.email]);
        await auditLogla(req, { eylem:'CREATE', tablo:'teklif_kayitlari', kayit_id:ins.rows[0].id,
            ozet:`Yeni teklif kaydı (kalem #${talep_urun_id})` });
        const tkUrun = (await pool.query("SELECT COALESCE(sk.stok_adi, tu.ozel_urun_adi, '-') urun FROM talep_urunleri tu LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id WHERE tu.id=$1", [talep_urun_id])).rows[0];
        const tkTed = tedarikci_id ? (await pool.query("SELECT firma_adi FROM tedarikciler WHERE id=$1", [tedarikci_id])).rows[0] : null;
        await bildirimGonder('TEKLIF_GIRILDI', {
            konu: 'Aterko Workspace - Yeni tedarikçi teklifi girildi',
            baslik: 'Tedarikçiden teklif girildi',
            mesaj: `${(tkTed && tkTed.firma_adi) || 'Bir tedarikçi'} için yeni teklif kaydedildi.`,
            detaylar: [
                { label: 'Ürün', value: (tkUrun && tkUrun.urun) || '-' },
                { label: 'Tedarikçi', value: (tkTed && tkTed.firma_adi) || '-' },
                { label: 'Birim fiyat', value: birim_fiyat ? `${birim_fiyat} ${para_birimi || 'TL'}` : '-' }
            ]
        });
        res.json({ ok: true, mesaj: 'Teklif kaydedildi.', id: ins.rows[0].id });
    } catch (e) { next(e); }
});

// Bir kaleme ait teklifleri listele
app.get('/api/teklifler/:talepUrunId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT tk.*, t.firma_adi as tedarikci_adi
            FROM teklif_kayitlari tk
            LEFT JOIN tedarikciler t ON tk.tedarikci_id=t.id
            WHERE tk.talep_urun_id=$1
            ORDER BY tk.birim_fiyat ASC NULLS LAST, tk.kayit_tarihi DESC
        `, [req.params.talepUrunId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Teklif sil
app.delete('/api/teklif-sil/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM teklif_kayitlari WHERE id=$1', [id]);
        await auditLogla(req, { eylem:'DELETE', tablo:'teklif_kayitlari', kayit_id:id, ozet:'Teklif silindi' });
        res.json({ ok: true, mesaj: 'Teklif silindi.' });
    } catch (e) { next(e); }
});

// TEKLİF İSTE — kalem listesini TEKLİF İSTENDİ durumuna geçir
// Body: { kalem_idler: [int], tedarikci_idler: [int], aciklama }
// Teklif Talebi e-posta gövdesi (siparis.html görsel diline uygun, inline CSS)
function teklifTalebiMailHTML({ tedarikciAdi, kalemler, isteyenAd, talepEtiket, projeAdi, teslimYeri, istenenTarih, not }) {
    const satirlar = kalemler.map((k, i) => `
        <tr style="${i % 2 ? 'background:#fafbfc;' : ''}">
          <td style="padding:7px 6px;border-bottom:1px solid #e9ecef;">${i + 1}</td>
          <td style="padding:7px 6px;border-bottom:1px solid #e9ecef;color:#0d6efd;font-weight:600;">${esc2(k.kod)}</td>
          <td style="padding:7px 6px;border-bottom:1px solid #e9ecef;">${esc2(k.ad)}</td>
          <td style="padding:7px 6px;border-bottom:1px solid #e9ecef;text-align:center;font-weight:600;">${k.miktar} ${esc2(k.birim)}</td>
        </tr>`).join('');
    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#212529;">
  <div style="max-width:660px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
    <div style="border-bottom:3px solid #ff4c00;padding:20px 26px;">
      <table style="width:100%;border-collapse:collapse;"><tr>
        <td style="vertical-align:top;"><img src="https://www.aterko.com/wp-content/uploads/2022/07/aterko-logo-dark.png" alt="ATERKO" height="34" style="height:34px;width:auto;display:block;border:0;"></td>
        <td style="text-align:right;vertical-align:top;"><div style="font-size:16px;font-weight:700;color:#ff4c00;">TEKLİF TALEBİ</div><div style="font-size:12px;font-weight:600;color:#212529;">${esc2(talepEtiket)}</div></td>
      </tr></table>
    </div>
    <div style="padding:24px 26px;">
      <p style="margin:0 0 6px;">Sayın <strong>${esc2(tedarikciAdi)}</strong> Yetkilisi,</p>
      <p style="margin:0 0 16px;color:#495057;">Aşağıda belirtilen malzemeler için fiyat teklifinizi rica ederiz.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr>
          <td style="background:#f8f9fa;border-left:3px solid #ff4c00;padding:9px 12px;width:50%;"><div style="font-size:8.5px;color:#6c757d;font-weight:700;text-transform:uppercase;letter-spacing:.3px;">İSTENEN TARİH</div><div style="font-weight:600;margin-top:2px;">${esc2(istenenTarih) || '-'}</div></td>
          <td style="width:8px;"></td>
          <td style="background:#f8f9fa;border-left:3px solid #ff4c00;padding:9px 12px;"><div style="font-size:8.5px;color:#6c757d;font-weight:700;text-transform:uppercase;letter-spacing:.3px;">TESLİM YERİ</div><div style="font-weight:600;margin-top:2px;">${esc2(teslimYeri) || '-'}</div></td>
        </tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#212529;color:#ffffff;">
          <th style="padding:9px 6px;text-align:left;font-size:11px;text-transform:uppercase;">Sıra</th>
          <th style="padding:9px 6px;text-align:left;font-size:11px;text-transform:uppercase;">Kod</th>
          <th style="padding:9px 6px;text-align:left;font-size:11px;text-transform:uppercase;">Ürün / Malzeme</th>
          <th style="padding:9px 6px;text-align:center;font-size:11px;text-transform:uppercase;">Miktar</th>
        </tr></thead>
        <tbody>${satirlar}</tbody>
      </table>
      ${not ? `<div style="margin-top:16px;padding:11px 13px;background:#fff8e1;border-left:3px solid #ffc107;font-size:13px;"><strong style="color:#856404;">NOT:</strong> ${esc2(not).replace(/\n/g, '<br>')}</div>` : ''}
      <p style="margin:20px 0 0;color:#495057;">Teklifinizi en kısa sürede tarafımıza iletmenizi rica ederiz. İyi çalışmalar dileriz.</p>
      <div style="margin-top:26px;font-size:14px;"><strong>${esc2(isteyenAd)}</strong><br><span style="color:#6c757d;">Aterko Satınalma</span></div>
    </div>
    <div style="padding:13px 26px;border-top:1px solid #dee2e6;background:#f8f9fa;font-size:11px;color:#6c757d;">Aterko</div>
  </div>
</body></html>`;
}
// Basit HTML-escape (mail gövdesi için)
function esc2(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// --- BİLDİRİM SİSTEMİ ---
// Genel amaçlı iç bildirim e-postası (siparis.html görsel diliyle uyumlu)
function bildirimMailHTML({ baslik, mesaj, detaylar, kalemler }) {
    const satirlar = (detaylar || []).map(d =>
        `<tr><td style="padding:7px 14px;color:#6c757d;font-size:13px;white-space:nowrap;vertical-align:top;">${esc2(d.label)}</td><td style="padding:7px 14px;font-weight:600;font-size:13px;color:#212529;">${esc2(d.value)}</td></tr>`
    ).join('');
    const kalemTablosu = (kalemler && kalemler.length) ? `
        <div style="font-size:12px;color:#6c757d;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin:20px 0 6px;">Ürünler (${kalemler.length})</div>
        <table style="border-collapse:collapse;width:100%;border:1px solid #e9ecef;font-size:13px;">
          <thead><tr style="background:#212529;color:#fff;">
            <th style="padding:7px 10px;text-align:left;font-weight:600;">Ürün</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;">Kod</th>
            <th style="padding:7px 10px;text-align:right;font-weight:600;white-space:nowrap;">Miktar</th>
          </tr></thead>
          <tbody>${kalemler.map((k, i) => `<tr style="background:${i % 2 ? '#fafbfc' : '#ffffff'};">
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc2(k.ad)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#6c757d;">${esc2(k.kod)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;white-space:nowrap;">${esc2(k.miktar)} ${esc2(k.birim || '')}</td>
          </tr>`).join('')}</tbody>
        </table>` : '';
    return `
    <div style="max-width:580px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#fff;border:1px solid #e9ecef;border-radius:8px;overflow:hidden;">
      <div style="padding:18px 26px;border-bottom:3px solid #ff4c00;">
        <img src="https://www.aterko.com/wp-content/uploads/2022/07/aterko-logo-dark.png" alt="ATERKO" height="30" style="height:30px;width:auto;display:block;border:0;">
      </div>
      <div style="padding:24px 26px;">
        <div style="font-size:17px;font-weight:700;color:#212529;margin-bottom:10px;">${esc2(baslik)}</div>
        <div style="font-size:14px;color:#495057;line-height:1.6;margin-bottom:${satirlar ? '18px' : '0'};">${esc2(mesaj)}</div>
        ${satirlar ? `<table style="border-collapse:collapse;width:100%;background:#f8f9fa;border-radius:6px;border:1px solid #e9ecef;">${satirlar}</table>` : ''}
        ${kalemTablosu}
        <div style="margin-top:22px;font-size:12px;color:#adb5bd;">Bu otomatik bir bildirimdir — Aterko Workspace tarafından gönderildi.</div>
      </div>
      <div style="padding:13px 26px;border-top:1px solid #dee2e6;background:#f8f9fa;font-size:11px;color:#6c757d;">Aterko</div>
    </div>`;
}

// Bir olay kuralını okuyup (aktifse) alıcıları çözer ve TEK e-posta gönderir.
// Render fire-and-forget'i kestiği için res.json ÖNCESİ await edilmeli.
// context: { konu, baslik, mesaj, detaylar, talepEdenAd }
async function bildirimGonder(olayKodu, context = {}) {
    try {
        if (!mailTransporter) return;
        const kR = await pool.query("SELECT * FROM bildirim_kurallari WHERE olay_kodu=$1 AND aktif=true", [olayKodu]);
        if (kR.rowCount === 0) return; // pasif veya tanımsız → sessizce çık
        const k = kR.rows[0];
        const aliciSet = new Set();
        // 1) Roller → o roldeki (pasif olmayan) kullanıcılar
        if (k.roller && k.roller.length) {
            const uR = await pool.query(
                "SELECT email FROM kullanicilar WHERE rol = ANY($1) AND durum='AKTIF' AND email IS NOT NULL", [k.roller]);
            uR.rows.forEach(u => aliciSet.add(u.email));
        }
        // 2) Ekstra belirli e-postalar
        (k.ekstra_emailler || []).forEach(e => e && aliciSet.add(e));
        // 3) Dinamik: talebi açan kişi (ad_soyad → email)
        if (k.dinamik_alicilar && k.dinamik_alicilar.includes('TALEP_SAHIBI') && context.talepEdenAd) {
            const eR = await pool.query("SELECT email FROM kullanicilar WHERE ad_soyad=$1 AND email IS NOT NULL LIMIT 1", [context.talepEdenAd]);
            if (eR.rowCount) aliciSet.add(eR.rows[0].email);
        }
        const alicilar = [...aliciSet].filter(Boolean);
        // CC alıcıları: cc_roller → kullanıcılar, cc_emailler
        const ccSet = new Set();
        if (k.cc_roller && k.cc_roller.length) {
            const cR = await pool.query(
                "SELECT email FROM kullanicilar WHERE rol = ANY($1) AND durum='AKTIF' AND email IS NOT NULL", [k.cc_roller]);
            cR.rows.forEach(u => ccSet.add(u.email));
        }
        (k.cc_emailler || []).forEach(e => e && ccSet.add(e));
        // TO'da zaten olan adresleri CC'den çıkar (mükerrer olmasın)
        let ccList = [...ccSet].filter(e => e && !aliciSet.has(e));
        if (!alicilar.length && !ccList.length) return;
        // TO hiç yoksa ama CC varsa, CC'yi TO yap (boş to ile mail gitmez)
        const toList = alicilar.length ? alicilar : ccList;
        const realCc = alicilar.length ? ccList : [];

        // Zengin içerik: talep/sipariş id verilmişse proje + ürün listesini otomatik ekle
        // (mail tek başına yeterli bilgi versin — kodun karşılığı aranmasın)
        try {
            context.detaylar = context.detaylar || [];
            const ekleDetay = (label, value) => { if (value && !context.detaylar.some(d => d.label === label)) context.detaylar.push({ label, value }); };
            if (context.talepId) {
                const tD = (await pool.query(
                    "SELECT p.proje_kodu, p.musteri_adi, p.proje_adi FROM satinalma_talepleri t LEFT JOIN projeler p ON t.proje_id=p.id WHERE t.id=$1", [context.talepId])).rows[0];
                if (tD) ekleDetay('Proje', `${tD.proje_kodu || ''}${tD.musteri_adi ? ' / ' + tD.musteri_adi : ''}${tD.proje_adi ? ' - ' + tD.proje_adi : ''}`.trim());
                const kD = (await pool.query(
                    "SELECT COALESCE(sk.stok_adi, tu.ozel_urun_adi, '-') ad, COALESCE(sk.stok_kodu, 'ÖZEL') kod, tu.miktar, COALESCE(sk.birim, tu.ozel_urun_birim, '') birim FROM talep_urunleri tu LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id WHERE tu.talep_id=$1 ORDER BY tu.id", [context.talepId])).rows;
                if (kD.length && !context.kalemler) context.kalemler = kD;
            }
            if (context.siparisId) {
                const sD = (await pool.query(
                    `SELECT ted.firma_adi tedarikci,
                       (SELECT p.proje_kodu || COALESCE(' / ' || p.musteri_adi, '') || COALESCE(' - ' || p.proje_adi, '')
                        FROM siparis_kalemleri sk2 JOIN talep_urunleri tu2 ON sk2.talep_urun_id=tu2.id
                        JOIN satinalma_talepleri t2 ON tu2.talep_id=t2.id JOIN projeler p ON t2.proje_id=p.id
                        WHERE sk2.siparis_id=s.id LIMIT 1) proje
                     FROM satinalma_siparisleri s LEFT JOIN tedarikciler ted ON s.tedarikci_id=ted.id WHERE s.id=$1`, [context.siparisId])).rows[0];
                if (sD) { ekleDetay('Proje', sD.proje); ekleDetay('Tedarikçi', sD.tedarikci); }
                const kD = (await pool.query(
                    "SELECT COALESCE(sk.stok_adi, tu.ozel_urun_adi, '-') ad, COALESCE(sk.stok_kodu, 'ÖZEL') kod, skk.siparis_miktari miktar, COALESCE(sk.birim, tu.ozel_urun_birim, '') birim FROM siparis_kalemleri skk JOIN talep_urunleri tu ON skk.talep_urun_id=tu.id LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id WHERE skk.siparis_id=$1 ORDER BY skk.id", [context.siparisId])).rows;
                if (kD.length && !context.kalemler) context.kalemler = kD;
            }
        } catch (ze) { console.error('⚠️ Bildirim zenginleştirme:', ze.message); }

        await mailTransporter.sendMail({
            from: `"Aterko Workspace" <${MAIL_FROM_EMAIL}>`,
            to: toList.join(', '),
            cc: realCc.length ? realCc.join(', ') : undefined,
            subject: context.konu || context.baslik || 'Aterko Workspace Bildirimi',
            html: bildirimMailHTML(context),
            attachments: (context.ekler && context.ekler.length) ? context.ekler : undefined
        });
        console.log('🔔 Bildirim:', olayKodu, '→', toList.length, 'alıcı' + (realCc.length ? ` + ${realCc.length} CC` : ''));
    } catch (e) {
        console.error('⚠️ Bildirim hatası:', olayKodu, e.message);
    }
}

app.post('/api/teklif-iste', yetkiKontrol, async (req, res, next) => {
    try {
        const { kalem_idler, tedarikci_idler, aciklama } = req.body;
        if (!Array.isArray(kalem_idler) || kalem_idler.length === 0) {
            return res.json({ ok: false, hata: 'En az bir kalem seçilmelidir.' });
        }
        if (!Array.isArray(tedarikci_idler) || tedarikci_idler.length === 0) {
            return res.json({ ok: false, hata: 'En az bir tedarikçi seçilmelidir.' });
        }

        // Kalem detayları (ürün, miktar, birim, kategori, talep, proje)
        const kalemlerR = await pool.query(`
            SELECT tu.id, tu.miktar, tu.durum,
                   COALESCE(sk.stok_adi, tu.ozel_urun_adi, '-') as ad,
                   COALESCE(sk.stok_kodu, 'ÖZEL') as kod,
                   COALESCE(sk.birim, tu.ozel_urun_birim, 'ADET') as birim,
                   COALESCE(sk.kategori, '') as kategori,
                   t.talep_no, t.istenen_tarih, t.teslim_yeri,
                   TRIM(COALESCE(p.proje_kodu,'') || ' ' || COALESCE(p.proje_adi,'')) as proje
            FROM talep_urunleri tu
            JOIN satinalma_talepleri t ON tu.talep_id = t.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id = sk.id
            LEFT JOIN projeler p ON t.proje_id = p.id
            WHERE tu.id = ANY($1::integer[])
        `, [kalem_idler]);
        const kalemler = kalemlerR.rows;
        const gecersiz = kalemler.filter(k => !['İŞLEME ALINDI', 'TEKLİF İSTENDİ'].includes((k.durum || '').trim()));
        if (gecersiz.length > 0) {
            return res.json({ ok: false, hata: `${gecersiz.length} kalem uygun durumda değil (İŞLEME ALINDI veya TEKLİF İSTENDİ olmalı).` });
        }

        // Tedarikçi + admin + isteyen bilgileri
        const tedR = await pool.query("SELECT id, firma_adi, email FROM tedarikciler WHERE id = ANY($1::integer[])", [tedarikci_idler]);
        const admR = await pool.query("SELECT email FROM kullanicilar WHERE rol IN ('ADMIN','Admin') AND durum='AKTIF'");
        const adminMails = admR.rows.map(a => a.email).filter(Boolean);
        const isteyenEmail = req.user.email;
        const isteyenAd = req.user.adSoyad || req.user.email;

        // Kalemleri TEKLİF İSTENDİ'ye çek + talep başlıklarını güncelle
        await pool.query("UPDATE talep_urunleri SET durum='TEKLİF İSTENDİ' WHERE id = ANY($1::integer[])", [kalem_idler]);
        const talepIdsR = await pool.query("SELECT DISTINCT talep_id FROM talep_urunleri WHERE id = ANY($1::integer[])", [kalem_idler]);
        for (const t of talepIdsR.rows) await talepBaslikDurumGuncelle(pool, t.talep_id);

        // Konu etiketleri
        const kategoriler = [...new Set(kalemler.map(k => k.kategori).filter(Boolean))];
        const kategoriEtiket = kategoriler.length === 1 ? kategoriler[0] : (kategoriler.length > 1 ? 'Muhtelif' : 'Malzeme');
        const talepNolar = [...new Set(kalemler.map(k => k.talep_no).filter(Boolean))];
        const talepEtiket = talepNolar.length === 1 ? talepNolar[0] : (talepNolar[0] + ' vd.');
        const ilkProje = kalemler[0]?.proje || '';
        const ilkTeslimYeri = kalemler[0]?.teslim_yeri || '';
        const ilkIstenenTarih = kalemler[0]?.istenen_tarih ? new Date(kalemler[0].istenen_tarih).toLocaleDateString('tr-TR') : '';

        // teklif_kayitlari: her tedarikçi×kalem için kayıt yoksa "İSTENDİ" ekle (geçmiş birikir) — SENKRON, hızlı
        for (const ted of tedR.rows) {
            for (const k of kalemler) {
                const varMi = await pool.query("SELECT 1 FROM teklif_kayitlari WHERE talep_urun_id=$1 AND tedarikci_id=$2 LIMIT 1", [k.id, ted.id]);
                if (varMi.rowCount === 0) {
                    await pool.query(
                        "INSERT INTO teklif_kayitlari (talep_urun_id, tedarikci_id, miktar, durum, olusturan_email) VALUES ($1,$2,$3,'İSTENDİ',$4)",
                        [k.id, ted.id, k.miktar, isteyenEmail]
                    );
                }
            }
        }

        const epostali = tedR.rows.filter(t => t.email);
        const epostasiz = tedR.rows.filter(t => !t.email).map(t => t.firma_adi);

        // E-postaları YANIT ÖNCESİ paralel gönder. (Render gibi PaaS'larda res.json
        // sonrası fire-and-forget kod kesilebildiği için arka plana atmıyoruz; paralel
        // gönderim + timeout sayesinde garanti gider ama kullanıcıyı uzun bekletmez.)
        let mailGitti = 0;
        const mailHata = [];
        if (mailTransporter && epostali.length) {
            const ccList = [...new Set([isteyenEmail, ...adminMails])].filter(Boolean).join(', ');
            const konu = `Aterko - ${kategoriEtiket} Teklif Talebi (${talepEtiket})`;
            const html = teklifTalebiMailHTML({
                tedarikciAdi: 'İlgili', kalemler, isteyenAd, talepEtiket,
                projeAdi: ilkProje, teslimYeri: ilkTeslimYeri, istenenTarih: ilkIstenenTarih, not: aciklama || ''
            });
            const sonuclar = await Promise.allSettled(epostali.map(ted =>
                mailTransporter.sendMail({
                    from: `"Aterko Satınalma" <${MAIL_FROM_EMAIL}>`,
                    to: ted.email,
                    cc: ccList,
                    subject: konu,
                    // Her tedarikçinin hitabı kendine: gövdedeki "İlgili"yi firma adıyla değiştir
                    html: html.replace('Sayın <strong>İlgili</strong> Yetkilisi', `Sayın <strong>${esc2(ted.firma_adi || 'İlgili')}</strong> Yetkilisi`)
                })
            ));
            sonuclar.forEach((r, i) => {
                if (r.status === 'fulfilled') { mailGitti++; console.log('✉️ Teklif maili gönderildi:', epostali[i].firma_adi); }
                else { mailHata.push(epostali[i].firma_adi); console.error('⚠️ Teklif mail hatası:', epostali[i].firma_adi, r.reason && r.reason.message); }
            });
        }

        res.json({
            ok: true,
            mesaj: `${kalem_idler.length} kalem için ${tedR.rows.length} tedarikçiden teklif istendi. ${mailGitti} e-posta gönderildi.` +
                   (mailHata.length ? ` Gönderilemedi: ${mailHata.join(', ')}.` : '') +
                   (epostasiz.length ? ` E-postası olmayan: ${epostasiz.join(', ')}.` : '')
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
        await auditLogla(req, { eylem: 'REVERT', tablo: 'satinalma_talepleri', kayit_id: parseInt(talep_id), ozet: `Geri alındı → ${yeniDurum}` });
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
        await auditLogla(req, {
            eylem: 'APPROVE', tablo: 'satinalma_siparisleri', kayit_id: req.body.siparis_id,
            ozet: 'Sipariş onaylandı'
        });
        const soNo = (await pool.query("SELECT siparis_no FROM satinalma_siparisleri WHERE id=$1", [req.body.siparis_id])).rows[0];
        // Final (kaşe+imzalı) sipariş formunu bildirim mailine ekle — durum artık "ONAYLANDI"
        let onaylandiEkler;
        try {
            const finalPdf = await siparisPDFUret(req.body.siparis_id, req.user);
            onaylandiEkler = [{ filename: `Siparis-${(soNo && soNo.siparis_no) || req.body.siparis_id}.pdf`, content: finalPdf }];
        } catch (pe) { console.error('⚠️ Final PDF (bildirim eki):', pe.message); }
        await bildirimGonder('SIPARIS_ONAYLANDI', {
            siparisId: req.body.siparis_id,
            konu: `Aterko Workspace - Sipariş onaylandı (${(soNo && soNo.siparis_no) || ''})`,
            baslik: 'Sipariş onaylandı',
            mesaj: `${(soNo && soNo.siparis_no) || ''} numaralı sipariş ${req.user.adSoyad} tarafından onaylandı.`,
            detaylar: [{ label: 'Sipariş No', value: (soNo && soNo.siparis_no) || '-' }],
            ekler: onaylandiEkler
        });
        res.json({ ok: true, mesaj: 'Sipariş onaylandı.' });
    } catch (e) { next(e); }
});

app.post('/api/siparis-gonder', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparis_id, ek_alici, ek_mesaj } = req.body;

        // Tedarikçi mail bilgisini al
        const sR = await pool.query(`
            SELECT s.siparis_no, s.para_birimi, s.kdv_orani, s.siparis_tarihi, s.termin_tarihi,
                   s.teslim_adresi, s.odeme_vade, s.teslim_nakliye,
                   t.firma_adi, t.email as tedarikci_email, t.adres as tedarikci_adres
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
        await auditLogla(req, { eylem: 'SEND', tablo: 'satinalma_siparisleri', kayit_id: parseInt(siparis_id), kayit_no: sip.siparis_no, ozet: `Tedarikçiye gönderildi: ${sip.firma_adi || '-'}` });

        // 2) Mail gönder (varsa)
        let mailDurum = 'gönderilmedi';
        if (mailTransporter) {
            try {
                // PDF üret (siparisPDFUret = tek kaynak, yeni şablon + durum bazlı imza)
                const pdfBuffer = await siparisPDFUret(siparis_id, req.user);

                // Mail gövdesi için sipariş özeti (kalemler + toplam)
                const trNum = n => { const v = parseFloat(n) || 0; const p = v.toFixed(2).split('.'); return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1]; };
                const trTarih = d => { if (!d) return '-'; const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`; };
                const para = sip.para_birimi || 'TL';
                const kdv = parseInt(sip.kdv_orani) || 20;
                const kgR = await pool.query(`
                    SELECT sk.siparis_miktari, sk.birim_fiyat,
                           COALESCE(sc.stok_adi, tu.ozel_urun_adi) as urun_adi,
                           COALESCE(sc.birim, tu.ozel_urun_birim) as birim
                    FROM siparis_kalemleri sk
                    JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
                    LEFT JOIN stok_kartlari sc ON tu.stok_kart_id = sc.id
                    WHERE sk.siparis_id = $1 ORDER BY sk.id ASC
                `, [siparis_id]);
                let araT = 0;
                const kalemRows = kgR.rows.map((k, i) => {
                    const t = parseFloat(k.siparis_miktari) * parseFloat(k.birim_fiyat); araT += t;
                    return `<tr>
                        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${i+1}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${k.urun_adi || '-'}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">${trNum(k.siparis_miktari)} ${k.birim || ''}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${trNum(k.birim_fiyat)} ${para}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${trNum(t)} ${para}</td>
                    </tr>`;
                }).join('');
                const genelT = araT * (1 + kdv / 100);
                const bilgiSatir = (l, v) => `<tr><td style="padding:3px 12px 3px 0;color:#6c757d;">${l}</td><td style="padding:3px 0;"><strong>${v}</strong></td></tr>`;

                const aliciListe = [sip.tedarikci_email, ek_alici].filter(Boolean).join(', ');
                const konu = `Sipariş Bildirimi — ${sip.siparis_no} | Aterko`;
                const govdeHTML = `
                    <div style="font-family:Arial,sans-serif;color:#212529;max-width:640px;">
                      <p>Sayın <strong>${sip.firma_adi || 'İlgili Yetkili'}</strong>,</p>
                      <p>Aşağıda detayları bulunan sipariş tarafınıza iletilmiştir. Resmî sipariş formu ekteki PDF'tedir.</p>
                      <table style="border-collapse:collapse;font-size:14px;margin:10px 0 16px;">
                        ${bilgiSatir('Sipariş No', sip.siparis_no)}
                        ${bilgiSatir('Sipariş Tarihi', trTarih(sip.siparis_tarihi))}
                        ${bilgiSatir('Termin Tarihi', trTarih(sip.termin_tarihi))}
                        ${bilgiSatir('Ödeme Koşulu', sip.odeme_vade || '-')}
                        ${bilgiSatir('Nakliye', sip.teslim_nakliye || '-')}
                        ${bilgiSatir('Teslim Adresi', sip.teslim_adresi || sip.tedarikci_adres || '-')}
                      </table>
                      <table style="border-collapse:collapse;font-size:13px;width:100%;">
                        <thead>
                          <tr style="background:#1a1a1a;color:#fff;">
                            <th style="padding:7px 8px;text-align:left;">No</th>
                            <th style="padding:7px 8px;text-align:left;">Ürün / Malzeme</th>
                            <th style="padding:7px 8px;text-align:center;">Miktar</th>
                            <th style="padding:7px 8px;text-align:right;">Birim Fiyat</th>
                            <th style="padding:7px 8px;text-align:right;">Toplam</th>
                          </tr>
                        </thead>
                        <tbody>${kalemRows}</tbody>
                      </table>
                      <p style="text-align:right;font-size:15px;margin:12px 0;">Genel Toplam (KDV %${kdv} dahil): <strong style="color:#ff4c00;">${trNum(genelT)} ${para}</strong></p>
                      ${ek_mesaj ? `<p style="margin-top:12px;padding:10px;background:#fff8e1;border-left:3px solid #ffc107;">${ek_mesaj.replace(/\n/g, '<br>')}</p>` : ''}
                      <p>Termin tarihinden önce teslimat planınızı bildirmenizi rica ederiz. Sorularınız için cevap mailimizden ulaşabilirsiniz.</p>
                      <p style="margin-top:18px;color:#6c757d;font-size:12px;">İyi çalışmalar,<br><strong>Aterko Satın Alma</strong></p>
                    </div>
                `;

                await mailTransporter.sendMail({
                    from: `"Aterko Satın Alma" <${MAIL_FROM_EMAIL}>`,
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
               COALESCE(sc.birim, tu.ozel_urun_birim) as birim,
               tu.aciklama
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
        const aciklamaHtml = k.aciklama ? `<div class="urun-aciklama">${k.aciklama}</div>` : '';
        return `<tr>
            <td class="text-center">${i+1}</td>
            <td>${k.urun_adi || '-'}${aciklamaHtml}</td>
            <td class="text-center">${trNum(k.siparis_miktari)}</td>
            <td class="text-center">${k.birim || ''}</td>
            <td class="text-end">${trNum(k.birim_fiyat)} ${para}</td>
            <td class="text-end">${trNum(tutar)} ${para}</td>
        </tr>`;
    }).join('');
    const kdvTutar = araToplam * kdv / 100;
    const genelToplam = araToplam + kdvTutar;

    const imzaliDurumlar = ['SİPARİŞ ONAYLANDI', 'SİPARİŞ GÖNDERİLDİ', 'KISMİ TESLİM', 'TAM TESLİM', 'TAMAMLANDI', 'TESLİM EDİLDİ'];
    const onayImzaHtml = imzaliDurumlar.includes(s.durum) ? '<img src="images/siparis_imza.png" alt="Onay">' : '';

    const degerler = {
        'SIPARIS_NO': s.siparis_no,
        'SIP_TARIH': trTarih(s.siparis_tarihi),
        'ISTENEN_TARIH': trTarih(s.termin_tarihi),
        'TEDARIKCI': s.tedarikci_adi || '-',
        'ARA_TOPLAM': `${trNum(araToplam)} ${para}`,
        'KDV_ORANI': String(kdv),
        'KDV_TUTARI': `${trNum(kdvTutar)} ${para}`,
        'GENEL_TOPLAM': `${trNum(genelToplam)} ${para}`,
        'SIP_ACIKLAMA': s.siparis_notu || '-',
        'EK_DOSYA': '-',
        'ODEME': s.odeme_vade || '-',
        'NAKLIYE': s.teslim_nakliye || '-',
        'TESLIM_ADRESI': s.teslim_adresi || s.tedarikci_adres || '-',
        'SATINALMA_YETKILISI': s.olusturan_adsoyad || (user && user.adSoyad) || '-'
    };

    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'templates', 'siparis.html'), 'utf8');
    html = html.replace('{{KALEM_SATIRLARI}}', kalemSatirlari);
    html = html.replace('{{ONAY_IMZA}}', onayImzaHtml);
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
        // Etkilenen talepleri bul
        const etkR = await client.query(
            `SELECT DISTINCT tu.talep_id FROM siparis_kalemleri sk
             JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
             WHERE sk.siparis_id = $1`, [siparis_id]
        );
        // Siparişin kalemlerine bağlı talep ürünlerini ONAYLANDI durumuna geri çevir
        await client.query(`
            UPDATE talep_urunleri SET durum='ONAYLANDI'
            WHERE id IN (SELECT talep_urun_id FROM siparis_kalemleri WHERE siparis_id=$1)
        `, [siparis_id]);
        await client.query("UPDATE satinalma_siparisleri SET durum='İPTAL' WHERE id=$1", [siparis_id]);
        // Etkilenen taleplerin başlık durumunu yeniden türet
        for (const row of etkR.rows) {
            await talepBaslikDurumGuncelle(client, row.talep_id);
        }
        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'CANCEL', tablo: 'satinalma_siparisleri', kayit_id: siparis_id,
            ozet: 'Sipariş iptal edildi'
        });
        const siNo = (await pool.query("SELECT siparis_no FROM satinalma_siparisleri WHERE id=$1", [siparis_id])).rows[0];
        await bildirimGonder('SIPARIS_IPTAL', {
            siparisId: siparis_id,
            konu: `Aterko Workspace - Sipariş iptal edildi (${(siNo && siNo.siparis_no) || ''})`,
            baslik: 'Sipariş iptal edildi',
            mesaj: `${(siNo && siNo.siparis_no) || ''} numaralı sipariş ${req.user.adSoyad} tarafından iptal edildi; bağlı talepler geri alındı.`,
            detaylar: [{ label: 'Sipariş No', value: (siNo && siNo.siparis_no) || '-' }]
        });
        res.json({ ok: true, mesaj: 'Sipariş iptal edildi, talepler geri alındı.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// ============================================================================
// FATURA ONAY SİSTEMİ
// ============================================================================
// Siparişe fatura no(ları) ekle ve onayla
// Body: { siparis_id, fatura_nolari: [], notlar }
app.post('/api/siparis-fatura-onayla', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparis_id, fatura_nolari, notlar } = req.body;
        if (!siparis_id) return res.json({ ok: false, hata: 'Sipariş ID gerekli.' });
        const liste = Array.isArray(fatura_nolari)
            ? fatura_nolari.map(s => String(s).trim()).filter(Boolean)
            : [];

        // Sipariş durumunu kontrol — sadece TAM/KISMI TESLIM siparişler için fatura onay
        const sR = await pool.query('SELECT durum, siparis_no FROM satinalma_siparisleri WHERE id=$1', [siparis_id]);
        if (sR.rowCount === 0) return res.json({ ok: false, hata: 'Sipariş bulunamadı.' });
        const durum = sR.rows[0].durum;
        if (!['TAM TESLİM', 'KISMİ TESLİM', 'TAMAMLANDI'].includes(durum)) {
            return res.json({ ok: false, hata: `Bu siparişe fatura ekleyebilmek için en az kısmi teslim olmalı (şu an: ${durum}).` });
        }

        const yeniDurum = liste.length > 0 ? 'ONAYLI' : 'YOK';
        await pool.query(`
            UPDATE satinalma_siparisleri SET
                fatura_nolari = $1,
                fatura_onay_durumu = $2,
                fatura_onay_tarihi = ${liste.length > 0 ? 'NOW()' : 'NULL'},
                fatura_onaylayan_email = $3,
                fatura_notu = $4
            WHERE id = $5
        `, [liste, yeniDurum, liste.length > 0 ? req.user.email : null, notlar || null, siparis_id]);

        await auditLogla(req, {
            eylem: 'UPDATE', tablo: 'satinalma_siparisleri', kayit_id: siparis_id,
            kayit_no: sR.rows[0].siparis_no,
            ozet: liste.length > 0
                ? `Fatura onaylandı: ${liste.join(', ')}`
                : 'Fatura onayı kaldırıldı'
        });
        if (liste.length > 0) await bildirimGonder('FATURA_ONAYLANDI', {
            siparisId: siparis_id,
            konu: `Aterko Workspace - Fatura onaylandı (${sR.rows[0].siparis_no})`,
            baslik: 'Fatura onaylandı',
            mesaj: `${sR.rows[0].siparis_no} numaralı siparişin faturası ${req.user.adSoyad} tarafından onaylandı.`,
            detaylar: [{ label: 'Sipariş No', value: sR.rows[0].siparis_no }, { label: 'Fatura No', value: liste.join(', ') }]
        });
        res.json({ ok: true, mesaj: liste.length > 0 ? `${liste.length} fatura onaylandı.` : 'Fatura onayı kaldırıldı.' });
    } catch (e) { next(e); }
});

// Fatura bekleyen siparişler (TAM/KISMI teslim + fatura_onay_durumu = YOK)
app.get('/api/fatura-bekleyen-siparisler', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT s.id, s.siparis_no, s.durum, s.fatura_onay_durumu, s.fatura_nolari,
                   s.termin_tarihi, s.para_birimi,
                   t.firma_adi as tedarikci_adi,
                   COALESCE(SUM(sk.birim_fiyat * sk.siparis_miktari),0)::numeric as toplam_tutar
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
            LEFT JOIN siparis_kalemleri sk ON sk.siparis_id=s.id
            WHERE s.durum IN ('TAM TESLİM', 'KISMİ TESLİM', 'TAMAMLANDI')
              AND COALESCE(s.fatura_onay_durumu, 'YOK') = 'YOK'
              AND COALESCE(s.arsiv, false) = false
            GROUP BY s.id, t.firma_adi
            ORDER BY s.id DESC
        `);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// ============================================================================
// TEDARİKÇİ FİYAT KARŞILAŞTIRMA
// ============================================================================
// Bir stok kartı için tedarikçi başına son fiyat geçmişi
app.get('/api/urun-fiyat-gecmisi/:stokKartId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT
                t.id as tedarikci_id, t.firma_adi as tedarikci_adi,
                s.siparis_no, s.siparis_tarihi, s.para_birimi,
                sk.birim_fiyat, sk.siparis_miktari
            FROM siparis_kalemleri sk
            JOIN satinalma_siparisleri s ON sk.siparis_id=s.id
            LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
            JOIN talep_urunleri tu ON sk.talep_urun_id=tu.id
            WHERE tu.stok_kart_id = $1
              AND COALESCE(sk.birim_fiyat,0) > 0
              AND s.durum NOT IN ('İPTAL')
              AND COALESCE(s.arsiv, false) = false
            ORDER BY s.siparis_tarihi DESC, s.id DESC
            LIMIT 50
        `, [req.params.stokKartId]);

        // Tedarikçi başına özet de hesapla
        const tedarikciOzet = {};
        r.rows.forEach(row => {
            const k = row.tedarikci_id || 0;
            if (!tedarikciOzet[k]) {
                tedarikciOzet[k] = {
                    tedarikci_id: row.tedarikci_id,
                    tedarikci_adi: row.tedarikci_adi || '-',
                    para_birimi: row.para_birimi,
                    son_fiyat: parseFloat(row.birim_fiyat),
                    son_tarih: row.siparis_tarihi,
                    fiyatlar: [],
                    siparis_sayisi: 0
                };
            }
            tedarikciOzet[k].fiyatlar.push(parseFloat(row.birim_fiyat));
            tedarikciOzet[k].siparis_sayisi++;
        });
        // Min, max, ortalama
        Object.values(tedarikciOzet).forEach(o => {
            o.min_fiyat = Math.min(...o.fiyatlar);
            o.max_fiyat = Math.max(...o.fiyatlar);
            o.ortalama = o.fiyatlar.reduce((a,b)=>a+b,0) / o.fiyatlar.length;
            delete o.fiyatlar;
        });

        res.json({ ok: true, gecmis: r.rows, tedarikci_ozet: Object.values(tedarikciOzet) });
    } catch (e) { next(e); }
});

app.post('/api/siparis-arsivle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const siparis_id = req.body.siparis_id;
        await client.query("UPDATE satinalma_siparisleri SET arsiv=true WHERE id=$1", [siparis_id]);
        // Bu siparişin bağlı olduğu talepleri kontrol et: tüm kalemleri kapandıysa talep de arşive gitsin
        const tR = await client.query(`
            SELECT DISTINCT tu.talep_id FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            WHERE sk.siparis_id = $1
        `, [siparis_id]);
        let arsivlenenTalep = 0;
        for (const row of tR.rows) {
            if (await talepArsivSenkron(client, row.talep_id)) arsivlenenTalep++;
        }
        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'ARCHIVE', tablo: 'satinalma_siparisleri', kayit_id: siparis_id,
            ozet: arsivlenenTalep ? `Sipariş arşivlendi (+${arsivlenenTalep} talep tamamlandı)` : 'Sipariş arşivlendi'
        });
        res.json({
            ok: true,
            mesaj: arsivlenenTalep
                ? `Sipariş arşivlendi. Tüm kalemleri tamamlanan ${arsivlenenTalep} talep de arşive alındı.`
                : 'Sipariş arşivlendi.'
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
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
        await auditLogla(req, { eylem: 'REVERT', tablo: 'satinalma_siparisleri', kayit_id: parseInt(siparis_id), ozet: `Geri alındı → ${hedef}` });
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

        // 5) Etkilenen taleplerin başlık durumunu kalemlerinden yeniden türet
        const etkilenenTalepIds = [...new Set(skR.rows.map(r => r.talep_id))];
        for (const tId of etkilenenTalepIds) {
            await talepBaslikDurumGuncelle(client, tId);
        }

        await client.query('COMMIT');
        res.json({
            ok: true,
            mesaj: `Sipariş silindi. Talep ve kalemler İŞLEME ALINDI durumuna döndü${birlesen > 0 ? ` ve ${birlesen} bölünmüş kalem birleştirildi` : ''}.`
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

                // Sipariş kaleminin birim fiyatını al (maliyet hesabı için)
                const fr = await client.query(`
                    SELECT sk2.birim_fiyat, COALESCE(s2.para_birimi,'TL') as para_birimi
                    FROM siparis_kalemleri sk2
                    JOIN satinalma_siparisleri s2 ON sk2.siparis_id=s2.id
                    WHERE sk2.id=$1
                `, [kalem.siparis_kalem_id]);
                const birimFiyat = parseFloat(fr.rows[0]?.birim_fiyat) || 0;
                const paraBirimi = fr.rows[0]?.para_birimi || 'TL';

                // Stok hareketine snapshot olarak birim_maliyet yaz
                await client.query(`
                    INSERT INTO stok_hareketleri
                    (stok_kart_id, tip, miktar, proje_id, depo_id, aciklama, kullanici_email, kullanici_adsoyad, birim_maliyet)
                    VALUES ($1, 'Giriş', $2, $3, $4, $5, $6, $7, $8)
                `, [kalem.stok_kart_id, teslimMiktar, projeId, depo_id || null, aciklama,
                    req.user.email, req.user.adSoyad, birimFiyat]);

                // Mevcut stok kartı bilgilerini al
                const sk = await client.query('SELECT guncel_stok_miktari, ortalama_alis_fiyati, maliyet_para_birimi FROM stok_kartlari WHERE id=$1', [kalem.stok_kart_id]);
                const eski = sk.rows[0] || { guncel_stok_miktari: 0, ortalama_alis_fiyati: 0, maliyet_para_birimi: 'TL' };
                const eskiStok = parseFloat(eski.guncel_stok_miktari) || 0;
                const eskiFiyat = parseFloat(eski.ortalama_alis_fiyati) || 0;
                const eskiPB = eski.maliyet_para_birimi || 'TL';

                // AĞIRLIKLI ORTALAMA: sadece aynı para biriminde anlamlı
                // Para birimi farklıysa son alış fiyatını kullan (basit yaklaşım)
                let yeniFiyat = eskiFiyat;
                if (birimFiyat > 0) {
                    if (eskiStok <= 0 || eskiFiyat <= 0 || eskiPB !== paraBirimi) {
                        // İlk alış veya para birimi değişti → yeni fiyat
                        yeniFiyat = birimFiyat;
                    } else {
                        // Ağırlıklı ortalama
                        yeniFiyat = ((eskiStok * eskiFiyat) + (teslimMiktar * birimFiyat)) / (eskiStok + teslimMiktar);
                    }
                }

                // Stok + maliyet güncelle
                await client.query(`
                    UPDATE stok_kartlari SET
                        guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1,
                        ortalama_alis_fiyati = $2,
                        maliyet_para_birimi = $3
                    WHERE id = $4
                `, [teslimMiktar, yeniFiyat, paraBirimi, kalem.stok_kart_id]);
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
        await auditLogla(req, { eylem: 'RECEIVE', tablo: 'satinalma_siparisleri', kayit_id: parseInt(siparis_id), kayit_no: siparisBilgi.siparis_no, ozet: `Mal kabul (${yeniSiparisDurum}) — ${kalemler.length} kalem` });
        // Bildirim: MUHASEBE'ye + malı bekleyen talep sahibine
        const teR = await pool.query(`SELECT DISTINCT t.talep_eden FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id=tu.id JOIN satinalma_talepleri t ON tu.talep_id=t.id
            WHERE sk.siparis_id=$1 AND t.talep_eden IS NOT NULL`, [siparis_id]);
        await bildirimGonder('MAL_KABUL', {
            siparisId: siparis_id,
            konu: `Aterko Workspace - Mal kabul yapıldı (${siparisBilgi.siparis_no})`,
            baslik: 'Mal kabul / teslim alındı',
            mesaj: `${siparisBilgi.siparis_no} numaralı siparişte mal kabul yapıldı${siparisBilgi.tedarikci_adi ? ' (' + siparisBilgi.tedarikci_adi + ')' : ''}. Sipariş durumu: ${yeniSiparisDurum}.`,
            detaylar: [
                { label: 'Sipariş No', value: siparisBilgi.siparis_no },
                { label: 'Tedarikçi', value: siparisBilgi.tedarikci_adi || '-' },
                { label: 'Durum', value: yeniSiparisDurum }
            ],
            talepEdenAd: teR.rows[0] && teR.rows[0].talep_eden
        });
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

// --- TALEP DOSYALARI (sipariş dosya sistemiyle aynı mekanizma) ---
app.get('/api/talep-dosyalari/:talepId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query('SELECT * FROM talep_dosyalari WHERE talep_id=$1 ORDER BY kayit_tarihi DESC', [req.params.talepId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

app.post('/api/talep-dosya-yukle/:talepId', yetkiKontrol, dosyaUpload.single('dosya'), async (req, res, next) => {
    if (!supabaseStorage) return res.status(500).json({ ok: false, hata: 'Storage yapılandırılmamış.' });
    try {
        const { talepId } = req.params;
        if (!req.file) return res.json({ ok: false, hata: 'Dosya bulunamadı.' });
        const tR = await pool.query('SELECT talep_no FROM satinalma_talepleri WHERE id=$1', [talepId]);
        if (tR.rowCount === 0) return res.json({ ok: false, hata: 'Talep bulunamadı.' });
        const talepNo = tR.rows[0].talep_no;
        const safeName = req.file.originalname.replace(/[^A-Za-z0-9._\-]/g, '_');
        const storagePath = `talep/${talepNo}/${Date.now()}-${safeName}`;
        const { error: upErr } = await supabaseStorage.storage
            .from(SIPARIS_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
        if (upErr) return res.json({ ok: false, hata: 'Yükleme hatası: ' + upErr.message });
        const { data: urlData } = supabaseStorage.storage.from(SIPARIS_BUCKET).getPublicUrl(storagePath);
        const r = await pool.query(`
            INSERT INTO talep_dosyalari
            (talep_id, dosya_adi, storage_path, public_url, mime_type, boyut, yukleyen_adsoyad, yukleyen_email)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [talepId, req.file.originalname, storagePath, urlData.publicUrl, req.file.mimetype, req.file.size, req.user.adSoyad, req.user.email]);
        res.json({ ok: true, mesaj: 'Dosya yüklendi.', data: r.rows[0] });
    } catch (e) { console.error('Talep dosya yükleme:', e); next(e); }
});

app.delete('/api/talep-dosya-sil/:dosyaId', yetkiKontrol, async (req, res, next) => {
    if (!supabaseStorage) return res.status(500).json({ ok: false, hata: 'Storage yapılandırılmamış.' });
    try {
        const r = await pool.query('SELECT storage_path FROM talep_dosyalari WHERE id=$1', [req.params.dosyaId]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Dosya bulunamadı.' });
        const { error: delErr } = await supabaseStorage.storage.from(SIPARIS_BUCKET).remove([r.rows[0].storage_path]);
        if (delErr) console.warn('Storage sil uyarı:', delErr.message);
        await pool.query('DELETE FROM talep_dosyalari WHERE id=$1', [req.params.dosyaId]);
        res.json({ ok: true, mesaj: 'Dosya silindi.' });
    } catch (e) { next(e); }
});

// Sipariş PDF üret ve indir
const { renderToPDF: pdfRender } = require('./lib/pdf-generator');
app.get('/api/siparis-pdf/:siparisId', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparisId } = req.params;
        const nR = await pool.query('SELECT siparis_no FROM satinalma_siparisleri WHERE id=$1', [siparisId]);
        if (nR.rowCount === 0) return res.status(404).json({ ok: false, hata: 'Sipariş bulunamadı.' });

        // Tek kaynak: siparisPDFUret (siparis-gonder ve bildirim ekleri de aynı helper'ı kullanır)
        const pdfBuffer = await siparisPDFUret(siparisId, req.user);

        const dosyaAdi = `Siparis-${nR.rows[0].siparis_no}.pdf`;
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

// ============================================================================
// BİLDİRİM SİSTEMİ (D-1)
// ============================================================================

// Sistem içi bildirim oluştur (diğer endpoint'lerden çağırılır)
// opts: { tip, link, kaynak_modul, referans_id }
async function bildirimOlustur(email, baslik, mesaj, opts = {}) {
    try {
        await pool.query(`
            INSERT INTO bildirimler (kullanici_email, tip, baslik, mesaj, link, kaynak_modul, referans_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [email, opts.tip || 'INFO', baslik, mesaj || null, opts.link || null,
            opts.kaynak_modul || null, opts.referans_id || null]);
    } catch (e) {
        console.warn('Bildirim oluşturulamadı:', e.message);
    }
}

// Çoklu hedef için (örn. tüm kullanıcılara) bildirim
async function bildirimOlusturToplu(emailler, baslik, mesaj, opts = {}) {
    for (const email of emailler) {
        await bildirimOlustur(email, baslik, mesaj, opts);
    }
}

// ============================================================================
// AUDIT LOG HELPER (D-4)
// opts: { eylem, tablo, kayit_id, kayit_no, ozet, eski_veri, yeni_veri }
// ============================================================================
async function auditLogla(req, opts) {
    try {
        await pool.query(`
            INSERT INTO audit_log
              (kullanici_email, kullanici_adsoyad, eylem, tablo, kayit_id, kayit_no, ozet, eski_veri, yeni_veri, ip_adres)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
            req?.user?.email || null,
            req?.user?.adSoyad || null,
            opts.eylem,
            opts.tablo,
            opts.kayit_id || null,
            opts.kayit_no || null,
            opts.ozet || null,
            opts.eski_veri ? JSON.stringify(opts.eski_veri) : null,
            opts.yeni_veri ? JSON.stringify(opts.yeni_veri) : null,
            req?.ip || req?.headers?.['x-forwarded-for'] || null
        ]);
    } catch (e) {
        console.warn('Audit log hatası:', e.message);
    }
}

// Audit log listesi (sadece ADMIN)
app.get('/api/audit-log', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.status(403).json({ ok: false, hata: 'Sadece ADMIN erişebilir.' });
    }
    try {
        const { tablo, kullanici, eylem, baslangic, bitis, kayit_id, limit } = req.query;
        const sart = []; const params = [];
        if (tablo) { params.push(tablo); sart.push(`tablo = $${params.length}`); }
        if (kullanici) { params.push('%' + kullanici + '%'); sart.push(`(kullanici_email ILIKE $${params.length} OR kullanici_adsoyad ILIKE $${params.length})`); }
        if (eylem) { params.push(eylem); sart.push(`eylem = $${params.length}`); }
        if (kayit_id) { params.push(parseInt(kayit_id)); sart.push(`kayit_id = $${params.length}`); }
        if (baslangic) { params.push(baslangic); sart.push(`kayit_tarihi >= $${params.length}::date`); }
        if (bitis) { params.push(bitis); sart.push(`kayit_tarihi < ($${params.length}::date + INTERVAL '1 day')`); }

        const lim = Math.min(parseInt(limit) || 200, 1000);
        const sartSQL = sart.length > 0 ? 'WHERE ' + sart.join(' AND ') : '';
        const r = await pool.query(`
            SELECT id, kullanici_email, kullanici_adsoyad, eylem, tablo, kayit_id, kayit_no,
                   ozet, eski_veri, yeni_veri, ip_adres, kayit_tarihi
            FROM audit_log
            ${sartSQL}
            ORDER BY kayit_tarihi DESC, id DESC
            LIMIT ${lim}
        `, params);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Satınalma durum zaman çizelgesi (timeline) — sipariş/talep detayında "kim, ne zaman, ne yaptı"
// (audit_log'dan; satınalmaya erişimi olan herkes görebilir — şeffaflık/suistimal önleme)
app.get('/api/satinalma-timeline/:tur/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const tur = req.params.tur;
        const id = parseInt(req.params.id);
        const tablo = tur === 'siparis' ? 'satinalma_siparisleri'
                    : tur === 'talep' ? 'satinalma_talepleri' : null;
        if (!tablo) return res.json({ ok: false, hata: 'Geçersiz tür.' });

        const auditR = await pool.query(`
            SELECT eylem, ozet, kullanici_adsoyad, kullanici_email, kayit_tarihi
            FROM audit_log WHERE tablo=$1 AND kayit_id=$2
            ORDER BY kayit_tarihi ASC, id ASC
        `, [tablo, id]);
        const olaylar = auditR.rows.map(r => ({ ...r, sentetik: false }));
        const varEylem = new Set(olaylar.map(o => o.eylem));
        // Tablo tarih damgalarından eksik aşamaları doldur (audit öncesi/geçmiş kayıtlar için)
        const ekle = (eylem, tarih, ozet) => {
            if (tarih && !varEylem.has(eylem)) {
                olaylar.push({ eylem, ozet, kullanici_adsoyad: null, kullanici_email: null, kayit_tarihi: tarih, sentetik: true });
                varEylem.add(eylem);
            }
        };
        if (tur === 'siparis') {
            const s = (await pool.query(`
                SELECT s.siparis_tarihi, s.onaylanma_tarihi, s.gonderim_tarihi,
                       (SELECT MAX(son_teslim_tarihi) FROM siparis_kalemleri WHERE siparis_id=s.id) as teslim_tarihi
                FROM satinalma_siparisleri s WHERE s.id=$1`, [id])).rows[0];
            if (s) {
                ekle('CREATE',  s.siparis_tarihi,    'Sipariş oluşturuldu');
                ekle('APPROVE', s.onaylanma_tarihi,  'Sipariş onaylandı');
                ekle('SEND',    s.gonderim_tarihi,   'Tedarikçiye gönderildi');
                ekle('RECEIVE', s.teslim_tarihi,     'Mal kabul yapıldı');
            }
        } else {
            const t = (await pool.query(`SELECT kayit_tarihi, onay_tarihi FROM satinalma_talepleri WHERE id=$1`, [id])).rows[0];
            if (t) {
                ekle('CREATE',  t.kayit_tarihi, 'Talep oluşturuldu');
                ekle('APPROVE', t.onay_tarihi,  'Talep onaylandı');
            }
        }
        olaylar.sort((a, b) => new Date(a.kayit_tarihi) - new Date(b.kayit_tarihi));
        res.json({ ok: true, data: olaylar });
    } catch (e) { next(e); }
});

// ============================================================================
// HIZLI ARAMA (D-5) — Cmd+K
// ============================================================================
app.get('/api/quick-search', yetkiKontrol, async (req, res, next) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ ok: true, sonuclar: [] });
        const like = '%' + q + '%';

        const [projeler, talepler, siparisler, tedarikciler, stoklar, teslimatlar] = await Promise.all([
            // Projeler (proje_kodu, müşteri, ad)
            pool.query(`
                SELECT id, proje_kodu, musteri_adi, proje_adi
                FROM projeler
                WHERE proje_kodu ILIKE $1 OR musteri_adi ILIKE $1 OR proje_adi ILIKE $1
                ORDER BY id DESC LIMIT 8
            `, [like]),
            // Satınalma talepleri
            pool.query(`
                SELECT t.id, t.talep_no, t.talep_eden, t.durum, p.proje_kodu, p.musteri_adi
                FROM satinalma_talepleri t
                LEFT JOIN projeler p ON t.proje_id=p.id
                WHERE t.talep_no ILIKE $1 OR t.talep_eden ILIKE $1
                ORDER BY t.id DESC LIMIT 8
            `, [like]),
            // Siparişler
            pool.query(`
                SELECT s.id, s.siparis_no, s.durum, t.firma_adi as tedarikci
                FROM satinalma_siparisleri s
                LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
                WHERE s.siparis_no ILIKE $1 OR t.firma_adi ILIKE $1
                ORDER BY s.id DESC LIMIT 8
            `, [like]),
            // Tedarikçiler
            pool.query(`
                SELECT id, firma_adi, email, yetkili_kisi
                FROM tedarikciler
                WHERE firma_adi ILIKE $1 OR yetkili_kisi ILIKE $1 OR email ILIKE $1
                ORDER BY firma_adi ASC LIMIT 8
            `, [like]),
            // Stok kartları
            pool.query(`
                SELECT id, stok_kodu, stok_adi, stok_tipi, guncel_stok_miktari, birim
                FROM stok_kartlari
                WHERE stok_kodu ILIKE $1 OR stok_adi ILIKE $1 OR kategori ILIKE $1
                ORDER BY stok_kodu ASC LIMIT 8
            `, [like]),
            // Teslimatlar (bina)
            pool.query(`
                SELECT pt.id, pt.bina_adi, pt.bina_turu, pt.urun_listesi_yayin_durumu,
                       p.proje_kodu, p.musteri_adi
                FROM proje_teslimatlari pt
                JOIN projeler p ON pt.proje_id=p.id
                WHERE pt.bina_adi ILIKE $1
                ORDER BY pt.id DESC LIMIT 8
            `, [like])
        ]);

        const sonuclar = [];
        projeler.rows.forEach(p => sonuclar.push({
            tip: 'proje', tipAd: '🏗️ Proje', tab: 'projeler',
            baslik: `${p.proje_kodu} — ${p.musteri_adi || ''}`,
            altMetin: p.proje_adi,
            id: p.id
        }));
        talepler.rows.forEach(t => sonuclar.push({
            tip: 'talep', tipAd: '🛒 Talep', tab: 'satinalma', altTab: 'talepler',
            baslik: t.talep_no,
            altMetin: `${t.proje_kodu || '-'} • ${t.talep_eden || ''} • ${t.durum}`,
            id: t.id
        }));
        siparisler.rows.forEach(s => sonuclar.push({
            tip: 'siparis', tipAd: '📦 Sipariş', tab: 'satinalma', altTab: 'siparisler',
            baslik: s.siparis_no,
            altMetin: `${s.tedarikci || '-'} • ${s.durum}`,
            id: s.id
        }));
        tedarikciler.rows.forEach(t => sonuclar.push({
            tip: 'tedarikci', tipAd: '🏢 Tedarikçi', tab: 'tedarikci',
            baslik: t.firma_adi,
            altMetin: `${t.yetkili_kisi || ''} ${t.email ? '• ' + t.email : ''}`,
            id: t.id
        }));
        stoklar.rows.forEach(s => sonuclar.push({
            tip: 'stok', tipAd: '📦 Stok', tab: 'stok',
            baslik: `${s.stok_kodu} — ${s.stok_adi}`,
            altMetin: `${s.stok_tipi || ''} • Mevcut: ${s.guncel_stok_miktari || 0} ${s.birim || ''}`,
            id: s.id
        }));
        teslimatlar.rows.forEach(t => sonuclar.push({
            tip: 'teslimat', tipAd: '🏗️ Teslimat', tab: 'urun-listesi',
            baslik: t.bina_adi,
            altMetin: `${t.proje_kodu} / ${t.musteri_adi || ''} • ${t.bina_turu || ''} • Liste: ${t.urun_listesi_yayin_durumu || 'TASLAK'}`,
            id: t.id
        }));

        res.json({ ok: true, sonuclar, toplam: sonuclar.length });
    } catch (e) { next(e); }
});

// ============================================================================
// ÜRÜN LİSTESİ — KOPYALA / ŞABLON / IMPORT / VERSİYON
// ============================================================================

// Kopya kaynağı olabilecek teslimatların listesi (içinde ürün olan)
// Şablonlar üstte gösterilir, sonra son yayınlanan teslimatlar
app.get('/api/urun-listesi-kopya-kaynaklari', yetkiKontrol, async (req, res, next) => {
    try {
        const { bina_turu } = req.query;
        const turFilter = bina_turu ? `AND pt.bina_turu = $1` : '';
        const params = bina_turu ? [bina_turu] : [];

        const q = `
            SELECT pt.id, pt.bina_adi, pt.bina_turu, pt.bina_tipi, pt.buyukluk_m2,
                   pt.is_sablon, pt.sablon_etiketi,
                   pt.urun_listesi_yayin_durumu,
                   p.proje_kodu, p.musteri_adi,
                   (SELECT COUNT(*)::int FROM teslimat_urunleri WHERE teslimat_id=pt.id) as kalem_sayisi
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id=p.id
            WHERE EXISTS (SELECT 1 FROM teslimat_urunleri WHERE teslimat_id=pt.id)
              ${turFilter}
            ORDER BY pt.is_sablon DESC,
                     CASE WHEN pt.urun_listesi_yayin_durumu='YAYINDA' THEN 0 ELSE 1 END,
                     pt.id DESC
            LIMIT 100
        `;
        const r = await pool.query(q, params);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Bir teslimattan diğerine ürünleri kopyala
// Body: { kaynak_id, hedef_id, mevcut_listeyi_temizle (bool), kalem_idler (opsiyonel — null=hepsi) }
app.post('/api/urun-listesi-kopyala', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kaynak_id, hedef_id, mevcut_listeyi_temizle, kalem_idler } = req.body;
        if (!kaynak_id || !hedef_id) return res.json({ ok: false, hata: 'Kaynak ve hedef gerekli.' });
        if (kaynak_id === hedef_id) return res.json({ ok: false, hata: 'Kaynak ve hedef aynı teslimat olamaz.' });

        // Hedef teslimat yayın durumunda mı?
        const h = await client.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [hedef_id]);
        if (h.rowCount === 0) return res.json({ ok: false, hata: 'Hedef teslimat bulunamadı.' });
        const hedefDurum = h.rows[0].urun_listesi_yayin_durumu;
        if (hedefDurum === 'ONAY BEKLİYOR') return res.json({ ok: false, hata: 'Onay bekleyen listeye kopyalama yapılamaz.' });
        const yayinda = hedefDurum === 'YAYINDA';

        // Mevcut listeyi temizle (sadece taslakta + bağlı talebi olmayan kalemler)
        if (mevcut_listeyi_temizle && !yayinda) {
            await client.query(`
                DELETE FROM teslimat_urunleri
                WHERE teslimat_id=$1 AND talep_urun_id IS NULL
            `, [hedef_id]);
        }

        // Kaynak kalemlerini al
        const idFilter = Array.isArray(kalem_idler) && kalem_idler.length > 0
            ? `AND id = ANY($2::int[])` : '';
        const kaynakParams = idFilter ? [kaynak_id, kalem_idler] : [kaynak_id];
        const kaynakR = await client.query(`
            SELECT stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, sira
            FROM teslimat_urunleri WHERE teslimat_id=$1 ${idFilter}
            ORDER BY sira ASC, id ASC
        `, kaynakParams);

        // Hedefe ekle (yayındaysa ek_urun=true)
        let eklendi = 0;
        for (const k of kaynakR.rows) {
            await client.query(`
                INSERT INTO teslimat_urunleri
                  (teslimat_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama,
                   ekleyen_kullanici, kullanim_amaci, durum, is_ek_urun, ek_urun_onay_durumu)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'URETIM','TASLAK',$8,$9)
            `, [hedef_id, k.stok_kart_id || null, k.ozel_urun_adi || null, k.ozel_urun_birim || null,
                k.miktar, k.aciklama || null, req.user.adSoyad, yayinda, yayinda ? 'ONAY BEKLİYOR' : null]);
            eklendi++;
        }

        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'CREATE', tablo: 'teslimat_urunleri',
            kayit_id: hedef_id,
            ozet: `Kopyalama: kaynak teslimat #${kaynak_id} → hedef #${hedef_id} (${eklendi} kalem${yayinda ? ', ek ürün onay bekliyor' : ''})`
        });
        res.json({
            ok: true,
            mesaj: `${eklendi} kalem kopyalandı.` + (yayinda ? ' Yayında olduğu için ek ürün olarak işaretlendi, ADMIN onayını bekliyor.' : '')
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Teslimatı şablon olarak işaretle / kaldır
app.post('/api/teslimat-sablon-isaretle', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, is_sablon, sablon_etiketi } = req.body;
        await pool.query(`
            UPDATE proje_teslimatlari SET is_sablon=$1, sablon_etiketi=$2 WHERE id=$3
        `, [!!is_sablon, sablon_etiketi || null, teslimat_id]);
        await auditLogla(req, {
            eylem: 'UPDATE', tablo: 'proje_teslimatlari', kayit_id: teslimat_id,
            ozet: is_sablon ? `Şablon olarak işaretlendi: ${sablon_etiketi || ''}` : 'Şablon işareti kaldırıldı'
        });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Excel/CSV import — kalemleri toplu ekle
// Body: { teslimat_id, kalemler: [{stok_kodu, ozel_urun_adi, miktar, birim, aciklama}] }
app.post('/api/urun-listesi-import', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { teslimat_id, kalemler } = req.body;
        if (!teslimat_id || !Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Teslimat ve kalem listesi gerekli.' });
        }

        const h = await client.query('SELECT urun_listesi_yayin_durumu FROM proje_teslimatlari WHERE id=$1', [teslimat_id]);
        if (h.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const yayinDurum = h.rows[0].urun_listesi_yayin_durumu;
        if (yayinDurum === 'ONAY BEKLİYOR') return res.json({ ok: false, hata: 'Onay bekleyen listeye import yapılamaz.' });
        const yayinda = yayinDurum === 'YAYINDA';

        let basarili = 0, eslesmeyen = 0;
        const eslesmeyenler = [];

        for (const k of kalemler) {
            const miktar = parseFloat(k.miktar);
            if (!(miktar > 0)) continue;

            let stok_kart_id = null;
            // Stok kodu ile eşleştir
            if (k.stok_kodu) {
                const sR = await client.query('SELECT id FROM stok_kartlari WHERE stok_kodu = $1', [k.stok_kodu.trim()]);
                if (sR.rowCount > 0) stok_kart_id = sR.rows[0].id;
            }

            if (!stok_kart_id && !k.ozel_urun_adi) {
                eslesmeyen++;
                eslesmeyenler.push(`Stok kodu '${k.stok_kodu||''}' eşleşmedi (özel ad yok)`);
                continue;
            }

            await client.query(`
                INSERT INTO teslimat_urunleri
                  (teslimat_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama,
                   ekleyen_kullanici, kullanim_amaci, durum, is_ek_urun, ek_urun_onay_durumu)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'URETIM','TASLAK',$8,$9)
            `, [teslimat_id, stok_kart_id, stok_kart_id ? null : (k.ozel_urun_adi || '').trim(),
                stok_kart_id ? null : (k.birim || 'adet'),
                miktar, k.aciklama || null,
                req.user.adSoyad, yayinda, yayinda ? 'ONAY BEKLİYOR' : null]);
            basarili++;
        }

        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'CREATE', tablo: 'teslimat_urunleri', kayit_id: teslimat_id,
            ozet: `Toplu import: ${basarili} kalem eklendi, ${eslesmeyen} eşleşmedi`
        });
        res.json({
            ok: true,
            mesaj: `${basarili} kalem eklendi.` + (eslesmeyen > 0 ? ` ${eslesmeyen} kalem eşleşmedi.` : ''),
            basarili, eslesmeyen, eslesmeyenler
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Versiyon snapshot al (manuel veya otomatik tetikleyici çağırır)
async function urunListesiVersiyonAl(teslimat_id, etiket, ozet, req) {
    try {
        const r = await pool.query(`
            SELECT id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama,
                   is_ek_urun, ek_urun_onay_durumu, sira
            FROM teslimat_urunleri WHERE teslimat_id=$1
            ORDER BY sira, id
        `, [teslimat_id]);
        await pool.query(`
            INSERT INTO urun_listesi_versiyonlari (teslimat_id, etiket, kalemler_snapshot, ozet, kullanici_email, kullanici_adsoyad)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [teslimat_id, etiket, JSON.stringify(r.rows), ozet || null,
            req?.user?.email || null, req?.user?.adSoyad || null]);
    } catch (e) {
        console.warn('Versiyon snapshot hatası:', e.message);
    }
}

// Versiyon listesi
app.get('/api/urun-listesi-versiyonlar/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT id, etiket, ozet, kullanici_email, kullanici_adsoyad, kayit_tarihi,
                   jsonb_array_length(kalemler_snapshot) as kalem_sayisi
            FROM urun_listesi_versiyonlari
            WHERE teslimat_id=$1
            ORDER BY kayit_tarihi DESC, id DESC
        `, [req.params.teslimatId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Tek versiyonun detayı (snapshot ile)
app.get('/api/urun-listesi-versiyon/:versiyonId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT v.*, pt.bina_adi, p.proje_kodu, p.musteri_adi
            FROM urun_listesi_versiyonlari v
            JOIN proje_teslimatlari pt ON v.teslimat_id=pt.id
            JOIN projeler p ON pt.proje_id=p.id
            WHERE v.id=$1
        `, [req.params.versiyonId]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Versiyon bulunamadı.' });

        // Snapshot içindeki stok_kart_id'ler için detay çek
        const v = r.rows[0];
        const kalemler = v.kalemler_snapshot || [];
        const stokIds = kalemler.map(k => k.stok_kart_id).filter(Boolean);
        let stokMap = {};
        if (stokIds.length > 0) {
            const sR = await pool.query(`SELECT id, stok_kodu, stok_adi, birim FROM stok_kartlari WHERE id = ANY($1::int[])`, [stokIds]);
            sR.rows.forEach(s => { stokMap[s.id] = s; });
        }
        // Kalemlere stok detayını ekle
        const zenginlestir = kalemler.map(k => ({
            ...k,
            stok_kodu: stokMap[k.stok_kart_id]?.stok_kodu || null,
            stok_adi: stokMap[k.stok_kart_id]?.stok_adi || null,
            stok_birim: stokMap[k.stok_kart_id]?.birim || null
        }));
        res.json({ ok: true, baslik: v, kalemler: zenginlestir });
    } catch (e) { next(e); }
});

// ============================================================================
// PROJE KARLILIK RAPORU — Aşama 1 (brüt: gelir - sipariş)
// ============================================================================
// Mantık:
//   Gelir = SUM(proje_teslimatlari.kdvsiz_tutar) — projenin sözleşme bedeli
//   Maliyet = SUM(siparis_kalemleri.birim_fiyat × siparis_miktari) — talep üzerinden bağlı siparişler
//   Brüt Kâr = Gelir - Maliyet (sadece aynı para biriminde anlamlı)
//   Diğer para birimlerinden maliyet ayrı sütun olarak gösterilir
app.get('/api/proje-karlilik', yetkiKontrol, async (req, res, next) => {
    try {
        const q = `
            WITH gelir AS (
                SELECT proje_id, SUM(COALESCE(kdvsiz_tutar, 0))::numeric as toplam_gelir,
                       COUNT(*)::int as teslimat_sayisi
                FROM proje_teslimatlari
                WHERE COALESCE(durum,'') <> 'İPTAL'
                GROUP BY proje_id
            ),
            -- Satınalma maliyeti (sipariş kalemlerinden, sipariş para birimi bazında)
            siparis_maliyet AS (
                SELECT t.proje_id,
                       s.para_birimi,
                       SUM(COALESCE(sk.birim_fiyat,0) * COALESCE(sk.siparis_miktari,0))::numeric as toplam,
                       COUNT(DISTINCT s.id)::int as siparis_sayisi
                FROM satinalma_siparisleri s
                JOIN siparis_kalemleri sk ON sk.siparis_id = s.id
                JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
                JOIN satinalma_talepleri t ON tu.talep_id = t.id
                WHERE COALESCE(s.arsiv,false)=false
                  AND COALESCE(s.durum,'') <> 'İPTAL'
                  AND t.proje_id IS NOT NULL
                GROUP BY t.proje_id, s.para_birimi
            ),
            -- Stok kullanım maliyeti (stok hareketlerinden — Çıkış, proje_id atanmış)
            -- Para birimi: stok kartının maliyet_para_birimi (TL varsayılan)
            stok_maliyet AS (
                SELECT sh.proje_id,
                       COALESCE(sk.maliyet_para_birimi, 'TL') as para_birimi,
                       SUM(COALESCE(sh.miktar, 0) * COALESCE(sh.birim_maliyet, 0))::numeric as toplam,
                       COUNT(*)::int as hareket_sayisi
                FROM stok_hareketleri sh
                JOIN stok_kartlari sk ON sh.stok_kart_id = sk.id
                WHERE sh.tip = 'Çıkış'
                  AND sh.proje_id IS NOT NULL
                  AND COALESCE(sh.birim_maliyet, 0) > 0
                GROUP BY sh.proje_id, sk.maliyet_para_birimi
            ),
            -- Para birimi bazında toplam: sipariş + stok kullanımı
            maliyet_birlesik AS (
                SELECT proje_id, para_birimi, SUM(toplam) as toplam,
                       MAX(siparis_sayisi) as siparis_sayisi,
                       MAX(hareket_sayisi) as stok_hareket_sayisi,
                       MAX(siparis_toplam) as siparis_toplam,
                       MAX(stok_toplam) as stok_toplam
                FROM (
                    SELECT proje_id, para_birimi, toplam, siparis_sayisi,
                           0::int as hareket_sayisi,
                           toplam as siparis_toplam, 0::numeric as stok_toplam
                    FROM siparis_maliyet
                    UNION ALL
                    SELECT proje_id, para_birimi, toplam, 0::int as siparis_sayisi,
                           hareket_sayisi,
                           0::numeric as siparis_toplam, toplam as stok_toplam
                    FROM stok_maliyet
                ) u
                GROUP BY proje_id, para_birimi
            ),
            maliyet_grup AS (
                SELECT proje_id,
                       json_object_agg(para_birimi, json_build_object(
                           'toplam', toplam,
                           'siparis_sayisi', siparis_sayisi,
                           'stok_hareket_sayisi', stok_hareket_sayisi,
                           'siparis_toplam', siparis_toplam,
                           'stok_toplam', stok_toplam
                       )) as breakdown,
                       SUM(siparis_sayisi)::int as toplam_siparis,
                       SUM(stok_hareket_sayisi)::int as toplam_stok_hareket
                FROM maliyet_birlesik
                GROUP BY proje_id
            )
            SELECT p.id, p.proje_kodu, p.musteri_adi, p.proje_adi, p.durum,
                   COALESCE(p.para_birimi, 'TL') as proje_para_birimi,
                   COALESCE(g.toplam_gelir, 0)::numeric as gelir,
                   COALESCE(g.teslimat_sayisi, 0) as teslimat_sayisi,
                   COALESCE(mg.breakdown, '{}'::json) as maliyet_breakdown,
                   COALESCE(mg.toplam_siparis, 0) as siparis_sayisi,
                   COALESCE(mg.toplam_stok_hareket, 0) as stok_hareket_sayisi
            FROM projeler p
            LEFT JOIN gelir g ON g.proje_id = p.id
            LEFT JOIN maliyet_grup mg ON mg.proje_id = p.id
            WHERE COALESCE(p.durum,'') NOT IN ('İPTAL')
            ORDER BY g.toplam_gelir DESC NULLS LAST
        `;
        const r = await pool.query(q);
        const data = r.rows.map(p => {
            const breakdown = p.maliyet_breakdown || {};
            const pbm = breakdown[p.proje_para_birimi];
            const ayni_pb_maliyet = pbm ? parseFloat(pbm.toplam) : 0;
            const ayni_pb_siparis = pbm ? parseFloat(pbm.siparis_toplam || 0) : 0;
            const ayni_pb_stok = pbm ? parseFloat(pbm.stok_toplam || 0) : 0;
            const gelir = parseFloat(p.gelir);
            const brutKar = gelir - ayni_pb_maliyet;
            const marjYuzde = gelir > 0 ? Math.round((brutKar / gelir) * 100) : 0;
            const diger = {};
            for (const [pb, v] of Object.entries(breakdown)) {
                if (pb !== p.proje_para_birimi) diger[pb] = parseFloat(v.toplam);
            }
            return {
                ...p, gelir, ayni_pb_maliyet, ayni_pb_siparis, ayni_pb_stok,
                brutKar, marjYuzde, diger_para_maliyet: diger
            };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

// Bir projenin maliyet kalemleri (detay)
app.get('/api/proje-karlilik/:projeId', yetkiKontrol, async (req, res, next) => {
    try {
        const { projeId } = req.params;
        const baslik = await pool.query(`
            SELECT p.*,
                   (SELECT SUM(COALESCE(kdvsiz_tutar,0)) FROM proje_teslimatlari WHERE proje_id=p.id AND COALESCE(durum,'')<>'İPTAL') as toplam_gelir
            FROM projeler p WHERE p.id=$1
        `, [projeId]);
        if (baslik.rowCount === 0) return res.json({ ok: false, hata: 'Proje bulunamadı.' });

        // Teslimatlar (gelir kalemleri)
        const teslimatlar = await pool.query(`
            SELECT id, bina_adi, bina_turu, bina_tipi, buyukluk_m2, kdvsiz_tutar, durum
            FROM proje_teslimatlari WHERE proje_id=$1
            ORDER BY id
        `, [projeId]);

        // Siparişler ve kalemleri (maliyet kalemleri)
        const siparisler = await pool.query(`
            SELECT s.id, s.siparis_no, s.tedarikci_id, s.para_birimi, s.durum, s.siparis_tarihi,
                   ted.firma_adi as tedarikci_adi,
                   COUNT(sk.id)::int as kalem_sayisi,
                   COALESCE(SUM(sk.birim_fiyat * sk.siparis_miktari),0)::numeric as toplam_tutar
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler ted ON s.tedarikci_id=ted.id
            JOIN siparis_kalemleri sk ON sk.siparis_id=s.id
            JOIN talep_urunleri tu ON sk.talep_urun_id=tu.id
            JOIN satinalma_talepleri t ON tu.talep_id=t.id
            WHERE t.proje_id=$1 AND COALESCE(s.arsiv,false)=false AND s.durum <> 'İPTAL'
            GROUP BY s.id, ted.firma_adi
            ORDER BY s.siparis_tarihi DESC
        `, [projeId]);

        // Tedarikçi bazlı maliyet özeti
        const tedarikciOzet = await pool.query(`
            SELECT ted.firma_adi as tedarikci, s.para_birimi,
                   COALESCE(SUM(sk.birim_fiyat * sk.siparis_miktari),0)::numeric as toplam,
                   COUNT(DISTINCT s.id)::int as siparis_sayisi
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler ted ON s.tedarikci_id=ted.id
            JOIN siparis_kalemleri sk ON sk.siparis_id=s.id
            JOIN talep_urunleri tu ON sk.talep_urun_id=tu.id
            JOIN satinalma_talepleri t ON tu.talep_id=t.id
            WHERE t.proje_id=$1 AND COALESCE(s.arsiv,false)=false AND s.durum <> 'İPTAL'
            GROUP BY ted.firma_adi, s.para_birimi
            ORDER BY toplam DESC
        `, [projeId]);

        res.json({
            ok: true,
            proje: baslik.rows[0],
            teslimatlar: teslimatlar.rows,
            siparisler: siparisler.rows,
            tedarikciOzet: tedarikciOzet.rows
        });
    } catch (e) { next(e); }
});

// ============================================================================
// ROL & İZİN YÖNETİMİ (sadece ADMIN)
// ============================================================================
// Modül kataloğu — UI ile sıkı bağlı, kod tarafında tanımlanır
// İleride permission middleware bu listeyi referans alır
const MODUL_KATALOG = [
    { kod: 'anasayfa',            ad: 'Ana Sayfa',           grup: 'Genel' },
    { kod: 'projeler',            ad: 'Projeler',            grup: 'İş Akışı' },
    { kod: 'bina_listeleri',      ad: 'Bina Listeleri',      grup: 'İş Akışı' },
    { kod: 'satinalma.talepler',  ad: 'Satınalma — Talepler', grup: 'Satınalma' },
    { kod: 'satinalma.siparisler',ad: 'Satınalma — Siparişler', grup: 'Satınalma' },
    { kod: 'satinalma.tedarikci', ad: 'Satınalma — Tedarikçi', grup: 'Satınalma' },
    { kod: 'satinalma.mal_kabul', ad: 'Satınalma — Mal Kabul', grup: 'Satınalma' },
    { kod: 'stok',                ad: 'Stok',                grup: 'Operasyon' },
    { kod: 'uretim',              ad: 'Üretim',              grup: 'Operasyon' },
    { kod: 'sevkiyat',            ad: 'Sevkiyat',            grup: 'Operasyon' },
    { kod: 'montaj',              ad: 'Montaj',              grup: 'Operasyon' },
    { kod: 'rapor.ozet',          ad: 'Rapor — Genel Bakış', grup: 'Rapor' },
    { kod: 'rapor.karlilik',      ad: 'Rapor — Karlılık',    grup: 'Rapor' },
    { kod: 'yonetim.kullanicilar',ad: 'Kullanıcılar',        grup: 'Yönetim' },
    { kod: 'yonetim.roller',      ad: 'Roller',              grup: 'Yönetim' },
    { kod: 'yonetim.form_tanimi', ad: 'Form Tanımları',      grup: 'Yönetim' },
    { kod: 'yonetim.audit_log',   ad: 'Audit Log',           grup: 'Yönetim' }
];
const IZIN_SEVIYELERI = ['YOK', 'OKUMA', 'YAZMA', 'TAM'];

// Modül kataloğunu döndüren endpoint (frontend matris UI'si için)
app.get('/api/modul-katalog', yetkiKontrol, (req, res) => {
    res.json({ ok: true, modul_katalog: MODUL_KATALOG, izin_seviyeleri: IZIN_SEVIYELERI });
});

// --- BİLDİRİM KURALLARI PANELİ (sadece ADMIN) ---
app.get('/api/bildirim-kurallari', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.status(403).json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const r = await pool.query("SELECT * FROM bildirim_kurallari ORDER BY sira, id");
        const roller = (await pool.query("SELECT ad FROM roller WHERE ad<>'ADMIN' ORDER BY sistem_rol DESC, id")).rows.map(x => x.ad);
        res.json({ ok: true, kurallar: r.rows, roller });
    } catch (e) { next(e); }
});

app.post('/api/bildirim-kural-guncelle', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const { id, aktif, roller, ekstra_emailler, dinamik_alicilar, cc_roller, cc_emailler } = req.body;
        if (!id) return res.json({ ok: false, hata: 'Kural ID gerekli.' });
        await pool.query(
            `UPDATE bildirim_kurallari SET aktif=$1, roller=$2, ekstra_emailler=$3, dinamik_alicilar=$4, cc_roller=$5, cc_emailler=$6 WHERE id=$7`,
            [!!aktif, roller || [], ekstra_emailler || [], dinamik_alicilar || [], cc_roller || [], cc_emailler || [], id]
        );
        res.json({ ok: true, mesaj: 'Bildirim kuralı güncellendi.' });
    } catch (e) { next(e); }
});

// Tüm roller (sistem + özel)
app.get('/api/roller', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.status(403).json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const r = await pool.query(`
            SELECT r.id, r.ad, r.aciklama, r.sistem_rol, r.kayit_tarihi,
                   (SELECT COUNT(*)::int FROM kullanicilar WHERE rol = r.ad AND durum='AKTIF') as kullanici_sayisi
            FROM roller r
            ORDER BY r.sistem_rol DESC, r.id ASC
        `);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Rol kaydet (ekle/güncelle)
app.post('/api/rol-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const { id, ad, aciklama } = req.body;
        const adNorm = (ad || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if (!adNorm) return res.json({ ok: false, hata: 'Rol adı zorunlu.' });
        if (adNorm.length < 2) return res.json({ ok: false, hata: 'Rol adı en az 2 karakter olmalı.' });

        if (id) {
            const eR = await pool.query('SELECT sistem_rol, ad FROM roller WHERE id=$1', [id]);
            if (eR.rowCount === 0) return res.json({ ok: false, hata: 'Rol bulunamadı.' });
            if (eR.rows[0].sistem_rol && eR.rows[0].ad !== adNorm) {
                return res.json({ ok: false, hata: 'Sistem rolünün adı değiştirilemez (sadece açıklaması).' });
            }
            await pool.query(`UPDATE roller SET ad=$1, aciklama=$2 WHERE id=$3`, [adNorm, aciklama || null, id]);
            rolCacheTemizle(); izinCacheTemizle();
            await auditLogla(req, { eylem: 'UPDATE', tablo: 'roller', kayit_id: id, ozet: `Rol güncellendi: ${adNorm}` });
            return res.json({ ok: true, mesaj: 'Rol güncellendi.' });
        } else {
            // Aynı isimde rol var mı?
            const x = await pool.query('SELECT id FROM roller WHERE ad=$1', [adNorm]);
            if (x.rowCount > 0) return res.json({ ok: false, hata: 'Bu adda bir rol zaten var.' });
            const ins = await pool.query(`
                INSERT INTO roller (ad, aciklama, sistem_rol) VALUES ($1, $2, FALSE) RETURNING id
            `, [adNorm, aciklama || null]);
            rolCacheTemizle(); izinCacheTemizle();
            await auditLogla(req, { eylem: 'CREATE', tablo: 'roller', kayit_id: ins.rows[0].id, ozet: `Yeni rol: ${adNorm}` });
            return res.json({ ok: true, mesaj: 'Rol oluşturuldu.', id: ins.rows[0].id });
        }
    } catch (e) { next(e); }
});

// Rol sil — sistem rolleri silinemez, kullanıcı atanmış roller silinemez
app.delete('/api/rol-sil/:id', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const id = parseInt(req.params.id);
        const r = await pool.query('SELECT ad, sistem_rol FROM roller WHERE id=$1', [id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Rol bulunamadı.' });
        if (r.rows[0].sistem_rol) return res.json({ ok: false, hata: 'Sistem rolü silinemez.' });
        // Atanmış kullanıcı kontrolü
        const k = await pool.query(`SELECT COUNT(*)::int as n FROM kullanicilar WHERE rol=$1`, [r.rows[0].ad]);
        if (k.rows[0].n > 0) return res.json({ ok: false, hata: `Bu role atanmış ${k.rows[0].n} kullanıcı var. Önce onları başka role taşıyın.` });

        await pool.query('DELETE FROM roller WHERE id=$1', [id]);
        rolCacheTemizle();
        await auditLogla(req, { eylem: 'DELETE', tablo: 'roller', kayit_id: id, ozet: `Rol silindi: ${r.rows[0].ad}` });
        res.json({ ok: true, mesaj: 'Rol silindi.' });
    } catch (e) { next(e); }
});

// İzin matrisi: tüm rollerin tüm modüllerdeki seviyeleri
app.get('/api/rol-izinleri', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.status(403).json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    try {
        const r = await pool.query(`
            SELECT ri.rol_id, r.ad as rol_ad, ri.modul_kod, ri.seviye
            FROM rol_izinleri ri
            JOIN roller r ON r.id = ri.rol_id
        `);
        // {rol_id: {modul_kod: seviye}}
        const matris = {};
        r.rows.forEach(row => {
            if (!matris[row.rol_id]) matris[row.rol_id] = {};
            matris[row.rol_id][row.modul_kod] = row.seviye;
        });
        res.json({ ok: true, matris });
    } catch (e) { next(e); }
});

// İzin matrisini toplu güncelle
// Body: { izinler: [{rol_id, modul_kod, seviye}] }
app.post('/api/rol-izinleri-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { izinler } = req.body;
        if (!Array.isArray(izinler)) return res.json({ ok: false, hata: 'izinler dizisi gerekli.' });

        let n = 0;
        for (const i of izinler) {
            if (!i.rol_id || !i.modul_kod) continue;
            const sev = (i.seviye || 'YOK').toUpperCase();
            if (!IZIN_SEVIYELERI.includes(sev)) continue;
            await client.query(`
                INSERT INTO rol_izinleri (rol_id, modul_kod, seviye) VALUES ($1, $2, $3)
                ON CONFLICT (rol_id, modul_kod) DO UPDATE SET seviye = EXCLUDED.seviye
            `, [i.rol_id, i.modul_kod, sev]);
            n++;
        }
        await client.query('COMMIT');
        izinCacheTemizle();
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'rol_izinleri', ozet: `İzin matrisi güncellendi: ${n} hücre` });
        res.json({ ok: true, mesaj: `${n} izin kaydı güncellendi.` });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Kullanıcı modülü için rol listesi (DB'den)
async function rolListesiniGetir() {
    const r = await pool.query('SELECT ad FROM roller ORDER BY sistem_rol DESC, ad');
    return r.rows.map(x => x.ad);
}

// Bir rolün tüm modüllerdeki izin haritasını döndür
// ADMIN için tüm modüller TAM (matriste yoksa bile)
const IZIN_CACHE = new Map();
async function getKullaniciIzinleri(rolAd) {
    if (!rolAd) return {};
    if (IZIN_CACHE.has(rolAd)) return IZIN_CACHE.get(rolAd);

    const izinler = {};
    // ADMIN her şeye TAM
    if (rolAd === 'ADMIN' || rolAd === 'Admin') {
        MODUL_KATALOG.forEach(m => { izinler[m.kod] = 'TAM'; });
        IZIN_CACHE.set(rolAd, izinler);
        return izinler;
    }
    // Diğer roller için DB'den oku
    const r = await pool.query(`
        SELECT ri.modul_kod, ri.seviye
        FROM rol_izinleri ri
        JOIN roller ro ON ri.rol_id = ro.id
        WHERE ro.ad = $1
    `, [rolAd]);
    // Varsayılan tüm modüller YOK
    MODUL_KATALOG.forEach(m => { izinler[m.kod] = 'YOK'; });
    // DB'deki tanımları overwrite et
    r.rows.forEach(row => { izinler[row.modul_kod] = row.seviye; });
    IZIN_CACHE.set(rolAd, izinler);
    return izinler;
}

function izinCacheTemizle() { IZIN_CACHE.clear(); }

// İzin gerektiren middleware
// Kullanım: app.post('/x', yetkiKontrol, izinGerekli('modul.kod', 'YAZMA'), handler)
function izinGerekli(modulKod, gerekliSeviye = 'OKUMA') {
    return async (req, res, next) => {
        try {
            // ADMIN her zaman geçer
            if (req.user.rol === 'ADMIN' || req.user.rol === 'Admin') return next();

            const izinler = await getKullaniciIzinleri(req.user.rol);
            const sahip = izinler[modulKod] || 'YOK';
            const seviyeSira = { 'YOK': 0, 'OKUMA': 1, 'YAZMA': 2, 'TAM': 3 };
            if (seviyeSira[sahip] < seviyeSira[gerekliSeviye]) {
                return res.status(403).json({
                    ok: false,
                    hata: `Bu işlem için yetkin yok (${modulKod} → ${gerekliSeviye} gerekli, sende ${sahip}).`
                });
            }
            next();
        } catch (e) { next(e); }
    };
}

// Endpoint → modül eşleme tablosu (regex pattern + gerekli seviye)
// İlk eşleşen kural uygulanır. Eşleşmeyen endpoint'ler için kontrol yok (örn. /me/izinler).
const ENDPOINT_IZIN_KURALLARI = [
    // Yönetim — sadece ADMIN (route handler'da zaten kontrol var, çift kontrol için bunlar burada)
    { pattern: /^\/api\/(kullanicilar|kullanici-|roller|rol-|modul-katalog|form-tanim|audit-log)/, modul: 'yonetim.kullanicilar', seviye: 'TAM' },
    // Bildirimler — herkes kendi bildirimlerini görür
    { pattern: /^\/api\/bildirim/, modul: 'anasayfa', seviye: 'OKUMA' },
    // Dashboard
    { pattern: /^\/api\/dashboard/, modul: 'anasayfa', seviye: 'OKUMA' },
    // Hızlı arama — temel okuma
    { pattern: /^\/api\/quick-search/, modul: 'anasayfa', seviye: 'OKUMA' },

    // Projeler
    { pattern: /^\/api\/(projeler|proje-detay|proje-teslimat)/, method: 'GET', modul: 'projeler', seviye: 'OKUMA' },
    { pattern: /^\/api\/(proje-kaydet|proje-sil|teslimat-durum)/, modul: 'projeler', seviye: 'YAZMA' },
    { pattern: /^\/api\/proje-karlilik/, modul: 'rapor.karlilik', seviye: 'OKUMA' },

    // Bina Listeleri (Ürün Listesi)
    { pattern: /^\/api\/teslimat-secenekleri/, modul: 'bina_listeleri', seviye: 'OKUMA' },
    { pattern: /^\/api\/teslimat-urunleri/, method: 'GET', modul: 'bina_listeleri', seviye: 'OKUMA' },
    { pattern: /^\/api\/teslimat-urun-(ekle|guncelle|sil)/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/teslimat-urun-talep-olustur/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/urun-listesi-(onaya|onayla|reddet|kopyala|import|sablon|ek-urun|kopya-kaynak)/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/urun-listesi-(versiyon|teslimat-sablon)/, modul: 'bina_listeleri', seviye: 'OKUMA' },

    // Satınalma — Talepler
    { pattern: /^\/api\/(satinalma-listesi|talep-detay|talep-urunleri|teklif-havuzu|arsiv)/, method: 'GET', modul: 'satinalma.talepler', seviye: 'OKUMA' },
    { pattern: /^\/api\/(talep-kaydet|talep-guncelle|talep-onayla|talep-reddet|talep-iptal|talep-arsivle|teklif-iste|teklif-iptal)/, modul: 'satinalma.talepler', seviye: 'TAM' },

    // Satınalma — Siparişler
    { pattern: /^\/api\/(siparis-listesi|siparis-detay|siparis-pdf|siparis-dosya)/, method: 'GET', modul: 'satinalma.siparisler', seviye: 'OKUMA' },
    { pattern: /^\/api\/(siparis-kaydet|siparis-guncelle|siparis-onayla|siparis-gonder|siparis-iptal|siparis-arsivle|siparis-gerial|siparis-dosya-yukle|siparis-dosya-sil)/, modul: 'satinalma.siparisler', seviye: 'TAM' },

    // Satınalma — Mal Kabul
    { pattern: /^\/api\/mal-kabul/, modul: 'satinalma.mal_kabul', seviye: 'YAZMA' },

    // Tedarikçiler
    { pattern: /^\/api\/tedarikci/, method: 'GET', modul: 'satinalma.tedarikci', seviye: 'OKUMA' },
    { pattern: /^\/api\/(tedarikci-kaydet|tedarikci-sil|tedarikci-)/, modul: 'satinalma.tedarikci', seviye: 'YAZMA' },

    // Stok
    { pattern: /^\/api\/(stok-kart|stok-hareketler|depolar|stok-kartlari)/, method: 'GET', modul: 'stok', seviye: 'OKUMA' },
    { pattern: /^\/api\/(stok-kaydet|stok-hareket-kaydet|stok-hareket-guncelle|stok-hareket-sil|depo-kaydet)/, modul: 'stok', seviye: 'YAZMA' },

    // Üretim
    { pattern: /^\/api\/uretim-(urunleri|is-emirleri|is-emri-detay)/, method: 'GET', modul: 'uretim', seviye: 'OKUMA' },
    { pattern: /^\/api\/uretim-/, modul: 'uretim', seviye: 'YAZMA' },

    // Sevkiyat
    { pattern: /^\/api\/sevkiyat-(urunleri|belgeleri|belgesi-detay|plani)/, method: 'GET', modul: 'sevkiyat', seviye: 'OKUMA' },
    { pattern: /^\/api\/sevkiyat-/, modul: 'sevkiyat', seviye: 'YAZMA' },

    // Montaj
    { pattern: /^\/api\/montaj-(teslimatlar|teslimat-urunleri|hareketler)/, method: 'GET', modul: 'montaj', seviye: 'OKUMA' },
    { pattern: /^\/api\/montaj-/, modul: 'montaj', seviye: 'YAZMA' },

    // Rapor
    { pattern: /^\/api\/ozet/, modul: 'rapor.ozet', seviye: 'OKUMA' },

    // Teknik şartname / form
    { pattern: /^\/api\/teknik-sartname/, modul: 'projeler', seviye: 'YAZMA' },
    { pattern: /^\/api\/form-tanimlari/, method: 'GET', modul: 'projeler', seviye: 'OKUMA' }
];

// Global izin middleware — tüm /api endpoint'lerine uygulanır
async function genelIzinMiddleware(req, res, next) {
    // yetkiKontrol'den sonra çalışır, req.user mevcut
    if (!req.user) return next();
    // ADMIN her zaman geçer
    if (req.user.rol === 'ADMIN' || req.user.rol === 'Admin') return next();

    // /me/izinler ve auth gibi her zaman erişilebilir olmalı
    if (req.path === '/me/izinler' || req.path === '/durum-guncelle') return next();

    // Eşleşen ilk kural uygulanır
    for (const k of ENDPOINT_IZIN_KURALLARI) {
        if (!k.pattern.test(req.path)) continue;
        if (k.method && k.method !== req.method) continue;
        // İzin kontrolü
        const izinler = await getKullaniciIzinleri(req.user.rol);
        const sahip = izinler[k.modul] || 'YOK';
        const seviyeSira = { 'YOK': 0, 'OKUMA': 1, 'YAZMA': 2, 'TAM': 3 };
        if (seviyeSira[sahip] < seviyeSira[k.seviye]) {
            return res.status(403).json({
                ok: false,
                hata: `Yetkin yok: ${k.modul} → ${k.seviye} gerekli, sende ${sahip}.`,
                izin_hatasi: true
            });
        }
        return next();
    }
    // Hiçbir kural eşleşmediyse erişim ver (whitelist olmadığı için)
    next();
}

// Endpoint: Aktif kullanıcının izin haritası
// ?as=ROL parametresi: sadece ADMIN için — başka rolün izinlerini simüle eder
app.get('/api/me/izinler', yetkiKontrol, async (req, res, next) => {
    try {
        // yetkiKontrol middleware'i X-Yansit-Rol header'ını zaten işledi:
        // simülasyonda req.user.rol = yansıtılan rol, req.user.gercek_rol = ADMIN, req.user.simulasyon = true.
        // Bu yüzden burada tekrar kontrol etmiyoruz — middleware'in sonucunu kullanıyoruz.
        const etkinRol = req.user.rol;
        const simulasyon = !!req.user.simulasyon;
        const izinler = await getKullaniciIzinleri(etkinRol);
        res.json({ ok: true, rol: etkinRol, gercek_rol: req.user.gercek_rol || req.user.rol, simulasyon, izinler, modul_katalog: MODUL_KATALOG });
    } catch (e) { next(e); }
});

// ============================================================================
// KULLANICI YÖNETİMİ (sadece ADMIN)
// ============================================================================
// Eski sabit liste yerine DB'den çekilir
let KULLANICI_ROLLERI_CACHE = null;
async function getKullaniciRolleri() {
    if (!KULLANICI_ROLLERI_CACHE) {
        KULLANICI_ROLLERI_CACHE = await rolListesiniGetir();
    }
    return KULLANICI_ROLLERI_CACHE;
}
// Rol değişimlerinden sonra cache'i invalidate
function rolCacheTemizle() { KULLANICI_ROLLERI_CACHE = null; }

app.get('/api/kullanicilar', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.status(403).json({ ok: false, hata: 'Sadece ADMIN erişebilir.' });
    }
    try {
        const r = await pool.query(`
            SELECT id, email, ad_soyad, rol, durum, son_giris, kayit_tarihi
            FROM kullanicilar ORDER BY id ASC
        `);
        const roller = await getKullaniciRolleri();
        res.json({ ok: true, data: r.rows, roller });
    } catch (e) { next(e); }
});

app.post('/api/kullanici-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN düzenleyebilir.' });
    }
    try {
        const { id, email, ad_soyad, rol, durum } = req.body;
        const emailNorm = (email || '').trim().toLowerCase();
        const adSoyadNorm = (ad_soyad || '').trim();
        const rolNorm = (rol || 'KULLANICI').trim().toUpperCase();
        const durumNorm = (durum || 'AKTIF').trim().toUpperCase();

        // Validation
        if (!emailNorm) return res.json({ ok: false, hata: 'E-posta zorunlu.' });
        if (!emailNorm.endsWith('@aterko.com')) return res.json({ ok: false, hata: 'Sadece @aterko.com e-postaları kabul edilir.' });
        if (!adSoyadNorm) return res.json({ ok: false, hata: 'Ad Soyad zorunlu.' });
        const gecerliRoller = await getKullaniciRolleri();
        if (!gecerliRoller.includes(rolNorm)) return res.json({ ok: false, hata: 'Geçersiz rol: ' + rolNorm });
        if (!['AKTIF','PASIF'].includes(durumNorm)) return res.json({ ok: false, hata: 'Geçersiz durum.' });

        let eski = null;
        if (id) {
            const eR = await pool.query('SELECT * FROM kullanicilar WHERE id=$1', [id]);
            if (eR.rowCount > 0) eski = eR.rows[0];
            // Kendinin rolünü ADMIN'den çıkaramaz
            if (eski && eski.email === req.user.email && eski.rol === 'ADMIN' && rolNorm !== 'ADMIN') {
                return res.json({ ok: false, hata: 'Kendi ADMIN yetkinizi kaldıramazsınız.' });
            }
            await pool.query(`
                UPDATE kullanicilar SET email=$1, ad_soyad=$2, rol=$3, durum=$4 WHERE id=$5
            `, [emailNorm, adSoyadNorm, rolNorm, durumNorm, id]);
            await auditLogla(req, {
                eylem: 'UPDATE', tablo: 'kullanicilar', kayit_id: id,
                ozet: `Kullanıcı güncellendi: ${emailNorm} (rol: ${rolNorm}, durum: ${durumNorm})`,
                eski_veri: eski, yeni_veri: req.body
            });
        } else {
            // E-posta benzersiz olmalı
            const x = await pool.query('SELECT id FROM kullanicilar WHERE LOWER(email)=$1', [emailNorm]);
            if (x.rowCount > 0) return res.json({ ok: false, hata: 'Bu e-posta zaten kayıtlı.' });
            const ins = await pool.query(`
                INSERT INTO kullanicilar (email, ad_soyad, rol, durum) VALUES ($1,$2,$3,$4) RETURNING id
            `, [emailNorm, adSoyadNorm, rolNorm, durumNorm]);
            await auditLogla(req, {
                eylem: 'CREATE', tablo: 'kullanicilar', kayit_id: ins.rows[0].id,
                ozet: `Yeni kullanıcı: ${emailNorm} (${rolNorm})`, yeni_veri: req.body
            });
        }
        res.json({ ok: true, mesaj: 'Kullanıcı kaydedildi.' });
    } catch (e) { next(e); }
});

app.delete('/api/kullanici-sil/:id', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN silebilir.' });
    }
    try {
        const id = parseInt(req.params.id);
        // Kendini silemez
        const r = await pool.query('SELECT email FROM kullanicilar WHERE id=$1', [id]);
        if (r.rowCount === 0) return res.json({ ok: false, hata: 'Kullanıcı bulunamadı.' });
        if (r.rows[0].email === req.user.email) {
            return res.json({ ok: false, hata: 'Kendinizi silemezsiniz.' });
        }
        // En az 1 ADMIN kalmalı
        const adminSay = await pool.query("SELECT COUNT(*)::int as n FROM kullanicilar WHERE rol='ADMIN' AND durum='AKTIF'");
        const silinen = await pool.query("SELECT rol FROM kullanicilar WHERE id=$1", [id]);
        if (silinen.rows[0].rol === 'ADMIN' && adminSay.rows[0].n <= 1) {
            return res.json({ ok: false, hata: 'Son AKTIF ADMIN silinemez. Önce başka bir ADMIN tanımlayın.' });
        }
        await pool.query('DELETE FROM kullanicilar WHERE id=$1', [id]);
        await auditLogla(req, {
            eylem: 'DELETE', tablo: 'kullanicilar', kayit_id: id,
            ozet: `Kullanıcı silindi: ${r.rows[0].email}`
        });
        res.json({ ok: true, mesaj: 'Kullanıcı silindi.' });
    } catch (e) { next(e); }
});

// ============================================================================
// İŞ AKIŞLARI / FORM TANIMLARI YÖNETİMİ (D-6)
// ============================================================================
app.get('/api/form-tanimlari', yetkiKontrol, async (req, res, next) => {
    try {
        const { bina_turu } = req.query;
        let sql = `SELECT * FROM form_tanimlari`;
        const params = [];
        if (bina_turu) { params.push(bina_turu); sql += ` WHERE bina_turu = $1`; }
        sql += ` ORDER BY bina_turu, bolum_sirasi, soru_sirasi`;
        const r = await pool.query(sql, params);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

app.post('/api/form-tanimi-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN düzenleyebilir.' });
    }
    try {
        const {
            id, bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru,
            giris_tipi, secenekler, zorunlu, kurallar, kosullar
        } = req.body;
        if (!bina_turu || !bolum_adi || !soru) {
            return res.json({ ok: false, hata: 'Bina türü, bölüm adı ve soru metni zorunlu.' });
        }

        let eski = null;
        if (id) {
            const r = await pool.query('SELECT * FROM form_tanimlari WHERE id=$1', [id]);
            if (r.rowCount > 0) eski = r.rows[0];
            await pool.query(`
                UPDATE form_tanimlari
                SET bina_turu=$1, bolum_sirasi=$2, bolum_adi=$3, soru_sirasi=$4, soru=$5,
                    giris_tipi=$6, secenekler=$7, zorunlu=$8, kurallar=$9, kosullar=$10
                WHERE id=$11
            `, [bina_turu, bolum_sirasi || 1, bolum_adi, soru_sirasi || 1, soru,
                giris_tipi || 'TEXT', secenekler ? JSON.stringify(secenekler) : null,
                !!zorunlu, kurallar || null, kosullar || null, id]);
            await auditLogla(req, {
                eylem: 'UPDATE', tablo: 'form_tanimlari', kayit_id: id,
                ozet: `Form sorusu güncellendi: ${soru.substring(0,60)}`,
                eski_veri: eski, yeni_veri: req.body
            });
        } else {
            const r = await pool.query(`
                INSERT INTO form_tanimlari (bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru,
                                            giris_tipi, secenekler, zorunlu, kurallar, kosullar)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
            `, [bina_turu, bolum_sirasi || 1, bolum_adi, soru_sirasi || 1, soru,
                giris_tipi || 'TEXT', secenekler ? JSON.stringify(secenekler) : null,
                !!zorunlu, kurallar || null, kosullar || null]);
            await auditLogla(req, {
                eylem: 'CREATE', tablo: 'form_tanimlari', kayit_id: r.rows[0].id,
                ozet: `Form sorusu eklendi: ${soru.substring(0,60)}`, yeni_veri: req.body
            });
        }
        res.json({ ok: true, mesaj: 'Form tanımı kaydedildi.' });
    } catch (e) { next(e); }
});

app.delete('/api/form-tanimi-sil/:id', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN silebilir.' });
    }
    try {
        const r = await pool.query('SELECT soru FROM form_tanimlari WHERE id=$1', [req.params.id]);
        await pool.query('DELETE FROM form_tanimlari WHERE id=$1', [req.params.id]);
        await auditLogla(req, {
            eylem: 'DELETE', tablo: 'form_tanimlari', kayit_id: parseInt(req.params.id),
            ozet: `Form sorusu silindi: ${r.rows[0]?.soru?.substring(0,60) || ''}`
        });
        res.json({ ok: true, mesaj: 'Soru silindi.' });
    } catch (e) { next(e); }
});

// Audit log özet (admin için)
app.get('/api/audit-log-ozet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Yetki yok.' });
    try {
        const son24 = await pool.query(`SELECT COUNT(*)::int as n FROM audit_log WHERE kayit_tarihi > NOW() - INTERVAL '24 hours'`);
        const eylemler = await pool.query(`
            SELECT eylem, COUNT(*)::int as n FROM audit_log
            WHERE kayit_tarihi > NOW() - INTERVAL '30 days'
            GROUP BY eylem ORDER BY n DESC LIMIT 10
        `);
        const kullanicilar = await pool.query(`
            SELECT kullanici_email, COUNT(*)::int as n FROM audit_log
            WHERE kayit_tarihi > NOW() - INTERVAL '30 days'
              AND kullanici_email IS NOT NULL
            GROUP BY kullanici_email ORDER BY n DESC LIMIT 10
        `);
        res.json({
            ok: true,
            son24saat: son24.rows[0].n,
            eylemDagilimi: eylemler.rows,
            kullaniciAktivite: kullanicilar.rows
        });
    } catch (e) { next(e); }
});

// Aktif kullanıcı için bildirim listesi (son N adet)
app.get('/api/bildirimler', yetkiKontrol, async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 30;
        // Kullanıcının kendi bildirimleri + herkese olanlar (kullanici_email NULL)
        const r = await pool.query(`
            SELECT * FROM bildirimler
            WHERE kullanici_email = $1 OR kullanici_email IS NULL
            ORDER BY kayit_tarihi DESC
            LIMIT $2
        `, [req.user.email, limit]);

        // Okunmamış sayısı
        const c = await pool.query(`
            SELECT COUNT(*)::int as n FROM bildirimler
            WHERE (kullanici_email = $1 OR kullanici_email IS NULL) AND okundu = FALSE
        `, [req.user.email]);

        res.json({ ok: true, data: r.rows, okunmamis: c.rows[0].n });
    } catch (e) { next(e); }
});

// Bildirim okundu işaretle (tek veya çoklu)
// Body: { ids: [1,2,3] } veya { hepsi: true }
app.post('/api/bildirim-okundu', yetkiKontrol, async (req, res, next) => {
    try {
        const { ids, hepsi } = req.body;
        if (hepsi) {
            await pool.query(`
                UPDATE bildirimler SET okundu = TRUE, okundu_tarihi = NOW()
                WHERE (kullanici_email = $1 OR kullanici_email IS NULL) AND okundu = FALSE
            `, [req.user.email]);
        } else if (Array.isArray(ids) && ids.length > 0) {
            await pool.query(`
                UPDATE bildirimler SET okundu = TRUE, okundu_tarihi = NOW()
                WHERE id = ANY($1::int[]) AND (kullanici_email = $2 OR kullanici_email IS NULL)
            `, [ids, req.user.email]);
        }
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ============================================================================
// OTOMATIK BİLDİRİM ÜRETİMİ (D-2)
// Periyodik check: termin yaklaşan siparişler + pasif kalan talepler
// ============================================================================

// Termin tarihi 3 gün içinde olan aktif siparişler için bildirim
async function bildirimUret_TerminYaklasan() {
    const r = await pool.query(`
        SELECT s.id, s.siparis_no, s.termin_tarihi,
               t.firma_adi as tedarikci_adi,
               (s.termin_tarihi - CURRENT_DATE)::int as kalan_gun
        FROM satinalma_siparisleri s
        LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
        WHERE s.termin_tarihi IS NOT NULL
          AND s.termin_tarihi BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
          AND s.durum NOT IN ('TAMAMLANDI', 'İPTAL', 'TAMAMLANDI ARŞİV')
          AND COALESCE(s.arsiv, false) = false
    `);
    let yeni = 0;
    for (const s of r.rows) {
        // Aynı sipariş için son 24 saatte aynı tipte bildirim atılmışsa atlayalım
        const c = await pool.query(`
            SELECT 1 FROM bildirimler
            WHERE kaynak_modul='satinalma_termin' AND referans_id=$1
              AND kayit_tarihi > NOW() - INTERVAL '24 hours' LIMIT 1
        `, [s.id]);
        if (c.rowCount > 0) continue;

        const kalan = s.kalan_gun;
        const tip = kalan <= 0 ? 'KRITIK' : (kalan <= 1 ? 'KRITIK' : 'UYARI');
        const gunMsg = kalan <= 0 ? 'BUGÜN' : (kalan === 1 ? 'yarın' : kalan + ' gün sonra');
        await bildirimOlustur(null,
            `${kalan <= 0 ? '🔴 Termin bugün' : '⏰ Termin yaklaşıyor'}: ${s.siparis_no}`,
            `${s.tedarikci_adi || 'Tedarikçi'} — termin ${gunMsg}`,
            { tip, link: '#satinalma', kaynak_modul: 'satinalma_termin', referans_id: s.id }
        );
        yeni++;
    }
    return yeni;
}

// 7+ gündür ONAY BEKLİYOR durumundaki talepler için bildirim
async function bildirimUret_PasifTalep() {
    const r = await pool.query(`
        SELECT id, talep_no, talep_eden,
               EXTRACT(DAY FROM (NOW() - kayit_tarihi))::int as gun
        FROM satinalma_talepleri
        WHERE durum = 'ONAY BEKLİYOR'
          AND kayit_tarihi < NOW() - INTERVAL '7 days'
          AND COALESCE(arsiv, false) = false
    `);
    let yeni = 0;
    for (const t of r.rows) {
        const c = await pool.query(`
            SELECT 1 FROM bildirimler
            WHERE kaynak_modul='satinalma_pasif_talep' AND referans_id=$1
              AND kayit_tarihi > NOW() - INTERVAL '7 days' LIMIT 1
        `, [t.id]);
        if (c.rowCount > 0) continue;

        await bildirimOlustur(null,
            `📌 Pasif talep: ${t.talep_no}`,
            `${t.gun} gündür ONAY BEKLİYOR durumunda. Talep eden: ${t.talep_eden || '—'}`,
            { tip: 'UYARI', link: '#satinalma', kaynak_modul: 'satinalma_pasif_talep', referans_id: t.id }
        );
        yeni++;
    }
    return yeni;
}

// Kritik stok altına düşen kalemler için bildirim
async function bildirimUret_KritikStok() {
    const r = await pool.query(`
        SELECT id, stok_kodu, stok_adi, guncel_stok_miktari, kritik_stok_miktari, birim
        FROM stok_kartlari
        WHERE kritik_stok_miktari IS NOT NULL
          AND kritik_stok_miktari > 0
          AND guncel_stok_miktari < kritik_stok_miktari
          AND stok_tipi != 'Ürün'
    `);
    let yeni = 0;
    for (const s of r.rows) {
        const c = await pool.query(`
            SELECT 1 FROM bildirimler
            WHERE kaynak_modul='kritik_stok' AND referans_id=$1
              AND kayit_tarihi > NOW() - INTERVAL '24 hours' LIMIT 1
        `, [s.id]);
        if (c.rowCount > 0) continue;

        await bildirimOlustur(null,
            `📦 Kritik stok: ${s.stok_kodu}`,
            `${s.stok_adi} — ${s.guncel_stok_miktari} ${s.birim} kaldı (kritik: ${s.kritik_stok_miktari})`,
            { tip: 'UYARI', link: '#stok', kaynak_modul: 'kritik_stok', referans_id: s.id }
        );
        yeni++;
    }
    return yeni;
}

// Master fonksiyon — periyodik tetikleyici çağırır
async function bildirimleriOtomatikUret() {
    try {
        const t = await bildirimUret_TerminYaklasan();
        const p = await bildirimUret_PasifTalep();
        const k = await bildirimUret_KritikStok();
        if (t + p + k > 0) {
            console.log(`📨 Bildirim üretildi → termin:${t}, pasif:${p}, kritik:${k}`);
        }
    } catch (e) {
        console.warn('Bildirim otomasyon hatası:', e.message);
    }
}

// Manuel tetikleme endpoint'i (admin için)
app.post('/api/bildirim-otomatik-tetikle', yetkiKontrol, async (req, res, next) => {
    try {
        const t = await bildirimUret_TerminYaklasan();
        const p = await bildirimUret_PasifTalep();
        const k = await bildirimUret_KritikStok();
        res.json({ ok: true, mesaj: `Üretildi: ${t} termin, ${p} pasif talep, ${k} kritik stok.` });
    } catch (e) { next(e); }
});

// ============================================================================
// GÜNLÜK SATINALMA RAPORU (PDF) — otomatik mail (Satınalma yetkilileri + Admin)
// ============================================================================
async function gunlukRaporVerisi() {
    const [geciken, yaklasan, bekleyenSiparis, bekleyenTalep, kritikStok, acikTalepC] = await Promise.all([
        pool.query(`SELECT s.siparis_no, COALESCE(t.firma_adi,'-') as tedarikci, s.termin_tarihi, s.durum,
                (CURRENT_DATE - s.termin_tarihi)::int as gun_gecti
            FROM satinalma_siparisleri s LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
            WHERE s.termin_tarihi < CURRENT_DATE
              AND s.durum NOT IN ('TAMAMLANDI','İPTAL','TAMAMLANDI ARŞİV','TAM TESLİM')
              AND COALESCE(s.arsiv,false)=false ORDER BY s.termin_tarihi ASC`),
        pool.query(`SELECT s.siparis_no, COALESCE(t.firma_adi,'-') as tedarikci, s.termin_tarihi, s.durum,
                (s.termin_tarihi - CURRENT_DATE)::int as kalan_gun
            FROM satinalma_siparisleri s LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
            WHERE s.termin_tarihi BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
              AND s.durum NOT IN ('TAMAMLANDI','İPTAL','TAMAMLANDI ARŞİV','TAM TESLİM')
              AND COALESCE(s.arsiv,false)=false ORDER BY s.termin_tarihi ASC`),
        pool.query(`SELECT s.siparis_no, COALESCE(t.firma_adi,'-') as tedarikci, s.siparis_tarihi
            FROM satinalma_siparisleri s LEFT JOIN tedarikciler t ON s.tedarikci_id=t.id
            WHERE s.durum='SİPARİŞ OLUŞTURULDU' AND COALESCE(s.arsiv,false)=false
            ORDER BY s.siparis_tarihi ASC`),
        pool.query(`SELECT talep_no, COALESCE(talep_eden,'-') as talep_eden, durum,
                EXTRACT(DAY FROM (NOW()-kayit_tarihi))::int as gun
            FROM satinalma_talepleri
            WHERE durum IN ('ONAY BEKLİYOR','ONAYLANDI') AND COALESCE(arsiv,false)=false
            ORDER BY kayit_tarihi ASC`),
        pool.query(`SELECT stok_kodu, stok_adi, guncel_stok_miktari, kritik_stok_miktari, birim
            FROM stok_kartlari
            WHERE kritik_stok_miktari IS NOT NULL AND kritik_stok_miktari>0
              AND guncel_stok_miktari < kritik_stok_miktari AND stok_tipi != 'Ürün'
            ORDER BY (guncel_stok_miktari::numeric/NULLIF(kritik_stok_miktari,0)) ASC`),
        pool.query(`SELECT COUNT(*)::int as n FROM satinalma_talepleri
            WHERE durum NOT IN ('TAMAMLANDI','REDDEDİLDİ','İPTAL','TAMAMLANDI ARŞİV') AND COALESCE(arsiv,false)=false`)
    ]);
    return { geciken: geciken.rows, yaklasan: yaklasan.rows, bekleyenSiparis: bekleyenSiparis.rows,
             bekleyenTalep: bekleyenTalep.rows, kritikStok: kritikStok.rows, acikTalep: acikTalepC.rows[0].n };
}

async function gunlukRaporPDF() {
    const v = await gunlukRaporVerisi();
    const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const trTarih = d => { if(!d) return '-'; const dt=new Date(d); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`; };
    const trNum = n => { const x=parseFloat(n)||0; return (x===Math.floor(x))?String(x):x.toFixed(2).replace('.',','); };
    const bos = m => `<div class="bos">✓ ${m}</div>`;
    const tablo = (rows, basliklar, satirFn, bosMsg) => rows.length
        ? `<table><thead><tr>${basliklar.map(b=>`<th${b.cls?` class="${b.cls}"`:''}>${b.t}</th>`).join('')}</tr></thead><tbody>${rows.map(satirFn).join('')}</tbody></table>`
        : bos(bosMsg);

    const tGeciken = tablo(v.geciken,
        [{t:'Sipariş'},{t:'Tedarikçi'},{t:'Termin'},{t:'Gecikme',cls:'text-center'},{t:'Durum'}],
        r=>`<tr><td>${esc(r.siparis_no)}</td><td>${esc(r.tedarikci)}</td><td>${trTarih(r.termin_tarihi)}</td><td class="text-center gun-gecti">${r.gun_gecti} gün</td><td>${esc(r.durum)}</td></tr>`,
        'Termini geçen sipariş yok.');
    const tYaklasan = tablo(v.yaklasan,
        [{t:'Sipariş'},{t:'Tedarikçi'},{t:'Termin'},{t:'Kalan',cls:'text-center'},{t:'Durum'}],
        r=>`<tr><td>${esc(r.siparis_no)}</td><td>${esc(r.tedarikci)}</td><td>${trTarih(r.termin_tarihi)}</td><td class="text-center gun-yakin">${r.kalan_gun<=0?'bugün':r.kalan_gun+' gün'}</td><td>${esc(r.durum)}</td></tr>`,
        'Termini yaklaşan sipariş yok.');
    const tBekleyenSip = tablo(v.bekleyenSiparis,
        [{t:'Sipariş'},{t:'Tedarikçi'},{t:'Tarih'}],
        r=>`<tr><td>${esc(r.siparis_no)}</td><td>${esc(r.tedarikci)}</td><td>${trTarih(r.siparis_tarihi)}</td></tr>`,
        'Onay bekleyen sipariş yok.');
    const tBekleyenTalep = tablo(v.bekleyenTalep,
        [{t:'Talep'},{t:'Talep Eden'},{t:'Durum'},{t:'Bekleme',cls:'text-center'}],
        r=>`<tr><td>${esc(r.talep_no)}</td><td>${esc(r.talep_eden)}</td><td>${esc(r.durum)}</td><td class="text-center${r.gun>=7?' gun-gecti':''}">${r.gun} gün</td></tr>`,
        'Bekleyen talep yok.');
    const tKritik = tablo(v.kritikStok,
        [{t:'Kod'},{t:'Stok'},{t:'Mevcut',cls:'text-end'},{t:'Kritik',cls:'text-end'}],
        r=>`<tr><td>${esc(r.stok_kodu)}</td><td>${esc(r.stok_adi)}</td><td class="text-end gun-gecti">${trNum(r.guncel_stok_miktari)} ${esc(r.birim||'')}</td><td class="text-end">${trNum(r.kritik_stok_miktari)} ${esc(r.birim||'')}</td></tr>`,
        'Kritik stok yok.');

    const simdi = new Date();
    const degerler = {
        'TARIH': trTarih(simdi),
        'URETIM_ZAMANI': `${trTarih(simdi)} ${String(simdi.getHours()).padStart(2,'0')}:${String(simdi.getMinutes()).padStart(2,'0')}`,
        'KPI_GECIKEN': String(v.geciken.length),
        'KPI_YAKLASAN': String(v.yaklasan.length),
        'KPI_BEKLEYEN_SIPARIS': String(v.bekleyenSiparis.length),
        'KPI_ACIK_TALEP': String(v.acikTalep),
        'KPI_KRITIK_STOK': String(v.kritikStok.length)
    };
    const fs = require('fs'); const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'templates', 'gunluk-rapor.html'), 'utf8');
    html = html.replace('{{TABLO_GECIKEN}}', tGeciken).replace('{{TABLO_YAKLASAN}}', tYaklasan)
               .replace('{{TABLO_BEKLEYEN_SIPARIS}}', tBekleyenSip).replace('{{TABLO_BEKLEYEN_TALEP}}', tBekleyenTalep)
               .replace('{{TABLO_KRITIK_STOK}}', tKritik);
    const tempName = `__gunluk_rapor_${Date.now()}`;
    fs.writeFileSync(path.join(__dirname, 'templates', tempName + '.html'), html);
    const pdf = await pdfRender(tempName, degerler);
    try { fs.unlinkSync(path.join(__dirname, 'templates', tempName + '.html')); } catch (e) {}
    return { pdf, ozet: degerler };
}

async function gunlukRaporGonder(testEmail) {
    if (!mailTransporter) { console.log('⚠️ Günlük rapor: mail kapalı'); return; }
    const { pdf, ozet } = await gunlukRaporPDF();
    let alicilar;
    if (testEmail) {
        alicilar = [testEmail];
    } else {
        const r = await pool.query(`SELECT email FROM kullanicilar
            WHERE rol IN ('SATINALMA','ADMIN') AND durum='AKTIF' AND email IS NOT NULL`);
        alicilar = [...new Set(r.rows.map(x => x.email))];
    }
    if (!alicilar.length) { console.log('⚠️ Günlük rapor: alıcı yok'); return; }
    const bugun = ozet.TARIH;
    await mailTransporter.sendMail({
        from: `"Aterko Workspace" <${MAIL_FROM_EMAIL}>`,
        to: alicilar.join(', '),
        subject: `Günlük Satınalma Raporu — ${bugun}`,
        html: `<div style="font-family:Arial,sans-serif;color:#212529;">
            <p>Merhaba,</p>
            <p>${bugun} tarihli günlük satınalma raporu ektedir.</p>
            <table style="border-collapse:collapse;font-size:14px;margin:10px 0;">
                <tr><td style="padding:3px 12px 3px 0;color:#dc3545;">Termini geçen sipariş:</td><td><strong>${ozet.KPI_GECIKEN}</strong></td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#fd7e14;">Termini yaklaşan:</td><td><strong>${ozet.KPI_YAKLASAN}</strong></td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#6f42c1;">Onay bekleyen sipariş:</td><td><strong>${ozet.KPI_BEKLEYEN_SIPARIS}</strong></td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#0d6efd;">Açık talep:</td><td><strong>${ozet.KPI_ACIK_TALEP}</strong></td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#6c757d;">Kritik stok:</td><td><strong>${ozet.KPI_KRITIK_STOK}</strong></td></tr>
            </table>
            <p style="color:#6c757d;font-size:12px;margin-top:16px;">Aterko Workspace — otomatik günlük rapor</p>
        </div>`,
        attachments: [{ filename: `Gunluk-Satinalma-Raporu-${bugun}.pdf`, content: pdf }]
    });
    console.log(`🗓️ Günlük satınalma raporu gönderildi → ${alicilar.length} alıcı${testEmail ? ' (TEST)' : ''}`);
}

// Manuel test (ADMIN) — raporu yalnızca isteyen kişiye gönderir
app.post('/api/gunluk-rapor-test', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.status(403).json({ ok:false, hata:'Sadece ADMIN.' });
    try {
        await gunlukRaporGonder(req.user.email);
        res.json({ ok: true, mesaj: `Test raporu ${req.user.email} adresine gönderildi.` });
    } catch (e) { res.status(500).json({ ok:false, hata: e.message }); }
});

// ============================================================================
// DASHBOARD (D-3) — Tek endpoint, tüm KPI'lar
// ============================================================================
app.get('/api/dashboard', yetkiKontrol, async (req, res, next) => {
    try {
        const [
            acikTalep, bekleyenSiparis, terminYaklasan, gecikenSiparis, kritikStok,
            acikIsEmri, yayindaTeslimat, sahaBekleyen, son7gunHareket,
            okunmamisBildirim, acikSevkiyat
        ] = await Promise.all([
            // Açık talepler (aktif, arşivlenmemiş, henüz tamamlanmamış)
            pool.query(`SELECT COUNT(*)::int as n FROM satinalma_talepleri
                WHERE durum NOT IN ('TAMAMLANDI','REDDEDİLDİ','İPTAL','TAMAMLANDI ARŞİV')
                AND COALESCE(arsiv,false)=false`),
            // Bekleyen sipariş onayları
            pool.query(`SELECT COUNT(*)::int as n FROM satinalma_siparisleri
                WHERE durum = 'ONAY BEKLİYOR' AND COALESCE(arsiv,false)=false`),
            // Termini yaklaşan (7 gün içi) siparişler
            pool.query(`SELECT COUNT(*)::int as n FROM satinalma_siparisleri
                WHERE termin_tarihi BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
                AND durum NOT IN ('TAMAMLANDI','İPTAL','TAMAMLANDI ARŞİV','TAM TESLİM')
                AND COALESCE(arsiv,false)=false`),
            // Termini geçmiş (gecikmiş) siparişler — kritik
            pool.query(`SELECT COUNT(*)::int as n FROM satinalma_siparisleri
                WHERE termin_tarihi < CURRENT_DATE
                AND durum NOT IN ('TAMAMLANDI','İPTAL','TAMAMLANDI ARŞİV','TAM TESLİM')
                AND COALESCE(arsiv,false)=false`),
            // Kritik stok altı
            pool.query(`SELECT COUNT(*)::int as n FROM stok_kartlari
                WHERE kritik_stok_miktari IS NOT NULL AND kritik_stok_miktari > 0
                AND guncel_stok_miktari < kritik_stok_miktari`),
            // Açık iş emirleri
            pool.query(`SELECT COUNT(*)::int as n FROM uretim_is_emirleri
                WHERE durum IN ('HAZIR','UYGULANIYOR')`),
            // Yayında teslimatlar
            pool.query(`SELECT COUNT(*)::int as n FROM proje_teslimatlari
                WHERE urun_listesi_yayin_durumu = 'YAYINDA'`),
            // Sahaya gelmiş ama henüz uygulanmamış (montaj bekleyen)
            pool.query(`SELECT COUNT(*)::int as n FROM teslimat_urunleri
                WHERE saha_teslim_miktar > COALESCE(uygulanan_miktar,0)`),
            // Son 7 gündeki stok hareketleri
            pool.query(`SELECT COUNT(*)::int as n FROM stok_hareketleri
                WHERE tarih >= NOW() - INTERVAL '7 days'`),
            // Okunmamış bildirim
            pool.query(`SELECT COUNT(*)::int as n FROM bildirimler
                WHERE (kullanici_email = $1 OR kullanici_email IS NULL) AND okundu = FALSE`,
                [req.user.email]),
            // Açık sevkiyat belgesi (Hazırlanıyor + Yolda)
            pool.query(`SELECT COUNT(*)::int as n FROM sevkiyat_belgeleri
                WHERE durum IN ('HAZIRLANIYOR','YOLDA')`)
        ]);

        // Son hareketler özeti (son 10 stok hareketi + son 5 bildirim karışık)
        const sonHareketler = await pool.query(`
            (SELECT 'stok' as kaynak, sh.id, sh.tip as durum,
                    COALESCE(sk.stok_adi, 'Stok') as baslik,
                    CONCAT(sh.tip, ': ', sh.miktar, ' ', COALESCE(sk.birim,''), ' — ', COALESCE(sh.aciklama,'')) as ozet,
                    sh.tarih as tarih, sh.kullanici_adsoyad as kim
             FROM stok_hareketleri sh
             LEFT JOIN stok_kartlari sk ON sh.stok_kart_id = sk.id
             ORDER BY sh.tarih DESC LIMIT 6)
            UNION ALL
            (SELECT 'talep' as kaynak, t.id, t.durum,
                    CONCAT('Talep: ', t.talep_no) as baslik,
                    CONCAT('Talep eden: ', COALESCE(t.talep_eden,'-')) as ozet,
                    t.kayit_tarihi as tarih, t.talep_eden as kim
             FROM satinalma_talepleri t
             WHERE COALESCE(t.arsiv,false)=false
             ORDER BY t.kayit_tarihi DESC LIMIT 4)
            ORDER BY tarih DESC LIMIT 10
        `);

        // Termin yaklaşan + gecikmiş ilk 10 sipariş (gecikmiş önce)
        const terminDetay = await pool.query(`
            SELECT s.id, s.siparis_no, s.termin_tarihi, s.durum,
                   t.firma_adi as tedarikci,
                   (s.termin_tarihi - CURRENT_DATE)::int as kalan_gun
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            WHERE s.termin_tarihi IS NOT NULL
              AND s.termin_tarihi <= CURRENT_DATE + INTERVAL '14 days'
              AND s.durum NOT IN ('TAMAMLANDI','İPTAL','TAMAMLANDI ARŞİV','TAM TESLİM')
              AND COALESCE(s.arsiv,false)=false
            ORDER BY s.termin_tarihi ASC LIMIT 10
        `);

        // Kritik stok ilk 5
        const kritikStokDetay = await pool.query(`
            SELECT id, stok_kodu, stok_adi, guncel_stok_miktari, kritik_stok_miktari, birim
            FROM stok_kartlari
            WHERE kritik_stok_miktari IS NOT NULL AND kritik_stok_miktari > 0
              AND guncel_stok_miktari < kritik_stok_miktari
            ORDER BY (guncel_stok_miktari::numeric / NULLIF(kritik_stok_miktari,0)) ASC
            LIMIT 5
        `);

        res.json({
            ok: true,
            kpi: {
                acikTalep:        acikTalep.rows[0].n,
                bekleyenSiparis:  bekleyenSiparis.rows[0].n,
                terminYaklasan:   terminYaklasan.rows[0].n,
                gecikenSiparis:   gecikenSiparis.rows[0].n,
                kritikStok:       kritikStok.rows[0].n,
                acikIsEmri:       acikIsEmri.rows[0].n,
                yayindaTeslimat:  yayindaTeslimat.rows[0].n,
                sahaBekleyen:     sahaBekleyen.rows[0].n,
                son7gunHareket:   son7gunHareket.rows[0].n,
                okunmamisBildirim: okunmamisBildirim.rows[0].n,
                acikSevkiyat:     acikSevkiyat.rows[0].n
            },
            sonHareketler:    sonHareketler.rows,
            terminDetay:      terminDetay.rows,
            kritikStokDetay:  kritikStokDetay.rows
        });
    } catch (e) { next(e); }
});

// Bildirim sil (kullanıcının kendi bildirimi)
app.delete('/api/bildirim-sil/:id', yetkiKontrol, async (req, res, next) => {
    try {
        await pool.query(`
            DELETE FROM bildirimler
            WHERE id = $1 AND kullanici_email = $2
        `, [req.params.id, req.user.email]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// ============================================================================
// FAZ B-2: ÜRETİM MODÜLÜ
// ============================================================================

// Yayında olan tüm ürün satırlarını cross-teslimat olarak listele
// (Üretim sekmesinde tek bir tablo, hangi binanın hangi ürünü olduğu görünür)
app.get('/api/uretim-urunleri', yetkiKontrol, async (req, res, next) => {
    try {
        const q = `
            SELECT tu.id, tu.teslimat_id, tu.miktar as gerekli_miktar,
                   tu.uretilen_miktar, tu.stoktan_ayrilan_miktar, tu.sevk_edilen_miktar,
                   tu.is_ek_urun, tu.ek_urun_onay_durumu, tu.aciklama,
                   tu.stok_kart_id, tu.ozel_urun_adi, tu.ozel_urun_birim,
                   tu.talep_urun_id,
                   sk.stok_kodu, sk.stok_adi, sk.stok_tipi, sk.birim as stok_birim,
                   sk.guncel_stok_miktari, sk.kategori,
                   pt.bina_adi, pt.bina_turu, pt.bina_tipi, pt.buyukluk_m2,
                   pt.bina_adedi, pt.konteyner_miktari,
                   p.proje_kodu, p.musteri_adi, p.proje_adi, p.id as proje_id,
                   -- Bağlı satınalma talebi (varsa)
                   tlpu.id as bagli_talep_urun_id,
                   tlp.id as bagli_talep_id,
                   tlp.talep_no as bagli_talep_no,
                   tlpu.durum as bagli_talep_durum,
                   -- Aktif iş emirlerinde atanmış toplam miktar
                   COALESCE((
                       SELECT SUM(iek.atanan_miktar - COALESCE(iek.tamamlanan_miktar,0))
                       FROM uretim_is_emri_kalemleri iek
                       JOIN uretim_is_emirleri ie ON iek.is_emri_id=ie.id
                       WHERE iek.teslimat_urun_id=tu.id AND ie.durum IN ('HAZIR','UYGULANIYOR')
                   ), 0) as is_emrinde_bekleyen_miktar
            FROM teslimat_urunleri tu
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            JOIN projeler p ON pt.proje_id=p.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
            LEFT JOIN talep_urunleri tlpu ON tu.talep_urun_id=tlpu.id
            LEFT JOIN satinalma_talepleri tlp ON tlpu.talep_id=tlp.id
            WHERE pt.urun_listesi_yayin_durumu='YAYINDA'
            AND (tu.is_ek_urun = FALSE OR tu.ek_urun_onay_durumu='ONAYLI')  -- onay bekleyen ek ürünler henüz aktif değil
            ORDER BY p.id DESC, pt.id ASC, tu.sira ASC, tu.id ASC
        `;
        const r = await pool.query(q);
        const data = r.rows.map(u => {
            const gerekli = parseFloat(u.gerekli_miktar) || 0;
            const uretilen = parseFloat(u.uretilen_miktar) || 0;
            const stoktan = parseFloat(u.stoktan_ayrilan_miktar) || 0;
            const sevk = parseFloat(u.sevk_edilen_miktar) || 0;
            const bekleyen = parseFloat(u.is_emrinde_bekleyen_miktar) || 0;
            const sevke_hazir = uretilen + stoktan - sevk;
            // Üretilmesi gereken kalan: gerekli - (üretilen + stoktan ayrılmış) - bekleyen iş emri
            const uretilmesi_kalan = Math.max(0, gerekli - uretilen - stoktan - bekleyen);
            let durum = 'BEKLEMEDE';
            if (sevke_hazir >= gerekli) durum = 'HAZIR';
            else if (uretilen > 0 || stoktan > 0 || bekleyen > 0) durum = 'KISMI';
            return { ...u, sevke_hazir, uretilmesi_kalan, kalem_durumu: durum };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

// Yeni iş emri oluştur (cross-teslimat çoklu kalem)
// Body: { ustabasi_adi, notlar, kalemler: [{teslimat_urun_id, atanan_miktar}] }
app.post('/api/uretim-is-emri-olustur', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { ustabasi_adi, notlar, kalemler } = req.body;
        if (!Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'En az 1 kalem seçilmeli.' });
        }
        const gecerli = kalemler.filter(k => k.teslimat_urun_id && parseFloat(k.atanan_miktar) > 0);
        if (gecerli.length === 0) return res.json({ ok: false, hata: 'Geçerli miktar girilmedi.' });

        // İş emri no üret
        const c = await client.query("SELECT COUNT(*)::int as n FROM uretim_is_emirleri");
        const emir_no = `IE-${10001 + c.rows[0].n}`;

        // Başlık
        const ie = await client.query(`
            INSERT INTO uretim_is_emirleri (emir_no, ustabasi_adi, durum, olusturan_email, notlar)
            VALUES ($1, $2, 'HAZIR', $3, $4) RETURNING id
        `, [emir_no, ustabasi_adi || null, req.user.email, notlar || null]);
        const ieId = ie.rows[0].id;

        for (const k of gecerli) {
            await client.query(`
                INSERT INTO uretim_is_emri_kalemleri (is_emri_id, teslimat_urun_id, atanan_miktar)
                VALUES ($1, $2, $3)
            `, [ieId, k.teslimat_urun_id, parseFloat(k.atanan_miktar)]);
        }

        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'CREATE', tablo: 'uretim_is_emirleri', kayit_id: ieId, kayit_no: emir_no,
            ozet: `Üretim iş emri oluşturuldu (${gecerli.length} kalem) — Ustabaşı: ${ustabasi_adi || '-'}`
        });
        res.json({ ok: true, mesaj: `${emir_no} oluşturuldu, ${gecerli.length} kalem atandı.`, emir_no, is_emri_id: ieId });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// İş emirleri listesi (özetli)
app.get('/api/uretim-is-emirleri', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT ie.*,
                   COUNT(iek.id)::int as kalem_sayisi,
                   COALESCE(SUM(iek.atanan_miktar),0) as toplam_atanan,
                   COALESCE(SUM(iek.tamamlanan_miktar),0) as toplam_tamamlanan
            FROM uretim_is_emirleri ie
            LEFT JOIN uretim_is_emri_kalemleri iek ON ie.id=iek.is_emri_id
            GROUP BY ie.id
            ORDER BY ie.id DESC
        `);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// İş emri detay (kalemleri ile)
app.get('/api/uretim-is-emri-detay/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.params;
        const baslik = await pool.query('SELECT * FROM uretim_is_emirleri WHERE id=$1', [id]);
        if (baslik.rowCount === 0) return res.json({ ok: false, hata: 'İş emri bulunamadı.' });
        const kalemler = await pool.query(`
            SELECT iek.*,
                   tu.miktar as listedeki_miktar, tu.ozel_urun_adi, tu.ozel_urun_birim,
                   sk.stok_kodu, sk.stok_adi, sk.birim as stok_birim,
                   pt.bina_adi, pt.bina_turu, p.proje_kodu, p.musteri_adi
            FROM uretim_is_emri_kalemleri iek
            JOIN teslimat_urunleri tu ON iek.teslimat_urun_id=tu.id
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            JOIN projeler p ON pt.proje_id=p.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
            WHERE iek.is_emri_id=$1
            ORDER BY iek.id
        `, [id]);
        res.json({ ok: true, baslik: baslik.rows[0], kalemler: kalemler.rows });
    } catch (e) { next(e); }
});

// İş emrinde kalemleri tamamlama (kısmi veya tam) — uretilen_miktar artar
// Body: { is_emri_id, kalemler: [{kalem_id, tamamlanan_miktar}] }
app.post('/api/uretim-is-emri-tamamla', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { is_emri_id, kalemler } = req.body;
        if (!is_emri_id || !Array.isArray(kalemler)) {
            return res.json({ ok: false, hata: 'Geçersiz veri.' });
        }

        for (const k of kalemler) {
            const yeniMiktar = parseFloat(k.tamamlanan_miktar);
            if (!(yeniMiktar >= 0)) continue;

            // Kalemin mevcut durumunu al
            const mevcut = await client.query(`
                SELECT atanan_miktar, COALESCE(tamamlanan_miktar,0) as eski_tamam, teslimat_urun_id
                FROM uretim_is_emri_kalemleri WHERE id=$1 AND is_emri_id=$2
            `, [k.kalem_id, is_emri_id]);
            if (mevcut.rowCount === 0) continue;
            const m = mevcut.rows[0];
            const sinir = parseFloat(m.atanan_miktar);
            const nihai = Math.min(yeniMiktar, sinir); // Atanan miktardan fazla olmasın
            const fark = nihai - parseFloat(m.eski_tamam);

            // Kalem güncelle
            await client.query(`UPDATE uretim_is_emri_kalemleri SET tamamlanan_miktar=$1 WHERE id=$2`,
                [nihai, k.kalem_id]);

            // teslimat_urunleri.uretilen_miktar'ı farkı kadar artır/azalt
            await client.query(`
                UPDATE teslimat_urunleri SET uretilen_miktar = COALESCE(uretilen_miktar,0) + $1 WHERE id=$2
            `, [fark, m.teslimat_urun_id]);
        }

        // İş emrinin genel durumunu güncelle
        const ozet = await client.query(`
            SELECT COALESCE(SUM(atanan_miktar),0) as atanan,
                   COALESCE(SUM(tamamlanan_miktar),0) as tamamlanan
            FROM uretim_is_emri_kalemleri WHERE is_emri_id=$1
        `, [is_emri_id]);
        const { atanan, tamamlanan } = ozet.rows[0];
        let yeniDurum = 'HAZIR';
        if (parseFloat(tamamlanan) >= parseFloat(atanan) && parseFloat(atanan) > 0) yeniDurum = 'TAMAMLANDI';
        else if (parseFloat(tamamlanan) > 0) yeniDurum = 'UYGULANIYOR';

        const tamamlanmaTarihi = yeniDurum === 'TAMAMLANDI' ? 'NOW()' : 'NULL';
        await client.query(`
            UPDATE uretim_is_emirleri SET durum=$1, tamamlanma_tarihi=${tamamlanmaTarihi}
            WHERE id=$2
        `, [yeniDurum, is_emri_id]);

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'İş emri güncellendi.', durum: yeniDurum });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Üretim Planı'ndan seçili kalemleri stoktan karşıla (manuel rezervasyon)
// Body: { kalemler: [{teslimat_urun_id, miktar}] }
app.post('/api/uretim-stoktan-karsila', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kalemler } = req.body;
        if (!Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }

        let basarili = 0, hatalar = [];
        for (const k of kalemler) {
            const miktar = parseFloat(k.miktar);
            if (!(miktar > 0)) continue;

            // Kalem bilgisini al
            const tu = await client.query(`
                SELECT tu.*, sk.guncel_stok_miktari, sk.stok_adi, sk.stok_kodu, sk.birim,
                       pt.proje_id
                FROM teslimat_urunleri tu
                LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
                JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
                WHERE tu.id=$1
            `, [k.teslimat_urun_id]);
            if (tu.rowCount === 0) { hatalar.push(`Kalem #${k.teslimat_urun_id} bulunamadı`); continue; }
            const row = tu.rows[0];

            if (!row.stok_kart_id) { hatalar.push(`${row.ozel_urun_adi || 'Özel ürün'} stoktan karşılanamaz — stok kartı yok`); continue; }

            // Stok kontrolü
            const mevcutStok = parseFloat(row.guncel_stok_miktari) || 0;
            if (mevcutStok < miktar) {
                hatalar.push(`${row.stok_adi}: stokta ${mevcutStok} ${row.birim} var, ${miktar} istendi — yetersiz`);
                continue;
            }

            // Sayaç güncelle
            await client.query(`
                UPDATE teslimat_urunleri SET stoktan_ayrilan_miktar = COALESCE(stoktan_ayrilan_miktar,0) + $1
                WHERE id=$2
            `, [miktar, k.teslimat_urun_id]);

            // Stok hareket kaydı (Çıkış - Sevkiyat Rezervi)
            await client.query(`
                INSERT INTO stok_hareketleri (stok_kart_id, tip, miktar, proje_id, aciklama, kullanici_email, kullanici_adsoyad)
                VALUES ($1, 'Çıkış', $2, $3, $4, $5, $6)
            `, [row.stok_kart_id, miktar, row.proje_id,
                `Sevkiyat Rezervi (Teslimat #${row.teslimat_id} ürün listesi)`,
                req.user.email, req.user.adSoyad]);

            // Stok kartı bakiyesini düş
            await client.query(`
                UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) - $1
                WHERE id=$2
            `, [miktar, row.stok_kart_id]);

            basarili++;
        }

        await client.query('COMMIT');
        if (hatalar.length > 0 && basarili === 0) {
            return res.json({ ok: false, hata: hatalar.join(' | ') });
        }
        res.json({
            ok: true,
            mesaj: `${basarili} kalem stoktan ayrıldı.` + (hatalar.length > 0 ? ` Uyarı: ${hatalar.length} kalem işlenemedi.` : ''),
            hatalar: hatalar
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Üretim Planı'ndan seçili kalemler için cross-teslimat satınalma talebi oluştur
// Body: { kalemler: [{teslimat_urun_id, miktar}], istenen_tarih, teslim_yeri, genel_aciklama }
// NOT: Cross-teslimat olabilir, ama bir talep tek projeye bağlı olmalı.
// Aynı projeden gelenleri grupla — birden çok proje varsa hata ver veya birden çok talep aç.
app.post('/api/uretim-satinalma-talebi-olustur', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kalemler, istenen_tarih, teslim_yeri, genel_aciklama } = req.body;
        if (!Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }

        // Kalem detaylarını + proje_id'lerini topla
        const ids = kalemler.map(k => k.teslimat_urun_id).filter(Boolean);
        const r = await client.query(`
            SELECT tu.id, tu.stok_kart_id, tu.ozel_urun_adi, tu.ozel_urun_birim, tu.aciklama,
                   pt.proje_id, pt.bina_adi
            FROM teslimat_urunleri tu
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            WHERE tu.id = ANY($1::int[])
        `, [ids]);

        // Proje bazında grupla
        const byProje = {};
        for (const row of r.rows) {
            const m = kalemler.find(k => k.teslimat_urun_id === row.id);
            if (!m || !(parseFloat(m.miktar) > 0)) continue;
            if (!byProje[row.proje_id]) byProje[row.proje_id] = [];
            byProje[row.proje_id].push({ ...row, talep_miktari: parseFloat(m.miktar) });
        }

        const olusturulanTalepler = [];
        for (const [projeId, kalemlerListe] of Object.entries(byProje)) {
            // Proje kodunu al
            const pR = await client.query('SELECT proje_kodu FROM projeler WHERE id=$1', [projeId]);
            const projeKodu = pR.rows[0]?.proje_kodu || 'GENEL';
            // Yeni format: ProjeNo-T-NNNN
            const seqRes = await client.query("SELECT nextval('talep_no_seq') as no");
            const talep_no = `${projeKodu}-T-${seqRes.rows[0].no}`;

            const tIns = await client.query(`
                INSERT INTO satinalma_talepleri (talep_no, proje_id, talep_eden, istenen_tarih, teslim_yeri, genel_aciklama, durum)
                VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR') RETURNING id
            `, [talep_no, projeId, req.user.adSoyad, istenen_tarih || null,
                teslim_yeri || 'Merkez Depo',
                genel_aciklama || `Üretim modülünden otomatik: ${kalemlerListe.length} kalem`]);
            const talepId = tIns.rows[0].id;

            for (const k of kalemlerListe) {
                const tuRow = await client.query('SELECT stok_birim FROM teslimat_urunleri tu LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id LEFT JOIN LATERAL (SELECT sk.birim as stok_birim) bn ON true WHERE tu.id=$1', [k.id]).catch(()=>({rowCount:0}));
                const yk = await client.query(`
                    INSERT INTO talep_urunleri (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                    VALUES ($1,$2,$3,$4,$5,$6,'ONAY BEKLİYOR') RETURNING id
                `, [talepId, k.stok_kart_id, k.ozel_urun_adi, k.ozel_urun_birim,
                    k.talep_miktari, k.aciklama || `Üretim Planı'ndan: ${k.bina_adi}`]);
                // Bağlantıyı kur — ürün listesindeki kalem hangi talebe gitti
                await client.query(`UPDATE teslimat_urunleri SET talep_urun_id=$1, durum='TALEP EDILDI' WHERE id=$2`,
                    [yk.rows[0].id, k.id]);
            }
            olusturulanTalepler.push({ talep_no, talep_id: talepId, kalem_sayisi: kalemlerListe.length, proje_id: projeId });
        }

        await client.query('COMMIT');
        const ozet = olusturulanTalepler.map(t => `${t.talep_no} (${t.kalem_sayisi} kalem)`).join(', ');
        res.json({
            ok: true,
            mesaj: `${olusturulanTalepler.length} satınalma talebi oluşturuldu: ${ozet}`,
            talepler: olusturulanTalepler
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// ============================================================================
// FAZ B-4: MONTAJ MODÜLÜ
// ============================================================================

// Montaja düşmüş teslimatlar: montaj_gerekli=true VE en az bir kalemi sahaya teslim olmuş
app.get('/api/montaj-teslimatlar', yetkiKontrol, async (req, res, next) => {
    try {
        const q = `
            SELECT pt.id as teslimat_id, pt.bina_adi, pt.bina_turu, pt.bina_tipi,
                   pt.buyukluk_m2, pt.bina_yeri,
                   p.proje_kodu, p.musteri_adi, p.proje_adi, p.id as proje_id,
                   COALESCE(SUM(tu.miktar), 0) as toplam_gerekli,
                   COALESCE(SUM(tu.saha_teslim_miktar), 0) as toplam_saha,
                   COALESCE(SUM(tu.uygulanan_miktar), 0) as toplam_uygulanan,
                   COALESCE(SUM(tu.teslim_edilen_miktar), 0) as toplam_teslim
            FROM proje_teslimatlari pt
            JOIN projeler p ON pt.proje_id=p.id
            LEFT JOIN teslimat_urunleri tu ON tu.teslimat_id=pt.id
                AND (tu.is_ek_urun = FALSE OR tu.ek_urun_onay_durumu='ONAYLI')
            WHERE pt.montaj_gerekli = TRUE
              AND pt.urun_listesi_yayin_durumu = 'YAYINDA'
            GROUP BY pt.id, p.id
            HAVING COALESCE(SUM(tu.saha_teslim_miktar), 0) > 0
            ORDER BY pt.id DESC
        `;
        const r = await pool.query(q);
        const data = r.rows.map(t => {
            const ger = parseFloat(t.toplam_gerekli) || 0;
            const sah = parseFloat(t.toplam_saha) || 0;
            const uyg = parseFloat(t.toplam_uygulanan) || 0;
            const tes = parseFloat(t.toplam_teslim) || 0;
            let durum = 'BEKLEMEDE';
            if (tes >= ger && ger > 0) durum = 'TESLIM';
            else if (uyg >= sah && sah > 0) durum = 'UYGULANDI';   // uygulama bitti, teslim bekliyor
            else if (uyg > 0) durum = 'UYGULANIYOR';
            else durum = 'SAHADA';
            return { ...t, durum, ilerleme_yuzde: ger > 0 ? Math.round((tes / ger) * 100) : 0 };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

// Bir teslimatın montaj odaklı ürün listesi
app.get('/api/montaj-teslimat-urunleri/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;
        const baslik = await pool.query(`
            SELECT pt.*, p.proje_kodu, p.musteri_adi, p.proje_adi
            FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id=p.id
            WHERE pt.id=$1
        `, [teslimatId]);
        if (baslik.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });

        const r = await pool.query(`
            SELECT tu.*,
                   sk.stok_kodu, sk.stok_adi, sk.birim as stok_birim
            FROM teslimat_urunleri tu
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
            WHERE tu.teslimat_id=$1
            AND (tu.is_ek_urun = FALSE OR tu.ek_urun_onay_durumu='ONAYLI')
            ORDER BY tu.sira ASC, tu.id ASC
        `, [teslimatId]);

        const data = r.rows.map(u => {
            const ger = parseFloat(u.miktar) || 0;
            const sah = parseFloat(u.saha_teslim_miktar) || 0;
            const uyg = parseFloat(u.uygulanan_miktar) || 0;
            const tes = parseFloat(u.teslim_edilen_miktar) || 0;
            const sahaBekleyen = Math.max(0, sah - uyg);             // sahaya geldi ama uygulanmamış
            const uygulamaBekleyen = Math.max(0, uyg - tes);         // uygulandı, müşteri teslimi bekliyor
            let durum = 'SAHADA';
            if (tes >= ger) durum = 'TESLIM';
            else if (uyg >= sah && sah > 0) durum = 'UYGULANDI';
            else if (uyg > 0) durum = 'UYGULANIYOR';
            else if (sah > 0) durum = 'SAHADA';
            else durum = 'BEKLEMEDE';
            return { ...u, sahaBekleyen, uygulamaBekleyen, kalem_durumu: durum };
        });
        res.json({ ok: true, baslik: baslik.rows[0], data });
    } catch (e) { next(e); }
});

// Uygulama kaydet — kalemler için uygulanan_miktar artırılır
// Body: { kalemler: [{teslimat_urun_id, fark_miktar}] }
// fark_miktar = bu sefer eklenecek uygulama miktarı (delta), mutlak değer değil
app.post('/api/montaj-uygulama-kaydet', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { kalemler } = req.body;
        if (!Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }

        let kayit = 0, hatalar = [];
        for (const k of kalemler) {
            const fark = parseFloat(k.fark_miktar);
            if (!(fark > 0)) continue;

            // Mevcut durumu al
            const tu = await client.query(`
                SELECT tu.uygulanan_miktar, tu.saha_teslim_miktar,
                       sk.stok_adi, tu.ozel_urun_adi
                FROM teslimat_urunleri tu
                LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
                WHERE tu.id=$1
            `, [k.teslimat_urun_id]);
            if (tu.rowCount === 0) { hatalar.push(`Kalem #${k.teslimat_urun_id} yok`); continue; }
            const row = tu.rows[0];
            const ad = row.stok_adi || row.ozel_urun_adi || `Kalem #${k.teslimat_urun_id}`;

            const mevcutUyg = parseFloat(row.uygulanan_miktar) || 0;
            const sah = parseFloat(row.saha_teslim_miktar) || 0;
            // Toplam uygulanan saha_teslim'i geçemez
            const yeniUyg = mevcutUyg + fark;
            if (yeniUyg > sah + 0.0001) {
                hatalar.push(`${ad}: sahada ${sah - mevcutUyg} kaldı, +${fark} eklenemez`);
                continue;
            }

            await client.query(`
                UPDATE teslimat_urunleri SET uygulanan_miktar = COALESCE(uygulanan_miktar,0) + $1
                WHERE id=$2
            `, [fark, k.teslimat_urun_id]);

            await client.query(`
                INSERT INTO montaj_hareketleri (teslimat_urun_id, hareket_tipi, miktar, kullanici_email, notlar)
                VALUES ($1, 'UYGULANDI', $2, $3, $4)
            `, [k.teslimat_urun_id, fark, req.user.email, k.notlar || null]);
            kayit++;
        }

        if (kayit === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, hata: 'Hiçbir kalem işlenemedi: ' + (hatalar.join(' | ') || 'geçerli miktar yok') });
        }

        await client.query('COMMIT');
        res.json({
            ok: true,
            mesaj: `${kayit} kalem için uygulama kaydedildi.` + (hatalar.length ? ` Uyarı: ${hatalar.length}` : ''),
            hatalar
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Müşteri teslimi — teslimatın tüm uygulanan miktarları teslim_edilen'e geçer
// Body: { teslimat_id, notlar }
app.post('/api/montaj-musteri-teslim', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { teslimat_id, notlar } = req.body;

        // Teslimatın kalemlerini al — uygulanan - teslim_edilen = teslim edilecek miktar
        const kalemler = await client.query(`
            SELECT id, uygulanan_miktar, teslim_edilen_miktar
            FROM teslimat_urunleri
            WHERE teslimat_id=$1
            AND (is_ek_urun = FALSE OR ek_urun_onay_durumu='ONAYLI')
        `, [teslimat_id]);

        let kayit = 0;
        for (const k of kalemler.rows) {
            const uyg = parseFloat(k.uygulanan_miktar) || 0;
            const tes = parseFloat(k.teslim_edilen_miktar) || 0;
            const fark = uyg - tes;
            if (fark <= 0) continue;

            await client.query(`
                UPDATE teslimat_urunleri SET teslim_edilen_miktar = COALESCE(teslim_edilen_miktar,0) + $1
                WHERE id=$2
            `, [fark, k.id]);

            await client.query(`
                INSERT INTO montaj_hareketleri (teslimat_urun_id, hareket_tipi, miktar, kullanici_email, notlar)
                VALUES ($1, 'MUSTERIYE_TESLIM', $2, $3, $4)
            `, [k.id, fark, req.user.email,
                notlar || `Bina (teslimat #${teslimat_id}) müşteriye teslim`]);
            kayit++;
        }

        if (kayit === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, hata: 'Müşteriye teslim edilecek uygulanmış kalem yok.' });
        }

        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'DELIVER', tablo: 'proje_teslimatlari', kayit_id: teslimat_id,
            ozet: `Müşteriye teslim: ${kayit} kalem`
        });
        res.json({ ok: true, mesaj: `${kayit} kalem müşteriye teslim edildi.` });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Montaj hareketleri log'u (bir teslimat için)
app.get('/api/montaj-hareketleri/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT mh.*, tu.ozel_urun_adi, sk.stok_kodu, sk.stok_adi
            FROM montaj_hareketleri mh
            JOIN teslimat_urunleri tu ON mh.teslimat_urun_id=tu.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
            WHERE tu.teslimat_id=$1
            ORDER BY mh.kayit_tarihi DESC, mh.id DESC
        `, [req.params.teslimatId]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// ============================================================================
// FAZ B-3: SEVKİYAT MODÜLÜ
// ============================================================================

// Sevke hazır kalemleri listele (sevkeHazir > sevk_edilen olanlar)
app.get('/api/sevkiyat-urunleri', yetkiKontrol, async (req, res, next) => {
    try {
        const q = `
            SELECT tu.id, tu.teslimat_id, tu.miktar as gerekli_miktar,
                   tu.uretilen_miktar, tu.stoktan_ayrilan_miktar, tu.sevk_edilen_miktar,
                   tu.is_ek_urun, tu.ek_urun_onay_durumu,
                   tu.stok_kart_id, tu.ozel_urun_adi, tu.ozel_urun_birim,
                   sk.stok_kodu, sk.stok_adi, sk.birim as stok_birim,
                   pt.bina_adi, pt.bina_turu, pt.bina_tipi, pt.buyukluk_m2,
                   p.proje_kodu, p.musteri_adi, p.proje_adi, p.id as proje_id
            FROM teslimat_urunleri tu
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            JOIN projeler p ON pt.proje_id=p.id
            LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
            WHERE pt.urun_listesi_yayin_durumu='YAYINDA'
            AND (tu.is_ek_urun = FALSE OR tu.ek_urun_onay_durumu='ONAYLI')
            ORDER BY p.id DESC, pt.id ASC, tu.sira ASC, tu.id ASC
        `;
        const r = await pool.query(q);
        const data = r.rows.map(u => {
            const gerekli = parseFloat(u.gerekli_miktar) || 0;
            const uretilen = parseFloat(u.uretilen_miktar) || 0;
            const stoktan = parseFloat(u.stoktan_ayrilan_miktar) || 0;
            const sevk = parseFloat(u.sevk_edilen_miktar) || 0;
            const sevke_hazir = Math.max(0, uretilen + stoktan - sevk);
            const sevk_edilebilir = sevke_hazir; // sevkedilebilir hazır olandır
            let durum = 'BEKLEMEDE';
            if (sevk >= gerekli) durum = 'TUM_SEVK';
            else if (sevk > 0) durum = 'KISMI_SEVK';
            else if (sevke_hazir > 0) durum = 'SEVKE_HAZIR';
            return { ...u, sevke_hazir, sevk_edilebilir, kalem_durumu: durum };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

// Yeni sevkiyat belgesi oluştur (cross-teslimat)
// Body: { plaka, sofor_adi, sofor_telefon, irsaliye_no, sevk_tarihi, notlar,
//         kalemler: [{teslimat_urun_id, miktar}] }
app.post('/api/sevkiyat-belgesi-olustur', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { plaka, sofor_adi, sofor_telefon, irsaliye_no, sevk_tarihi, notlar, kalemler } = req.body;
        if (!Array.isArray(kalemler) || kalemler.length === 0) {
            return res.json({ ok: false, hata: 'Kalem seçilmedi.' });
        }
        if (!plaka || !plaka.trim()) return res.json({ ok: false, hata: 'Plaka zorunlu.' });

        // Sevkiyat no üret
        const c = await client.query("SELECT COUNT(*)::int as n FROM sevkiyat_belgeleri");
        const sevkiyat_no = `SVK-${10001 + c.rows[0].n}`;

        const sb = await client.query(`
            INSERT INTO sevkiyat_belgeleri (sevkiyat_no, plaka, sofor_adi, sofor_telefon,
                irsaliye_no, sevk_tarihi, durum, olusturan_email, notlar)
            VALUES ($1, $2, $3, $4, $5, $6, 'HAZIRLANIYOR', $7, $8) RETURNING id
        `, [sevkiyat_no, plaka.trim(), sofor_adi || null, sofor_telefon || null,
            irsaliye_no || null, sevk_tarihi || null, req.user.email, notlar || null]);
        const sbId = sb.rows[0].id;

        // Her kalem için: sevk edilebilir kontrolü + kayıt + sayaç güncelle
        let kayit = 0, hatalar = [];
        for (const k of kalemler) {
            const miktar = parseFloat(k.miktar);
            if (!(miktar > 0)) continue;

            const tu = await client.query(`
                SELECT tu.uretilen_miktar, tu.stoktan_ayrilan_miktar, tu.sevk_edilen_miktar,
                       tu.miktar as gerekli, sk.stok_adi, tu.ozel_urun_adi
                FROM teslimat_urunleri tu
                LEFT JOIN stok_kartlari sk ON tu.stok_kart_id=sk.id
                WHERE tu.id=$1
            `, [k.teslimat_urun_id]);
            if (tu.rowCount === 0) { hatalar.push(`Kalem #${k.teslimat_urun_id} yok`); continue; }
            const row = tu.rows[0];
            const sevkeHazir = (parseFloat(row.uretilen_miktar)||0) + (parseFloat(row.stoktan_ayrilan_miktar)||0) - (parseFloat(row.sevk_edilen_miktar)||0);
            const ad = row.stok_adi || row.ozel_urun_adi || `Kalem #${k.teslimat_urun_id}`;
            if (miktar > sevkeHazir + 0.0001) {
                hatalar.push(`${ad}: sevke hazır ${sevkeHazir}, ${miktar} istendi`);
                continue;
            }

            await client.query(`
                INSERT INTO sevkiyat_kalemleri (sevkiyat_id, teslimat_urun_id, miktar)
                VALUES ($1, $2, $3)
            `, [sbId, k.teslimat_urun_id, miktar]);

            await client.query(`
                UPDATE teslimat_urunleri SET sevk_edilen_miktar = COALESCE(sevk_edilen_miktar,0) + $1
                WHERE id=$2
            `, [miktar, k.teslimat_urun_id]);
            kayit++;
        }

        if (kayit === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, hata: 'Hiçbir kalem işlenemedi: ' + hatalar.join(' | ') });
        }

        await client.query('COMMIT');
        await auditLogla(req, {
            eylem: 'CREATE', tablo: 'sevkiyat_belgeleri', kayit_id: sbId, kayit_no: sevkiyat_no,
            ozet: `Sevkiyat belgesi oluşturuldu — Plaka: ${plaka}, ${kayit} kalem`
        });
        res.json({
            ok: true, sevkiyat_no, sevkiyat_id: sbId,
            mesaj: `${sevkiyat_no} oluşturuldu, ${kayit} kalem sevk edildi.` + (hatalar.length ? ` Uyarı: ${hatalar.length}` : ''),
            hatalar
        });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Sevkiyat belgeleri listesi
app.get('/api/sevkiyat-belgeleri', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT sb.*,
                   COUNT(sk.id)::int as kalem_sayisi,
                   COALESCE(SUM(sk.miktar),0) as toplam_miktar
            FROM sevkiyat_belgeleri sb
            LEFT JOIN sevkiyat_kalemleri sk ON sb.id=sk.sevkiyat_id
            GROUP BY sb.id
            ORDER BY sb.id DESC
        `);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Sevkiyat belgesi detay
app.get('/api/sevkiyat-belgesi-detay/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.params;
        const baslik = await pool.query('SELECT * FROM sevkiyat_belgeleri WHERE id=$1', [id]);
        if (baslik.rowCount === 0) return res.json({ ok: false, hata: 'Sevkiyat belgesi bulunamadı.' });
        const kalemler = await pool.query(`
            SELECT sk.*,
                   tu.ozel_urun_adi, tu.ozel_urun_birim,
                   skk.stok_kodu, skk.stok_adi, skk.birim as stok_birim,
                   pt.bina_adi, pt.bina_turu, pt.montaj_gerekli,
                   p.proje_kodu, p.musteri_adi
            FROM sevkiyat_kalemleri sk
            JOIN teslimat_urunleri tu ON sk.teslimat_urun_id=tu.id
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            JOIN projeler p ON pt.proje_id=p.id
            LEFT JOIN stok_kartlari skk ON tu.stok_kart_id=skk.id
            WHERE sk.sevkiyat_id=$1
            ORDER BY sk.id
        `, [id]);
        res.json({ ok: true, baslik: baslik.rows[0], kalemler: kalemler.rows });
    } catch (e) { next(e); }
});

// Sevkiyat durumunu güncelle (HAZIRLANIYOR → YOLDA → TESLIM)
// TESLIM'e geçilirken: teslimat.montaj_gerekli=false ise sevk edilen miktarlar
// doğrudan teslim_edilen_miktar'a yazılır (montaj ekranı atlanır).
app.post('/api/sevkiyat-durum-guncelle', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { sevkiyat_id, yeni_durum } = req.body;
        const izin = ['HAZIRLANIYOR','YOLDA','TESLIM'];
        if (!izin.includes(yeni_durum)) return res.json({ ok: false, hata: 'Geçersiz durum.' });

        await client.query(`UPDATE sevkiyat_belgeleri SET durum=$1 WHERE id=$2`, [yeni_durum, sevkiyat_id]);

        let montajsizSayisi = 0, montajliSayisi = 0;
        if (yeni_durum === 'TESLIM') {
            // Sevkiyat kalemlerini al
            const kalemler = await client.query(`
                SELECT sk.teslimat_urun_id, sk.miktar, pt.montaj_gerekli, pt.id as teslimat_id
                FROM sevkiyat_kalemleri sk
                JOIN teslimat_urunleri tu ON sk.teslimat_urun_id=tu.id
                JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
                WHERE sk.sevkiyat_id=$1
            `, [sevkiyat_id]);

            for (const k of kalemler.rows) {
                if (k.montaj_gerekli === false) {
                    // Montajsız teslimat → direkt teslim_edilen_miktar'a yaz
                    await client.query(`
                        UPDATE teslimat_urunleri
                        SET teslim_edilen_miktar = COALESCE(teslim_edilen_miktar,0) + $1
                        WHERE id=$2
                    `, [k.miktar, k.teslimat_urun_id]);
                    // Montaj hareketi log'una da yaz (izlenebilirlik için MUSTERIYE_TESLIM)
                    await client.query(`
                        INSERT INTO montaj_hareketleri (teslimat_urun_id, hareket_tipi, miktar, kullanici_email, notlar)
                        VALUES ($1, 'MUSTERIYE_TESLIM', $2, $3, $4)
                    `, [k.teslimat_urun_id, k.miktar, req.user.email,
                        `Otomatik: montajsız teslimat — sevkiyat #${sevkiyat_id} teslim onayı`]);
                    montajsizSayisi++;
                } else {
                    // Montajlı teslimat → saha_teslim_miktar'a yaz (Montaj modülünde işlenecek)
                    await client.query(`
                        UPDATE teslimat_urunleri
                        SET saha_teslim_miktar = COALESCE(saha_teslim_miktar,0) + $1
                        WHERE id=$2
                    `, [k.miktar, k.teslimat_urun_id]);
                    await client.query(`
                        INSERT INTO montaj_hareketleri (teslimat_urun_id, hareket_tipi, miktar, kullanici_email, notlar)
                        VALUES ($1, 'SAHA_TESLIM', $2, $3, $4)
                    `, [k.teslimat_urun_id, k.miktar, req.user.email,
                        `Otomatik: sevkiyat #${sevkiyat_id} teslim onayı → sahaya teslim`]);
                    montajliSayisi++;
                }
            }
        }

        await client.query('COMMIT');
        let mesaj = `Durum güncellendi: ${yeni_durum}.`;
        if (yeni_durum === 'TESLIM') {
            if (montajsizSayisi > 0) mesaj += ` ${montajsizSayisi} kalem doğrudan müşteriye teslim edildi.`;
            if (montajliSayisi > 0) mesaj += ` ${montajliSayisi} kalem montaj sürecine aktarıldı.`;
        }
        await auditLogla(req, {
            eylem: yeni_durum === 'TESLIM' ? 'DELIVER' : 'UPDATE',
            tablo: 'sevkiyat_belgeleri', kayit_id: sevkiyat_id,
            ozet: `Sevkiyat durumu: ${yeni_durum}`
        });
        res.json({ ok: true, mesaj });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// Sevkiyat iptal et — sevk_edilen_miktar geri çekilir
app.post('/api/sevkiyat-iptal/:id', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;
        const sb = await client.query('SELECT durum FROM sevkiyat_belgeleri WHERE id=$1', [id]);
        if (sb.rowCount === 0) return res.json({ ok: false, hata: 'Sevkiyat bulunamadı.' });
        if (sb.rows[0].durum === 'IPTAL') return res.json({ ok: false, hata: 'Zaten iptal edilmiş.' });
        if (sb.rows[0].durum === 'TESLIM') return res.json({ ok: false, hata: 'Teslim edilen sevkiyat iptal edilemez.' });

        // Kalemleri geri çek — montaj_gerekli'ye göre teslim_edilen veya saha_teslim de geri çek
        const eskiDurum = sb.rows[0].durum;
        const kalemler = await client.query(`
            SELECT sk.teslimat_urun_id, sk.miktar, pt.montaj_gerekli
            FROM sevkiyat_kalemleri sk
            JOIN teslimat_urunleri tu ON sk.teslimat_urun_id=tu.id
            JOIN proje_teslimatlari pt ON tu.teslimat_id=pt.id
            WHERE sk.sevkiyat_id=$1
        `, [id]);
        for (const k of kalemler.rows) {
            await client.query(`
                UPDATE teslimat_urunleri
                SET sevk_edilen_miktar = GREATEST(0, COALESCE(sevk_edilen_miktar,0) - $1)
                WHERE id=$2
            `, [k.miktar, k.teslimat_urun_id]);

            // Eğer "TESLIM" olduktan sonra iptal ediyorsak — teslim sayaçlarını da geri çek
            if (eskiDurum === 'TESLIM') {
                if (k.montaj_gerekli === false) {
                    await client.query(`
                        UPDATE teslimat_urunleri
                        SET teslim_edilen_miktar = GREATEST(0, COALESCE(teslim_edilen_miktar,0) - $1)
                        WHERE id=$2
                    `, [k.miktar, k.teslimat_urun_id]);
                } else {
                    await client.query(`
                        UPDATE teslimat_urunleri
                        SET saha_teslim_miktar = GREATEST(0, COALESCE(saha_teslim_miktar,0) - $1)
                        WHERE id=$2
                    `, [k.miktar, k.teslimat_urun_id]);
                }
            }
        }
        await client.query(`UPDATE sevkiyat_belgeleri SET durum='IPTAL' WHERE id=$1`, [id]);

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Sevkiyat iptal edildi, miktarlar geri çekildi.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

// İş emri iptal et — atanan miktarlar serbest bırakılır (henüz tamamlanmamış olanlar)
app.post('/api/uretim-is-emri-iptal/:id', yetkiKontrol, async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;
        const ie = await client.query('SELECT durum FROM uretim_is_emirleri WHERE id=$1', [id]);
        if (ie.rowCount === 0) return res.json({ ok: false, hata: 'İş emri bulunamadı.' });
        if (ie.rows[0].durum === 'TAMAMLANDI') {
            return res.json({ ok: false, hata: 'Tamamlanmış iş emri iptal edilemez.' });
        }
        // Tamamlanmış miktarlar zaten uretilen_miktar'a işlenmiş — onları geri çekmiyoruz.
        // Sadece atanan ama tamamlanmayan kısmı serbest bırakıyoruz (atanan_miktar=tamamlanan_miktar yapıyoruz).
        await client.query(`
            UPDATE uretim_is_emri_kalemleri SET atanan_miktar = COALESCE(tamamlanan_miktar,0)
            WHERE is_emri_id=$1
        `, [id]);
        await client.query(`UPDATE uretim_is_emirleri SET durum='IPTAL' WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'İş emri iptal edildi.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { client.release(); }
});

app.use((err, req, res, next) => {
    console.error("🔥 Hata:", err.message);
    res.status(500).json({ ok: false, hata: err.message });
});

// ============================================================================
// ŞEMA GÜVENCE: server başlarken eksik sütunları/sequence'i ekle (idempotent)
// ============================================================================
async function semaGuvence() {
    try {
        // Talep numarası sequence (1084'ten başlat)
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS talep_no_seq START 1084`);
        // Talep bölme sütunları (Madde 6)
        await pool.query(`
            ALTER TABLE satinalma_talepleri
                ADD COLUMN IF NOT EXISTS parent_talep_id INTEGER REFERENCES satinalma_talepleri(id),
                ADD COLUMN IF NOT EXISTS alt_sira INTEGER DEFAULT 1,
                ADD COLUMN IF NOT EXISTS bolunme_tarihi TIMESTAMP
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_satinalma_talepleri_parent ON satinalma_talepleri(parent_talep_id)`);

        // Sipariş notları (iletişim geçmişi)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS siparis_notlari (
                id SERIAL PRIMARY KEY,
                siparis_id INTEGER NOT NULL REFERENCES satinalma_siparisleri(id) ON DELETE CASCADE,
                yazan_email TEXT,
                yazan_adsoyad TEXT,
                not_metni TEXT NOT NULL,
                kayit_tarihi TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_siparis_notlari_siparis ON siparis_notlari(siparis_id)`);

        // Talep dosyaları (sipariş dosya sistemiyle aynı yapı)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS talep_dosyalari (
                id SERIAL PRIMARY KEY,
                talep_id INTEGER NOT NULL REFERENCES satinalma_talepleri(id) ON DELETE CASCADE,
                dosya_adi TEXT,
                storage_path TEXT,
                public_url TEXT,
                mime_type TEXT,
                boyut BIGINT,
                yukleyen_adsoyad TEXT,
                yukleyen_email TEXT,
                kayit_tarihi TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_talep_dosyalari_talep ON talep_dosyalari(talep_id)`);

        // Siparişi oluşturan kişi (PDF'te "Satınalma Yetkilisi" alanı için)
        await pool.query(`
            ALTER TABLE satinalma_siparisleri
                ADD COLUMN IF NOT EXISTS olusturan_adsoyad TEXT,
                ADD COLUMN IF NOT EXISTS olusturan_email TEXT
        `);

        // Bildirim kuralları (panelden yönetilen aç/kapa + alıcılar)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bildirim_kurallari (
                id SERIAL PRIMARY KEY,
                olay_kodu TEXT UNIQUE NOT NULL,
                olay_adi TEXT NOT NULL,
                kategori TEXT,
                aktif BOOLEAN DEFAULT true,
                roller TEXT[] DEFAULT '{}',
                ekstra_emailler TEXT[] DEFAULT '{}',
                dinamik_alicilar TEXT[] DEFAULT '{}',
                aciklama TEXT,
                sira INTEGER DEFAULT 0
            )
        `);
        // Çekirdek olaylar — yalnızca yoksa eklenir (panel ayarlarını ezmez)
        await pool.query(`
            INSERT INTO bildirim_kurallari (olay_kodu, olay_adi, kategori, aktif, roller, dinamik_alicilar, sira) VALUES
              ('TALEP_ONAYA_GONDERILDI','Yeni talep onaya gönderildi','TALEP & ONAY', true,  '{YONETIM}',          '{TALEP_SAHIBI}',10),
              ('TALEP_ONAYLANDI',       'Talep onaylandı',            'TALEP & ONAY', true,  '{SATINALMA}',        '{TALEP_SAHIBI}',20),
              ('TALEP_REDDEDILDI',      'Talep reddedildi',           'TALEP & ONAY', true,  '{}',                 '{TALEP_SAHIBI}',30),
              ('TALEP_ISLEME_ALINDI',   'Talep işleme alındı',        'TALEP & ONAY', false, '{}',                 '{TALEP_SAHIBI}',40),
              ('TEKLIF_GIRILDI',        'Tedarikçiden teklif girildi','TEKLİF',       false, '{SATINALMA}',        '{}',            50),
              ('SIPARIS_OLUSTURULDU',   'Yeni sipariş oluşturuldu',   'SİPARİŞ',      true,  '{YONETIM,SATINALMA}','{}',            60),
              ('SIPARIS_ONAYLANDI',     'Sipariş onaylandı',          'SİPARİŞ',      false, '{SATINALMA}',        '{}',            70),
              ('MAL_KABUL',             'Mal kabul / teslim alındı',  'SİPARİŞ',      true,  '{MUHASEBE}',         '{TALEP_SAHIBI}',80),
              ('FATURA_ONAYLANDI',      'Fatura onaylandı',           'SİPARİŞ',      false, '{MUHASEBE}',         '{}',            90),
              ('SIPARIS_IPTAL',         'Sipariş iptal edildi',       'SİPARİŞ',      false, '{YONETIM,SATINALMA}','{}',           100)
            ON CONFLICT (olay_kodu) DO NOTHING
        `);
        // CC alıcı alanları (sonradan eklendi — mevcut tabloya da uygulanır)
        await pool.query(`
            ALTER TABLE bildirim_kurallari
                ADD COLUMN IF NOT EXISTS cc_roller TEXT[] DEFAULT '{}',
                ADD COLUMN IF NOT EXISTS cc_emailler TEXT[] DEFAULT '{}'
        `);

        // Güvenlik: public şemadaki TÜM tablolarda RLS'yi aç (Supabase PostgREST
        // üzerinden anon erişimi blokla). Backend DATABASE_URL kullandığı için
        // FORCE yok — service_role/owner normal çalışır, sadece anon/authenticated
        // PostgREST istekleri politikasız kaldığı için bloklanır.
        await pool.query(`
            DO $$
            DECLARE t RECORD;
            BEGIN
                FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
                    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
                END LOOP;
            END $$;
        `);
        console.log('✅ Şema güvencesi tamam (talep bölme alanları + sequence + RLS).');
    } catch (e) {
        console.error('⚠️ Şema güvencesi hatası:', e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 API Sunucusu ${PORT} portunda Korumalı modda çalışıyor!`);
    await semaGuvence();
    // Bildirim otomasyonu: server'ın 10 saniye sonra ilk kontrolü, sonra her saat
    setTimeout(() => bildirimleriOtomatikUret().catch(()=>{}), 10 * 1000);
    setInterval(() => bildirimleriOtomatikUret().catch(()=>{}), 60 * 60 * 1000);
    // Günlük satınalma raporu (PDF) — her gün 08:00 Türkiye saati, Satınalma yetkilileri + Admin'e
    const cron = require('node-cron');
    cron.schedule('0 8 * * *', () => {
        gunlukRaporGonder().catch(e => console.error('🗓️ Günlük rapor hatası:', e.message));
    }, { timezone: 'Europe/Istanbul' });
    console.log('🗓️ Günlük satınalma raporu zamanlandı: her gün 08:00 (TR)');
});
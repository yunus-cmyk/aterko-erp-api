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
// Kaynak kod / hassas dosyaların statik servis edilmesini engelle (express.static'ten ÖNCE).
// Tarayıcı yalnızca inline + CDN script kullanır; hiçbir yerel .js/.csv'ye ihtiyaç yok.
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    const blok = p.endsWith('.js') || p.endsWith('.csv')
        || p === '/package.json' || p === '/package-lock.json' || p === '/render.yaml'
        || p.startsWith('/lib/') || p.startsWith('/node_modules/') || p.startsWith('/.');
    if (blok) return res.status(404).send('Not found');
    next();
});
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
// Gönderen adresleri (her ikisi de yunus@aterko.com altında "Send mail as" alias'ı):
//   - SATINALMA modülü mailleri  → MAIL_FROM_EMAIL (satinalma@aterko.com)
//   - Diğer TÜM bildirimler      → MAIL_FROM_GENEL (aterko@aterko.com)
const MAIL_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER;
const MAIL_FROM_GENEL = process.env.MAIL_FROM_GENEL || 'aterko@aterko.com';
// Satınalma olay kodları — bildirim motorunda gönderen adresi seçimi için
const SATINALMA_OLAY_MI = kod => /^(TALEP_|TEKLIF_|SIPARIS_|MAL_KABUL|FATURA_)/.test(String(kod || ''));

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
// JWT_SECRET zorunlu — kaynak koda gömülü sabit anahtar YOK (ifşa riski).
// Üretimde tanımlı değilse başlatma; geliştirmede oturumluk rastgele anahtar üret.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
        console.error("❌ JWT_SECRET ortam değişkeni tanımlı değil — üretimde çalışılamaz. Sunucu durduruluyor.");
        process.exit(1);
    }
    JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
    console.warn("⚠️  JWT_SECRET yok — geliştirme için oturumluk rastgele anahtar üretildi (her yeniden başlatmada değişir).");
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
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
    }
});

// Hareket güncelle (sadece admin) — stok bakiyesini doğru şekilde yeniden hesapla
app.post('/api/stok-hareket-guncelle', yetkiKontrol, izinGerekli('stok', 'TAM'), async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id, stok_kart_id, tip, miktar, proje_id, depo_id, aciklama } = req.body;
        // Doğrulama (stok-hareket-kaydet ile simetri): miktar pozitif, tip yalnızca Giriş/Çıkış
        const yeniMiktar = parseFloat(miktar);
        if (isNaN(yeniMiktar) || yeniMiktar <= 0) { await client.query('ROLLBACK'); return res.json({ ok: false, hata: 'Miktar 0\'dan büyük olmalıdır.' }); }
        if (tip !== 'Giriş' && tip !== 'Çıkış') { await client.query('ROLLBACK'); return res.json({ ok: false, hata: 'Geçersiz hareket tipi (Giriş/Çıkış olmalı).' }); }
        const eskiR = await client.query('SELECT stok_kart_id, tip, miktar FROM stok_hareketleri WHERE id=$1', [id]);
        if (eskiR.rowCount === 0) { await client.query('ROLLBACK'); return res.json({ ok: false, hata: 'Hareket bulunamadı.' }); }
        const eski = eskiR.rows[0];

        // Eski etkiyi geri al
        const eskiDelta = eski.tip === 'Giriş' ? -parseFloat(eski.miktar) : parseFloat(eski.miktar);
        await client.query('UPDATE stok_kartlari SET guncel_stok_miktari = COALESCE(guncel_stok_miktari,0) + $1 WHERE id=$2',
            [eskiDelta, eski.stok_kart_id]);

        // Yeni etkiyi uygula
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
        try { await client.query('ROLLBACK'); } catch (_) {}
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
        try { await client.query('ROLLBACK'); } catch (_) {}
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
            INSERT INTO projeler (proje_kodu, musteri_adi, proje_adi, sozlesme_tarihi, satis_turu, nakliye, para_birimi, kdv_orani, satis_temsilcisi, aset_link, drive_link, durum)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'TASLAK') RETURNING id
        `, [
            proje.proje_kodu, proje.musteri_adi, proje.proje_adi, proje.sozlesme_tarihi || null,
            proje.satis_turu, proje.nakliye, proje.para_birimi, parseInt(proje.kdv_orani),
            (proje.satis_temsilcisi || '').trim() || null, (proje.aset_link || '').trim() || null, (proje.drive_link || '').trim() || null
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
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
    }
});

// YENİ: Projeleri, Teslimat Sayılarını, Toplam Tutarları ve Hesaplanmış Durumu Birlikte Çek
// Projeler modülünde FİYAT görme yetkisi: YAZMA veya TAM gerekir.
// OKUMA seviyesindeki kullanıcıya tutarlar SUNUCUDA maskelenir (ekrana hiç inmez).
async function projeFiyatGorebilir(req) {
    if (req.user.rol === 'ADMIN' || req.user.rol === 'Admin') return true;
    const izinler = await getKullaniciIzinleri(req.user.rol);
    return ['YAZMA', 'TAM'].includes(izinler['projeler']);
}

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
            // TASLAK proje (henüz ADMIN onayı yok) listede TASLAK görünür — teslimat
            // hesaplı durumu onu ezmesin; onaydan sonra hesaplı durum devam eder
            durum: r.durum === 'TASLAK' ? 'TASLAK' : (r.hesaplanmis_durum || r.durum || 'BEKLEMEDE')
        }));
        // FİYAT MASKESİ: projeler YAZMA yetkisi olmayana tutarlar sunucudan hiç inmez
        const fiyatGorebilir = await projeFiyatGorebilir(req);
        if (!fiyatGorebilir) data.forEach(r => { r.kdvsiz_toplam = null; r.kdvli_toplam = null; });
        res.json({ ok: true, data, fiyat_gizli: !fiyatGorebilir });
    } catch (error) { next(error); }
});

// YENİ: Proje Detayını ve Bağlı Teslimatları Getir
// ============================================================================
// PROJE ONAY AKIŞI (yeni): TASLAK → (ADMIN onayı) → SÖZLEŞME → iş emri → PROJE...
// TASLAK'ta şartname serbest; SÖZLEŞME'de şartname KİLİTLİ ve iş emri açılabilir.
// Onay geri alınabilir (yalnız aktif iş emri yoksa) → proje TASLAK'a döner.
// Mevcut/eski projeler (AKTİF/PROJE durumunda) bu akışın DIŞINDA — davranışları değişmez.
// ============================================================================
app.post('/api/proje-onayla', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin')
            return res.status(403).json({ ok: false, hata: 'Proje onayı yalnızca ADMIN yetkisindedir.' });
        const { proje_id } = req.body;
        const u = await pool.query(
            "UPDATE projeler SET durum='SÖZLEŞME' WHERE id=$1 AND durum='TASLAK' RETURNING proje_kodu", [proje_id]);
        if (!u.rowCount) return res.json({ ok: false, hata: 'Proje bulunamadı veya TASLAK durumunda değil.' });
        await auditLogla(req, { eylem: 'APPROVE', tablo: 'projeler', kayit_id: parseInt(proje_id), kayit_no: u.rows[0].proje_kodu, ozet: 'Proje onaylandı → SÖZLEŞME (teknik şartname kilitlendi)' });
        res.json({ ok: true, mesaj: `${u.rows[0].proje_kodu} onaylandı — SÖZLEŞME. Teknik şartname kilitlendi; artık iş emri oluşturulabilir.` });
    } catch (e) { next(e); }
});

app.post('/api/proje-onay-geri-al', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin')
            return res.status(403).json({ ok: false, hata: 'Onay geri alma yalnızca ADMIN yetkisindedir.' });
        const { proje_id } = req.body;
        // Projede aktif iş emri varsa geri alınamaz — önce iş emri silinmeli/iptal edilmeli
        const ie = await pool.query(
            `SELECT ie.emir_no FROM is_emirleri ie JOIN proje_teslimatlari pt ON ie.teslimat_id=pt.id
             WHERE pt.proje_id=$1 AND ie.durum <> 'İPTAL' LIMIT 1`, [proje_id]);
        if (ie.rowCount) return res.json({ ok: false, hata: `Onay geri alınamaz: ${ie.rows[0].emir_no} numaralı aktif iş emri var. Önce iş emri silinmeli (taslaksa) veya iptal edilmelidir.` });
        const u = await pool.query(
            "UPDATE projeler SET durum='TASLAK' WHERE id=$1 AND durum='SÖZLEŞME' RETURNING proje_kodu", [proje_id]);
        if (!u.rowCount) return res.json({ ok: false, hata: 'Proje bulunamadı veya SÖZLEŞME durumunda değil.' });
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'projeler', kayit_id: parseInt(proje_id), kayit_no: u.rows[0].proje_kodu, ozet: 'Proje onayı GERİ ALINDI → TASLAK (şartname yeniden düzenlenebilir)' });
        res.json({ ok: true, mesaj: `${u.rows[0].proje_kodu} onayı geri alındı — TASLAK. Teknik şartname yeniden düzenlenebilir.` });
    } catch (e) { next(e); }
});

app.get('/api/proje-detay/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.params;
        
        // Ana Projeyi Çek
        const projeRes = await pool.query("SELECT * FROM projeler WHERE id = $1", [id]);
        if(projeRes.rowCount === 0) return res.json({ ok: false, hata: "Proje bulunamadı." });
        
        // Projeye Bağlı Teslimatları (Binaları) Çek
        const teslimatRes = await pool.query("SELECT * FROM proje_teslimatlari WHERE proje_id = $1 ORDER BY id ASC", [id]);

        // FİYAT MASKESİ: projeler YAZMA yetkisi olmayana teslimat tutarları sunucudan hiç inmez
        const fiyatGorebilir = await projeFiyatGorebilir(req);
        if (!fiyatGorebilir) teslimatRes.rows.forEach(t => { t.kdvsiz_tutar = null; });
        res.json({ ok: true, proje: projeRes.rows[0], teslimatlar: teslimatRes.rows, fiyat_gizli: !fiyatGorebilir });
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
        // Yeni alanlar (temsilci/linkler): payload'da HİÇ yoksa (eski önbellekli sayfa) mevcut
        // değer korunur — yoksa eski form her kayıtta bu alanları null'a ezer (yaşandı: 72691).
        // Alan payload'da varsa boş gönderim bilinçli temizlik sayılır (null yazılır).
        const eskiP = await client.query('SELECT satis_temsilcisi, aset_link, drive_link FROM projeler WHERE id=$1', [proje.id]);
        const koru = (yeni, eski) => yeni === undefined ? eski : ((String(yeni || '').trim()) || null);
        await client.query(`
            UPDATE projeler SET musteri_adi=$1, proje_adi=$2, sozlesme_tarihi=$3,
                                satis_turu=$4, nakliye=$5, para_birimi=$6, kdv_orani=$7,
                                satis_temsilcisi=$8, aset_link=$9, drive_link=$10
            WHERE id=$11
        `, [proje.musteri_adi, proje.proje_adi, proje.sozlesme_tarihi || null,
            proje.satis_turu, proje.nakliye, proje.para_birimi, parseInt(proje.kdv_orani),
            koru(proje.satis_temsilcisi, eskiP.rows[0]?.satis_temsilcisi),
            koru(proje.aset_link, eskiP.rows[0]?.aset_link),
            koru(proje.drive_link, eskiP.rows[0]?.drive_link),
            proje.id]);

        // 2. Mevcut teslimat ID'lerini al
        const mevcutRes = await client.query('SELECT id FROM proje_teslimatlari WHERE proje_id = $1', [proje.id]);
        const mevcutIds = new Set(mevcutRes.rows.map(r => r.id));
        const gonderilenIds = new Set();
        const kilitliBinalar = [];   // aktif iş emrine bağlı (şartname alanları güncellenmeyen) teslimatlar
        // Proje ADMIN onayıyla SÖZLEŞME'deyse şartnameye giren teslimat alanları da kilitlidir
        const projeDurumu = (await client.query('SELECT durum FROM projeler WHERE id=$1', [proje.id])).rows[0]?.durum;
        const sozlesmeKilidi = projeDurumu === 'SÖZLEŞME';

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
                // İŞ EMRİ KİLİDİ: aktif iş emri varken şartnameye giren alanlar değiştirilemez —
                // yalnız sevkiyat başlangıcı ve tutar güncellenir (belge bütünlüğü)
                const kilitliIE = await aktifIsEmri(t.id);
                if (kilitliIE || sozlesmeKilidi) {
                    await client.query(
                        'UPDATE proje_teslimatlari SET sevkiyat_baslangici=$1, kdvsiz_tutar=$2 WHERE id=$3',
                        [sevkiyatBaslangici, parseFloat(t.kdvsiz_tutar) || 0, t.id]);
                    kilitliBinalar.push(`${t.bina_adi || t.id} (${kilitliIE ? kilitliIE.emir_no : 'SÖZLEŞME kilidi'})`);
                    gonderilenIds.add(t.id);
                    continue;
                }
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

        // 4. Gönderilmeyen mevcut teslimatları sil — aktif iş emri bağlıysa SİLİNEMEZ
        const silinecek = [...mevcutIds].filter(id => !gonderilenIds.has(id));
        for (const sid of silinecek) {
            const ie = await aktifIsEmri(sid);
            if (ie) {
                await client.query('ROLLBACK');
                return res.json({ ok: false, hata: `Teslimat silinemez: ${ie.emir_no} numaralı iş emrine bağlı. Önce iş emri silinmeli/iptal edilmelidir.` });
            }
            if (sozlesmeKilidi) {
                await client.query('ROLLBACK');
                return res.json({ ok: false, hata: 'Teslimat silinemez: proje ADMIN onayıyla SÖZLEŞME durumunda. Önce onay geri alınmalıdır.' });
            }
        }
        if (silinecek.length > 0) {
            await client.query('DELETE FROM proje_teslimatlari WHERE id = ANY($1::integer[])', [silinecek]);
        }

        await client.query('COMMIT');
        const kilitliMsg = kilitliBinalar.length
            ? ` Not: ${kilitliBinalar.join(', ')} iş emrine bağlı olduğundan şartname alanları DEĞİŞTİRİLMEDİ (yalnız sevkiyat/tutar güncellendi).`
            : '';
        res.json({ ok: true, mesaj: 'Proje güncellendi.' + kilitliMsg, silinen_teslimat: silinecek.length });
    } catch (error) {
        await client.query('ROLLBACK');
        next(error);
    } finally {
        try { await client.query('ROLLBACK'); } catch (_) {}
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
        try { await client.query('ROLLBACK'); } catch (_) {}
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
    const { kalem_idler, yeni_durum } = req.body; // kalem_idler bir dizi (array) olacak
    // Durum whitelist — serbest metin yerine yalnızca geçerli talep durumları kabul edilir
    const GECERLI_DURUMLAR = ['ONAY BEKLİYOR', 'ONAYLANDI', 'İŞLEME ALINDI', 'TEKLİF İSTENDİ', 'İPTAL'];
    if (!kalem_idler || kalem_idler.length === 0) {
        return res.json({ ok: false, hata: "İşlem yapılacak ürün seçilmedi." });
    }
    if (!GECERLI_DURUMLAR.includes(yeni_durum)) {
        return res.json({ ok: false, hata: `Geçersiz durum değeri: ${yeni_durum}` });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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
        try { await client.query('ROLLBACK'); } catch (_) {}
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
            const r = https.get('https://www.tcmb.gov.tr/kurlar/today.xml', (res) => {
                let buf = '';
                res.on('data', c => buf += c);
                res.on('end', () => resolve(buf));
            });
            r.on('error', reject);
            r.setTimeout(8000, () => r.destroy(new Error('TCMB zaman aşımı')));  // askıda kalmayı önle
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
        // NOT: Tutar grafikleri farklı para birimlerini KARIŞTIRMAMALI. Her satır siparişin
        // para birimiyle gelir; para birimi bazında toplanıp JS'te TL'ye çevrilir (tek ölçek = TL).
        const [durumDag, tedarikciDag, kategoriDag, aylikDag] = await Promise.all([
            // Durum dağılımı (sipariş adedi — para birimi bağımsız)
            pool.query(`SELECT COALESCE(s.durum,'-') as ad, COUNT(DISTINCT s.id)::int as deger
                ${JOINS} WHERE ${where} GROUP BY s.durum ORDER BY deger DESC`, params),
            // Tedarikçi dağılımı (tutar — para birimi bazında ayrı, JS'te TL'ye çevrilir)
            pool.query(`SELECT COALESCE(tdr.firma_adi,'-') as ad, COALESCE(s.para_birimi,'TL') as pb,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} GROUP BY tdr.firma_adi, s.para_birimi`, params),
            // Kategori dağılımı (tutar)
            pool.query(`SELECT COALESCE(NULLIF(TRIM(skart.kategori),''),'Diğer') as ad, COALESCE(s.para_birimi,'TL') as pb,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} GROUP BY 1, s.para_birimi`, params),
            // Aylık harcama (tutar, kronolojik)
            pool.query(`SELECT TO_CHAR(DATE_TRUNC('month', s.siparis_tarihi),'YYYY-MM') as ad, COALESCE(s.para_birimi,'TL') as pb,
                SUM(COALESCE(sk.siparis_miktari,0)*COALESCE(sk.birim_fiyat,0))::numeric as deger
                ${JOINS} WHERE ${where} AND s.siparis_tarihi IS NOT NULL GROUP BY 1, s.para_birimi`, params)
        ]);
        // Para birimi satırlarını TL'ye çevirip 'ad' bazında birleştir (limit varsa en büyük N)
        const tlTopla = (rows, limit) => {
            const m = new Map();
            rows.forEach(r => {
                const tl = parseFloat(r.deger || 0) * (kurlar[r.pb] || 1);
                m.set(r.ad, (m.get(r.ad) || 0) + tl);
            });
            let arr = [...m.entries()].map(([ad, deger]) => ({ ad, deger }));
            arr.sort((a, b) => b.deger - a.deger);
            return limit ? arr.slice(0, limit) : arr;
        };
        const aylikTL = tlTopla(aylikDag.rows, 0).sort((a, b) => a.ad < b.ad ? -1 : (a.ad > b.ad ? 1 : 0));
        const grafikler = {
            durum:     durumDag.rows.map(r => ({ ad: r.ad, deger: r.deger })),
            tedarikci: tlTopla(tedarikciDag.rows, 8),
            kategori:  tlTopla(kategoriDag.rows, 8),
            aylik:     aylikTL
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
    // Base = kök talep numarasının TAMAMI (ör. 72759-T-1111). Alt-talep = base-altSira.
    // NOT: root her zaman ProjeNo-T-NNNN biçiminde (parent_talep_id NULL), ekstra sonek yok —
    // eskiden buradaki .replace(/-\d+$/,'') asıl sıra numarasını (NNNN) kırpıp 72759-T-1 üretiyordu.
    const baseTalepNo = rootTalepNo;

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

// Sipariş düzenlemede kalem miktarı değişince farkı "kalan alt-talep" ile dengeler (TOPLAM KORUNUR).
//  • Azaltma → serbest kalan miktarı MEVCUT kalan alt-talebe ekler (aynı ürün satırına); o üründe/altta
//    açık kalan yoksa yeni alt-talep açar (talepBol). Yeni alt-talep GEREKSİZ yere çoğalmaz.
//  • Artırma → kalandan düşer (üst sınır = sipariş edilen + kalan; onaylı toplamı aşamaz).
async function kalemMiktarSenkronla(client, siparisKalemId, yeniMiktar) {
    // Sipariş kaleminin bağlı olduğu (sipariş edilen) talep ürünü A
    const aR = await client.query(`
        SELECT sk.siparis_miktari AS eski, tu.id AS a_id, tu.talep_id,
               tu.stok_kart_id, tu.ozel_urun_adi, tu.ozel_urun_birim, tu.aciklama
        FROM siparis_kalemleri sk JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
        WHERE sk.id = $1`, [siparisKalemId]);
    if (aR.rowCount === 0) return { hata: 'Sipariş kalemi bulunamadı.' };
    const A = aR.rows[0];
    const eski = parseFloat(A.eski) || 0;
    const delta = yeniMiktar - eski;

    // Root talep (parent yoksa kendisi)
    const tR = await client.query('SELECT parent_talep_id, id FROM satinalma_talepleri WHERE id=$1', [A.talep_id]);
    const root = tR.rows[0].parent_talep_id || tR.rows[0].id;

    // Aynı ürünün AÇIK (henüz sipariş edilmemiş) kalan kalemi — aile içinde, A hariç
    const urunSql = A.stok_kart_id != null ? 'tu.stok_kart_id = $3' : 'tu.ozel_urun_adi = $3';
    const urunVal = A.stok_kart_id != null ? A.stok_kart_id : A.ozel_urun_adi;
    const rR = await client.query(`
        SELECT tu.id, tu.miktar, tu.talep_id FROM talep_urunleri tu
        JOIN satinalma_talepleri t ON tu.talep_id = t.id
        WHERE (t.id = $1 OR t.parent_talep_id = $1) AND tu.id <> $2
          AND ${urunSql}
          AND tu.durum IN ('ONAY BEKLİYOR','ONAYLANDI','İŞLEME ALINDI','TEKLİF İSTENDİ')
        ORDER BY t.id DESC LIMIT 1`, [root, A.a_id, urunVal]);
    const R = rR.rows[0] || null;
    const kalanMiktar = R ? (parseFloat(R.miktar) || 0) : 0;

    // Üst sınır: sipariş edilen + kalan (onaylı toplam korunur)
    const capToplam = eski + kalanMiktar;
    if (yeniMiktar > capToplam + 0.001) {
        return { hata: `Kalem miktarı toplam talep miktarını (${capToplam}) aşamaz.` };
    }

    // Sipariş kalemini + sipariş edilen talep ürününü yeni miktara ayarla (senkron)
    await client.query('UPDATE siparis_kalemleri SET siparis_miktari=$1 WHERE id=$2', [yeniMiktar, siparisKalemId]);
    await client.query('UPDATE talep_urunleri SET miktar=$1 WHERE id=$2', [yeniMiktar, A.a_id]);

    const etkilenen = new Set([A.talep_id]);

    if (delta < -0.001) {
        // AZALTMA: serbest kalan miktarı kalan alt-talebe EKLE
        const serbest = -delta;
        if (R) {
            await client.query('UPDATE talep_urunleri SET miktar = COALESCE(miktar,0) + $1 WHERE id=$2', [serbest, R.id]);
            etkilenen.add(R.talep_id);
        } else {
            // Aynı ürün yoksa: açık bir kalan alt-talep var mı? Varsa oraya yeni satır ekle
            const sib = await client.query(`
                SELECT t.id FROM satinalma_talepleri t
                WHERE t.parent_talep_id = $1 AND COALESCE(t.durum,'') <> 'İPTAL'
                  AND EXISTS (SELECT 1 FROM talep_urunleri x WHERE x.talep_id=t.id
                              AND x.durum IN ('ONAY BEKLİYOR','ONAYLANDI','İŞLEME ALINDI','TEKLİF İSTENDİ'))
                ORDER BY t.id DESC LIMIT 1`, [root]);
            if (sib.rowCount) {
                await client.query(`INSERT INTO talep_urunleri
                    (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                    VALUES ($1,$2,$3,$4,$5,$6,'İŞLEME ALINDI')`,
                    [sib.rows[0].id, A.stok_kart_id, A.ozel_urun_adi, A.ozel_urun_birim, serbest, A.aciklama]);
                etkilenen.add(sib.rows[0].id);
            } else {
                // Hiç kalan alt-talep yok → yeni alt-talep aç
                const bi = await talepBol(client, A.talep_id, [{
                    stok_kart_id: A.stok_kart_id, ozel_urun_adi: A.ozel_urun_adi, ozel_urun_birim: A.ozel_urun_birim,
                    miktar: serbest, aciklama: A.aciklama, durum: 'İŞLEME ALINDI'
                }]);
                if (bi) etkilenen.add(bi.yeniTalepId);
            }
        }
    } else if (delta > 0.001 && R) {
        // ARTIRMA: kalandan DÜŞ (cap kontrolü R'nin yeterli olduğunu garanti eder)
        const kalanYeni = kalanMiktar - delta;
        if (kalanYeni <= 0.001) await client.query('DELETE FROM talep_urunleri WHERE id=$1', [R.id]);
        else await client.query('UPDATE talep_urunleri SET miktar=$1 WHERE id=$2', [kalanYeni, R.id]);
        etkilenen.add(R.talep_id);
    }

    // Etkilenen taleplerin başlık durumunu kalemlerinden yeniden türet
    for (const tid of etkilenen) await talepBaslikDurumGuncelle(client, tid);
    return { ok: true };
}

// KDV oranını normalize eder: 0 (KDV muafiyeti) geçerli bir değerdir; eski `kdv_orani || 20`
// kalıbı 0'ı yanlışlıkla %20 yapıyordu. Geçersiz/boş değerde %20 varsayılır.
function normKdv(v) { const n = parseInt(v); return Number.isNaN(n) ? 20 : n; }

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
            // Eşzamanlı aynı-base sipariş oluşturmayı serileştir (çift sipariş_no önlenir)
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [baseSiparisNo]);
            const c = await client.query(
                `SELECT COUNT(*)::int as n FROM satinalma_siparisleri WHERE siparis_no = $1 OR siparis_no LIKE $1 || '-%'`,
                [baseSiparisNo]
            );
            const adet = c.rows[0].n;
            siparis_no = adet === 0 ? baseSiparisNo : `${baseSiparisNo}-${adet + 1}`;
        } else {
            // Fallback (talep yoksa eski format)
            await client.query("SELECT pg_advisory_xact_lock(hashtext('SAT-S'))");
            const countRes = await client.query('SELECT COUNT(*) FROM satinalma_siparisleri');
            siparis_no = `SAT-S-${1001 + parseInt(countRes.rows[0].count)}`;
        }

        // 2. Ana Sipariş Başlığını Kaydet
        const siparisInsert = await client.query(`
            INSERT INTO satinalma_siparisleri (siparis_no, tedarikci_id, siparis_tarihi, termin_tarihi, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani, olusturan_adsoyad, olusturan_email)
            VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
        `, [siparis_no, tedarikci_id, termin_tarihi || null, odeme_vade, teslim_nakliye, teslim_adresi, siparis_notu, para_birimi || 'TL', normKdv(kdv_orani), req.user.adSoyad || null, req.user.email || null]);

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
        try { await client.query('ROLLBACK'); } catch (_) {}
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
                       'birim', COALESCE(skart.birim, tu.ozel_urun_birim), 'kategori', skart.kategori, 'aciklama', tu.aciklama,
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
// Sipariş oluşturma ekranı için: her stok kartının SON alım fiyatı + tedarikçisi + tarihi
// (ürün adının altında bilgi olarak gösterilir — fiyat girerken referans)
app.get('/api/son-alis-fiyatlari', yetkiKontrol, async (req, res, next) => {
    try {
        const ids = String(req.query.ids || '').split(',').map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
        if (!ids.length) return res.json({ ok: true, data: [] });
        const r = await pool.query(`
            SELECT DISTINCT ON (tu.stok_kart_id)
                   tu.stok_kart_id, sk.birim_fiyat, s.para_birimi, s.siparis_tarihi,
                   ted.firma_adi AS tedarikci
            FROM siparis_kalemleri sk
            JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            JOIN satinalma_siparisleri s ON sk.siparis_id = s.id
            LEFT JOIN tedarikciler ted ON s.tedarikci_id = ted.id
            WHERE tu.stok_kart_id = ANY($1) AND COALESCE(sk.birim_fiyat, 0) > 0
              AND COALESCE(s.durum, '') <> 'İPTAL'
            ORDER BY tu.stok_kart_id, s.siparis_tarihi DESC NULLS LAST, sk.id DESC
        `, [ids]);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

app.get('/api/siparis-detay/:siparisId', yetkiKontrol, async (req, res, next) => {
    try {
        const { siparisId } = req.params;
        const query = `
            SELECT sk.id as siparis_kalem_id, sk.siparis_miktari, sk.birim_fiyat,
                   tu.aciklama,
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
        const bas = await pool.query(`SELECT s.para_birimi, s.kdv_orani, s.durum, s.siparis_no, s.termin_tarihi,
                s.odeme_vade, s.teslim_nakliye, s.teslim_adresi, s.siparis_notu, s.tedarikci_id, s.siparis_tarihi,
                s.fatura_onay_durumu, s.fatura_nolari, s.fatura_notu, s.fatura_onaylayan_email, s.fatura_onay_tarihi,
                t.firma_adi AS tedarikci_adi
             FROM satinalma_siparisleri s LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
             WHERE s.id=$1`, [siparisId]);
        res.json({ ok: true, data: result.rows, siparis: bas.rows[0] || null });
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
                   t.proje_id,
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
                   COALESCE(COUNT(tu.id), 0) as urun_sayisi,
                   STRING_AGG(DISTINCT NULLIF(TRIM(skart.kategori), ''), ', ') as kategoriler
            FROM satinalma_talepleri t
            LEFT JOIN projeler p ON t.proje_id = p.id
            LEFT JOIN talep_urunleri tu ON t.id = tu.talep_id
            LEFT JOIN stok_kartlari skart ON tu.stok_kart_id = skart.id
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
                   COUNT(sk.id) as kalem_sayisi,
                   STRING_AGG(DISTINCT NULLIF(TRIM(skart.kategori), ''), ', ') as kategoriler,
                   MAX(p.proje_kodu) as proje_kodu,
                   MAX(p.musteri_adi) as musteri_adi,
                   MAX(p.proje_adi) as proje_adi
            FROM satinalma_siparisleri s
            LEFT JOIN tedarikciler t ON s.tedarikci_id = t.id
            LEFT JOIN siparis_kalemleri sk ON s.id = sk.siparis_id
            LEFT JOIN talep_urunleri tu ON sk.talep_urun_id = tu.id
            LEFT JOIN stok_kartlari skart ON tu.stok_kart_id = skart.id
            LEFT JOIN satinalma_talepleri tlp ON tu.talep_id = tlp.id
            LEFT JOIN projeler p ON tlp.proje_id = p.id
            WHERE COALESCE(s.arsiv, false) = true
            GROUP BY s.id, t.firma_adi
            ORDER BY s.siparis_tarihi DESC NULLS LAST, s.id DESC
        `);
        res.json({ ok: true, talepler: talepler.rows, siparisler: siparisler.rows });
    } catch (e) { next(e); }
});

// ============================================================================
// MALİ İŞLER — cari takip (tedarikçi/müşteri) + hareket defteri (Faz 1)
// İlke: BAKİYE TUTULMAZ, HESAPLANIR: devir + faturalar − ödemeler/tahsilatlar.
// Tedarikçi verisi TEK tablo (tedarikciler) — Satınalma kendi yüzünü, Mali İşler
// mali yüzünü gösterir (mali alanlar yalnız mali izinle iner).
// Para birimi: TL. Mühlet: sistem ayarında tek sabit tarih (mali_ayar).
// ============================================================================
async function maliBakiyeler(tarafTip, tarafIds) {
    if (!tarafIds.length) return {};
    const r = await pool.query(`
        SELECT taraf_id,
               COALESCE(SUM(CASE WHEN tip='FATURA' THEN tutar END), 0) AS fatura_toplam,
               COALESCE(SUM(CASE WHEN tip IN ('ODEME','TAHSILAT') AND gerceklesen_tarih IS NOT NULL THEN COALESCE(gerceklesen_tutar, tutar) END), 0) AS odeme_toplam,
               COALESCE(SUM(CASE WHEN tip='CEK' AND muhlet_oncesi AND gerceklesen_tarih IS NULL THEN tutar END), 0) AS cek_once,
               COALESCE(SUM(CASE WHEN tip='CEK' AND NOT muhlet_oncesi AND gerceklesen_tarih IS NULL THEN tutar END), 0) AS cek_sonra,
               COALESCE(SUM(CASE WHEN tip='PROJEKSIYON' AND gerceklesen_tarih IS NULL THEN tutar END), 0) AS projeksiyon_toplam,
               COALESCE(SUM(CASE WHEN tip IN ('ODEME','TAHSILAT') AND gerceklesen_tarih IS NULL THEN COALESCE(planlanan_tutar, tutar) END), 0) AS plan_toplam
        FROM cari_hareketler
        WHERE taraf_tip = $1 AND taraf_id = ANY($2)
        GROUP BY taraf_id`, [tarafTip, tarafIds]);
    const map = {};
    r.rows.forEach(x => map[x.taraf_id] = x);
    return map;
}

// Tedarikçi cari listesi (mali görünüm) — bakiyeler hareketlerden HESAPLANIR
app.get('/api/mali-tedarikciler', yetkiKontrol, async (req, res, next) => {
    try {
        const t = await pool.query(`
            SELECT t.id, t.firma_adi, t.tur, t.durum, t.yetkili_kisi, t.telefon, t.email,
                   t.iban, t.banka_bilgisi, t.genel_vade_gun, t.mali_aciklama,
                   t.muhlet_oncesi_borc, t.muhlet_sonrasi_devir,
                   k.ad_soyad AS ilgili_kisi
            FROM tedarikciler t LEFT JOIN kullanicilar k ON t.ilgili_kisi_id = k.id
            ORDER BY t.firma_adi`);
        const bak = await maliBakiyeler('TEDARIKCI', t.rows.map(x => x.id));
        const data = t.rows.map(x => {
            const b = bak[x.id] || {};
            return {
                ...x,
                fatura_toplam: parseFloat(b.fatura_toplam || 0),
                odeme_toplam: parseFloat(b.odeme_toplam || 0),
                cek_once: parseFloat(b.cek_once || 0),
                cek_sonra: parseFloat(b.cek_sonra || 0),
                plan_toplam: parseFloat(b.plan_toplam || 0),
                // Mühlet sonrası bakiye = devir + faturalar − ödemeler (HESAPLANAN)
                muhlet_sonrasi_bakiye: parseFloat(x.muhlet_sonrasi_devir || 0) + parseFloat(b.fatura_toplam || 0) - parseFloat(b.odeme_toplam || 0)
            };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

// Tedarikçi mali kartı: bilgiler + bakiyeler + hareket listeleri
app.get('/api/mali-tedarikci/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const t = await pool.query(`
            SELECT t.*, k.ad_soyad AS ilgili_kisi FROM tedarikciler t
            LEFT JOIN kullanicilar k ON t.ilgili_kisi_id = k.id WHERE t.id=$1`, [req.params.id]);
        if (!t.rowCount) return res.json({ ok: false, hata: 'Tedarikçi bulunamadı.' });
        const h = await pool.query(
            `SELECT * FROM cari_hareketler WHERE taraf_tip='TEDARIKCI' AND taraf_id=$1
             ORDER BY COALESCE(belge_tarihi, kayit_tarihi::date) DESC, id DESC`, [req.params.id]);
        const bak = (await maliBakiyeler('TEDARIKCI', [parseInt(req.params.id)]))[req.params.id] || {};
        res.json({
            ok: true, tedarikci: t.rows[0], hareketler: h.rows,
            bakiye: {
                muhlet_oncesi_borc: parseFloat(t.rows[0].muhlet_oncesi_borc || 0),
                muhlet_sonrasi_bakiye: parseFloat(t.rows[0].muhlet_sonrasi_devir || 0) + parseFloat(bak.fatura_toplam || 0) - parseFloat(bak.odeme_toplam || 0),
                fatura_toplam: parseFloat(bak.fatura_toplam || 0),
                odeme_toplam: parseFloat(bak.odeme_toplam || 0),
                cek_once: parseFloat(bak.cek_once || 0),
                cek_sonra: parseFloat(bak.cek_sonra || 0)
            }
        });
    } catch (e) { next(e); }
});

// Tedarikçinin MALİ alanlarını güncelle (kimlik alanları Satınalma ekranından yönetilir)
app.post('/api/mali-tedarikci-guncelle', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, tur, iban, banka_bilgisi, genel_vade_gun, ilgili_kisi_id, mali_aciklama,
                muhlet_oncesi_borc, muhlet_sonrasi_devir } = req.body;
        const u = await pool.query(`
            UPDATE tedarikciler SET tur=$1, iban=$2, banka_bilgisi=$3, genel_vade_gun=$4,
                   ilgili_kisi_id=$5, mali_aciklama=$6, muhlet_oncesi_borc=$7, muhlet_sonrasi_devir=$8
            WHERE id=$9 RETURNING firma_adi`,
            [tur || 'Tedarikçi', (iban || '').trim() || null, (banka_bilgisi || '').trim() || null,
             parseInt(genel_vade_gun) || null, parseInt(ilgili_kisi_id) || null, (mali_aciklama || '').trim() || null,
             parseFloat(muhlet_oncesi_borc) || 0, parseFloat(muhlet_sonrasi_devir) || 0, id]);
        if (!u.rowCount) return res.json({ ok: false, hata: 'Tedarikçi bulunamadı.' });
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'tedarikciler', kayit_id: parseInt(id), ozet: `Mali kart güncellendi: ${u.rows[0].firma_adi}` });
        res.json({ ok: true, mesaj: 'Mali bilgiler kaydedildi.' });
    } catch (e) { next(e); }
});

// Müşteri listesi — cari alacak HESAPLANIR (devir + faturalar − tahsilatlar); projeksiyon ayrı katman
app.get('/api/mali-musteriler', yetkiKontrol, async (req, res, next) => {
    try {
        const m = await pool.query(`
            SELECT m.*, k.ad_soyad AS ilgili_kisi FROM musteriler m
            LEFT JOIN kullanicilar k ON m.ilgili_kisi_id = k.id ORDER BY m.firma_adi`);
        const bak = await maliBakiyeler('MUSTERI', m.rows.map(x => x.id));
        const data = m.rows.map(x => {
            const b = bak[x.id] || {};
            return {
                ...x,
                fatura_toplam: parseFloat(b.fatura_toplam || 0),
                tahsilat_toplam: parseFloat(b.odeme_toplam || 0),
                projeksiyon_toplam: parseFloat(b.projeksiyon_toplam || 0),
                plan_toplam: parseFloat(b.plan_toplam || 0),
                cari_alacak: parseFloat(x.devir_alacak || 0) + parseFloat(b.fatura_toplam || 0) - parseFloat(b.odeme_toplam || 0)
            };
        });
        res.json({ ok: true, data });
    } catch (e) { next(e); }
});

app.get('/api/mali-musteri/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const m = await pool.query(`
            SELECT m.*, k.ad_soyad AS ilgili_kisi FROM musteriler m
            LEFT JOIN kullanicilar k ON m.ilgili_kisi_id = k.id WHERE m.id=$1`, [req.params.id]);
        if (!m.rowCount) return res.json({ ok: false, hata: 'Müşteri bulunamadı.' });
        const h = await pool.query(
            `SELECT * FROM cari_hareketler WHERE taraf_tip='MUSTERI' AND taraf_id=$1
             ORDER BY COALESCE(belge_tarihi, kayit_tarihi::date) DESC, id DESC`, [req.params.id]);
        const bak = (await maliBakiyeler('MUSTERI', [parseInt(req.params.id)]))[req.params.id] || {};
        res.json({
            ok: true, musteri: m.rows[0], hareketler: h.rows,
            bakiye: {
                cari_alacak: parseFloat(m.rows[0].devir_alacak || 0) + parseFloat(bak.fatura_toplam || 0) - parseFloat(bak.odeme_toplam || 0),
                fatura_toplam: parseFloat(bak.fatura_toplam || 0),
                tahsilat_toplam: parseFloat(bak.odeme_toplam || 0),
                projeksiyon_toplam: parseFloat(bak.projeksiyon_toplam || 0)
            }
        });
    } catch (e) { next(e); }
});

// Müşteri oluştur/güncelle (id varsa update)
app.post('/api/mali-musteri-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const b = req.body;
        if (!b.firma_adi || !String(b.firma_adi).trim()) return res.json({ ok: false, hata: 'Firma adı zorunludur.' });
        const vals = [String(b.firma_adi).trim(), b.tur || 'Kurumsal', b.durum || 'AKTIF',
            (b.yetkili_kisi || '').trim() || null, (b.telefon || '').trim() || null, (b.email || '').trim() || null,
            (b.vergi_no || '').trim() || null, (b.vergi_dairesi || '').trim() || null, (b.adres || '').trim() || null,
            parseInt(b.ilgili_kisi_id) || null, (b.aciklama || '').trim() || null, parseFloat(b.devir_alacak) || 0];
        if (b.id) {
            const u = await pool.query(`UPDATE musteriler SET firma_adi=$1, tur=$2, durum=$3, yetkili_kisi=$4,
                telefon=$5, email=$6, vergi_no=$7, vergi_dairesi=$8, adres=$9, ilgili_kisi_id=$10,
                aciklama=$11, devir_alacak=$12 WHERE id=$13 RETURNING id`, [...vals, b.id]);
            if (!u.rowCount) return res.json({ ok: false, hata: 'Müşteri bulunamadı.' });
            await auditLogla(req, { eylem: 'UPDATE', tablo: 'musteriler', kayit_id: parseInt(b.id), ozet: `Müşteri güncellendi: ${vals[0]}` });
            return res.json({ ok: true, id: b.id, mesaj: 'Müşteri güncellendi.' });
        }
        const i = await pool.query(`INSERT INTO musteriler (firma_adi, tur, durum, yetkili_kisi, telefon, email,
            vergi_no, vergi_dairesi, adres, ilgili_kisi_id, aciklama, devir_alacak)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, vals);
        await auditLogla(req, { eylem: 'CREATE', tablo: 'musteriler', kayit_id: i.rows[0].id, ozet: `Müşteri oluşturuldu: ${vals[0]}` });
        res.json({ ok: true, id: i.rows[0].id, mesaj: 'Müşteri oluşturuldu.' });
    } catch (e) { next(e); }
});

// Cari hareket ekle: FATURA / ODEME (tedarikçi) / TAHSILAT (müşteri) / CEK / PROJEKSIYON (müşteri)
app.post('/api/mali-hareket-ekle', yetkiKontrol, async (req, res, next) => {
    try {
        const b = req.body;
        // GIDER = cari kartı olmayan işletme gideri (maaş vb.) — yalnız ödeme, nakit akışa tek kalem
        const tarafTip = ['MUSTERI', 'GIDER'].includes(b.taraf_tip) ? b.taraf_tip : 'TEDARIKCI';
        const tip = String(b.tip || '').toUpperCase();
        const gecerli = tarafTip === 'TEDARIKCI' ? ['FATURA', 'ODEME', 'CEK'] : tarafTip === 'MUSTERI' ? ['FATURA', 'TAHSILAT', 'PROJEKSIYON'] : ['ODEME'];
        if (tarafTip === 'GIDER' && !(b.aciklama || '').trim()) return res.json({ ok: false, hata: 'Gider kalemi için açıklama zorunludur (örn. "Temmuz maaşları").' });
        if (!gecerli.includes(tip)) return res.json({ ok: false, hata: `Geçersiz hareket tipi (${tarafTip} için: ${gecerli.join(', ')}).` });
        const tutar = parseFloat(b.tutar);
        if (!(tutar > 0)) return res.json({ ok: false, hata: 'Tutar sıfırdan büyük olmalı.' });
        if (!b.belge_tarihi) return res.json({ ok: false, hata: 'Tarih zorunludur.' });
        if (tip === 'CEK' && (!b.cek_no || !String(b.cek_no).trim())) return res.json({ ok: false, hata: 'Çek için çek no zorunludur.' });
        if (tip === 'CEK' && !b.vade_tarihi) return res.json({ ok: false, hata: 'Çek için vade tarihi zorunludur (nakit akışına girer).' });
        if (tip === 'PROJEKSIYON' && !['AVANS', 'HAKEDIS', 'CEK'].includes(String(b.projeksiyon_tur || '').toUpperCase()))
            return res.json({ ok: false, hata: 'Projeksiyon türü Avans / Hakediş / Çek olmalıdır.' });
        // ODEME/TAHSILAT normalde gerçekleşmiş nakit kaydıdır; "planlı" bayrağıyla ileri tarihli
        // taksit olarak girilir (kasa/bakiyeye dokunmaz, nakit akışa vadesiyle yazılır)
        const planli = !!b.planli && (tip === 'ODEME' || tip === 'TAHSILAT');
        if (planli && !b.vade_tarihi) return res.json({ ok: false, hata: 'Planlı ödeme/tahsilat için ödeme tarihi (vade) zorunludur.' });
        const gerc = (tip === 'ODEME' || tip === 'TAHSILAT') && !planli;
        const i = await pool.query(`
            INSERT INTO cari_hareketler (taraf_tip, taraf_id, tip, belge_tarihi, belge_no, tutar,
                vade_tarihi, gerceklesen_tarih, gerceklesen_tutar, cek_no, banka, muhlet_oncesi,
                projeksiyon_tur, aciklama, olusturan_email)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [tarafTip, tarafTip === 'GIDER' ? 0 : parseInt(b.taraf_id), tip, b.belge_tarihi, (b.belge_no || '').trim() || null, tutar,
             b.vade_tarihi || null, gerc ? b.belge_tarihi : null, gerc ? tutar : null,
             (b.cek_no || '').trim() || null, (b.banka || '').trim() || null, !!b.muhlet_oncesi,
             tip === 'PROJEKSIYON' ? String(b.projeksiyon_tur).toUpperCase() : null,
             (b.aciklama || '').trim() || null, req.user.email]);
        await auditLogla(req, { eylem: 'CREATE', tablo: 'cari_hareketler', kayit_id: i.rows[0].id, ozet: `${tarafTip} #${b.taraf_id} ${tip} ${tutar} TL` });
        res.json({ ok: true, id: i.rows[0].id, mesaj: 'Hareket kaydedildi.' });
    } catch (e) { next(e); }
});

// Hareket sil — yalnız TAM yetki (yanlış giriş düzeltme; iz audit'te kalır)
app.post('/api/mali-hareket-sil', yetkiKontrol, async (req, res, next) => {
    try {
        const d = await pool.query('DELETE FROM cari_hareketler WHERE id=$1 RETURNING taraf_tip, taraf_id, tip, tutar', [req.body.id]);
        if (!d.rowCount) return res.json({ ok: false, hata: 'Hareket bulunamadı.' });
        const h = d.rows[0];
        await auditLogla(req, { eylem: 'DELETE', tablo: 'cari_hareketler', kayit_id: parseInt(req.body.id), ozet: `${h.taraf_tip} #${h.taraf_id} ${h.tip} ${h.tutar} TL SİLİNDİ` });
        res.json({ ok: true, mesaj: 'Hareket silindi.' });
    } catch (e) { next(e); }
});

// Kart dışı gider kalemleri (maaş vb.) — açık planlar önce, sonra gerçekleşenler
app.get('/api/mali-giderler', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT * FROM cari_hareketler WHERE taraf_tip='GIDER'
            ORDER BY (gerceklesen_tarih IS NOT NULL), COALESCE(planlanan_vade, vade_tarihi, belge_tarihi), id`);
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// İlgili kişi dropdown'u için aktif ekip listesi (yalnız id + ad; e-posta inmez)
app.get('/api/mali-ekip', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query("SELECT id, ad_soyad FROM kullanicilar WHERE durum='AKTIF' ORDER BY ad_soyad");
        res.json({ ok: true, data: r.rows });
    } catch (e) { next(e); }
});

// Mali ayarlar (mühlet tarihi, kasa açılışı) — okuma herkes (modül izinli), yazma ADMIN
app.get('/api/mali-ayar', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query("SELECT deger FROM sistem_ayarlari WHERE anahtar='mali_ayar'");
        const ayar = r.rows[0]?.deger || { muhlet_tarihi: null, kasa_acilis: 0 };
        if (!ayar.varsayilan_odeme_vadesi) ayar.varsayilan_odeme_vadesi = '2026-07-13';
        res.json({ ok: true, ayar });
    } catch (e) { next(e); }
});
app.post('/api/mali-ayar', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin')
            return res.status(403).json({ ok: false, hata: 'Mali ayarları yalnızca ADMIN değiştirebilir.' });
        const yeni = { muhlet_tarihi: req.body.muhlet_tarihi || null, kasa_acilis: parseFloat(req.body.kasa_acilis) || 0,
            varsayilan_odeme_vadesi: req.body.varsayilan_odeme_vadesi || '2026-07-13' };
        await pool.query(`INSERT INTO sistem_ayarlari (anahtar, deger, guncelleme) VALUES ('mali_ayar', $1, now())
            ON CONFLICT (anahtar) DO UPDATE SET deger=$1, guncelleme=now()`, [JSON.stringify(yeni)]);
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'sistem_ayarlari', ozet: `Mali ayar: mühlet=${yeni.muhlet_tarihi || '-'}, kasa açılış=${yeni.kasa_acilis}` });
        res.json({ ok: true, ayar: yeni, mesaj: 'Mali ayarlar kaydedildi.' });
    } catch (e) { next(e); }
});

// ============ MALİ İŞLER — FAZ 2 (nakit akış + kasa) ============
// Üç değerli vade modeli: asıl vade (vade_tarihi, SABİT) / planlanan (planlanan_vade+planlanan_tutar,
// hareketli) / gerçekleşen (gerceklesen_tarih+gerceklesen_tutar, işlenince kilit).

// Planlama: yalnız gerçekleşmemiş FATURA/CEK/PROJEKSIYON kalemlerinde; boş gönderilirse plan silinir (asıl vadeye dönülür)
app.post('/api/mali-hareket-planla', yetkiKontrol, async (req, res, next) => {
    try {
        const h = await pool.query('SELECT tip, gerceklesen_tarih FROM cari_hareketler WHERE id=$1', [req.body.id]);
        if (!h.rowCount) return res.json({ ok: false, hata: 'Hareket bulunamadı.' });
        if (h.rows[0].gerceklesen_tarih) return res.json({ ok: false, hata: 'Gerçekleşmiş kalem yeniden planlanamaz.' });
        if (!['FATURA', 'CEK', 'PROJEKSIYON', 'ODEME', 'TAHSILAT'].includes(h.rows[0].tip)) return res.json({ ok: false, hata: 'Bu kalem planlanamaz.' });
        await pool.query('UPDATE cari_hareketler SET planlanan_vade=$1, planlanan_tutar=$2 WHERE id=$3',
            [req.body.planlanan_vade || null, parseFloat(req.body.planlanan_tutar) || null, req.body.id]);
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'cari_hareketler', kayit_id: parseInt(req.body.id), ozet: `Plan: vade=${req.body.planlanan_vade || '-'}, tutar=${req.body.planlanan_tutar || '-'}` });
        res.json({ ok: true, mesaj: req.body.planlanan_vade ? 'Plan kaydedildi.' : 'Plan kaldırıldı (asıl vadeye dönüldü).' });
    } catch (e) { next(e); }
});

// Gerçekleştirme: tedarikçi FATURA → otomatik ÖDEME kaydı; müşteri FATURA/PROJEKSIYON → otomatik
// TAHSİLAT kaydı; ÇEK → yalnız damga (kasadan düşer, cari bakiyeye ayrıca dokunmaz)
app.post('/api/mali-hareket-gerceklestir', yetkiKontrol, async (req, res, next) => {
    const cl = await pool.connect();
    try {
        const { id, tarih, tutar } = req.body;
        if (!tarih) return res.json({ ok: false, hata: 'Gerçekleşme tarihi zorunludur.' });
        const t = parseFloat(tutar);
        if (!(t > 0)) return res.json({ ok: false, hata: 'Gerçekleşen tutar sıfırdan büyük olmalı.' });
        await cl.query('BEGIN');
        // Atomik: yalnız henüz gerçekleşmemişse damgala (çift tıklama mükerrer kayıt üretmez)
        const u = await cl.query(`UPDATE cari_hareketler SET gerceklesen_tarih=$1, gerceklesen_tutar=$2
            WHERE id=$3 AND gerceklesen_tarih IS NULL AND tip IN ('FATURA','CEK','PROJEKSIYON','ODEME','TAHSILAT') RETURNING *`, [tarih, t, id]);
        if (!u.rowCount) { await cl.query('ROLLBACK'); return res.json({ ok: false, hata: 'Kalem bulunamadı, zaten gerçekleşmiş ya da bu tipte gerçekleştirme yapılamaz.' }); }
        const h = u.rows[0];
        let karsi = null;
        // karsi_kayit=false: fatura avans/mahsupla kapatıldı — otomatik ödeme/tahsilat üretilmez
        if ((h.tip === 'FATURA' || h.tip === 'PROJEKSIYON') && req.body.karsi_kayit !== false) {
            const yeniTip = h.taraf_tip === 'TEDARIKCI' ? 'ODEME' : 'TAHSILAT';
            const ozet = h.tip === 'FATURA'
                ? `Fatura ${h.belge_no || '#' + h.id} ${yeniTip === 'ODEME' ? 'ödemesi' : 'tahsilatı'}`
                : `Projeksiyon (${h.projeksiyon_tur || ''}) tahsilatı`;
            const i = await cl.query(`INSERT INTO cari_hareketler (taraf_tip, taraf_id, tip, belge_tarihi, belge_no,
                tutar, gerceklesen_tarih, gerceklesen_tutar, aciklama, olusturan_email)
                VALUES ($1,$2,$3,$4,$5,$6,$4,$6,$7,$8) RETURNING id`,
                [h.taraf_tip, h.taraf_id, yeniTip, tarih, h.belge_no, t, ozet, req.user.email]);
            karsi = { id: i.rows[0].id, tip: yeniTip };
        }
        await cl.query('COMMIT');
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'cari_hareketler', kayit_id: parseInt(id), ozet: `GERÇEKLEŞTİ: ${h.taraf_tip} #${h.taraf_id} ${h.tip} ${t} TL (${tarih})${karsi ? ' → otomatik ' + karsi.tip : ''}` });
        res.json({ ok: true, mesaj: 'Gerçekleşme işlendi.' + (karsi ? ` Otomatik ${karsi.tip === 'ODEME' ? 'ödeme' : 'tahsilat'} kaydı oluşturuldu.` : ''), karsi });
    } catch (e) { await cl.query('ROLLBACK').catch(() => {}); next(e); }
    finally { cl.release(); }
});

// Kasa bugünkü bakiyesi = kasa açılışı + gerçekleşen tahsilatlar − ödemeler − ödenen çekler
async function maliKasaBakiye() {
    const a = await pool.query("SELECT deger FROM sistem_ayarlari WHERE anahtar='mali_ayar'");
    const acilis = parseFloat(a.rows[0]?.deger?.kasa_acilis) || 0;
    const r = await pool.query(`SELECT
            COALESCE(SUM(CASE WHEN tip='TAHSILAT' AND gerceklesen_tarih IS NOT NULL THEN COALESCE(gerceklesen_tutar, tutar) END), 0) AS giris,
            COALESCE(SUM(CASE WHEN tip='ODEME' AND gerceklesen_tarih IS NOT NULL THEN COALESCE(gerceklesen_tutar, tutar) END), 0) AS cikis_odeme,
            COALESCE(SUM(CASE WHEN tip='CEK' AND gerceklesen_tarih IS NOT NULL THEN gerceklesen_tutar END), 0) AS cikis_cek
        FROM cari_hareketler`);
    const x = r.rows[0];
    return { acilis, bakiye: acilis + parseFloat(x.giris) - parseFloat(x.cikis_odeme) - parseFloat(x.cikis_cek) };
}

// Nakit akış: gerçekleşmemiş kalemler etkin vadeye (planlanan ?? asıl) göre gün gün
app.get('/api/mali-nakit-akis', yetkiKontrol, async (req, res, next) => {
    try {
        const gun = Math.min(parseInt(req.query.gun) || 60, 365);
        const r = await pool.query(`
            SELECT h.id, h.taraf_tip, h.taraf_id, h.tip, h.belge_no, h.cek_no, h.projeksiyon_tur,
                   h.tutar, h.planlanan_tutar, h.vade_tarihi, h.planlanan_vade,
                   COALESCE(h.planlanan_vade, h.vade_tarihi) AS etkin_vade,
                   COALESCE(h.planlanan_tutar, h.tutar) AS etkin_tutar,
                   CASE WHEN h.taraf_tip='TEDARIKCI' THEN t.firma_adi WHEN h.taraf_tip='MUSTERI' THEN m.firma_adi
                        ELSE COALESCE(h.aciklama, 'Diğer gider') END AS firma_adi,
                   CASE WHEN h.taraf_tip='MUSTERI' THEN 'GIRIS' ELSE 'CIKIS' END AS yon
            FROM cari_hareketler h
            LEFT JOIN tedarikciler t ON h.taraf_tip='TEDARIKCI' AND h.taraf_id = t.id
            LEFT JOIN musteriler m ON h.taraf_tip='MUSTERI' AND h.taraf_id = m.id
            WHERE h.gerceklesen_tarih IS NULL
              AND ((h.taraf_tip='TEDARIKCI' AND h.tip IN ('FATURA','CEK','ODEME'))
                OR (h.taraf_tip='MUSTERI' AND h.tip IN ('FATURA','PROJEKSIYON','TAHSILAT'))
                OR (h.taraf_tip='GIDER' AND h.tip='ODEME'))
              AND NOT (h.tip='CEK' AND h.muhlet_oncesi)
            ORDER BY etkin_vade NULLS LAST, h.id`);
        // Mühlet öncesi çekler nakit akışa GİRMEZ (konkordato/yapılandırma kapsamı, ödenmeyecek)
        // Faturasız cari borç (devir kısmı): bakiye − açık faturalar; varsayılan ödeme vadesiyle akışa girer
        const ayarR = await pool.query("SELECT deger FROM sistem_ayarlari WHERE anahtar='mali_ayar'");
        const varsayilanVade = ayarR.rows[0]?.deger?.varsayilan_odeme_vadesi || '2026-07-13';
        const devirler = await pool.query(`
            SELECT t.id, t.firma_adi,
                   COALESCE(t.muhlet_sonrasi_devir, 0)
                   + COALESCE(SUM(CASE WHEN h.tip='FATURA' THEN h.tutar END), 0)
                   - COALESCE(SUM(CASE WHEN h.tip IN ('ODEME','TAHSILAT') AND h.gerceklesen_tarih IS NOT NULL THEN COALESCE(h.gerceklesen_tutar, h.tutar) END), 0) AS bakiye,
                   COALESCE(SUM(CASE WHEN h.tip='FATURA' AND h.gerceklesen_tarih IS NULL THEN h.tutar END), 0) AS acik_fatura,
                   COALESCE(SUM(CASE WHEN h.tip='ODEME' AND h.gerceklesen_tarih IS NULL THEN COALESCE(h.planlanan_tutar, h.tutar) END), 0) AS acik_plan
            FROM tedarikciler t
            LEFT JOIN cari_hareketler h ON h.taraf_tip='TEDARIKCI' AND h.taraf_id = t.id
            GROUP BY t.id, t.firma_adi`);
        const kasa = await maliKasaBakiye();
        const bugun = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
        const bitis = new Date(Date.now() + gun * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
        const ymdStr = v => v ? String(v instanceof Date ? v.toLocaleDateString('sv-SE') : v).slice(0, 10) : null;
        const kalemler = [], gecikmis = [], vadesiz = [];
        for (const h of r.rows) {
            let vade = ymdStr(h.etkin_vade);
            const kalem = { id: h.id, taraf_tip: h.taraf_tip, taraf_id: h.taraf_id, firma_adi: h.firma_adi,
                tip: h.tip, belge_no: h.belge_no, cek_no: h.cek_no, projeksiyon_tur: h.projeksiyon_tur,
                yon: h.yon, tutar: parseFloat(h.etkin_tutar), asil_vade: ymdStr(h.vade_tarihi),
                planlanan_vade: ymdStr(h.planlanan_vade), vade };
            // Plan kalemleri (ödeme/tahsilat planı) gecikmişe DÜŞMEZ: o gün ödenmediyse
            // ve yeni vade girilmediyse otomatik bugüne taşınır (kullanıcı kuralı)
            if ((h.tip === 'ODEME' || h.tip === 'TAHSILAT') && vade && vade < bugun) {
                kalem.tasindi = true; kalem.vade = vade = bugun;
            }
            if (!vade) vadesiz.push(kalem);
            else if (vade < bugun) gecikmis.push(kalem);
            else if (vade <= bitis) kalemler.push(kalem);
        }
        // Devir kalemleri de plan niteliğindedir — varsayılan vade geçtiyse bugüne taşınır
        const devirVade = varsayilanVade < bugun ? bugun : varsayilanVade;
        for (const d of devirler.rows) {
            // Devir kalemi = bakiye − açık faturalar − planlı ödeme taksitleri (taksitler kendi tarihinde ayrı kalem)
            const tutar = Math.round((parseFloat(d.bakiye) - parseFloat(d.acik_fatura) - parseFloat(d.acik_plan)) * 100) / 100;
            if (tutar <= 0) continue;
            const kalem = { id: null, taraf_tip: 'TEDARIKCI', taraf_id: d.id, firma_adi: d.firma_adi,
                tip: 'DEVIR', belge_no: null, cek_no: null, projeksiyon_tur: null,
                yon: 'CIKIS', tutar, asil_vade: varsayilanVade, planlanan_vade: null, vade: devirVade,
                tasindi: devirVade !== varsayilanVade };
            if (devirVade <= bitis) kalemler.push(kalem);
        }
        kalemler.sort((a, b) => a.vade < b.vade ? -1 : a.vade > b.vade ? 1 : 0);
        res.json({ ok: true, bugun, bitis, kasa_bugun: kasa.bakiye, kasa_acilis: kasa.acilis, varsayilan_vade: varsayilanVade, kalemler, gecikmis, vadesiz });
    } catch (e) { next(e); }
});

// Kasa defteri: gerçekleşen nakit hareketleri kronolojik (kümülatif frontend'de hesaplanır)
app.get('/api/mali-kasa', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT h.id, h.taraf_tip, h.taraf_id, h.tip, h.belge_no, h.cek_no, h.aciklama,
                   COALESCE(h.gerceklesen_tarih, h.belge_tarihi) AS tarih,
                   COALESCE(h.gerceklesen_tutar, h.tutar) AS tutar,
                   CASE WHEN h.taraf_tip='TEDARIKCI' THEN t.firma_adi WHEN h.taraf_tip='MUSTERI' THEN m.firma_adi
                        ELSE COALESCE(h.aciklama, 'Diğer gider') END AS firma_adi
            FROM cari_hareketler h
            LEFT JOIN tedarikciler t ON h.taraf_tip='TEDARIKCI' AND h.taraf_id = t.id
            LEFT JOIN musteriler m ON h.taraf_tip='MUSTERI' AND h.taraf_id = m.id
            WHERE (h.tip IN ('ODEME','TAHSILAT') AND h.gerceklesen_tarih IS NOT NULL) OR (h.tip='CEK' AND h.gerceklesen_tarih IS NOT NULL)
            ORDER BY tarih, h.id`);
        const kasa = await maliKasaBakiye();
        res.json({ ok: true, kasa_acilis: kasa.acilis, kasa_bugun: kasa.bakiye, data: r.rows });
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
            teslim_adresi || null, siparis_notu || null, para_birimi || 'TL', normKdv(kdv_orani), id
        ]);

        // Sipariş kalemlerini güncelle: fiyat + miktar. Miktar değişimi kalan alt-talebe yansır (toplam korunur).
        for (const k of (kalemler || [])) {
            if (!k.siparis_kalem_id) continue;
            const yeniMiktar = parseFloat(k.siparis_miktari) || 0;
            const yeniFiyat = parseFloat(k.birim_fiyat) || 0;
            if (yeniMiktar <= 0) { await client.query('ROLLBACK'); return res.json({ ok: false, hata: 'Kalem miktarı 0\'dan büyük olmalı.' }); }
            await client.query('UPDATE siparis_kalemleri SET birim_fiyat=$1 WHERE id=$2', [yeniFiyat, k.siparis_kalem_id]);
            const sonuc = await kalemMiktarSenkronla(client, k.siparis_kalem_id, yeniMiktar);
            if (sonuc.hata) { await client.query('ROLLBACK'); return res.json({ ok: false, hata: sonuc.hata }); }
        }

        await client.query('COMMIT');
        res.json({ ok: true, mesaj: 'Sipariş güncellendi.' });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
                { label: 'Birim fiyat', value: birim_fiyat ? `${trSayi(birim_fiyat, { min: 2 })} ${para_birimi || 'TL'}` : '-' }
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
// Türkçe sayı biçimi: binlik ayıraç nokta, ondalık ayıraç virgül (mail/bildirim gövdeleri).
// min=0 → gereksiz ondalık gösterilmez (miktar); min=2 → para için sabit iki hane.
function trSayi(n, { min = 0, max = 2 } = {}) {
    const v = parseFloat(n);
    if (!isFinite(v)) return esc2(n == null ? '' : n);
    return v.toLocaleString('tr-TR', { minimumFractionDigits: min, maximumFractionDigits: max });
}

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
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;white-space:nowrap;">${trSayi(k.miktar)} ${esc2(k.birim || '')}</td>
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
        // 2b) Çağrıya özel ek alıcılar (örn. iş emrinin ek_alicilar alanı)
        (context.ekAlicilar || []).forEach(e => e && aliciSet.add(String(e).trim()));
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
            // Satınalma olayları satinalma@'dan, diğer her şey (iş emri, görev vb.) aterko@'dan
            from: `"Aterko Workspace" <${SATINALMA_OLAY_MI(olayKodu) ? MAIL_FROM_EMAIL : MAIL_FROM_GENEL}>`,
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
        // Atomik durum geçişi — yalnızca "SİPARİŞ OLUŞTURULDU" iken onaylanır.
        // Mükerrer/eşzamanlı istekler (çift tıklama, ağ tekrarı) tekrar bildirim ÜRETMEZ (idempotent):
        // yalnızca ilk geçiş bir satır döndürür; sonrakiler rowCount=0 ile sessizce çıkar.
        const upd = await pool.query(
            "UPDATE satinalma_siparisleri SET durum='SİPARİŞ ONAYLANDI', onaylanma_tarihi=NOW() WHERE id=$1 AND durum='SİPARİŞ OLUŞTURULDU' RETURNING siparis_no",
            [req.body.siparis_id]);
        if (upd.rowCount === 0) {
            return res.json({ ok: true, mesaj: 'Sipariş zaten onaylanmış — tekrar bildirim gönderilmedi.', tekrar: true });
        }
        await auditLogla(req, {
            eylem: 'APPROVE', tablo: 'satinalma_siparisleri', kayit_id: req.body.siparis_id,
            ozet: 'Sipariş onaylandı'
        });
        const soNo = upd.rows[0];
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
                const kdv = normKdv(sip.kdv_orani);
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
    const kdv = normKdv(s.kdv_orani);
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
            const pb = row.para_birimi || 'TL';
            // Aynı tedarikçinin farklı para birimindeki fiyatları KARIŞTIRILMAMALI
            const k = (row.tedarikci_id || 0) + '|' + pb;
            if (!tedarikciOzet[k]) {
                tedarikciOzet[k] = {
                    tedarikci_id: row.tedarikci_id,
                    tedarikci_adi: row.tedarikci_adi || '-',
                    para_birimi: pb,
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
        const etkilenenTalepUrun = new Set();   // mal kabul sonrası talep başlık durumunu güncellemek için

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
            etkilenenTalepUrun.add(sk.talep_urun_id);
            const eskiTeslim = parseFloat(sk.teslim_alinan_miktar) || 0;
            const siparisMiktari = parseFloat(sk.siparis_miktari) || 0;
            const kalan = siparisMiktari - eskiTeslim;
            // Fazla teslim engeli: girilen miktar kalan miktarı aşamaz (stok/maliyet şişmesin)
            if (teslimMiktar > kalan + 0.001) {
                await client.query('ROLLBACK');
                return res.json({ ok: false, hata: `Teslim miktarı sipariş kalanını aşamaz (kalem kalan: ${kalan}, girilen: ${teslimMiktar}).` });
            }
            const yeniToplamTeslim = eskiTeslim + teslimMiktar;
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

        // Etkilenen taleplerin başlık durumunu kalemlerinden yeniden türet (mal kabul sonrası bayat kalmasın)
        if (etkilenenTalepUrun.size) {
            const tgR = await client.query('SELECT DISTINCT talep_id FROM talep_urunleri WHERE id = ANY($1::integer[])', [[...etkilenenTalepUrun]]);
            for (const row of tgR.rows) await talepBaslikDurumGuncelle(client, row.talep_id);
        }

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
        try { await client.query('ROLLBACK'); } catch (_) {}
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

// Teknik şartname salt-okunur alanlarının bağlanabileceği teslimat (bina bilgisi) kolonları
const BILGI_ALANLARI = {
    'bina_tipi': 'Bina Tipi',
    'kat_adedi': 'Kat Adedi',
    'kat_yuksekligi': 'Kat Yüksekliği',
    'bina_adedi': 'Bina Adedi',
    'konteyner_ebadi': 'Konteyner Ebadı',
    'konteyner_miktari': 'Konteyner Miktarı',
    'dis_duvar_kesiti': 'Dış Duvar Kesiti',
    'ic_duvar_kesiti': 'İç Duvar Kesiti',
    'buyukluk_m2': 'Büyüklük (m²)',
    'bina_yeri': 'Bina Yeri',
    'bina_adi': 'Bina Adı'
};
// Bir teslimat için form_tanimlari'nda kaynak_kolon tanımlı salt-okunur alanların değerleri (soru → değer)
async function otomatikAlanDegerleri(t) {
    const r = await pool.query(
        "SELECT DISTINCT soru, kaynak_kolon FROM form_tanimlari WHERE bina_turu=$1 AND kaynak_kolon IS NOT NULL AND kaynak_kolon<>''",
        [t.bina_turu]);
    const o = {};
    r.rows.forEach(({ soru, kaynak_kolon }) => {
        if (BILGI_ALANLARI[kaynak_kolon] && t[kaynak_kolon] != null && t[kaynak_kolon] !== '')
            o[soru] = String(t[kaynak_kolon]);
    });
    return o;
}

// Teslimatın mevcut teknik şartname verisini getir
app.get('/api/teknik-sartname/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimatId } = req.params;
        const result = await pool.query(`
            SELECT pt.*, p.durum AS proje_durum
            FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id = p.id
            WHERE pt.id = $1`, [teslimatId]);
        if (result.rowCount === 0) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const t = result.rows[0];
        // SALT_OKUNUR alanlar için otomatik değerler — kaynak_kolon eşleştirmesinden (panelden yönetilir)
        const otomatikDegerler = await otomatikAlanDegerleri(t);
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
// Dinamik üretici lib/teknik-sartname-dinamik.js'e taşındı (test edilebilirlik için)
const { teknikSartnameHTML, teslimatVeri, cevapBicim, motorIsle } = require('./lib/teknik-sartname-dinamik');

// PDF dosya adı yardımcıları: yasak karakterleri temizle + Türkçe karakterli ad için
// RFC5987 Content-Disposition (filename* UTF-8; ASCII fallback) — Node header'a ham
// Türkçe karakter kabul etmez.
const dosyaAdiTemizle = s => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150);
const cdHeader = ad => `inline; filename="${ad.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(ad)}`;

// Teknik şartname kodu — iş emri gibi proje bazlı iki basamak: {proje_kodu}-TŞ-01, -02...
// İlk PDF üretiminde atanır ve teslimatta SABİT kalır.
async function sartnameKoduAta(t) {
    if (t.sartname_kodu) return t.sartname_kodu;
    const mx = await pool.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(sartname_kodu, '^.*-TŞ-', ''), '')::int), 0) AS mx
         FROM proje_teslimatlari WHERE proje_id=$1 AND sartname_kodu LIKE '%-TŞ-%'`, [t.proje_id]);
    const kod = `${t.proje_kodu}-TŞ-${String(Number(mx.rows[0].mx) + 1).padStart(2, '0')}`;
    // Yarışta benzersizlik: yalnız hâlâ boşsa yaz; doluysa mevcut değeri kullan
    const u = await pool.query("UPDATE proje_teslimatlari SET sartname_kodu=$1 WHERE id=$2 AND sartname_kodu IS NULL RETURNING sartname_kodu", [kod, t.id]);
    t.sartname_kodu = u.rowCount ? u.rows[0].sartname_kodu
        : (await pool.query("SELECT sartname_kodu FROM proje_teslimatlari WHERE id=$1", [t.id])).rows[0].sartname_kodu;
    return t.sartname_kodu;
}

// Teslimatın teknik şartname PDF'ini üretir (dinamik şablon → Google fallback → form).
// Hem GET /teknik-sartname-pdf hem İş Emri snapshot'ı (is-emri-olustur) bu tek kaynağı kullanır.
async function teslimatSartnamePDF(teslimatId, kullaniciAd) {
    const r = await pool.query(`
        SELECT pt.*, p.proje_kodu, p.musteri_adi, p.proje_adi, p.nakliye, p.satis_temsilcisi
        FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id = p.id
        WHERE pt.id = $1
    `, [teslimatId]);
    if (r.rowCount === 0) throw new Error('Teslimat bulunamadı.');
    const t = r.rows[0];
    await sartnameKoduAta(t);   // {proje_kodu}-TŞ-NN — ilk üretimde atanır, sabit kalır

        // Bina türünün özel (zengin, EĞER/HESAP/HARİCİ'li) şablonu varsa onu kullan — birebir doküman.
        const SABLON_HARITASI = { 'Prefabrik': 'prefabrik' };
        const fs = require('fs'); const path = require('path');
        const sablon = SABLON_HARITASI[t.bina_turu];
        const { renderToPDF, htmlToPDF } = require('./lib/pdf-generator');
        let pdfBuffer;
        // Her sayfa sağ altına proje künyesi (gri italik)
        const fesc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const pdfOpts = {
            margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
            footerTemplate: `<div style="width:100%;font-family:'Rubik','Helvetica',sans-serif;font-size:7pt;color:#888;font-style:italic;padding:0 20mm;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;">` +
                `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
                `<span>${fesc(t.sartname_kodu)} · ${fesc(t.proje_kodu)} / ${fesc(t.musteri_adi)} - ${fesc(t.proje_adi)} [ ${fesc(t.bina_adi)} ]</span>` +
                `</div>`
        };

        // 1) Panelden yönetilen DB şablonu (teknik_sartname_sablonu) varsa → dinamik üret
        const tsSab = await pool.query(
            "SELECT bolum_no,bolum_adi,bolum_gizle,bolum_aciklama,soru,cevap_sablonu,yeni_tablo,baslik_gizle FROM teknik_sartname_sablonu WHERE bina_turu=$1 ORDER BY bolum_no,satir_sira",
            [t.bina_turu]);
        if (tsSab.rowCount) {
            const ft = tsSab.rows.map(x => ({
                bolum_adi: x.bolum_adi, bolum_sirasi: x.bolum_no, soru: x.soru, cevap_sablonu: x.cevap_sablonu,
                bolum_aciklama: x.bolum_aciklama, yeni_tablo: x.yeni_tablo, baslik_gizle: x.baslik_gizle,
                bolum_gizle: x.bolum_gizle || null
            }));
            pdfBuffer = await htmlToPDF(teknikSartnameHTML(t, ft, kullaniciAd), pdfOpts);
        } else if (sablon && fs.existsSync(path.join(__dirname, 'templates', sablon + '.html'))) {
            const trTarih = d => { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`; };
            const degerler = {
                'Proje No': t.proje_kodu, 'Müşteri Adı': t.musteri_adi, 'Proje Adı': t.proje_adi,
                'Bina Yeri': t.bina_yeri || '', 'Nakliye': t.nakliye || '',
                'Bina Adı': t.bina_adi || '', 'Bina Tipi': t.bina_tipi || '',
                'Kat Yüksekliği': t.kat_yuksekligi || '', 'Kat Adedi': t.kat_adedi || '',
                'Büyüklük': t.buyukluk_m2 ? `${t.buyukluk_m2} m²` : '',
                'TARİH': trTarih(new Date()), 'DÜZENLEYEN': kullaniciAd || '', 'KOD': `${t.proje_kodu}-${t.id}`,
                ...(t.ek_veriler || {}) // form cevapları (Dış Duvar Kalınlığı (mm), Bina Tipi vb.)
            };
            // Salt-okunur alanlar (kaynak_kolon eşleştirmesi) teslimattan güncel gelsin (ek_veriler'i ezer)
            Object.assign(degerler, await otomatikAlanDegerleri(t));
            // Boş bırakılan GİRİŞ (serbest metin) alanlarına "-" koy
            const girisR = await pool.query("SELECT soru FROM form_tanimlari WHERE bina_turu=$1 AND giris_tipi='GİRİŞ'", [t.bina_turu]);
            girisR.rows.forEach(({ soru }) => {
                if (degerler[soru] == null || String(degerler[soru]).trim() === '') degerler[soru] = '-';
            });
            // Antet sadece ilk sayfada (şablonun başında) — her sayfada tekrar etmez
            pdfBuffer = await renderToPDF(sablon, degerler);
        } else {
            // Özel şablonu olmayan türler için form tanımlarından dinamik üretim
            const ftR = await pool.query(`
                SELECT bolum_adi, bolum_sirasi, soru, soru_sirasi, giris_tipi, kosullar, secenek_metinleri
                FROM form_tanimlari WHERE bina_turu = $1 ORDER BY bolum_sirasi, soru_sirasi
            `, [t.bina_turu]);
            if (ftR.rowCount === 0) {
                throw new Error(`"${t.bina_turu}" bina türü için şablon veya form tanımı yok.`);
            }
            pdfBuffer = await htmlToPDF(teknikSartnameHTML(t, ftR.rows, kullaniciAd), pdfOpts);
        }
    return { pdfBuffer, t };
}

app.get('/api/teknik-sartname-pdf/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const { pdfBuffer, t } = await teslimatSartnamePDF(req.params.teslimatId, req.user.adSoyad);
        // Zengin dosya adı: {kod} __ {proje_kodu} _ {müşteri} - {proje adı} [ {bina adı} ].pdf
        const dosyaAdi = dosyaAdiTemizle(`${t.sartname_kodu} __ ${t.proje_kodu} _ ${t.musteri_adi} - ${t.proje_adi} [ ${t.bina_adi} ]`) + '.pdf';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', cdHeader(dosyaAdi));
        res.send(pdfBuffer);
    } catch (error) {
        console.error('🔥 Teknik şartname PDF Hatası:', error);
        res.status(500).json({ ok: false, hata: error.message });
    }
});

// Panelde önizleme/örnek PDF için temsili teslimat üretir (her form alanının İLK seçeneğiyle)
async function ornekTeslimat(binaTuru) {
    const ff = await pool.query("SELECT soru, giris_tipi, secenekler FROM form_tanimlari WHERE bina_turu=$1", [binaTuru]);
    const ek = {};
    ff.rows.forEach(f => {
        const sec = Array.isArray(f.secenekler) ? f.secenekler : [];
        const tip = (f.giris_tipi || '').toUpperCase();
        if ((tip === 'TEK' || tip === 'ÇOK' || tip === 'COK') && sec.length) ek[f.soru] = sec[0];
        else if (tip === 'GİRİŞ' || tip === 'GIRIS') ek[f.soru] = '(örnek)';
    });
    return {
        bina_turu: binaTuru, proje_kodu: 'ÖRNEK', musteri_adi: 'Örnek Müşteri',
        proje_adi: 'Örnek Proje', nakliye: 'Alıcıya aittir', bina_adi: 'Örnek Bina',
        bina_tipi: ek['Bina Tipi'] || '', kat_adedi: ek['Kat Adedi'] || 1,
        kat_yuksekligi: ek['Kat Yüksekliği (mm)'] || 3000, buyukluk_m2: 100,
        bina_yeri: 'Örnek Şantiye', montaj_gerekli: true, ek_veriler: ek
    };
}

// #3 — Panelden örnek PDF (temsili verilerle tam şablon)
app.get('/api/teknik-sartname-ornek-pdf/:binaTuru', yetkiKontrol, async (req, res, next) => {
    try {
        const binaTuru = req.params.binaTuru;
        const tsSab = await pool.query(
            "SELECT bolum_no,bolum_adi,bolum_gizle,bolum_aciklama,soru,cevap_sablonu,yeni_tablo,baslik_gizle FROM teknik_sartname_sablonu WHERE bina_turu=$1 ORDER BY bolum_no,satir_sira",
            [binaTuru]);
        if (!tsSab.rowCount) return res.status(400).json({ ok: false, hata: `"${binaTuru}" için şablon yok.` });
        const t = await ornekTeslimat(binaTuru);
        const ft = tsSab.rows.map(x => ({
            bolum_adi: x.bolum_adi, bolum_sirasi: x.bolum_no, soru: x.soru, cevap_sablonu: x.cevap_sablonu,
            bolum_aciklama: x.bolum_aciklama, yeni_tablo: x.yeni_tablo, baslik_gizle: x.baslik_gizle,
            bolum_gizle: x.bolum_gizle || null
        }));
        const { htmlToPDF } = require('./lib/pdf-generator');
        const pdf = await htmlToPDF(teknikSartnameHTML(t, ft, req.user.adSoyad),
            { margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
        const ad = `ORNEK-${binaTuru}-Teknik-Sartname.pdf`.replace(/[^a-zA-Z0-9\-_.]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${ad}"`);
        res.send(pdf);
    } catch (error) { console.error('🔥 Örnek PDF Hatası:', error); next(error); }
});

// #1 — Canlı önizleme: kaydetmeden, editördeki içeriğin çıktı görünümünü döndür
app.post('/api/teknik-sartname-onizle', yetkiKontrol, async (req, res, next) => {
    try {
        const { bina_turu, tip, karar, secenekler, metin, ham } = req.body;
        const { kur } = require('./lib/sartname-ayristir');
        let cevap_sablonu;
        if (tip === 'basit') cevap_sablonu = kur(karar, secenekler || {});
        else if (tip === 'sabit') cevap_sablonu = String(metin == null ? '' : metin);
        else cevap_sablonu = String(ham == null ? '' : ham);
        const t = await ornekTeslimat(bina_turu);
        const veri = teslimatVeri(t, req.user.adSoyad);
        const bicimle = v => { const r = cevapBicim(motorIsle(cevap_sablonu, v)); return r.trim() ? r : '<span class="text-muted fst-italic">(boş)</span>'; };
        if (tip === 'basit' && karar) {
            const onizleme = Object.keys(secenekler || {}).map(s => ({ secenek: s, html: bicimle({ ...veri, [karar]: s }) }));
            return res.json({ ok: true, tip, karar, onizleme });
        }
        return res.json({ ok: true, tip, html: bicimle(veri) });
    } catch (error) { next(error); }
});

// Teknik şartname formunu kaydet (ek_veriler JSONB'ye yaz)
app.post('/api/teknik-sartname-kaydet', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, form_verisi } = req.body;
        if (!teslimat_id) return res.json({ ok: false, hata: 'Teslimat ID gerekli.' });

        // İŞ EMRİ KİLİDİ: aktif iş emri varken şartname değiştirilemez
        const kilit = await aktifIsEmri(teslimat_id);
        if (kilit) return res.json({ ok: false, hata: `Teknik şartname ${kilit.emir_no} numaralı iş emrine bağlandı ve KİLİTLİDİR. Değişiklik için önce iş emrinin silinmesi (taslaksa) veya ADMIN tarafından iptali gerekir.` });
        // PROJE ONAY KİLİDİ: proje SÖZLEŞME'ye alındıysa (ADMIN onayı) şartname kilitlidir —
        // değişiklik için ADMIN'in onayı geri alması (proje → TASLAK) gerekir
        const pd = await pool.query(
            "SELECT p.durum FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id=p.id WHERE pt.id=$1", [teslimat_id]);
        if (pd.rows[0]?.durum === 'SÖZLEŞME')
            return res.json({ ok: false, hata: 'Proje ADMIN onayıyla SÖZLEŞME durumunda — teknik şartname KİLİTLİDİR. Değişiklik için ADMIN\'in proje onayını geri alması gerekir.' });

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

// Teknik şartname KOPYALAMA kaynakları: aynı bina türündeki, formu doldurulmuş diğer teslimatlar
// (aynı projeden veya başka projeden). Frontend seçilen kaynağın cevaplarını forma UYARLAYARAK alır.
app.get('/api/teknik-sartname-kopya-kaynaklar/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const cur = await pool.query('SELECT bina_turu FROM proje_teslimatlari WHERE id=$1', [req.params.teslimatId]);
        if (!cur.rowCount) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        const r = await pool.query(`
            SELECT pt.id, pt.bina_adi, pt.bina_tipi, pt.kat_yuksekligi, pt.kat_adedi,
                   pt.konteyner_ebadi, pt.buyukluk_m2, p.proje_kodu, p.musteri_adi, p.proje_adi
            FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id=p.id
            WHERE pt.bina_turu = $1 AND pt.id <> $2
              AND pt.ek_veriler IS NOT NULL AND pt.ek_veriler <> '{}'::jsonb
              AND COALESCE(pt.durum,'') <> 'İPTAL'
            ORDER BY pt.id DESC LIMIT 200`, [cur.rows[0].bina_turu, req.params.teslimatId]);
        res.json({ ok: true, bina_turu: cur.rows[0].bina_turu, kaynaklar: r.rows });
    } catch (e) { next(e); }
});

// ============================================================================
// İŞ EMRİ (teknik şartname bazlı, teslimat düzeyi) — SATIŞ aşaması
// Akış: teslimat (SÖZLEŞME) → iş emri OLUŞTUR [HAZIRLANDI; şartname KİLİTLENİR;
//       teslimat durumu 'İŞ EMRİ'] → YAYINLA [YAYINLANDI; teslimat 'PROJE';
//       ekibe PDF ekli mail] → yayın sonrası yalnız append-only NOT (her not mail).
// Belge = oluşturma ANINDA dondurulan PDF + veri kopyası; şablon sonradan değişse
// bile iş emri değişmez. Taslak silinebilir; yayınlananı yalnız ADMIN iptal eder
// (iz kalır) → şartname yeniden açılır. Üretimdeki kalem-bazlı iş emrinden AYRIDIR.
// ============================================================================
async function aktifIsEmri(teslimatId) {
    const r = await pool.query("SELECT * FROM is_emirleri WHERE teslimat_id=$1 AND durum <> 'İPTAL' LIMIT 1", [teslimatId]);
    return r.rows[0] || null;
}

// İş Emri PDF'i — şartnameden FARKLI format (lib isEmriHTML: bölüm başına kutu,
// başta Proje+Teslimat Bilgileri, sonda İş Emri Notu). Oluşturma anında dondurulur.
async function isEmriPDF(teslimatId, kullaniciAd, emirNo, isEmriNotu) {
    const r = await pool.query(`
        SELECT pt.*, p.proje_kodu, p.musteri_adi, p.proje_adi, p.nakliye,
               p.satis_temsilcisi, p.aset_link, p.drive_link
        FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id = p.id
        WHERE pt.id = $1`, [teslimatId]);
    if (r.rowCount === 0) throw new Error('Teslimat bulunamadı.');
    const t = r.rows[0];
    // İş emri FORM TANIMLARINDAN beslenir (şartname şablonundan DEĞİL):
    // formdaki başlıklar + sorular + formda verilen cevaplar (ek_veriler)
    const ftR = await pool.query(
        "SELECT bolum_adi, bolum_sirasi, soru, kosullar FROM form_tanimlari WHERE bina_turu=$1 ORDER BY bolum_sirasi, soru_sirasi", [t.bina_turu]);
    if (!ftR.rowCount) throw new Error(`"${t.bina_turu}" bina türü için form tanımı yok.`);
    const ft = ftR.rows;
    // Otomatik dolan (kaynak_kolon) alanların GÜNCEL değerleri cevaplara işlensin
    t.ek_veriler = { ...(t.ek_veriler || {}), ...(await otomatikAlanDegerleri(t)) };
    // [03] Projedeki Teslimatlar bölümü için: projedeki tüm (iptal olmayan) binalar
    const ptR = await pool.query(
        `SELECT id, bina_adi, bina_turu, bina_tipi, kat_yuksekligi, kat_adedi,
                konteyner_ebadi, konteyner_miktari, buyukluk_m2
         FROM proje_teslimatlari WHERE proje_id=$1 AND COALESCE(durum,'') <> 'İPTAL' ORDER BY id`, [t.proje_id]);
    const { htmlToPDF } = require('./lib/pdf-generator');
    const { isEmriHTML } = require('./lib/teknik-sartname-dinamik');
    const fesc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pdfBuffer = await htmlToPDF(isEmriHTML(t, ft, kullaniciAd, emirNo, isEmriNotu, ptR.rows), {
        margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
        footerTemplate: `<div style="width:100%;font-family:'Rubik','Helvetica',sans-serif;font-size:7pt;color:#888;font-style:italic;padding:0 20mm;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;">` +
            `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
            `<span>${fesc(emirNo)} // ${fesc(t.bina_adi)}${t.buyukluk_m2 ? ' - ' + fesc(t.buyukluk_m2) + ' m²' : ''}</span>` +
            `</div>`
    });
    return { pdfBuffer, t };
}
const isEmriAliciListe = ie => String(ie.ek_alicilar || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

app.get('/api/is-emri/:teslimatId', yetkiKontrol, async (req, res, next) => {
    try {
        const ie = await pool.query(
            `SELECT id, emir_no, teslimat_id, durum, is_emri_notu, ek_alicilar,
                    olusturan_adsoyad, olusturma_tarihi, yayinlayan_email, yayinlama_tarihi
             FROM is_emirleri WHERE teslimat_id=$1 AND durum <> 'İPTAL' LIMIT 1`, [req.params.teslimatId]);
        if (!ie.rowCount) return res.json({ ok: true, is_emri: null });
        const notlar = await pool.query(
            "SELECT id, yazan_adsoyad, not_metni, tarih FROM is_emri_notlari WHERE is_emri_id=$1 ORDER BY tarih", [ie.rows[0].id]);
        res.json({ ok: true, is_emri: ie.rows[0], notlar: notlar.rows });
    } catch (e) { next(e); }
});

app.post('/api/is-emri-olustur', yetkiKontrol, async (req, res, next) => {
    try {
        const { teslimat_id, is_emri_notu, ek_alicilar } = req.body;
        if (!teslimat_id) return res.json({ ok: false, hata: 'Teslimat ID gerekli.' });
        if (await aktifIsEmri(teslimat_id)) return res.json({ ok: false, hata: 'Bu teslimat için zaten bir iş emri var.' });
        // Emir no: proje bazlı iki basamak — {ProjeKodu}-İE-01, -02, ... (teslimat adedince)
        const tkR = await pool.query(
            "SELECT p.proje_kodu, p.durum AS proje_durum FROM proje_teslimatlari pt JOIN projeler p ON pt.proje_id=p.id WHERE pt.id=$1", [teslimat_id]);
        if (!tkR.rowCount) return res.json({ ok: false, hata: 'Teslimat bulunamadı.' });
        // Yeni akış: TASLAK projede iş emri açılamaz — önce ADMIN onayı (SÖZLEŞME) gerekir
        if (tkR.rows[0].proje_durum === 'TASLAK')
            return res.json({ ok: false, hata: 'Proje henüz TASLAK durumunda — iş emri için önce ADMIN\'in projeyi onaylaması (SÖZLEŞME) gerekir.' });
        const projeKodu = tkR.rows[0].proje_kodu;
        const mxR = await pool.query(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(emir_no, '^.*-İE-', ''), '')::int), 0) AS mx
             FROM is_emirleri WHERE emir_no LIKE $1`, [`${projeKodu}-İE-%`]);
        const emir_no = `${projeKodu}-İE-${String(Number(mxR.rows[0].mx) + 1).padStart(2, '0')}`;
        // Belgeyi DONDUR: İş Emri formatlı PDF + veri kopyası (şablon sonradan değişse bile sabit kalır)
        const { pdfBuffer, t } = await isEmriPDF(teslimat_id, req.user.adSoyad, emir_no, (is_emri_notu || '').trim());
        const snapshot = {
            proje_kodu: t.proje_kodu, musteri_adi: t.musteri_adi, proje_adi: t.proje_adi,
            bina_adi: t.bina_adi, bina_turu: t.bina_turu, bina_tipi: t.bina_tipi,
            kat_adedi: t.kat_adedi, kat_yuksekligi: t.kat_yuksekligi, bina_adedi: t.bina_adedi,
            buyukluk_m2: t.buyukluk_m2, bina_yeri: t.bina_yeri, montaj_gerekli: t.montaj_gerekli,
            ek_veriler: t.ek_veriler || {}, dondurulma: new Date().toISOString()
        };
        const ins = await pool.query(
            `INSERT INTO is_emirleri (emir_no, teslimat_id, durum, is_emri_notu, ek_alicilar, form_snapshot, pdf, olusturan_email, olusturan_adsoyad)
             VALUES ($1,$2,'HAZIRLANDI',$3,$4,$5,$6,$7,$8) RETURNING id`,
            [emir_no, teslimat_id, (is_emri_notu || '').trim() || null, (ek_alicilar || '').trim() || null,
             JSON.stringify(snapshot), pdfBuffer, req.user.email, req.user.adSoyad]);
        // Erken aşamadaki teslimatı 'İŞ EMRİ' aşamasına çek (ileri aşamayı geriletme)
        await pool.query("UPDATE proje_teslimatlari SET durum='İŞ EMRİ' WHERE id=$1 AND durum IN ('BEKLEMEDE','SÖZLEŞME')", [teslimat_id]);
        await auditLogla(req, { eylem: 'CREATE', tablo: 'is_emirleri', kayit_id: ins.rows[0].id, kayit_no: emir_no, ozet: `İş emri hazırlandı (${t.bina_adi}) — şartname kilitlendi` });
        // ADMIN'e "onay bekleyen iş emri" bildirimi (yayınlama yetkisi yalnız ADMIN'de)
        await bildirimGonder('IS_EMRI_ONAY_BEKLIYOR', {
            konu: `Aterko Workspace - Onay bekleyen iş emri (${emir_no})`,
            baslik: 'İş Emri Onayınızı Bekliyor',
            mesaj: `${req.user.adSoyad} tarafından ${emir_no} numaralı iş emri hazırlandı. İnceleyip uygunsa "Yayınla" ile onaylayabilirsiniz — yayınlama yetkisi ADMIN'dedir.`,
            detaylar: [
                { label: 'İş Emri No', value: emir_no },
                { label: 'Proje', value: `${t.proje_kodu || ''}${t.musteri_adi ? ' / ' + t.musteri_adi : ''}` },
                { label: 'Bina', value: t.bina_adi || '-' },
                { label: 'Hazırlayan', value: req.user.adSoyad }
            ]
        });
        res.json({ ok: true, id: ins.rows[0].id, emir_no, mesaj: `${emir_no} hazırlandı. Teknik şartname kilitlendi — ADMIN'e onay bildirimi gönderildi.` });
    } catch (e) { next(e); }
});

// Taslak (HAZIRLANDI) iş emrinde YALNIZ iş emri notu güncellenebilir.
// Not belgeye basıldığı için PDF aynı emir no ile YENİDEN DONDURULUR.
// Yayınlandıktan sonra not da kilitlenir — yalnız süreç notu (yorum) eklenebilir.
app.post('/api/is-emri-guncelle', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, is_emri_notu } = req.body;
        const ieR = await pool.query("SELECT * FROM is_emirleri WHERE id=$1", [id]);
        if (!ieR.rowCount) return res.json({ ok: false, hata: 'İş emri bulunamadı.' });
        const ie = ieR.rows[0];
        if (ie.durum !== 'HAZIRLANDI')
            return res.json({ ok: false, hata: 'Yayınlanmış iş emrinde not değiştirilemez — süreç notu (yorum) ekleyin.' });
        const yeniNot = (is_emri_notu || '').trim() || null;
        const { pdfBuffer } = await isEmriPDF(ie.teslimat_id, ie.olusturan_adsoyad || req.user.adSoyad, ie.emir_no, yeniNot || '');
        await pool.query("UPDATE is_emirleri SET is_emri_notu=$1, pdf=$2 WHERE id=$3", [yeniNot, pdfBuffer, id]);
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'is_emirleri', kayit_id: parseInt(id), kayit_no: ie.emir_no, ozet: 'İş emri notu güncellendi (belge yeniden donduruldu)' });
        res.json({ ok: true, mesaj: 'İş emri notu güncellendi — belge yeniden donduruldu.' });
    } catch (e) { next(e); }
});

app.post('/api/is-emri-yayinla', yetkiKontrol, async (req, res, next) => {
    try {
        // Yayınlama = onay → yalnız ADMIN
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin')
            return res.status(403).json({ ok: false, hata: 'İş emri yayınlama (onay) yetkisi yalnızca ADMIN\'dedir.' });
        const { id } = req.body;
        // Atomik geçiş — yalnız HAZIRLANDI'dan; mükerrer tıklama ikinci mail üretmez
        const upd = await pool.query(
            `UPDATE is_emirleri SET durum='YAYINLANDI', yayinlayan_email=$1, yayinlama_tarihi=NOW()
             WHERE id=$2 AND durum='HAZIRLANDI' RETURNING *`, [req.user.email, id]);
        if (!upd.rowCount) return res.json({ ok: false, hata: 'İş emri bulunamadı veya zaten yayınlanmış.' });
        const ie = upd.rows[0];
        const s = ie.form_snapshot || {};
        // İş emri yayınlandı → projelendirme başlar
        await pool.query("UPDATE proje_teslimatlari SET durum='PROJE' WHERE id=$1 AND durum IN ('BEKLEMEDE','SÖZLEŞME','İŞ EMRİ')", [ie.teslimat_id]);
        await auditLogla(req, { eylem: 'APPROVE', tablo: 'is_emirleri', kayit_id: ie.id, kayit_no: ie.emir_no, ozet: 'İş emri YAYINLANDI — teslimat PROJE aşamasına geçti' });
        await bildirimGonder('IS_EMRI_YAYINLANDI', {
            konu: `Aterko Workspace - İş Emri yayınlandı (${ie.emir_no})`,
            baslik: 'İş Emri Yayınlandı',
            mesaj: `${ie.emir_no} numaralı iş emri ${req.user.adSoyad} tarafından onaylanıp yayınlandı. Teknik şartname ektedir; bina projelendirme aşamasına alınmıştır.${ie.is_emri_notu ? `\n\n📌 İş emri notu: ${ie.is_emri_notu}` : ''}`,
            detaylar: [
                { label: 'İş Emri No', value: ie.emir_no },
                { label: 'Proje', value: `${s.proje_kodu || ''}${s.musteri_adi ? ' / ' + s.musteri_adi : ''}${s.proje_adi ? ' - ' + s.proje_adi : ''}` },
                { label: 'Bina', value: `${s.bina_adi || ''} (${s.bina_turu || ''}${s.bina_tipi ? ' — ' + s.bina_tipi : ''})` },
                { label: 'Yayınlayan', value: req.user.adSoyad }
            ],
            ekAlicilar: isEmriAliciListe(ie),
            ekler: [{ filename: dosyaAdiTemizle(`${ie.emir_no} __ ${s.proje_kodu || ''} _ ${s.musteri_adi || ''} - ${s.proje_adi || ''} [ ${s.bina_adi || ''} ]`) + '.pdf', content: ie.pdf }]
        });
        res.json({ ok: true, mesaj: `${ie.emir_no} yayınlandı — ekibe bildirim gönderildi. Teslimat PROJE aşamasına geçti.` });
    } catch (e) { next(e); }
});

// Taslak (HAZIRLANDI) iş emrini sil → şartname kilidi açılır, teslimat SÖZLEŞME'ye döner
app.post('/api/is-emri-sil', yetkiKontrol, async (req, res, next) => {
    try {
        const { id } = req.body;
        const del = await pool.query("DELETE FROM is_emirleri WHERE id=$1 AND durum='HAZIRLANDI' RETURNING emir_no, teslimat_id", [id]);
        if (!del.rowCount) return res.json({ ok: false, hata: 'Yalnızca HAZIRLANDI (taslak) durumundaki iş emri silinebilir. Yayınlanmış iş emrini ADMIN iptal edebilir.' });
        await pool.query("UPDATE proje_teslimatlari SET durum='SÖZLEŞME' WHERE id=$1 AND durum='İŞ EMRİ'", [del.rows[0].teslimat_id]);
        await auditLogla(req, { eylem: 'DELETE', tablo: 'is_emirleri', kayit_id: id, kayit_no: del.rows[0].emir_no, ozet: 'Taslak iş emri silindi — şartname yeniden düzenlenebilir' });
        res.json({ ok: true, mesaj: `${del.rows[0].emir_no} silindi. Teknik şartname yeniden düzenlenebilir.` });
    } catch (e) { next(e); }
});

// Yayınlanmış iş emrini İPTAL et — yalnız ADMIN; iz kalır, alıcılara bilgi gider, şartname açılır
app.post('/api/is-emri-iptal', yetkiKontrol, async (req, res, next) => {
    try {
        if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin')
            return res.status(403).json({ ok: false, hata: 'Yayınlanmış iş emrini yalnızca ADMIN iptal edebilir.' });
        const { id, neden } = req.body;
        if (!neden || !String(neden).trim()) return res.json({ ok: false, hata: 'İptal nedeni zorunludur.' });
        const upd = await pool.query(
            `UPDATE is_emirleri SET durum='İPTAL', iptal_eden_email=$1, iptal_tarihi=NOW(), iptal_nedeni=$2
             WHERE id=$3 AND durum='YAYINLANDI' RETURNING *`, [req.user.email, String(neden).trim(), id]);
        if (!upd.rowCount) return res.json({ ok: false, hata: 'İş emri bulunamadı veya yayınlanmış durumda değil.' });
        const ie = upd.rows[0];
        await pool.query("UPDATE proje_teslimatlari SET durum='SÖZLEŞME' WHERE id=$1 AND durum IN ('İŞ EMRİ','PROJE')", [ie.teslimat_id]);
        await auditLogla(req, { eylem: 'CANCEL', tablo: 'is_emirleri', kayit_id: ie.id, kayit_no: ie.emir_no, ozet: `İş emri İPTAL edildi: ${String(neden).trim()}` });
        await bildirimGonder('IS_EMRI_YAYINLANDI', {
            konu: `Aterko Workspace - İş Emri İPTAL edildi (${ie.emir_no})`,
            baslik: 'İş Emri İPTAL Edildi',
            mesaj: `${ie.emir_no} numaralı iş emri ${req.user.adSoyad} tarafından iptal edildi. Bu iş emrine göre çalışma YAPILMAMALIDIR.`,
            detaylar: [
                { label: 'İş Emri No', value: ie.emir_no },
                { label: 'İptal nedeni', value: String(neden).trim() },
                { label: 'İptal eden', value: req.user.adSoyad }
            ],
            ekAlicilar: isEmriAliciListe(ie)
        });
        res.json({ ok: true, mesaj: `${ie.emir_no} iptal edildi — alıcılara bilgi gönderildi. Teknik şartname yeniden düzenlenebilir.` });
    } catch (e) { next(e); }
});

// Yayın sonrası not — ana belge DEĞİŞMEZ; notlar append-only, her not aynı alıcılara mail
app.post('/api/is-emri-not', yetkiKontrol, async (req, res, next) => {
    try {
        const { id, not_metni } = req.body;
        if (!not_metni || !String(not_metni).trim()) return res.json({ ok: false, hata: 'Not metni boş olamaz.' });
        const ieR = await pool.query("SELECT * FROM is_emirleri WHERE id=$1 AND durum='YAYINLANDI'", [id]);
        if (!ieR.rowCount) return res.json({ ok: false, hata: 'Not yalnızca YAYINLANMIŞ iş emrine eklenebilir.' });
        const ie = ieR.rows[0];
        await pool.query("INSERT INTO is_emri_notlari (is_emri_id, yazan_email, yazan_adsoyad, not_metni) VALUES ($1,$2,$3,$4)",
            [id, req.user.email, req.user.adSoyad, String(not_metni).trim()]);
        await auditLogla(req, { eylem: 'UPDATE', tablo: 'is_emri_notlari', kayit_id: id, kayit_no: ie.emir_no, ozet: 'İş emrine not eklendi' });
        await bildirimGonder('IS_EMRI_NOT', {
            konu: `Aterko Workspace - İş emri notu (${ie.emir_no})`,
            baslik: 'İş Emrine Not Eklendi',
            mesaj: `${ie.emir_no} numaralı iş emrine ${req.user.adSoyad} tarafından not eklendi:\n\n"${String(not_metni).trim()}"\n\nAna iş emri dokümanı değişmemiştir; bu not süreçteki değişikliği tarif eder.`,
            detaylar: [{ label: 'İş Emri No', value: ie.emir_no }, { label: 'Yazan', value: req.user.adSoyad }],
            ekAlicilar: isEmriAliciListe(ie)
        });
        res.json({ ok: true, mesaj: 'Not eklendi ve alıcılara bildirildi.' });
    } catch (e) { next(e); }
});

// Dondurulmuş iş emri PDF'i (oluşturma anındaki hali — şablon değişse de sabit)
app.get('/api/is-emri-pdf/:id', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query("SELECT emir_no, pdf, form_snapshot FROM is_emirleri WHERE id=$1", [req.params.id]);
        if (!r.rowCount || !r.rows[0].pdf) return res.status(404).json({ ok: false, hata: 'İş emri PDF bulunamadı.' });
        const s = r.rows[0].form_snapshot || {};
        const ad = dosyaAdiTemizle(`${r.rows[0].emir_no} __ ${s.proje_kodu || ''} _ ${s.musteri_adi || ''} - ${s.proje_adi || ''} [ ${s.bina_adi || ''} ]`) + '.pdf';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', cdHeader(ad));
        res.send(r.rows[0].pdf);
    } catch (e) { next(e); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    { kod: 'satinalma.teklif',    ad: 'Satınalma — Teklif Havuzu', grup: 'Satınalma' },
    { kod: 'satinalma.siparisler',ad: 'Satınalma — Siparişler', grup: 'Satınalma' },
    { kod: 'satinalma.tedarikci', ad: 'Satınalma — Tedarikçi', grup: 'Satınalma' },
    { kod: 'satinalma.mal_kabul', ad: 'Satınalma — Mal Kabul', grup: 'Satınalma' },
    { kod: 'satinalma.arsiv',     ad: 'Satınalma — Arşiv', grup: 'Satınalma' },
    { kod: 'satinalma.rapor',     ad: 'Satınalma — Rapor (Genel Bakış)', grup: 'Satınalma' },
    { kod: 'mali.tedarikci',      ad: 'Mali İşler — Tedarikçi Cari', grup: 'Mali İşler' },
    { kod: 'mali.musteri',        ad: 'Mali İşler — Müşteri Cari',   grup: 'Mali İşler' },
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
    // Not: Görev Takip modülü izin matrisi ile YÖNETİLMEZ — erişim kullanicilar.cekirdek_ekip (kişi bazlı)
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    { pattern: /^\/api\/(kullanicilar|kullanici-|roller|rol-|modul-katalog|form-tanimi-|audit-log)/, modul: 'yonetim.kullanicilar', seviye: 'TAM' },
    // Bildirim otomatik tetikleme — yönetim işi (genel bildirim kuralından ÖNCE)
    { pattern: /^\/api\/bildirim-otomatik-tetikle/, modul: 'yonetim.kullanicilar', seviye: 'TAM' },
    // Bildirimler — herkes kendi bildirimlerini görür
    { pattern: /^\/api\/bildirim/, modul: 'anasayfa', seviye: 'OKUMA' },
    // Dashboard
    { pattern: /^\/api\/dashboard/, modul: 'anasayfa', seviye: 'OKUMA' },
    // Hızlı arama — temel okuma
    { pattern: /^\/api\/quick-search/, modul: 'anasayfa', seviye: 'OKUMA' },

    // Projeler
    { pattern: /^\/api\/(projeler|proje-detay|proje-teslimat)/, method: 'GET', modul: 'projeler', seviye: 'OKUMA' },
    { pattern: /^\/api\/(proje-kaydet|proje-sil|proje-onay|teslimat-durum)/, modul: 'projeler', seviye: 'YAZMA' },
    { pattern: /^\/api\/proje-karlilik/, modul: 'rapor.karlilik', seviye: 'OKUMA' },

    // Bina Listeleri (Ürün Listesi)
    { pattern: /^\/api\/teslimat-secenekleri/, modul: 'bina_listeleri', seviye: 'OKUMA' },
    { pattern: /^\/api\/teslimat-urunleri/, method: 'GET', modul: 'bina_listeleri', seviye: 'OKUMA' },
    { pattern: /^\/api\/teslimat-urun-(ekle|guncelle|sil)/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/teslimat-urun-talep-olustur/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/urun-listesi-(onaya|onayla|reddet|kopyala|import|sablon|ek-urun|kopya-kaynak)/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    { pattern: /^\/api\/urun-listesi-(versiyon|teslimat-sablon)/, modul: 'bina_listeleri', seviye: 'OKUMA' },

    // Satınalma — Talepler
    { pattern: /^\/api\/(satinalma-listesi|talep-detay|talep-urunleri|arsiv)/, method: 'GET', modul: 'satinalma.talepler', seviye: 'OKUMA' },
    // Teklif Havuzu — talepten AYRI izin satırı (satinalma.teklif)
    { pattern: /^\/api\/(teklif-havuzu|teklifler)/, method: 'GET', modul: 'satinalma.teklif', seviye: 'OKUMA' },
    { pattern: /^\/api\/teklif-(iste|iptal|kaydet|sil)/, modul: 'satinalma.teklif', seviye: 'TAM' },
    // Arşiv sayfası + arşivden çıkarma — ayrı izin satırı (arşivde sipariş tutarları var)
    { pattern: /^\/api\/satinalma-arsiv/, method: 'GET', modul: 'satinalma.arsiv', seviye: 'OKUMA' },
    { pattern: /^\/api\/arsivden-cikar/, modul: 'satinalma.arsiv', seviye: 'TAM' },
    // Satınalma Raporu (Genel Bakış) — tutar/grafik özetleri
    { pattern: /^\/api\/satinalma-genel-ozet/, method: 'GET', modul: 'satinalma.rapor', seviye: 'OKUMA' },
    { pattern: /^\/api\/(talep-kaydet|talep-guncelle|talep-onayla|talep-reddet|talep-iptal|talep-arsivle)/, modul: 'satinalma.talepler', seviye: 'TAM' },

    // Satınalma — Siparişler
    { pattern: /^\/api\/(siparis-listesi|siparis-detay|siparis-pdf|siparis-dosya|son-alis-fiyatlari)/, method: 'GET', modul: 'satinalma.siparisler', seviye: 'OKUMA' },
    { pattern: /^\/api\/(siparis-kaydet|siparis-guncelle|siparis-onayla|siparis-gonder|siparis-iptal|siparis-arsivle|siparis-gerial|siparis-dosya-yukle|siparis-dosya-sil)/, modul: 'satinalma.siparisler', seviye: 'TAM' },

    // Satınalma — Mal Kabul
    { pattern: /^\/api\/mal-kabul/, modul: 'satinalma.mal_kabul', seviye: 'YAZMA' },

    // Tedarikçiler
    { pattern: /^\/api\/tedarikci/, method: 'GET', modul: 'satinalma.tedarikci', seviye: 'OKUMA' },
    { pattern: /^\/api\/(tedarikci-kaydet|tedarikci-sil|tedarikci-)/, modul: 'satinalma.tedarikci', seviye: 'YAZMA' },

    // Mali İşler — cari takip (hareket silme yalnız TAM; ayar yazma uç içinde ayrıca ADMIN)
    { pattern: /^\/api\/mali-hareket-sil/, modul: 'mali.tedarikci', seviye: 'TAM' },
    { pattern: /^\/api\/mali-(tedarikci|ayar|ekip|nakit-akis|kasa|gider)/, method: 'GET', modul: 'mali.tedarikci', seviye: 'OKUMA' },
    { pattern: /^\/api\/mali-musteri/, method: 'GET', modul: 'mali.musteri', seviye: 'OKUMA' },
    { pattern: /^\/api\/mali-musteri-kaydet/, modul: 'mali.musteri', seviye: 'YAZMA' },
    { pattern: /^\/api\/mali-(tedarikci-guncelle|hareket-ekle|hareket-planla|hareket-gerceklestir|ayar)/, modul: 'mali.tedarikci', seviye: 'YAZMA' },

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
    { pattern: /^\/api\/is-emri/, method: 'GET', modul: 'projeler', seviye: 'OKUMA' },
    { pattern: /^\/api\/is-emri-(olustur|guncelle|yayinla|sil|iptal|not)/, modul: 'projeler', seviye: 'YAZMA' },
    { pattern: /^\/api\/form-tanimlari/, method: 'GET', modul: 'projeler', seviye: 'OKUMA' },

    // --- FAIL-OPEN KAPATMA: önceden hiçbir kurala uymayan yazma uçları ---
    // Talepler (yeni-talep + dosya = YAZMA; durum/geri-al/arşiv/teklif yönetimi = TAM)
    { pattern: /^\/api\/yeni-talep/, modul: 'satinalma.talepler', seviye: 'YAZMA' },
    { pattern: /^\/api\/talep-dosya-(yukle|sil)/, modul: 'satinalma.talepler', seviye: 'YAZMA' },
    { pattern: /^\/api\/(talep-durum-guncelle|talep-gerial)/, modul: 'satinalma.talepler', seviye: 'TAM' },
    // Siparişler (silme/fatura onayı = TAM; not = OKUMA)
    { pattern: /^\/api\/(siparis-tamamen-sil|siparis-fatura-onayla)/, modul: 'satinalma.siparisler', seviye: 'TAM' },
    { pattern: /^\/api\/siparis-not-sil/, modul: 'satinalma.siparisler', seviye: 'OKUMA' },
    { pattern: /^\/api\/siparis\/[0-9]+\/not-ekle/, modul: 'satinalma.siparisler', seviye: 'OKUMA' },
    // Mal Kabul (siparis-teslim-al = mal kabul işlemidir)
    { pattern: /^\/api\/siparis-teslim-al/, modul: 'satinalma.mal_kabul', seviye: 'YAZMA' },
    // Projeler
    { pattern: /^\/api\/proje-guncelle/, modul: 'projeler', seviye: 'YAZMA' },
    // Bina Listeleri
    { pattern: /^\/api\/teslimat-sablon-isaretle/, modul: 'bina_listeleri', seviye: 'YAZMA' },
    // Günlük rapor ayarları (yönetim)
    { pattern: /^\/api\/gunluk-rapor/, modul: 'yonetim.kullanicilar', seviye: 'TAM' }
];

// Global izin middleware — tüm /api endpoint'lerine uygulanır
async function genelIzinMiddleware(req, res, next) {
    // yetkiKontrol'den sonra çalışır, req.user mevcut
    if (!req.user) return next();
    // ADMIN her zaman geçer
    if (req.user.rol === 'ADMIN' || req.user.rol === 'Admin') return next();

    // /me/izinler ve auth gibi her zaman erişilebilir olmalı
    // Görev Takip: izin katmanını atla; asıl kapı route'lardaki cekirdekEkipKontrol (cekirdek_ekip=TRUE)
    if (req.path === '/api/me/izinler' || req.path === '/api/durum-guncelle' || req.path.startsWith('/api/gorev')) return next();

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
    // Hiçbir kural eşleşmediyse: YAZMA metodları (POST/PUT/PATCH/DELETE) REDDEDİLİR (deny-by-default),
    // OKUMA (GET/HEAD) serbest bırakılır. Böylece kurala bağlanmamış yeni yazma uçları açıkta kalmaz.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return res.status(403).json({ ok: false, hata: 'Bu işlem için yetkiniz yok (tanımsız uç).', izin_hatasi: true });
    }
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
        const ce = await pool.query("SELECT cekirdek_ekip FROM kullanicilar WHERE id=$1", [req.user.id]);
        const cekirdek_ekip = !!(ce.rows[0] && ce.rows[0].cekirdek_ekip);
        res.json({ ok: true, rol: etkinRol, gercek_rol: req.user.gercek_rol || req.user.rol, simulasyon, izinler, modul_katalog: MODUL_KATALOG, cekirdek_ekip });
    } catch (e) { next(e); }
});

// =============================================================================
// GÖREV TAKİP MODÜLÜ (Yönetim / Çekirdek Ekip) — yalnızca cekirdek_ekip=TRUE erişir
// =============================================================================
// Asıl erişim kapısı — izin katmanından bağımsız (roller paylaşımlı olduğu için cekirdek_ekip boolean'ı esas)
async function cekirdekEkipKontrol(req, res, next) {
    try {
        const r = await pool.query("SELECT cekirdek_ekip FROM kullanicilar WHERE id=$1", [req.user.id]);
        if (r.rows[0] && r.rows[0].cekirdek_ekip === true) return next();
        return res.status(403).json({ ok: false, hata: 'Bu modüle erişiminiz yok (çekirdek yönetim ekibi).' });
    } catch (e) { next(e); }
}
// Görev alanı serbest tema etiketidir (dinamik) — normalize: trim, TR uppercase, boşluk→_, geçersiz karakter at
function gorevAlanNormalize(a) {
    if (!a) return 'GENEL';
    const s = String(a).trim().toLocaleUpperCase('tr').replace(/\s+/g, '_').replace(/[^A-ZÇĞİÖŞÜ0-9_]/g, '');
    return s || 'GENEL';
}
const GOREV_ONCELIKLER = ['KRITIK', 'YUKSEK', 'NORMAL'];
const GOREV_DURUMLAR = ['ACIK', 'DEVAM', 'TAMAMLANDI', 'IPTAL'];
const gorevOrtakMi = req => ['yunus@aterko.com', 'yakup@aterko.com'].includes((req.user.email || '').toLowerCase());

// Çekirdek ekip üyeleri (görev sahibi dropdown'u)
app.get('/api/gorev-ekip', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const r = await pool.query("SELECT id, ad_soyad, email FROM kullanicilar WHERE cekirdek_ekip=TRUE AND durum='AKTIF' ORDER BY ad_soyad");
        res.json({ ok: true, ekip: r.rows });
    } catch (e) { next(e); }
});

// Görev alanları — veriden türetilir (dinamik alan yönetimi v1.1): alan + aktif_sayi + toplam
app.get('/api/gorevler/alanlar', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(`
            SELECT alan,
                   COUNT(*) FILTER (WHERE durum IN ('ACIK','DEVAM'))::int AS aktif_sayi,
                   COUNT(*)::int AS toplam
            FROM yonetim_gorevleri GROUP BY alan ORDER BY alan`);
        res.json({ ok: true, alanlar: r.rows });
    } catch (e) { next(e); }
});

// Pazartesi görünümü — tek istekte 5 blok (gecikenler asla gizlenmez)
app.get('/api/gorevler/pazartesi', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const q = sql => pool.query(sql).then(r => r.rows);
        const sel = `SELECT g.id, g.baslik, g.alan, g.oncelik, g.durum, g.bitis_tarihi, g.taahhut, g.tamamlanma_tarihi, g.sahip_id, sh.ad_soyad AS sahip_ad FROM yonetim_gorevleri g JOIN kullanicilar sh ON g.sahip_id=sh.id`;
        const gecikenler = await q(`${sel} WHERE g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE ORDER BY g.bitis_tarihi ASC`);
        const bu_hafta = await q(`${sel} WHERE g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi >= CURRENT_DATE AND g.bitis_tarihi < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days' ORDER BY g.bitis_tarihi ASC`);
        const gecen_hafta_bitenler = await q(`${sel} WHERE g.durum='TAMAMLANDI' AND g.tamamlanma_tarihi >= NOW() - INTERVAL '7 days' ORDER BY g.tamamlanma_tarihi DESC`);
        const taahhutler = await q(`${sel} WHERE g.taahhut=TRUE ORDER BY (g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE) DESC, g.bitis_tarihi ASC`);
        const sahip_ozeti = await q(`
            SELECT sh.id AS sahip_id, sh.ad_soyad AS sahip_ad,
                   COUNT(g.id) FILTER (WHERE g.durum IN ('ACIK','DEVAM'))::int AS acik,
                   COUNT(g.id) FILTER (WHERE g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE)::int AS geciken,
                   COUNT(g.id) FILTER (WHERE g.durum='TAMAMLANDI' AND g.tamamlanma_tarihi >= date_trunc('month', CURRENT_DATE))::int AS bu_ay_tamamlanan
            FROM kullanicilar sh LEFT JOIN yonetim_gorevleri g ON g.sahip_id=sh.id
            WHERE sh.cekirdek_ekip=TRUE
            GROUP BY sh.id, sh.ad_soyad ORDER BY geciken DESC, acik DESC`);
        // Taahhüt Tutarlılığı Karnesi — son 90 gün (bitiş tarihine göre): zamanında / geç / kaçan
        const karne = await q(`
            SELECT sh.id AS sahip_id, sh.ad_soyad AS sahip_ad,
                   COUNT(g.id) FILTER (WHERE g.durum='TAMAMLANDI' AND g.tamamlanma_tarihi::date <= g.bitis_tarihi)::int AS zamaninda,
                   COUNT(g.id) FILTER (WHERE g.durum='TAMAMLANDI' AND g.tamamlanma_tarihi::date > g.bitis_tarihi)::int AS gec,
                   COUNT(g.id) FILTER (WHERE g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE)::int AS kacan
            FROM kullanicilar sh
            LEFT JOIN yonetim_gorevleri g ON g.sahip_id=sh.id AND g.bitis_tarihi >= CURRENT_DATE - INTERVAL '90 days'
            WHERE sh.cekirdek_ekip=TRUE
            GROUP BY sh.id, sh.ad_soyad ORDER BY sh.ad_soyad`);
        res.json({ ok: true, gecikenler, bu_hafta, gecen_hafta_bitenler, taahhutler, sahip_ozeti, karne });
    } catch (e) { next(e); }
});

// Görev listesi — filtreler: sahip_id, durum, alan, taahhut, gecikmis
app.get('/api/gorevler', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const { sahip_id, durum, alan, taahhut, gecikmis } = req.query;
        const kos = [], par = [];
        if (sahip_id) { par.push(sahip_id); kos.push(`g.sahip_id = $${par.length}`); }
        if (durum) { par.push(durum); kos.push(`g.durum = $${par.length}`); }
        if (alan) { par.push(alan); kos.push(`g.alan = $${par.length}`); }
        if (taahhut === '1' || taahhut === 'true') kos.push(`g.taahhut = TRUE`);
        if (gecikmis === '1') kos.push(`g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE`);
        const where = kos.length ? 'WHERE ' + kos.join(' AND ') : '';
        const r = await pool.query(`
            SELECT g.*, sh.ad_soyad AS sahip_ad, ol.ad_soyad AS olusturan_ad,
                   (g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE) AS gecikmis,
                   COALESCE((SELECT json_agg(json_build_object('id',n.id,'not_metni',n.not_metni,'yazan',ky.ad_soyad,'tarih',n.olusturma_tarihi) ORDER BY n.olusturma_tarihi)
                             FROM gorev_notlari n JOIN kullanicilar ky ON n.yazan_id=ky.id WHERE n.gorev_id=g.id), '[]') AS kayit_notlari
            FROM yonetim_gorevleri g
            JOIN kullanicilar sh ON g.sahip_id = sh.id
            JOIN kullanicilar ol ON g.olusturan_id = ol.id
            ${where}
            ORDER BY (g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE) DESC, g.bitis_tarihi ASC, g.id DESC`, par);
        res.json({ ok: true, gorevler: r.rows });
    } catch (e) { next(e); }
});

// Görev notlarını normalize et — [{metin, tarih}] dizisi. tarih (ilk kayıt) korunur;
// yeni/geçersiz tarih bugüne (Europe/Istanbul) damgalanır. Boş metinliler atılır.
function gorevNotlarNormalize(arr) {
    if (!Array.isArray(arr)) return [];
    const bugun = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' }); // YYYY-MM-DD
    const out = [];
    for (const n of arr) {
        const metin = String(n && n.metin != null ? n.metin : '').trim();
        if (!metin) continue;
        const tarih = (n && typeof n.tarih === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.tarih)) ? n.tarih : bugun;
        out.push({ metin, tarih });
    }
    return out;
}
const gorevNotSig = a => JSON.stringify((Array.isArray(a) ? a : []).map(n => n.metin + '|' + n.tarih));

// Görev oluştur / güncelle (id varsa update). sahip_id + bitis_tarihi zorunlu.
app.post('/api/gorev-kaydet', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const { id, baslik, aciklama, notlar, sahip_id, alan, oncelik, bitis_tarihi, taahhut, taahhut_vade } = req.body;
        const notlarArr = gorevNotlarNormalize(notlar);
        const notlarParam = notlarArr.length ? JSON.stringify(notlarArr) : null;
        if (!baslik || !String(baslik).trim()) return res.json({ ok: false, hata: 'Görev başlığı zorunludur.' });
        if (!sahip_id || !bitis_tarihi) return res.json({ ok: false, hata: 'Görevin sahibi ve bitiş tarihi zorunludur.' });
        const alanV = gorevAlanNormalize(alan);
        if (alanV.length < 2) return res.json({ ok: false, hata: 'Alan adı en az 2 karakter olmalı.' });
        const oncelikV = GOREV_ONCELIKLER.includes(oncelik) ? oncelik : 'NORMAL';
        const vadeV = taahhut && [30, 90].includes(Number(taahhut_vade)) ? Number(taahhut_vade) : null;
        if (id) {
            // Ledger bütünlüğü: bitiş tarihi / sahip değişikliği otomatik nota işlenir (deadline sessizce ötelenemesin)
            const eski = await pool.query("SELECT bitis_tarihi, sahip_id, notlar FROM yonetim_gorevleri WHERE id=$1", [id]);
            if (!eski.rowCount) return res.status(404).json({ ok: false, hata: 'Görev bulunamadı.' });
            const r = await pool.query(
                `UPDATE yonetim_gorevleri SET baslik=$1, aciklama=$2, sahip_id=$3, alan=$4, oncelik=$5, bitis_tarihi=$6, taahhut=$7, taahhut_vade=$8, notlar=$9 WHERE id=$10 RETURNING id`,
                [String(baslik).trim(), aciklama || null, sahip_id, alanV, oncelikV, bitis_tarihi, !!taahhut, vadeV, notlarParam, id]);
            const trFmt = d => d ? new Date(d).toLocaleDateString('tr-TR') : '-';
            // pg DATE'i takvim günü (YYYY-MM-DD) olarak karşılaştır — yerel bileşenler, tz kaymasız
            const ymd = d => { if (!d) return ''; const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
            // Notlar değişince Kayıt Notları'na iz düşür (kim/ne zaman)
            if (gorevNotSig(eski.rows[0].notlar) !== gorevNotSig(notlarArr))
                await pool.query("INSERT INTO gorev_notlari (gorev_id, yazan_id, not_metni) VALUES ($1,$2,$3)",
                    [id, req.user.id, notlarArr.length ? '📝 Notlar güncellendi' : '📝 Notlar temizlendi']);
            if (ymd(eski.rows[0].bitis_tarihi) !== String(bitis_tarihi).slice(0, 10))
                await pool.query("INSERT INTO gorev_notlari (gorev_id, yazan_id, not_metni) VALUES ($1,$2,$3)",
                    [id, req.user.id, `⏱ Bitiş tarihi değişti: ${trFmt(eski.rows[0].bitis_tarihi)} → ${trFmt(bitis_tarihi)}`]);
            if (Number(eski.rows[0].sahip_id) !== Number(sahip_id))
                await pool.query("INSERT INTO gorev_notlari (gorev_id, yazan_id, not_metni) VALUES ($1,$2,$3)",
                    [id, req.user.id, `👤 Sahip değişti`]);
            return res.json({ ok: true, id: r.rows[0].id, mesaj: 'Görev güncellendi.' });
        }
        const r = await pool.query(
            `INSERT INTO yonetim_gorevleri (baslik, aciklama, sahip_id, olusturan_id, alan, oncelik, bitis_tarihi, taahhut, taahhut_vade, notlar)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [String(baslik).trim(), aciklama || null, sahip_id, req.user.id, alanV, oncelikV, bitis_tarihi, !!taahhut, vadeV, notlarParam]);
        res.json({ ok: true, id: r.rows[0].id, mesaj: 'Görev oluşturuldu.' });
    } catch (e) { next(e); }
});

// Görev durumu değiştir — yalnızca sahip veya ortaklar (Yunus/Yakup). TAMAMLANDI → tamamlanma_tarihi.
app.post('/api/gorev-durum', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const { id, durum } = req.body;
        if (!id || !GOREV_DURUMLAR.includes(durum)) return res.json({ ok: false, hata: 'Geçersiz görev veya durum.' });
        const g = await pool.query("SELECT sahip_id FROM yonetim_gorevleri WHERE id=$1", [id]);
        if (!g.rowCount) return res.status(404).json({ ok: false, hata: 'Görev bulunamadı.' });
        if (g.rows[0].sahip_id !== req.user.id && !gorevOrtakMi(req))
            return res.status(403).json({ ok: false, hata: 'Durumu yalnızca görevin sahibi veya ortaklar (Yunus/Yakup) değiştirebilir.' });
        const r = await pool.query(
            `UPDATE yonetim_gorevleri SET durum=$1, tamamlanma_tarihi = CASE WHEN $1='TAMAMLANDI' THEN NOW() ELSE NULL END WHERE id=$2 RETURNING id, durum`,
            [durum, id]);
        res.json({ ok: true, id: r.rows[0].id, durum: r.rows[0].durum, mesaj: 'Durum güncellendi.' });
    } catch (e) { next(e); }
});

// Göreve not ekle
app.post('/api/gorev-not', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const { gorev_id, not_metni } = req.body;
        if (!gorev_id || !not_metni || !String(not_metni).trim()) return res.json({ ok: false, hata: 'Görev ve not metni zorunludur.' });
        const g = await pool.query("SELECT id FROM yonetim_gorevleri WHERE id=$1", [gorev_id]);
        if (!g.rowCount) return res.status(404).json({ ok: false, hata: 'Görev bulunamadı.' });
        const r = await pool.query(
            `INSERT INTO gorev_notlari (gorev_id, yazan_id, not_metni) VALUES ($1,$2,$3) RETURNING id, olusturma_tarihi`,
            [gorev_id, req.user.id, String(not_metni).trim()]);
        res.json({ ok: true, id: r.rows[0].id, olusturma_tarihi: r.rows[0].olusturma_tarihi, mesaj: 'Not eklendi.' });
    } catch (e) { next(e); }
});

// Görevi KALICI sil — yalnızca ADMIN (iz bırakmaz; gorev_notlari ON DELETE CASCADE ile birlikte silinir)
app.delete('/api/gorev-sil/:id', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.status(403).json({ ok: false, hata: 'Görevi yalnızca ADMIN silebilir.' });
    try {
        const r = await pool.query("DELETE FROM yonetim_gorevleri WHERE id=$1 RETURNING id", [req.params.id]);
        if (!r.rowCount) return res.status(404).json({ ok: false, hata: 'Görev bulunamadı.' });
        res.json({ ok: true, mesaj: 'Görev kalıcı olarak silindi.' });
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
            SELECT id, email, ad_soyad, rol, durum, son_giris, kayit_tarihi, cekirdek_ekip
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
        const { id, email, ad_soyad, rol, durum, cekirdek_ekip } = req.body;
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
                UPDATE kullanicilar SET email=$1, ad_soyad=$2, rol=$3, durum=$4, cekirdek_ekip=$5 WHERE id=$6
            `, [emailNorm, adSoyadNorm, rolNorm, durumNorm, !!cekirdek_ekip, id]);
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
                INSERT INTO kullanicilar (email, ad_soyad, rol, durum, cekirdek_ekip) VALUES ($1,$2,$3,$4,$5) RETURNING id
            `, [emailNorm, adSoyadNorm, rolNorm, durumNorm, !!cekirdek_ekip]);
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

// ---- TEKNİK ŞARTNAME ŞABLONU (panel: bölüm/satır + seçenek→metin editörü) ----
app.get('/api/teknik-sartname-sablonu/:binaTuru', yetkiKontrol, async (req, res, next) => {
    try {
        const { ayristir } = require('./lib/sartname-ayristir');
        const r = await pool.query(
            "SELECT id,bolum_no,bolum_adi,bolum_gizle,soru,satir_sira,cevap_sablonu,yeni_tablo,baslik_gizle FROM teknik_sartname_sablonu WHERE bina_turu=$1 ORDER BY bolum_no,satir_sira",
            [req.params.binaTuru]);
        // Form alanlarının seçenek haritası — "seçenek eşleştirme yardımı" için
        const ff = await pool.query("SELECT soru, secenekler FROM form_tanimlari WHERE bina_turu=$1", [req.params.binaTuru]);
        const formSecMap = {};
        ff.rows.forEach(f => { if (Array.isArray(f.secenekler) && f.secenekler.length) formSecMap[f.soru] = f.secenekler; });
        const satirlar = r.rows.map(x => {
            const ay = ayristir(x.cevap_sablonu);
            const row = {
                id: x.id, bolum_no: x.bolum_no, bolum_adi: x.bolum_adi, bolum_gizle: x.bolum_gizle,
                soru: x.soru, yeni_tablo: x.yeni_tablo, baslik_gizle: x.baslik_gizle, ...ay
            };
            if (ay.tip === 'basit' && ay.karar) row.form_secenekler = formSecMap[ay.karar] || null;
            return row;
        });
        res.json({ ok: true, satirlar, form_secenek_map: formSecMap });
    } catch (e) { next(e); }
});

app.post('/api/teknik-sartname-sablonu-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN düzenleyebilir.' });
    }
    try {
        const { kur } = require('./lib/sartname-ayristir');
        const { id, tip, karar, secenekler, metin, ham, yeni_tablo, baslik_gizle, soru, bolum_adi, bolum_gizle } = req.body;
        let cevap_sablonu;
        if (tip === 'basit') cevap_sablonu = kur(karar, secenekler || {});
        else if (tip === 'sabit') cevap_sablonu = String(metin == null ? '' : metin);
        else cevap_sablonu = String(ham == null ? '' : ham);
        const r = await pool.query(
            "UPDATE teknik_sartname_sablonu SET cevap_sablonu=$1, yeni_tablo=$2, baslik_gizle=$3, soru=$4, guncelleme=now() WHERE id=$5 RETURNING bina_turu,bolum_no",
            [cevap_sablonu, !!yeni_tablo, !!baslik_gizle, soru == null ? '' : String(soru), id]);
        if (r.rowCount) {
            // baslik_gizle + bolum_adi bölüm geneli — aynı bölümün tüm satırlarına yansıt
            await pool.query("UPDATE teknik_sartname_sablonu SET baslik_gizle=$1 WHERE bina_turu=$2 AND bolum_no=$3", [!!baslik_gizle, r.rows[0].bina_turu, r.rows[0].bolum_no]);
            if (bolum_adi !== undefined) await pool.query("UPDATE teknik_sartname_sablonu SET bolum_adi=$1 WHERE bina_turu=$2 AND bolum_no=$3", [String(bolum_adi || ''), r.rows[0].bina_turu, r.rows[0].bolum_no]);
            // bolum_gizle (koşullu bölüm gizleme / HARİCİ) — bölüm geneli
            if (bolum_gizle !== undefined) await pool.query("UPDATE teknik_sartname_sablonu SET bolum_gizle=$1 WHERE bina_turu=$2 AND bolum_no=$3", [bolum_gizle || null, r.rows[0].bina_turu, r.rows[0].bolum_no]);
        }
        if (!r.rowCount) return res.status(404).json({ ok: false, hata: 'Satır bulunamadı.' });
        res.json({ ok: true, satir: r.rows[0] });
    } catch (e) { next(e); }
});

// Bir tablodaki bir bina türünün satırlarını başka türe kopyalar (id/guncelleme hariç, bina_turu hedefle)
async function _binaTuruTabloCogalt(client, tablo, kaynak, hedef) {
    const r = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name NOT IN ('id','guncelleme') ORDER BY ordinal_position`,
        [tablo]);
    const cols = r.rows.map(x => `"${x.column_name}"`);
    const sel = r.rows.map(x => x.column_name === 'bina_turu' ? '$2' : `"${x.column_name}"`);
    return client.query(`INSERT INTO ${tablo} (${cols.join(',')}) SELECT ${sel.join(',')} FROM ${tablo} WHERE bina_turu=$1`, [kaynak, hedef]);
}

// Bina türü çoğalt: form_tanimlari + teknik_sartname_sablonu birlikte (transaction)
// Bir bina türünü sıfırla: form_tanimlari + teknik_sartname_sablonu satırlarını siler (yeniden çoğaltmak için)
app.delete('/api/teknik-sartname-turu-sifirla/:binaTuru', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN sıfırlayabilir.' });
    const bt = req.params.binaTuru;
    if (bt === 'Prefabrik') return res.json({ ok: false, hata: 'Prefabrik ana şablondur, sıfırlanamaz.' });
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const f = await client.query("DELETE FROM form_tanimlari WHERE bina_turu=$1", [bt]);
            const s = await client.query("DELETE FROM teknik_sartname_sablonu WHERE bina_turu=$1", [bt]);
            await client.query('COMMIT');
            res.json({ ok: true, mesaj: `"${bt}" sıfırlandı (${f.rowCount} form sorusu, ${s.rowCount} şablon satırı silindi). Artık yeniden çoğaltabilirsiniz.` });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
    } catch (e) { next(e); }
});

app.post('/api/teknik-sartname-cogalt', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN çoğaltabilir.' });
    }
    const { kaynak, hedef } = req.body;
    if (!kaynak || !hedef || kaynak === hedef) return res.json({ ok: false, hata: 'Geçerli bir kaynak ve farklı bir hedef gerekli.' });
    try {
        // Hedef boş olmalı (üzerine yazma)
        const dolu = await pool.query(
            "SELECT (SELECT count(*) FROM form_tanimlari WHERE bina_turu=$1)::int f, (SELECT count(*) FROM teknik_sartname_sablonu WHERE bina_turu=$1)::int t", [hedef]);
        if (dolu.rows[0].f > 0 || dolu.rows[0].t > 0)
            return res.json({ ok: false, hata: `"${hedef}" zaten dolu (form ${dolu.rows[0].f}, şablon ${dolu.rows[0].t} satır). Önce boşaltılmalı.` });
        const kay = await pool.query("SELECT (SELECT count(*) FROM teknik_sartname_sablonu WHERE bina_turu=$1)::int t", [kaynak]);
        if (kay.rows[0].t === 0) return res.json({ ok: false, hata: `Kaynak "${kaynak}" şablonu boş.` });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const f = await _binaTuruTabloCogalt(client, 'form_tanimlari', kaynak, hedef);
            const s = await _binaTuruTabloCogalt(client, 'teknik_sartname_sablonu', kaynak, hedef);
            await client.query('COMMIT');
            res.json({ ok: true, mesaj: `"${kaynak}" → "${hedef}" çoğaltıldı (${f.rowCount} form sorusu, ${s.rowCount} şablon satırı).`, form: f.rowCount, sablon: s.rowCount });
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
    } catch (e) { next(e); }
});

// Teknik şartname şablonuna yeni satır (ve gerekirse yeni bölüm) ekle
app.post('/api/teknik-sartname-sablonu-ekle', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN ekleyebilir.' });
    try {
        const { kur } = require('./lib/sartname-ayristir');
        const { bina_turu, bolum_no, bolum_adi, bolum_gizle, soru, tip, karar, secenekler, metin, ham, yeni_tablo, baslik_gizle } = req.body;
        if (!bina_turu || bolum_no == null || bolum_no === '') return res.json({ ok: false, hata: 'Bina türü ve bölüm no zorunlu.' });
        // Çakışma kontrolü: bu bölüm no zaten FARKLI adlı bir bölüme aitse reddet (PDF'te birleşmesinler)
        if (bolum_adi && String(bolum_adi).trim()) {
            const vc = await pool.query("SELECT DISTINCT bolum_adi FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2 AND COALESCE(bolum_adi,'')<>''", [bina_turu, bolum_no]);
            const farkli = vc.rows.find(x => (x.bolum_adi || '').trim() !== String(bolum_adi).trim());
            if (farkli) return res.json({ ok: false, hata: `Bölüm no ${bolum_no} zaten "${farkli.bolum_adi}" bölümüne ait. Farklı bir bölüm için başka numara seçin (aksi halde PDF'te birleşirler).` });
        }
        let cevap_sablonu;
        if (tip === 'basit') cevap_sablonu = kur(karar, secenekler || {});
        else if (tip === 'sabit') cevap_sablonu = String(metin == null ? '' : metin);
        else cevap_sablonu = String(ham == null ? '' : ham);
        // satır sırası: o bölümün son sırası + 1
        const sr = await pool.query("SELECT COALESCE(MAX(satir_sira),-1)+1 AS s FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2", [bina_turu, bolum_no]);
        const r = await pool.query(
            "INSERT INTO teknik_sartname_sablonu (bina_turu,bolum_no,bolum_adi,bolum_gizle,soru,satir_sira,cevap_sablonu,yeni_tablo,baslik_gizle) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            [bina_turu, bolum_no, bolum_adi || '', bolum_gizle || null, soru || '', sr.rows[0].s, cevap_sablonu, !!yeni_tablo, !!baslik_gizle]);
        res.json({ ok: true, id: r.rows[0].id, mesaj: 'Satır eklendi.' });
    } catch (e) { next(e); }
});

// Teknik şartname içeriğinde {{}} ile kullanılabilecek alanlar (o türe göre)
app.get('/api/teknik-sartname-alanlar/:binaTuru', yetkiKontrol, async (req, res, next) => {
    try {
        const r = await pool.query(
            "SELECT DISTINCT soru, kaynak_kolon FROM form_tanimlari WHERE bina_turu=$1 AND soru IS NOT NULL AND soru<>'' ORDER BY soru",
            [req.params.binaTuru]);
        // Proje'den otomatik dolan (kaynak_kolon dolu) alanlar → "proje" (mavi); diğerleri kullanıcı girişi → "form" (gri)
        const projeSoru = r.rows.filter(x => x.kaynak_kolon).map(x => x.soru);
        const formSoru = r.rows.filter(x => !x.kaynak_kolon).map(x => x.soru);
        // Her türde ortak sistem alanları (form sorusu olmayan proje/sistem verileri)
        const genel = ['Proje No', 'Müşteri Adı', 'Proje Adı', 'Bina Yeri', 'Nakliye', 'Sahada Montaj', 'Bina Adı', 'Büyüklük', 'TARİH', 'DÜZENLEYEN', 'SATIŞ TEMSİLCİSİ', 'KOD'];
        res.json({
            ok: true,
            form: formSoru,
            sistem: [...new Set([...genel, ...projeSoru])]
        });
    } catch (e) { next(e); }
});

// Teknik şartname şablonundan satır sil
app.delete('/api/teknik-sartname-sablonu-sil/:id', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN silebilir.' });
    try {
        const r = await pool.query("DELETE FROM teknik_sartname_sablonu WHERE id=$1 RETURNING soru", [req.params.id]);
        if (!r.rowCount) return res.status(404).json({ ok: false, hata: 'Satır bulunamadı.' });
        res.json({ ok: true, mesaj: 'Satır silindi.' });
    } catch (e) { next(e); }
});

// Satırı taşı: aynı bölümde yukarı/aşağı (komşuyla sıra değiş) VEYA başka bölüme (hedef_bolum_no)
app.post('/api/teknik-sartname-sablonu-tasi', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN taşıyabilir.' });
    const { id, yon, hedef_bolum_no, hedef_bolum_adi } = req.body;
    try {
        const sR = await pool.query("SELECT * FROM teknik_sartname_sablonu WHERE id=$1", [id]);
        if (!sR.rowCount) return res.status(404).json({ ok: false, hata: 'Satır bulunamadı.' });
        const s = sR.rows[0];
        // Başka bölüme taşı
        if (hedef_bolum_no != null && hedef_bolum_no !== '') {
            const sr = await pool.query("SELECT COALESCE(MAX(satir_sira),-1)+1 AS m FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2", [s.bina_turu, hedef_bolum_no]);
            // hedef bölümün adı/gizle/no — mevcut bir satırdan al (yoksa gönderilen ad)
            const hb = await pool.query("SELECT bolum_adi,baslik_gizle FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2 LIMIT 1", [s.bina_turu, hedef_bolum_no]);
            const yeniAd = hb.rowCount ? hb.rows[0].bolum_adi : (hedef_bolum_adi || s.bolum_adi);
            // Hedef bölümün başlık-gizle durumunu satıra yansıt (aksi halde kaynak bölümün bayrağı hedef başlığını gizler)
            const yeniGizle = hb.rowCount ? hb.rows[0].baslik_gizle : false;
            await pool.query("UPDATE teknik_sartname_sablonu SET bolum_no=$1, bolum_adi=$2, satir_sira=$3, baslik_gizle=$4 WHERE id=$5", [hedef_bolum_no, yeniAd, sr.rows[0].m, yeniGizle, id]);
            return res.json({ ok: true });
        }
        // Aynı bölümde yukarı/aşağı: komşuyla satir_sira değiştir
        const op = yon === 'yukari' ? '<' : '>';
        const ord = yon === 'yukari' ? 'DESC' : 'ASC';
        const komsu = await pool.query(
            `SELECT id,satir_sira FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2 AND satir_sira ${op} $3 ORDER BY satir_sira ${ord} LIMIT 1`,
            [s.bina_turu, s.bolum_no, s.satir_sira]);
        if (!komsu.rowCount) return res.json({ ok: true, mesaj: 'Zaten sınırda.' });
        const k = komsu.rows[0];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("UPDATE teknik_sartname_sablonu SET satir_sira=$1 WHERE id=$2", [k.satir_sira, id]);
            await client.query("UPDATE teknik_sartname_sablonu SET satir_sira=$1 WHERE id=$2", [s.satir_sira, k.id]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// #4 — Bölümü bir üst/alt bölümle sıra takası yap (bina türü içinde)
app.post('/api/teknik-sartname-bolum-tasi', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN taşıyabilir.' });
    const { bina_turu, bolum_no, yon } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const op = yon === 'yukari' ? '<' : '>';
        const ord = yon === 'yukari' ? 'DESC' : 'ASC';
        const komsu = await client.query(
            `SELECT DISTINCT bolum_no FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no ${op} $2 ORDER BY bolum_no ${ord} LIMIT 1`,
            [bina_turu, bolum_no]);
        if (!komsu.rowCount) { await client.query('ROLLBACK'); return res.json({ ok: true, mesaj: 'Zaten sınırda.' }); }
        const komsuNo = komsu.rows[0].bolum_no;
        const gecici = -999999;   // geçici no ile takas (çakışma olmasın)
        await client.query("UPDATE teknik_sartname_sablonu SET bolum_no=$1 WHERE bina_turu=$2 AND bolum_no=$3", [gecici, bina_turu, bolum_no]);
        await client.query("UPDATE teknik_sartname_sablonu SET bolum_no=$1 WHERE bina_turu=$2 AND bolum_no=$3", [bolum_no, bina_turu, komsuNo]);
        await client.query("UPDATE teknik_sartname_sablonu SET bolum_no=$1 WHERE bina_turu=$2 AND bolum_no=$3", [komsuNo, bina_turu, gecici]);
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK'); next(e); }
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
});

// #4 — Bölümü tüm satırlarıyla sil
app.post('/api/teknik-sartname-bolum-sil', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN silebilir.' });
    const { bina_turu, bolum_no } = req.body;
    try {
        const r = await pool.query("DELETE FROM teknik_sartname_sablonu WHERE bina_turu=$1 AND bolum_no=$2", [bina_turu, bolum_no]);
        res.json({ ok: true, silinen: r.rowCount });
    } catch (e) { next(e); }
});

app.post('/api/form-tanimi-kaydet', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') {
        return res.json({ ok: false, hata: 'Sadece ADMIN düzenleyebilir.' });
    }
    try {
        const {
            id, bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru,
            giris_tipi, secenekler, zorunlu, kurallar, kosullar, secenek_metinleri, kaynak_kolon
        } = req.body;
        if (!bina_turu || !bolum_adi || !soru) {
            return res.json({ ok: false, hata: 'Bina türü, bölüm adı ve soru metni zorunlu.' });
        }
        const metinJson = (secenek_metinleri && Object.keys(secenek_metinleri).length) ? JSON.stringify(secenek_metinleri) : null;

        let eski = null;
        if (id) {
            const r = await pool.query('SELECT * FROM form_tanimlari WHERE id=$1', [id]);
            if (r.rowCount > 0) eski = r.rows[0];
            await pool.query(`
                UPDATE form_tanimlari
                SET bina_turu=$1, bolum_sirasi=$2, bolum_adi=$3, soru_sirasi=$4, soru=$5,
                    giris_tipi=$6, secenekler=$7, zorunlu=$8, kurallar=$9, kosullar=$10,
                    secenek_metinleri=COALESCE($11, secenek_metinleri), kaynak_kolon=$12
                WHERE id=$13
            `, [bina_turu, bolum_sirasi || 1, bolum_adi, soru_sirasi || 1, soru,
                giris_tipi || 'TEXT', secenekler ? JSON.stringify(secenekler) : null,
                !!zorunlu, kurallar || null, kosullar || null, metinJson, kaynak_kolon || null, id]);
            await auditLogla(req, {
                eylem: 'UPDATE', tablo: 'form_tanimlari', kayit_id: id,
                ozet: `Form sorusu güncellendi: ${soru.substring(0,60)}`,
                eski_veri: eski, yeni_veri: req.body
            });
        } else {
            const r = await pool.query(`
                INSERT INTO form_tanimlari (bina_turu, bolum_sirasi, bolum_adi, soru_sirasi, soru,
                                            giris_tipi, secenekler, zorunlu, kurallar, kosullar, secenek_metinleri, kaynak_kolon)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id
            `, [bina_turu, bolum_sirasi || 1, bolum_adi, soru_sirasi || 1, soru,
                giris_tipi || 'TEXT', secenekler ? JSON.stringify(secenekler) : null,
                !!zorunlu, kurallar || null, kosullar || null, metinJson, kaynak_kolon || null]);
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

// Form sorusunu aynı bölümde yukarı/aşağı taşı (komşuyla soru_sirasi swap)
app.post('/api/form-tanimi-tasi', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN taşıyabilir.' });
    const { id, yon } = req.body;
    try {
        const sR = await pool.query("SELECT * FROM form_tanimlari WHERE id=$1", [id]);
        if (!sR.rowCount) return res.status(404).json({ ok: false, hata: 'Soru bulunamadı.' });
        const s = sR.rows[0];
        const op = yon === 'yukari' ? '<' : '>';
        const ord = yon === 'yukari' ? 'DESC' : 'ASC';
        const komsu = await pool.query(
            `SELECT id,soru_sirasi FROM form_tanimlari WHERE bina_turu=$1 AND bolum_sirasi=$2 AND soru_sirasi ${op} $3 ORDER BY soru_sirasi ${ord}, id ${ord} LIMIT 1`,
            [s.bina_turu, s.bolum_sirasi, s.soru_sirasi]);
        if (!komsu.rowCount) return res.json({ ok: true, mesaj: 'Zaten sınırda.' });
        const k = komsu.rows[0];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Aynı soru_sirasi ise (çakışma) deterministik sıra ver
            const yeniS = k.soru_sirasi === s.soru_sirasi ? (yon === 'yukari' ? s.soru_sirasi - 1 : s.soru_sirasi + 1) : k.soru_sirasi;
            await client.query("UPDATE form_tanimlari SET soru_sirasi=$1 WHERE id=$2", [yeniS, id]);
            if (k.soru_sirasi !== s.soru_sirasi) await client.query("UPDATE form_tanimlari SET soru_sirasi=$1 WHERE id=$2", [s.soru_sirasi, k.id]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
        res.json({ ok: true });
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
    const trNum = n => trSayi(n);  // binlik nokta + ondalık virgül (gereksiz ondalık gösterilmez)
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

async function gunlukRaporAyarOku() {
    const r = await pool.query("SELECT deger FROM sistem_ayarlari WHERE anahtar='gunluk_rapor'");
    return r.rowCount ? r.rows[0].deger : { aktif: true, saat: '08:00', ek_alicilar: '' };
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
        alicilar = r.rows.map(x => x.email);
        const ayar = await gunlukRaporAyarOku();
        if (ayar.ek_alicilar) String(ayar.ek_alicilar).split(/[,;\s]+/).filter(Boolean).forEach(e => alicilar.push(e));
        alicilar = [...new Set(alicilar)];
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

// Günlük rapor cron'unu panel ayarına göre (saat/aktif) kurar/yeniden kurar — yalnızca production
let raporCronTask = null;
async function raporCronKur() {
    if (!(process.env.RENDER || process.env.NODE_ENV === 'production')) return;
    const cronLib = require('node-cron');
    if (raporCronTask) { raporCronTask.stop(); raporCronTask = null; }
    const ayar = await gunlukRaporAyarOku();
    if (!ayar.aktif) { console.log('🗓️ Günlük rapor KAPALI (panel ayarı).'); return; }
    const [h, m] = (ayar.saat || '08:00').split(':').map(Number);
    raporCronTask = cronLib.schedule(`${m} ${h} * * *`, () => {
        gunlukRaporGonder().catch(e => console.error('🗓️ Günlük rapor hatası:', e.message));
    }, { timezone: 'Europe/Istanbul' });
    console.log(`🗓️ Günlük satınalma raporu zamanlandı: her gün ${ayar.saat} (TR)`);
}

// Manuel test (ADMIN) — raporu yalnızca isteyen kişiye gönderir
app.post('/api/gunluk-rapor-test', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.status(403).json({ ok:false, hata:'Sadece ADMIN.' });
    try {
        await gunlukRaporGonder(req.user.email);
        res.json({ ok: true, mesaj: `Test raporu ${req.user.email} adresine gönderildi.` });
    } catch (e) { res.status(500).json({ ok:false, hata: e.message }); }
});

// Günlük rapor ayarı: oku
app.get('/api/gunluk-rapor-ayar', yetkiKontrol, async (req, res, next) => {
    try {
        const ayar = await gunlukRaporAyarOku();
        // Rol bazlı alıcı sayısını da bilgi olarak ver
        const r = await pool.query("SELECT count(*)::int n FROM kullanicilar WHERE rol IN ('SATINALMA','ADMIN') AND durum='AKTIF' AND email IS NOT NULL");
        res.json({ ok: true, ayar, rolAliciSayisi: r.rows[0].n });
    } catch (e) { next(e); }
});

// Günlük rapor ayarı: kaydet (ADMIN) + cron'u yeniden kur
app.post('/api/gunluk-rapor-ayar', yetkiKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN değiştirebilir.' });
    try {
        const { aktif, saat, ek_alicilar } = req.body;
        const saatGecerli = /^([01]\d|2[0-3]):[0-5]\d$/.test(saat || '');
        const yeni = { aktif: !!aktif, saat: saatGecerli ? saat : '08:00', ek_alicilar: String(ek_alicilar || '').trim() };
        await pool.query(
            "INSERT INTO sistem_ayarlari (anahtar,deger,guncelleme) VALUES ('gunluk_rapor',$1,now()) ON CONFLICT (anahtar) DO UPDATE SET deger=$1, guncelleme=now()",
            [JSON.stringify(yeni)]);
        if (typeof raporCronKur === 'function') await raporCronKur();
        res.json({ ok: true, ayar: yeni });
    } catch (e) { next(e); }
});

// ============================================================================
// GÖREV RAPORU (PDF + günlük/haftalık e-posta) — çekirdek ekip
// ============================================================================
async function gorevRaporVerisi(filtre = {}) {
    const kos = [], par = [];
    if (filtre.sahip_id) { par.push(filtre.sahip_id); kos.push(`g.sahip_id=$${par.length}`); }
    if (filtre.durum) { par.push(filtre.durum); kos.push(`g.durum=$${par.length}`); }
    else if (filtre.sadeceAcik) kos.push(`g.durum IN ('ACIK','DEVAM')`);
    if (filtre.alan) { par.push(filtre.alan); kos.push(`g.alan=$${par.length}`); }
    if (filtre.taahhut) kos.push(`g.taahhut=TRUE`);
    if (filtre.gecikmis) kos.push(`g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE`);
    const where = kos.length ? 'WHERE ' + kos.join(' AND ') : '';
    const g = await pool.query(`
        SELECT g.id, g.baslik, g.alan, g.oncelik, g.durum, g.bitis_tarihi, g.taahhut, g.sahip_id, sh.ad_soyad AS sahip_ad,
               (g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE) AS gecikmis
        FROM yonetim_gorevleri g JOIN kullanicilar sh ON g.sahip_id=sh.id
        ${where}
        ORDER BY sh.ad_soyad, (g.durum IN ('ACIK','DEVAM') AND g.bitis_tarihi < CURRENT_DATE) DESC, g.bitis_tarihi ASC`, par);
    let baslik = 'Tüm Görevler';
    if (filtre.sahip_id) {
        const sr = await pool.query("SELECT ad_soyad FROM kullanicilar WHERE id=$1", [filtre.sahip_id]);
        baslik = sr.rows[0] ? sr.rows[0].ad_soyad : 'Görevler';
    }
    return { gorevler: g.rows, baslik };
}
function gorevRaporHTML(gorevler, baslik) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tr = d => d ? new Date(d).toLocaleDateString('tr-TR') : '-';
    const ALAN = { TAAHHUT: '30/90 Taahhüt', NAKIT: 'Nakit Seferberliği', YENIDEN_YAPILANMA: 'Yeniden Yapılanma', KOMISER: 'Komiser Hazırlığı', PZT_KARAR: 'Pazartesi Kararı', GENEL: 'Genel' };
    const alanAd = k => ALAN[k] || String(k || '').split('_').filter(Boolean).map(w => w.charAt(0) + w.slice(1).toLocaleLowerCase('tr')).join(' ');
    const DURUM = { ACIK: 'Açık', DEVAM: 'Devam', TAMAMLANDI: 'Tamamlandı', IPTAL: 'İptal' };
    const grup = {}; gorevler.forEach(g => { (grup[g.sahip_ad] = grup[g.sahip_ad] || []).push(g); });
    let govde = '';
    Object.keys(grup).sort((a, b) => a.localeCompare(b, 'tr')).forEach(ad => {
        const gs = grup[ad];
        const acik = gs.filter(x => ['ACIK', 'DEVAM'].includes(x.durum)).length;
        const gec = gs.filter(x => x.gecikmis).length;
        govde += `<h3>${esc(ad)} <span class="ozet">(açık: ${acik}${gec ? ` · <span class="kirmizi">geciken: ${gec}</span>` : ''})</span></h3>
        <table><thead><tr><th style="width:44%">Görev</th><th>Alan</th><th>Öncelik</th><th>Bitiş</th><th>Durum</th></tr></thead><tbody>
        ${gs.map(x => `<tr class="${x.gecikmis ? 'gec' : ''}"><td>${esc(x.baslik)}${x.taahhut ? ' <span class="tb">Taahhüt</span>' : ''}</td><td>${esc(alanAd(x.alan))}</td><td>${esc(x.oncelik)}</td><td>${tr(x.bitis_tarihi)}${x.gecikmis ? ' ⚠' : ''}</td><td>${esc(DURUM[x.durum] || x.durum)}</td></tr>`).join('')}
        </tbody></table>`;
    });
    if (!gorevler.length) govde = '<p class="bos">Kayıt yok.</p>';
    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><style>
      @page { margin: 16mm; size: A4; }
      body { font-family: Arial, sans-serif; font-size: 10pt; color:#1a1a1a; }
      h1 { font-size: 16pt; margin:0 0 2px; }
      .ust { color:#666; font-size:9pt; margin-bottom:14px; border-bottom:2px solid #0d6efd; padding-bottom:8px; }
      h3 { font-size:11pt; margin:16px 0 4px; color:#0d6efd; page-break-after:avoid; }
      .ozet { font-weight:normal; font-size:9pt; color:#666; }
      .kirmizi { color:#dc3545; font-weight:bold; }
      table { width:100%; border-collapse:collapse; margin-bottom:8px; }
      th { background:#f1f3f5; text-align:left; padding:5px 8px; font-size:8.5pt; border-bottom:1px solid #dee2e6; }
      td { padding:5px 8px; font-size:9pt; border-bottom:1px solid #eee; vertical-align:top; }
      tr { page-break-inside:avoid; }
      tr.gec td { background:#fff5f5; }
      tr.gec td:first-child { border-left:3px solid #dc3545; }
      .tb { background:#cff4fc; color:#055160; font-size:7.5pt; padding:1px 5px; border-radius:4px; }
      .bos { color:#888; font-style:italic; }
      .ft { margin-top:18px; color:#999; font-size:8pt; }
    </style></head><body>
      <h1>Görev Raporu — ${esc(baslik)}</h1>
      <div class="ust">Oluşturma: ${new Date().toLocaleString('tr-TR')} · Aterko Workspace · Çekirdek Yönetim Ekibi · Toplam ${gorevler.length} görev</div>
      ${govde}
      <div class="ft">Aterko Workspace — Görev Takip</div>
    </body></html>`;
}
async function gorevRaporPDF(filtre) {
    const { htmlToPDF } = require('./lib/pdf-generator');
    const { gorevler, baslik } = await gorevRaporVerisi(filtre);
    const pdf = await htmlToPDF(gorevRaporHTML(gorevler, baslik), {});
    return { pdf, sayi: gorevler.length, baslik };
}

// On-demand PDF — kişi bazlı (sahip_id) ya da tümü; liste filtrelerini yansıtır
app.get('/api/gorevler/pdf', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const { sahip_id, durum, alan, taahhut, gecikmis } = req.query;
        const { pdf } = await gorevRaporPDF({ sahip_id, durum, alan, taahhut: taahhut === '1' || taahhut === 'true', gecikmis: gecikmis === '1' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="Gorev-Raporu.pdf"');
        res.send(pdf);
    } catch (e) { next(e); }
});

// Zamanlı görev raporu (günlük/haftalık) — panel ayarı
async function gorevRaporAyarOku() {
    const r = await pool.query("SELECT deger FROM sistem_ayarlari WHERE anahtar='gorev_rapor'");
    return r.rowCount ? r.rows[0].deger : { aktif: false, periyot: 'haftalik', gun: 1, saat: '08:00', ek_alicilar: '' };
}
async function gorevRaporGonder(testEmail) {
    if (!mailTransporter) { console.log('⚠️ Görev raporu: mail kapalı'); return; }
    const { pdf, sayi } = await gorevRaporPDF({ sadeceAcik: true });
    let alicilar;
    if (testEmail) alicilar = [testEmail];
    else {
        const r = await pool.query("SELECT email FROM kullanicilar WHERE cekirdek_ekip=TRUE AND durum='AKTIF' AND email IS NOT NULL");
        alicilar = r.rows.map(x => x.email);
        const ayar = await gorevRaporAyarOku();
        if (ayar.ek_alicilar) String(ayar.ek_alicilar).split(/[,;\s]+/).filter(Boolean).forEach(e => alicilar.push(e));
        alicilar = [...new Set(alicilar)];
    }
    if (!alicilar.length) { console.log('⚠️ Görev raporu: alıcı yok'); return; }
    const bugun = new Date().toLocaleDateString('tr-TR');
    await mailTransporter.sendMail({
        from: `"Aterko Workspace" <${MAIL_FROM_GENEL}>`,   // görev raporu satınalma değil → genel adres
        to: alicilar.join(', '),
        subject: `Görev Raporu — ${bugun}`,
        html: `<div style="font-family:Arial,sans-serif;color:#212529;"><p>Merhaba,</p><p>${bugun} tarihli açık görev raporu (${sayi} görev) ektedir.</p><p style="color:#6c757d;font-size:12px;margin-top:16px;">Aterko Workspace — otomatik görev raporu</p></div>`,
        attachments: [{ filename: `Gorev-Raporu-${bugun}.pdf`, content: pdf }]
    });
    console.log(`📋 Görev raporu gönderildi → ${alicilar.length} alıcı${testEmail ? ' (TEST)' : ''}`);
}
let gorevRaporCronTask = null;
async function gorevRaporCronKur() {
    if (!(process.env.RENDER || process.env.NODE_ENV === 'production')) return;
    const cronLib = require('node-cron');
    if (gorevRaporCronTask) { gorevRaporCronTask.stop(); gorevRaporCronTask = null; }
    const ayar = await gorevRaporAyarOku();
    if (!ayar.aktif) { console.log('📋 Görev raporu KAPALI (panel ayarı).'); return; }
    const [h, m] = (ayar.saat || '08:00').split(':').map(Number);
    const gunSpec = ayar.periyot === 'gunluk' ? '*' : String(ayar.gun == null ? 1 : ayar.gun);
    gorevRaporCronTask = cronLib.schedule(`${m} ${h} * * ${gunSpec}`, () => {
        gorevRaporGonder().catch(e => console.error('📋 Görev raporu hatası:', e.message));
    }, { timezone: 'Europe/Istanbul' });
    console.log(`📋 Görev raporu zamanlandı: ${ayar.periyot} ${ayar.saat} (TR)${ayar.periyot === 'haftalik' ? ` gün=${gunSpec}` : ''}`);
}
app.post('/api/gorev-rapor-test', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try { await gorevRaporGonder(req.user.email); res.json({ ok: true, mesaj: `Test raporu ${req.user.email} adresine gönderildi.` }); }
    catch (e) { res.status(500).json({ ok: false, hata: e.message }); }
});
app.get('/api/gorev-rapor-ayar', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    try {
        const ayar = await gorevRaporAyarOku();
        const r = await pool.query("SELECT count(*)::int n FROM kullanicilar WHERE cekirdek_ekip=TRUE AND durum='AKTIF'");
        res.json({ ok: true, ayar, cekirdekSayisi: r.rows[0].n });
    } catch (e) { next(e); }
});
app.post('/api/gorev-rapor-ayar', yetkiKontrol, cekirdekEkipKontrol, async (req, res, next) => {
    if (req.user.rol !== 'ADMIN' && req.user.rol !== 'Admin') return res.json({ ok: false, hata: 'Sadece ADMIN değiştirebilir.' });
    try {
        const { aktif, periyot, gun, saat, ek_alicilar } = req.body;
        const saatGecerli = /^([01]\d|2[0-3]):[0-5]\d$/.test(saat || '');
        const yeni = { aktif: !!aktif, periyot: periyot === 'gunluk' ? 'gunluk' : 'haftalik', gun: Math.min(6, Math.max(0, parseInt(gun) || 1)), saat: saatGecerli ? saat : '08:00', ek_alicilar: String(ek_alicilar || '').trim() };
        await pool.query("INSERT INTO sistem_ayarlari (anahtar,deger,guncelleme) VALUES ('gorev_rapor',$1,now()) ON CONFLICT (anahtar) DO UPDATE SET deger=$1, guncelleme=now()", [JSON.stringify(yeni)]);
        await gorevRaporCronKur();
        res.json({ ok: true, ayar: yeni });
    } catch (e) { next(e); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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

            // Stok kontrolü — satırı KİLİTLE (FOR UPDATE): eşzamanlı istekler/aynı üründe negatif stok önlenir
            const lockR = await client.query('SELECT COALESCE(guncel_stok_miktari,0) AS m FROM stok_kartlari WHERE id=$1 FOR UPDATE', [row.stok_kart_id]);
            const mevcutStok = parseFloat(lockR.rows[0]?.m) || 0;
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
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
    finally { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); }
});

app.use((err, req, res, next) => {
    console.error("🔥 Hata:", err);
    // pg/sistem hataları (err.code var) iç şema detayı sızdırabilir → istemciye genel mesaj.
    // Uygulama içi throw new Error('...') mesajları (code yok) kullanıcıya gösterilir.
    const musteriMesaj = err.code ? 'Sunucu hatası oluştu. Lütfen tekrar deneyin.' : (err.message || 'Sunucu hatası.');
    res.status(500).json({ ok: false, hata: musteriMesaj });
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

        // Teknik şartname seçenek metinleri (PDF'te ham cevap yerine profesyonel şartname cümlesi)
        // Yapı: { "seçenek değeri": "şartname cümlesi", ... } — TEK ve ÇOK sorular için
        await pool.query(`ALTER TABLE form_tanimlari ADD COLUMN IF NOT EXISTS secenek_metinleri JSONB`);
        await pool.query(`ALTER TABLE form_tanimlari ADD COLUMN IF NOT EXISTS kaynak_kolon TEXT`);
        await pool.query(`ALTER TABLE teknik_sartname_sablonu ADD COLUMN IF NOT EXISTS yeni_tablo BOOLEAN DEFAULT false`);
        await pool.query(`ALTER TABLE teknik_sartname_sablonu ADD COLUMN IF NOT EXISTS baslik_gizle BOOLEAN DEFAULT false`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sistem_ayarlari (anahtar TEXT PRIMARY KEY, deger JSONB, guncelleme TIMESTAMPTZ DEFAULT now())`);
        await pool.query(`INSERT INTO sistem_ayarlari (anahtar,deger) VALUES ('gunluk_rapor',$1) ON CONFLICT (anahtar) DO NOTHING`, [JSON.stringify({ aktif: true, saat: '08:00', ek_alicilar: '' })]);
        await pool.query(`INSERT INTO sistem_ayarlari (anahtar,deger) VALUES ('gorev_rapor',$1) ON CONFLICT (anahtar) DO NOTHING`, [JSON.stringify({ aktif: false, periyot: 'haftalik', gun: 1, saat: '08:00', ek_alicilar: '' })]);
        await pool.query(`ALTER TABLE yonetim_gorevleri ADD COLUMN IF NOT EXISTS notlar JSONB`).catch(() => {});
        // İş Emri (teknik şartname bazlı, teslimat düzeyi — satış aşaması)
        await pool.query(`CREATE TABLE IF NOT EXISTS is_emirleri (
            id SERIAL PRIMARY KEY,
            emir_no TEXT UNIQUE NOT NULL,
            teslimat_id INTEGER NOT NULL REFERENCES proje_teslimatlari(id) ON DELETE CASCADE,
            durum TEXT NOT NULL DEFAULT 'HAZIRLANDI',
            is_emri_notu TEXT,
            ek_alicilar TEXT,
            form_snapshot JSONB,
            pdf BYTEA,
            olusturan_email TEXT, olusturan_adsoyad TEXT, olusturma_tarihi TIMESTAMPTZ DEFAULT NOW(),
            yayinlayan_email TEXT, yayinlama_tarihi TIMESTAMPTZ,
            iptal_eden_email TEXT, iptal_tarihi TIMESTAMPTZ, iptal_nedeni TEXT
        )`);
        // Teslimat başına tek AKTİF iş emri (İPTAL edilenler iz olarak kalır, yenisi açılabilir)
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_is_emirleri_teslimat_aktif ON is_emirleri(teslimat_id) WHERE durum <> 'İPTAL'`);
        await pool.query(`CREATE TABLE IF NOT EXISTS is_emri_notlari (
            id SERIAL PRIMARY KEY,
            is_emri_id INTEGER NOT NULL REFERENCES is_emirleri(id) ON DELETE CASCADE,
            yazan_email TEXT, yazan_adsoyad TEXT,
            not_metni TEXT NOT NULL,
            tarih TIMESTAMPTZ DEFAULT NOW()
        )`);
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS is_emri_no_seq START 1001`);
        // Proje bilgileri: satış temsilcisi + dış sistem linkleri (ASET/DRIVE) — iş emrine yansır
        await pool.query(`ALTER TABLE projeler
            ADD COLUMN IF NOT EXISTS satis_temsilcisi TEXT,
            ADD COLUMN IF NOT EXISTS aset_link TEXT,
            ADD COLUMN IF NOT EXISTS drive_link TEXT`).catch(() => {});
        // Teknik şartname kodu ({proje_kodu}-TŞ-NN) — ilk PDF üretiminde atanır, sonra sabit
        await pool.query(`ALTER TABLE proje_teslimatlari ADD COLUMN IF NOT EXISTS sartname_kodu TEXT`).catch(() => {});
        // ============ MALİ İŞLER (Faz 1) ============
        // Tedarikçi mali alanları (kimlik alanları Satınalma'da kalır; bunlar mali yüz)
        await pool.query(`ALTER TABLE tedarikciler
            ADD COLUMN IF NOT EXISTS tur TEXT DEFAULT 'Tedarikçi',
            ADD COLUMN IF NOT EXISTS iban TEXT,
            ADD COLUMN IF NOT EXISTS banka_bilgisi TEXT,
            ADD COLUMN IF NOT EXISTS genel_vade_gun INTEGER,
            ADD COLUMN IF NOT EXISTS ilgili_kisi_id INTEGER,
            ADD COLUMN IF NOT EXISTS mali_aciklama TEXT,
            ADD COLUMN IF NOT EXISTS muhlet_oncesi_borc NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS muhlet_sonrasi_devir NUMERIC DEFAULT 0`).catch(e => console.error('⚠️ tedarikci mali kolon:', e.message));
        await pool.query(`CREATE TABLE IF NOT EXISTS musteriler (
            id SERIAL PRIMARY KEY,
            firma_adi TEXT NOT NULL,
            tur TEXT DEFAULT 'Kurumsal',
            durum TEXT DEFAULT 'AKTIF',
            yetkili_kisi TEXT, telefon TEXT, email TEXT,
            vergi_no TEXT, vergi_dairesi TEXT, adres TEXT,
            ilgili_kisi_id INTEGER,
            aciklama TEXT,
            devir_alacak NUMERIC DEFAULT 0,
            kayit_tarihi TIMESTAMPTZ DEFAULT NOW()
        )`);
        // Cari hareket defteri — bakiyeler HER ZAMAN bu tablodan hesaplanır (kolonda bakiye tutulmaz)
        // planlanan_/gerceklesen_ alanları Faz 2 (nakit akış) için şimdiden şemada
        await pool.query(`CREATE TABLE IF NOT EXISTS cari_hareketler (
            id SERIAL PRIMARY KEY,
            taraf_tip TEXT NOT NULL,
            taraf_id INTEGER NOT NULL,
            tip TEXT NOT NULL,
            belge_tarihi DATE,
            belge_no TEXT,
            tutar NUMERIC NOT NULL,
            vade_tarihi DATE,
            planlanan_vade DATE,
            planlanan_tutar NUMERIC,
            gerceklesen_tarih DATE,
            gerceklesen_tutar NUMERIC,
            cek_no TEXT, banka TEXT,
            muhlet_oncesi BOOLEAN DEFAULT false,
            projeksiyon_tur TEXT,
            aciklama TEXT,
            olusturan_email TEXT,
            kayit_tarihi TIMESTAMPTZ DEFAULT NOW()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_cari_taraf ON cari_hareketler(taraf_tip, taraf_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_cari_vade ON cari_hareketler(vade_tarihi) WHERE vade_tarihi IS NOT NULL`);
        // Mali İşler izin tohumları: ADMIN=TAM, MUHASEBE=YAZMA, YONETIM=OKUMA (yalnız satır yoksa)
        for (const [rolAd, seviye] of [['ADMIN', 'TAM'], ['MUHASEBE', 'YAZMA'], ['YONETIM', 'OKUMA']]) {
            for (const modul of ['mali.tedarikci', 'mali.musteri']) {
                await pool.query(`
                    INSERT INTO rol_izinleri (rol_id, modul_kod, seviye)
                    SELECT r.id, $1::varchar, $2::varchar FROM roller r
                    WHERE r.ad = $3
                      AND NOT EXISTS (SELECT 1 FROM rol_izinleri ri WHERE ri.rol_id = r.id AND ri.modul_kod = $1)
                `, [modul, seviye, rolAd]).catch(e => console.error('⚠️ mali izin tohumu:', e.message));
            }
        }
        // Teklif Havuzu ayrı izin satırı: mevcut davranış korunarak her rolün
        // satinalma.talepler seviyesi satinalma.teklif'e kopyalanır (yalnız yoksa)
        await pool.query(`
            INSERT INTO rol_izinleri (rol_id, modul_kod, seviye)
            SELECT ri.rol_id, 'satinalma.teklif'::varchar, ri.seviye
            FROM rol_izinleri ri
            WHERE ri.modul_kod = 'satinalma.talepler'
              AND NOT EXISTS (SELECT 1 FROM rol_izinleri r2 WHERE r2.rol_id = ri.rol_id AND r2.modul_kod = 'satinalma.teklif')
        `).catch(e => console.error('⚠️ teklif izin tohumu:', e.message));
        // Arşiv + Rapor (Genel Bakış) ayrı izin satırları: SİPARİŞLER seviyesi kopyalanır
        // (arşiv/rapor sipariş tutarları içerir — siparişi görmeyen bunları da görmesin)
        for (const yeniModul of ['satinalma.arsiv', 'satinalma.rapor']) {
            await pool.query(`
                INSERT INTO rol_izinleri (rol_id, modul_kod, seviye)
                SELECT ri.rol_id, $1::varchar, ri.seviye
                FROM rol_izinleri ri
                WHERE ri.modul_kod = 'satinalma.siparisler'
                  AND NOT EXISTS (SELECT 1 FROM rol_izinleri r2 WHERE r2.rol_id = ri.rol_id AND r2.modul_kod = $1)
            `, [yeniModul]).catch(e => console.error('⚠️ arsiv/rapor izin tohumu:', e.message));
        }
        // Bildirim olayları (panel > Bildirim Ayarları'ndan roller/kişiler yönetilir)
        await pool.query(`INSERT INTO bildirim_kurallari (olay_kodu, olay_adi, kategori, aktif, roller, ekstra_emailler, dinamik_alicilar, sira)
            SELECT 'IS_EMRI_YAYINLANDI','İş emri yayınlandı (şartname PDF ekli)','Proje',true,'{}','{}','{}',50
            WHERE NOT EXISTS (SELECT 1 FROM bildirim_kurallari WHERE olay_kodu='IS_EMRI_YAYINLANDI')`);
        await pool.query(`INSERT INTO bildirim_kurallari (olay_kodu, olay_adi, kategori, aktif, roller, ekstra_emailler, dinamik_alicilar, sira)
            SELECT 'IS_EMRI_NOT','İş emrine not eklendi','Proje',true,'{}','{}','{}',51
            WHERE NOT EXISTS (SELECT 1 FROM bildirim_kurallari WHERE olay_kodu='IS_EMRI_NOT')`);
        await pool.query(`INSERT INTO bildirim_kurallari (olay_kodu, olay_adi, kategori, aktif, roller, ekstra_emailler, dinamik_alicilar, sira)
            SELECT 'IS_EMRI_ONAY_BEKLIYOR','İş emri onay bekliyor (ADMIN''e)','Proje',true,ARRAY['ADMIN'],'{}','{}',49
            WHERE NOT EXISTS (SELECT 1 FROM bildirim_kurallari WHERE olay_kodu='IS_EMRI_ONAY_BEKLIYOR')`);
        // Eski TEXT notlar'ı tarihli JSONB dizisine çevir (idempotent; yalnız text ise)
        await pool.query(`
            DO $$
            BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='yonetim_gorevleri' AND column_name='notlar' AND data_type='text') THEN
                ALTER TABLE yonetim_gorevleri ALTER COLUMN notlar TYPE JSONB
                  USING (CASE WHEN notlar IS NULL OR btrim(notlar)='' THEN NULL
                         ELSE jsonb_build_array(jsonb_build_object('metin', notlar, 'tarih', to_char((now() AT TIME ZONE 'Europe/Istanbul')::date,'YYYY-MM-DD'))) END);
              END IF;
            END $$;`).catch(() => {});

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
    // Zamanlanmış işler YALNIZCA production'da (Render). Lokal nodemon mükerrer mail/bildirim üretmesin.
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
        setTimeout(() => bildirimleriOtomatikUret().catch(()=>{}), 10 * 1000);
        setInterval(() => bildirimleriOtomatikUret().catch(()=>{}), 60 * 60 * 1000);
        // Günlük satınalma raporu (PDF) — panel ayarına göre (saat/aktif), Satınalma yetkilileri + Admin'e
        raporCronKur().catch(e => console.error('🗓️ Günlük rapor cron kurulamadı:', e.message));
        // Görev raporu (PDF) — günlük/haftalık, çekirdek ekibe
        gorevRaporCronKur().catch(e => console.error('📋 Görev raporu cron kurulamadı:', e.message));
    } else {
        console.log('🗓️ Zamanlanmış işler lokalde atlandı (yalnızca production çalışır).');
    }
});
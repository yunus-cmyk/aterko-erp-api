# Aterko ERP API

Aterko prefabrik yapı firması icin gelistirilen ERP sistemi.

## Teknoloji
- **Backend:** Node.js + Express.js (CommonJS)
- **Veritabani:** PostgreSQL (Supabase, `pg` pool ile baglanti, SSL aktif)
- **Auth:** Google OAuth 2.0 + JWT (12 saat sureli token)
- **PDF:** Puppeteer + PDFKit
- **Deploy:** Render
- **Frontend:** Tek sayfa HTML (`index.html`), ayri bir hosting uzerinde

## Proje Yapisi
- `server.js` — Tum API endpoint'leri (tek dosya)
- `index.html` — Frontend (tek sayfa uygulama)
- `migrate.js` — Veritabani migration scripti
- `.env` — DATABASE_URL (Supabase connection string)

## ERP Modulleri
1. **Stok Kartlari** — Urun katalogu ve stok takibi
2. **Proje Takip** — Proje ve teslimat (bina) yonetimi
3. **Satinalma Talepleri** — Talep olusturma, onay sureci
4. **Siparis Yonetimi** — Kismi siparis (split-order) bolunme motoru
5. **Mal Kabul** — Teslim alma ve otomatik stok guncelleme
6. **Tedarikciler** — Tedarikci kayitlari

## Veritabani Tablolari
- `kullanicilar` — Kullanici yonetimi (email, rol, durum)
- `stok_kartlari` — Urun katalogu (stok_kodu unique, guncel_stok_miktari)
- `projeler` — Ana proje kayitlari (5 haneli proje_kodu)
- `proje_teslimatlari` — Projelere bagli binalar/teslimatlar
- `teslimat_urunleri` — Teslimatlara bagli urun listeleri
- `satinalma_talepleri` — Satin alma talepleri (SAT-T-XXXX format)
- `talep_urunleri` — Talep kalemleri (durum: ONAY BEKLIYOR > ISLEME ALINDI > SIPARIS OLUSTURULDU > TESLIM ALINDI)
- `satinalma_siparisleri` — Siparisler (SAT-S-XXXX format)
- `siparis_kalemleri` — Siparis kalemleri (birim_fiyat, siparis_miktari)
- `tedarikciler` — Tedarikci firma bilgileri

## Komutlar
```bash
# Sunucuyu baslat
node server.js

# Paketleri yukle
npm install
```

## Kurallar
- Tum API endpoint'leri `yetkiKontrol` middleware'i ile korunur
- Transaction gerektiren islemler (siparis, proje kayit) `BEGIN/COMMIT/ROLLBACK` ile sarmalanir
- Turkce degisken ve tablo isimleri kullanilir
- Hata mesajlari Turkce doner

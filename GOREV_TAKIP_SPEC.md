# Görev Takip Modülü — Spek (Yönetim / Çekirdek Ekip)

> Bu spek, Cowork oturumunda hazırlanan "görev, tarih, sahip" liderlik uygulamasının
> ERP'ye entegrasyonu içindir. Uygulama detayı bu dosyada; iş bağlamı: kesin mühlet
> dönemi haftalık yönetim ritmi (Pazartesi toplantıları) bu modül üzerinden yürüyecek.

## Amaç
5 kişilik çekirdek yönetim ekibi (Yunus, Yakup, Mahmut, Ömer, Mehmet) arasında
görev/taahhüt takibi: her görevin bir SAHİBİ, bir BİTİŞ TARİHİ ve net bir DURUMU olur.
Pazartesi yönetim toplantısı bu ekran üzerinden yapılır.

## Kapsam ve erişim
- SADECE çekirdek ekip erişir. Erişim kontrolü mevcut izin sistemiyle:
  yeni izin kodu `yonetim.gorevler` (grup: 'Yönetim') tanımlanır ve yalnızca
  bu 5 kullanıcının rolüne atanır. Ayrıca endpoint'lerde savunma amaçlı ikinci
  kontrol: `cekirdekEkipKontrol` middleware — `kullanicilar` tablosunda
  `cekirdek_ekip = TRUE` olanlar (migration ile eklenecek boolean kolon).
- Diğer roller bu menüyü hiç görmez (frontend'de izin koduna bağlı sekme).

## Veri modeli (migration: migrate-gorevler.js, mevcut migrate.js stilinde)
```sql
ALTER TABLE kullanicilar ADD COLUMN IF NOT EXISTS cekirdek_ekip BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS yonetim_gorevleri (
  id SERIAL PRIMARY KEY,
  baslik TEXT NOT NULL,
  aciklama TEXT,
  sahip_id INTEGER NOT NULL REFERENCES kullanicilar(id),
  olusturan_id INTEGER NOT NULL REFERENCES kullanicilar(id),
  alan TEXT NOT NULL DEFAULT 'GENEL',          -- SATIS | MALI | IDARI | ORTAKLAR | GENEL
  oncelik TEXT NOT NULL DEFAULT 'NORMAL',      -- KRITIK | YUKSEK | NORMAL
  durum TEXT NOT NULL DEFAULT 'ACIK',          -- ACIK | DEVAM | TAMAMLANDI | IPTAL
  bitis_tarihi DATE NOT NULL,
  tamamlanma_tarihi TIMESTAMPTZ,
  taahhut BOOLEAN DEFAULT FALSE,               -- 30/90 gün "taahhüt" işareti (toplantı taahhütleri)
  olusturma_tarihi TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gorev_notlari (
  id SERIAL PRIMARY KEY,
  gorev_id INTEGER NOT NULL REFERENCES yonetim_gorevleri(id) ON DELETE CASCADE,
  yazan_id INTEGER NOT NULL REFERENCES kullanicilar(id),
  not_metni TEXT NOT NULL,
  olusturma_tarihi TIMESTAMPTZ DEFAULT NOW()
);
```

## API (server.js, mevcut kalıpla: yetkiKontrol + cekirdekEkipKontrol, cevap: { ok, ... } / { ok:false, hata })
- `GET  /api/gorevler` — filtreler: `?sahip_id=&durum=&alan=&taahhut=&gecikmis=1`
  Gecikmiş tanımı: `durum IN ('ACIK','DEVAM') AND bitis_tarihi < CURRENT_DATE`.
- `POST /api/gorev-kaydet` — yeni görev veya güncelleme (id varsa update).
  Kural: `sahip_id` ve `bitis_tarihi` zorunlu — sahipsiz/tarihsiz görev kaydedilemez
  (Türkçe hata: "Görevin sahibi ve bitiş tarihi zorunludur.").
- `POST /api/gorev-durum` — { id, durum }. TAMAMLANDI → tamamlanma_tarihi = NOW().
  Durum değişikliğini yalnızca görevin sahibi veya Yunus yapabilir.
- `POST /api/gorev-not` — { gorev_id, not_metni }.
- `GET  /api/gorevler/pazartesi` — "Pazartesi görünümü" (aşağıda).

## Pazartesi görünümü (toplantı ekranı — modülün kalbi)
Tek endpoint, tek ekran; toplantıda yansıtılacak. Dönen bloklar:
1. `gecikenler` — geciken görevler (kırmızı), sahibe göre gruplu
2. `bu_hafta` — bitiş tarihi bu hafta içinde olanlar, sahibe göre gruplu
3. `gecen_hafta_bitenler` — son 7 günde TAMAMLANDI olanlar (isimle teslim/takdir için)
4. `taahhutler` — taahhut=TRUE olan görevlerin durum özeti (30/90 gün taahhüt takibi)
5. `sahip_ozeti` — kişi başına: açık / geciken / bu ay tamamlanan sayıları

## Frontend (index.html — mevcut SPA yapısına yeni sekme)
- Menüde "Görevler" sekmesi (izin kodu `yonetim.gorevler` olanlara görünür).
- İki görünüm: **Liste** (filtreler: sahip, durum, alan, taahhüt; geciken satırlar kırmızı)
  ve **Pazartesi** (yukarıdaki 5 blok, yazdırılabilir sade düzen).
- Hızlı ekleme: başlık + sahip (5 kişilik dropdown) + tarih; detay sonradan.
- Görev kartında not geçmişi görünür.

## İş kuralları
- Her görev tek sahiplidir; ortak görev yok (ikinci kişi not ile katkı verir).
- Bitiş tarihi geçen görev otomatik "gecikti" görünümüne düşer; kimse gizleyemez.
- İptal eden kişi not yazmak zorundadır (frontend zorlaması yeterli).
- Silme yok; yalnızca IPTAL durumu (iz kalır).

## Seed (migration sonunda, e-postalar mevcut kullanıcı kayıtlarıyla eşleştirilerek)
- 5 kullanıcıda `cekirdek_ekip = TRUE` işaretlenir (e-posta listesi deploy sırasında netleştirilecek;
  yunus@aterko.com kesin, diğer 4 e-posta sorulacak).
- İlk görevler `gorevler-seed.csv` dosyasından yüklenir (repo kökünde; sahip adları
  kullanicilar.ad_soyad ile eşleştirilir, eşleşmeyen kayıtlar raporlanıp atlanır).
  Park listesi (seed'e dahil değil, ikinci dalga): Mehmet — sözleşme envanteri (Ağustos),
  Mahmut — teklif/fiyat şablonları.

## Dinamik alan yönetimi (v1.1 — eklenecek)
Alan listesi arayüzde sabit kodlu olmaktan çıkarılır; veriden türetilir:

1. **Kaynak:** Yeni endpoint `GET /api/gorevler/alanlar` →
   `SELECT alan, COUNT(*) FILTER (WHERE durum IN ('ACIK','DEVAM')) AS aktif_sayi, COUNT(*) AS toplam
    FROM yonetim_gorevleri GROUP BY alan ORDER BY alan`.
   Sonuç: `{ ok, alanlar: [{ alan, aktif_sayi, toplam }] }`.
2. **Görev formunda yeni alan tanımlama:** Alan seçim menüsünün sonunda
   `+ Yeni alan…` seçeneği; seçilince kısa metin girişi açılır. Girilen değer
   normalize edilir (trim, Türkçe karakter korunarak UPPERCASE, boşluk → `_`)
   ve görevle birlikte kaydedilir. Ayrı tanım tablosu GEREKMEZ — alan, ilk
   göreviyle doğar. Boş/1 karakterlik değer reddedilir (Türkçe hata mesajı).
3. **Pasif alanların gösterimi:** Filtre menüsünde `aktif_sayi > 0` olan
   alanlar normal listelenir; `aktif_sayi = 0` olanlar (tümü tamamlanmış/iptal)
   listenin sonunda gri ve "(pasif)" ekiyle gösterilir — gizlenmez, çünkü
   geçmiş görevlere filtreyle ulaşılabilmeli. Görev OLUŞTURMA formunda ise
   pasif alanlar da normal seçilebilir (alan yeniden canlanabilir).
4. **Etiket görünümü:** Görev kartındaki alan etiketi ile öncelik etiketi
   görsel olarak ayrışmalı (ör. alan = gri/çerçeveli, öncelik = renkli dolgulu) —
   kullanıcı ikisini karıştırmasın.
5. **Filtredeki '30/90 Taahhüt' seçeneği** alan üzerinden değil `taahhut=TRUE`
   bayrağı üzerinden filtrelemeli (ayrı bir onay kutusu/anahtar olarak).

## Kabul kriterleri
1. Çekirdek ekip dışı bir kullanıcı /api/gorevler'e 403 alır ve sekmeyi görmez.
2. Sahipsiz veya tarihsiz görev kaydedilemez.
3. Pazartesi görünümü tek istekte 5 bloğu döner ve geciken görev asla gizlenemez.
4. Mevcut modüllerin hiçbirinde regresyon yok (yeni kod izole: yeni tablolar + yeni endpoint'ler).

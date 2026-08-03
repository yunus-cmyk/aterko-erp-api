# Aterko Workspace — Uçtan Uca Akış

**Müşteri tanımından binanın müşteriye teslimine kadar hangi aksiyonda ne oluyor.**
Tarih: 1 Ağustos 2026 · Bu belge canlı koddan çıkarılmıştır.

---

## Bakış: iki faz, bir kayıt

Bir proje hayatı boyunca **tek kayıt** olarak yaşar; yalnız *fazı* değişir:

| Faz | Modül | Ne yapılır |
|---|---|---|
| **SATIS** | Satış | İşin ticareti: müşteri → fırsat → teklif → analiz → şartname → sözleşme |
| **TESLIMAT** | Operasyon | İşin mutfağı: iş emri → üretim → sevkiyat → montaj → teslim |

Geçiş **sözleşme onayında** kendiliğinden olur. Satış tarafı o andan sonra salt okunur arşivdir.

---

## A. SATIŞ FAZI

### 1. Müşteri kartı
**Nerede:** Satış > Müşteriler · **Kim:** `satis.musteri` yazma
Ad, ünvan, vergi bilgileri, iletişim, ilgili kişiler girilir.
→ Müşteri **"Potansiyel"** satış durumuyla doğar.

### 2. Fırsat (proje) açılışı
**Nerede:** Müşteri kartı > "Yeni Proje (Fırsat)" · **Kim:** `satis.proje` yazma
Yalnız müşteri kartından açılır; müşteri alanı salt okunurdur.
→ 5 haneli **proje numarası** verilir (eski sistemin serisi devam eder: 72xxx)
→ Proje `faz=SATIS`, `satis_durumu=TASLAK` doğar
→ **Otomatik:** müşterinin durumu **"Görüşme Yapılmış"** olur

### 3. Teklif oluşturma
**Nerede:** Proje > Teklifler > "Teklif Oluştur" · **Kim:** `satis.teklif` yazma
Teklif yalnız proje içinden açılır (bağımsız "yeni teklif" yoktur).
→ Teklif no: `{proje}-TEK-01`, durum **TASLAK**
→ Müşteri / proje / tarih salt okunurdur — kayıttan gelir

### 4. Teklif bileşenleri (bina tanımı)
**Nerede:** Teklif formu · **Kim:** `satis.teklif` yazma
Her bina bir kalemdir ve **teslimat formunun birebir karşılığı** doldurulur:
Bina Türü (Prefabrik/Konteyner/Hafif Çelik/Yapısal Çelik/Diğer), Bina Tipi, m², adet,
kat adedi/yüksekliği veya konteyner ebadı, duvar kesitleri, bina yeri, **Montaj Gerekli**.
"Diğer" kalemleri (nakliye, hizmet) yalnız ad+miktar+birim+fiyat ister.
→ Opsiyonel işaretli kalemler toplama girmez

### 5. Teknik şartname
**Nerede:** Proje > Teknik Şartnameler · **Kim:** `satis.teklif` yazma
Her bina bileşeni için ayrı şartname; sorular bina türüne göre gelir, bileşen bilgileri
(tip, m², adet, ebat) **otomatik dolu ve kilitli**. Montaj gerekli değilse montaj bölümü hiç görünmez.
→ Cevaplar bileşene kaydedilir, istenirse **PDF** indirilir
→ Liste: doluluk (cevaplanan/toplam), son güncelleme, kilit durumu

### 6. Fiyat analizi (yaşayan analiz)
**Nerede:** Proje > Analiz · **Kim:** satış yetkisi olan herkes (ayrı "analizci" rolü yok)
**a) Öznitelikler:** Form otomatik oluşur; bileşenden gelen alanlar (bina türü, kat, m²,
duvar kesiti, konteyner ölçüleri) dolu ve kilitli gelir; ilgisiz bölümler gizlenir.
Kapsam kutusu işaretlenen bölümler hesaba girer.
**b) "Kaydet ve Dökümü Üret":** malzeme dökümü hesaplanır, o günün fiyatları kilitlenir
→ **Önerilen fiyat** otomatik hesaplanıp kaleme yazılır
**c) Revizyon:** öznitelik değişirse ekran "döküm eski" uyarısı verir; "Dökümü Güncelle" gerekir
→ Analiz zorunlu değildir, teklif akışını engellemez

### 7. Teklif verme ve sonuç
**Nerede:** Teklif penceresi · **Kim:** ver/ret/revize `satis.teklif`, **kabul `satis.teklif_onay` (YÖNETİM)**

| Aksiyon | Sonuç |
|---|---|
| **Teklif Ver** | durum → CEVAP BEKLENEN · proje → "Teklif Sürecinde" · müşteri → "Teklif Sürecinde" |
| **Kabul Et** | durum → ONAYLANAN · projedeki diğer teklifler REVİZE'ye düşer · proje → "Satışı Tamamlanan" |
| **Reddet** | durum → REDDEDİLEN · proje → "Reddedilen" |
| **Revize Et** | yeni teklif kopyası (`-TEK-02`) — analiz verisi de taşınır |

**Kabul kapıları:** opsiyonel kalem kalmamalı **ve tüm bina bileşenlerinin teknik şartnamesi
doldurulmuş olmalı.** Kabul anında şartnameler ve analiz **kilitlenir** (değişiklik için revize gerekir).

### 8. Sözleşme
**Nerede:** Proje > Sözleşme

| Adım | Kim | Ne olur |
|---|---|---|
| **Sözleşme Oluştur** | `satis.teklif` TAM | Onaylı tekliften sözleşme (`{proje}-SOZ-01`); döviz kuru sabitlenir; **teslimatlar (binalar) burada doğar — durumları SÖZLEŞME** |
| **Onaya Gönder** | satış yetkisi | durum → "Sözleşmesi Onayda" |
| **Sözleşmeyi Onayla** | **YÖNETİM** | Sözleşme onaylanır **ve proje aynı anda Operasyon fazına geçer** |
| *(Revize Talep Et)* | YÖNETİM | Sözleşme taslağa döner, düzeltilip yeniden onaylanır |

→ Proje artık `faz=TESLIMAT`, `durum=SÖZLEŞME` — **iş emri açılabilir**
→ Şartname cevapları bileşenden teslimata miras geçer

---

## B. OPERASYON FAZI

### Teslimat (bina) durum zinciri

Her bina kendi yolculuğunu bu durumlarla yapar:

**SÖZLEŞME** (sözleşmeyle doğar) → **İŞ EMRİ** (iş emri oluşturulunca) → **PROJE** (iş emri
yayınlanınca; üretim/tedarik aşaması) → **ÜRETİM** → **MONTAJ** → **TESLİM EDİLDİ**

### 9. Bina listesi (ürün listesi)
**Nerede:** Operasyon > Projeler > proje > teslimat · **Kim:** `projeler` yazma
Binanın malzeme listesi hazırlanır (stok kartından veya özel ürün olarak).
Yayın akışı: **TASLAK → ONAY BEKLİYOR → YAYINDA** (reddedilirse taslağa döner).
→ Her kalem için miktar zinciri başlar: *gerekli → üretilen → sevk edilen → uygulanan → teslim edilen*

### 10. İş emri
**Nerede:** Teslimat > İş Emri · **Kim:** `projeler` yazma

| Aksiyon | Sonuç |
|---|---|
| **Oluştur** | `{proje}-İE-NN` · durum HAZIRLANDI · şartname o an **dondurulur** (belge bütünlüğü) · teslimat → "İŞ EMRİ" |
| **Yayınla** | durum YAYINLANDI · **PDF üretilir ve ilgililere e-posta gider** · teslimat → "PROJE" |
| **İptal / Sil** | teslimat "SÖZLEŞME"ye döner (yalnız taslak silinebilir) |

→ İş emri açık teslimatın bina bilgileri ve şartnamesi kilitlenir

### 11. Üretim
**Nerede:** Operasyon > Üretim · **Kim:** `uretim` yazma
Ekran, bina listesindeki kalemleri "gerekli / stokta / üretilen / eksik" olarak gösterir. Üç yol:

| Aksiyon | Sonuç |
|---|---|
| **İş Emri Oluştur** | Üretim iş emri açılır, kalemler ekibe atanır |
| **Tamamlandı işle** | `uretilen_miktar` artar → bina listesindeki ilerleme yükselir |
| **Stoktan Karşıla** | Depodaki mevcut stok bu binaya ayrılır (`stoktan_ayrilan_miktar`) |
| **Satınalma Talebi** | Eksik malzeme için talep açılır → Satınalma zinciri başlar |

### 12. Sevkiyat
**Nerede:** Operasyon > Sevkiyat · **Kim:** `sevkiyat` yazma
Sevke hazır kalemlerden **sevkiyat belgesi** oluşturulur (bir bina birkaç sevkiyatta gidebilir).
Durum: **HAZIRLANIYOR → YOLDA → TESLİM**
→ "TESLİM" işaretlendiğinde: `sevk_edilen_miktar` artar, **stoktan düşülür**
→ Montaj gerekmiyorsa bu adım müşteriye teslim demektir

### 13. Montaj
**Nerede:** Operasyon > Montaj · **Kim:** `montaj` yazma
Yalnız **Montaj Gerekli** işaretli binalar için. Saha ekibi uyguladığı kalemleri işler.
→ `uygulanan_miktar` artar — mantığı üretimle aynıdır (kalem kalem ilerler)

### 14. Müşteriye teslim
**Nerede:** Montaj > "Müşteriye Teslim" · **Kim:** `montaj` yazma
Binanın kalemleri teslim edilmiş sayılır (`teslim_edilen_miktar`), montaj hareketi kaydedilir.
→ Teslimat durumu **"TESLİM EDİLDİ"** olur — yolculuk tamamlanır

---

## C. Yan zincirler

**Satınalma:** Talep → Teklif Havuzu → Sipariş → Mal Kabul → **stoğa giriş**.
Üretimden doğan talepler bu zincire düşer; mal kabul stok miktarını artırır.

**Mali İşler:** Sözleşme ve satınalma tutarları cari hesaplara işlenir; tahsilat/ödeme ve
nakit akışı burada izlenir. **Not:** tahsilat artık projenin fazını belirlemez (2026-07-30 kararı).

**Görev Takip:** Çekirdek ekibin haftalık görev/taahhüt takibi (sağ üstteki simge).

---

## D. Otomatik tetikler (kimse elle yapmaz)

| Olay | Otomatik sonuç |
|---|---|
| Proje açılır | Müşteri → "Görüşme Yapılmış" |
| Teklif verilir | Proje → "Teklif Sürecinde", müşteri → "Teklif Sürecinde" |
| Teklif kabul edilir | Diğer teklifler REVİZE, şartname + analiz kilitlenir |
| Sözleşme oluşturulur | **Teslimatlar (binalar) türetilir**, kur sabitlenir |
| Sözleşme onaylanır | **Proje Operasyon fazına geçer** (durum SÖZLEŞME) |
| İş emri oluşturulur | Şartname dondurulur |
| İş emri yayınlanır | PDF + e-posta gider |
| Üretim/sevkiyat/montaj işlenir | İlerleme miktarları ve aşama damgaları güncellenir |
| Sevkiyat "TESLİM" olur | Stoktan düşülür |

## E. Kilitler (veri bütünlüğü)

- **Teklif ONAYLANAN** → şartname ve analiz salt okunur (revize açar)
- **İş emri açık** → teslimatın bina bilgileri ve şartnamesi değiştirilemez
- **Proje SÖZLEŞME (Operasyon)** → şartname kilitli; düzeltme için ADMIN onayı geri alabilir (aktif iş emri yoksa)
- **Faz TESLIMAT** → satış tarafında yeni teklif/revize açılamaz (arşiv)

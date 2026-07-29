# Analiz Ekranı Eksik Tespiti — Eski Sistem ↔ Workspace

**Tarih:** 29 Temmuz 2026
**Amaç:** Ekip (Ayşe Bilgin, Abdulkadir Hallı) fiyat analizini hâlâ eski sistemde yapıyor. Kesme tarihinin ön koşulu, Workspace analiz ekranının eskisinin yerini tam tutması. Bu belge eksikleri üç kaynaktan tespit eder: ekibin **fiilen yaptığı iş** (denetim kayıtları), eski ekranın **tüm düğme/alan dökümü** (arayüz paketi + çözülmüş Java kaynağı) ve bizim ekranın mevcut hali.

---

## 1. Ekibin gerçekte yaptığı iş (son 7 gün, eski sistem)

| Kişi | İşlem | Adet | Anlamı |
|---|---|---|---|
| Ayşe | Öznitelik girişi | 1.873 | form doldurma |
| Ayşe | Bölüm ekleme | 1.014 | tekrarlı bölüm (Duvar 2, Pencere 3…) |
| Ayşe | Fiyat kilidi | 1.164 | "Ürün & Hizmetleri Oluştur" çalıştırma |
| Ayşe | Döküm satırı düzenleme | 426 | ızgarada elle düzeltme |
| Abdulkadir | Fiyat kilidi | 954 | |
| Abdulkadir | Öznitelik girişi | 861 | |
| Abdulkadir | Döküm satırı düzenleme | 466 | |

Doğrulama: son 30 günde analiz **yalnız teklif kalemlerine** yapılmış (iş emri/teslimat analizi sıfır) → bizim ekranın kapsamı doğru.

---

## 2. EKRAN EKSİKLERİ — eski ekranda olup bizde olmayanlar

### E1. Analiz PDF raporu — **en büyük eksik**
Eski ekranda **"Generate Pdf"** düğmesi: kalemin analizini rapor olarak basar (`ComponentAnalysisPdfExtServiceImpl`). İçeriği:
- Fiyatlar **ana ürün kategorisine göre gruplu** (Duvar, Çatı, Elektrik…)
- **Montaj kalemleri ayrı bölüm**
- Doldurulan **öznitelik listesi** (seçimlerle birlikte)
- Teklif + proje başlık bilgileri

Bizde döküm yalnız ekranda; yazdırılabilir çıktı yok. Analistin işini satışa/yönetime sunma aracı bu rapor.

### E2. Excel dökümü
Eski ekranda **"Generate Csv"**: döküm ızgarasını **XLSX** indirir (gerçekte Excel; toplam maliyet/satış hesaplı, kategori süzgeçli). Bizde hiçbir dışa aktarma yok.

### E3. "Fiyatları tekrar hesapla" düğmesi
Eskide **ayrı uç** (`calculate-and-save-prices`): döküm satırlarına ve elle düzeltmelere **dokunmadan**, yalnız fiyat kilitlerini bugünkü fiyatlarla tazeler ve yeni fiyat turu (`price_set`) açar. Bizde fiyat tazeleme "Dökümü Üret"in içinde — o ise satır eşleştirmesini de yeniden yapar. Ekip bunları ayrı işler olarak kullanıyor (fiyat kilidi 2.100+/hafta).

### E4. Dökümde kategori gruplama / süzgeç
Bizim döküm tablosu **düz liste**. Eski ekranda kategori süzgeci var (Excel ucu da kategoriye göre süzüyor), PDF kategori gruplu. Ortalama döküm 50-150 satır — düz listede Duvar/Çatı/Elektrik kalemlerini ayırt etmek zor. Kayıtta bölüm bilgisi zaten duruyor (`sat_analiz_bolumler` bağı), yalnız ekranda kullanılmıyor.

### E5. Satır notu ve sıra düzenleme
Eski ızgara sütunları: Miktar, **Not**, **Sıra No** — üçü de düzenlenebilir. Bizde yalnız miktar düzenlenebiliyor; not salt gösterim, sıra hiç yok. Haftalık ~900 satır düzenlemesinin bir kısmı not/sıra.

### Elenenler (eksik DEĞİL)
- **Kilitli fiyatı elle düzeltme** (`editedByUser`): eski veride 886 kayıt, tamamı yıllar önce; son 90 günde **sıfır** kullanım → yapılmasına gerek yok.
- **"Analiz türü seçiniz"** etiketi: çeviri dosyasında var ama ekranda kullanılmıyor (ölü özellik).
- Bizde **zaten var olanlar**: analiz iş kuyruğu (rozetli sekme + durum süzgeci), elle ürün ekleme, öznitelik kopyalama, tekrarlı bölüm ekle/sil, ipucu gösterimi, salt-okunur/zorunlu alanlar, önerilen fiyat mesajı, analiz talep/tamamla akışı, döküm önizleme sayısı, "Bugünkü Satış" fark sütunu (eskide bu bile yok).
- Eski üretim süresi ~20 saniyeydi (uyarı yazısı vardı); bizim motor saniyeler içinde.

---

## 3. VERİ EKSİĞİ — ekranın değil arşivin sorunu (kısır döngü)

Workspace'in analiz arşivi **26 Temmuz yedeğinde donmuş**. O günden beri ekip eskiye yazmaya devam etti:

| 26 Temmuz sonrası eskide oluşan | Adet |
|---|---|
| Öznitelik değeri | 702 |
| Form bölümü | 353 |
| Döküm satırı | 64 |
| Fiyat kilidi | 224 |

Özellikle: dün aktardığımız **72902-TEK-01** kaleminin analizi eskide **sürüyor** (156 öznitelik + 49 döküm satırı yalnız eskide). Ekip bizim ekranı açsa "analiz boş/eksik" görür — ekran eksik olduğu için değil, **veri orada olmadığı için**. Bu kısır döngü kesme tarihine kadar ancak fark aktarımıyla yönetilir: dünkü betiğin analiz verilerini de kapsayan bir sürümü periyodik çalıştırılmalı.

---

## 4. Önerilen iş sırası

| # | İş | Etki | Boyut |
|---|---|---|---|
| 1 | **Fark aktarımı genişletmesi**: 26 Temmuz sonrası öznitelik/bölüm/döküm/fiyat kilitlerini taşı (idempotent, tekrar çalıştırılabilir) | Ekranın "boş" görünmesi biter | Orta |
| 2 | **E1 Analiz PDF** (kategori gruplu; mevcut puppeteer altyapısıyla) | Analistin çıktı aracı | Orta |
| 3 | **E3 Fiyatları tekrar hesapla** düğmesi | Günlük işin ayrı adımı | Küçük |
| 4 | **E4 kategori gruplama** (döküm tablosunda bölüm başlıkları + süzgeç) | Kullanılabilirlik | Küçük |
| 5 | **E5 not + sıra düzenleme** | Izgara eşitliği | Küçük |
| 6 | **E2 Excel dökümü** | Çıktı eşitliği | Küçük |

Sonrası: ekipten sözlü doğrulama (aşağıdaki liste), bir hafta paralel kullanım, kesme tarihi.

---

## 5. Ayşe & Abdulkadir'e gösterilecek doğrulama listesi

Tespitler koddan; ekipten yalnız şunu doğrulamak yeterli:
1. Analiz PDF'ini kime/ne için veriyorsunuz? (müşteri mi, iç kullanım mı)
2. Excel dökümünü ne için indiriyorsunuz? (satınalmaya mı, kontrol mü)
3. "Fiyatları tekrar hesapla"yı hangi durumda kullanıyorsunuz? (revize mi, eski analiz tazeleme mi)
4. Izgarada not/sıra alanlarını gerçekten kullanıyor musunuz?
5. Bu listede olmayan, günlük kullandığınız başka bir şey var mı?

---

*Tespitler: son 7-30 günlük denetim kayıtları (jhi_entity_audit_event), eski arayüz paketi (main.bundle), çözülmüş Java kaynakları (ComponentAnalysisPdfExtServiceImpl, ComponentProductGenerateCsvServiceImpl) ve Workspace kodunun karşılaştırmasıyla yapıldı. Hiçbir veri değiştirilmedi.*

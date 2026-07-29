# Eski Sistem (aset.aterko.com) ↔ Aterko Workspace — Derinlemesine Veri Analizi

**Tarih:** 28 Temmuz 2026
**Kapsam:** Eski sistemin 90 tablosu / 711 alanı ile yeni sistemin 58 tablosu / 696 alanının tamamı
**Yöntem:** Her iki veritabanının şeması, satır sayıları, yabancı anahtarları (eski 108, yeni 50) ve örnek verileri canlı olarak okundu; eski sistemin arayüz paketi ve çözümlenmiş Java kaynakları ile karşılaştırıldı. **Hiçbir veri değiştirilmedi, yalnız okundu.**

---

## 1. Yönetici Özeti — Önce Bunlar

### 1.1 En kritik bulgu: Eski sistem HÂLÂ AKTİF KULLANIMDA

Bu, entegrasyon kararını doğrudan değiştiren bulgudur. Analiz sırasında ölçüldü:

| Ölçüm | Sonuç |
|---|---|
| Son 30 günde eski sistemde işlem | **190.000+ kayıt hareketi** |
| Bugün (28.07.2026) son işlem saati | **13:23** — Ayşe Bilgin |
| 26 Temmuz'daki yedek sonrası açılan yeni teklif | **3 adet** (32301, 32302, 32303) |
| 26 Temmuz sonrası açılan yeni proje | **3 adet** (72901, 72902, 72903) |
| 26 Temmuz sonrası müşteri güncellemesi | 19 |
| Yalnız eski sistemde olup Workspace'te olmayan proje | **72902, 72903** |

Son 30 günde kim ne yapıyor:

| Kullanıcı | Ağırlıklı işi | Hacim |
|---|---|---|
| Ayşe Bilgin | Fiyat analizi + teklif + müşteri + proje | 37.662 |
| Abdulkadir Hallı | Fiyat analizi (öznitelik/ürün fiyatı) | 19.760 |
| Varol Aytekin | Fiyat/maliyet güncelleme | 2.728 |
| Mahmut Akdağcık | Teklif + müşteri | 1.362 |
| Tahir Şahin | Fiyat | 144 |

**Anlamı:** Satış ve özellikle **fiyat analizi işi hâlâ eski sistemde yapılıyor.** Yani bu bir "eski arşivi taşıyalım" işi değil, **iki canlı sistemin ayrışması** meselesi. Her geçen gün iki veri kümesi birbirinden uzaklaşıyor. Entegrasyonun ilk kararı teknik değil operasyonel olmalı: *hangi iş hangi sistemde yapılacak?*

### 1.2 İyi haber: Bağlantı omurgası zaten kurulu

Eşleştirme için gereken anahtarların neredeyse tamamı **zaten yerinde**:

| Varlık | Yeni sistemdeki kayıt | Eski kimlik taşıyan | Kapsama |
|---|---|---|---|
| Proje | 4.249 | `proje_kodu` = eski `project.id` | **4.247 / 4.249 (%99,95)** |
| Müşteri | 2.364 | `sat_musteriler.eski_id` | 2.290 (kalan 74'ü Workspace'te açılmış yeni müşteri) |
| Müşteri kişisi | 2.092 | `eski_id` | 2.092 (%100) |
| Teklif | 5.608 | `eski_id` + `eski_proje_id` | 5.607 (%99,98) |
| Teklif kalemi | 17.424 | `eski_id` | 17.424 (%100) |
| Sözleşme | 727 | `eski_id` | 727 (%100) |
| Ürün | 5.936 | `eski_id` | 5.936 (%100) |
| Ürün ağacı | 10.282 | `eski_id` | 10.282 (%100) |
| Analiz verisi | 1,5 milyon satır | `eski_id` + `eski_entity_id` | ~%100 |

**Yani bağlantı kurma sorunu %90 çözülmüş durumda.** Eksik olan, henüz hiç taşınmamış veri kümelerini bu omurgaya bağlamak.

### 1.3 Rakamla durum

| | Tablo | Satır |
|---|---|---|
| Eski sistem toplam | 90 | ~9,5 milyon |
| → Zaten aktarılmış | **37** | 1.574.578 |
| → **Aktarılmamış (gerçek konu)** | **38** | **273.552** |
| → Önemsiz (JHipster altyapısı, yedek, boş) | 15 | 7.611.892 |
| Yeni sistem toplam | 58 | ~1,6 milyon |
| → Eskide karşılığı olmayan yeni modüller | 33 | — |

---

## 2. Bağlantı Anahtarları Haritası

Entegrasyonun temeli budur. Aşağıdaki anahtarlar **bugün mevcut ve çalışır durumda**:

| # | Bağlantı | Nasıl | Güvenilirlik |
|---|---|---|---|
| **K1** | Proje | `projeler.proje_kodu::int = project.id` | **Kesin.** Eski sistemde proje numarası zaten birincil anahtar (72800, 72901...). 4.247 eşleşme, 0 çakışma. |
| **K2** | Müşteri | `sat_musteriler.eski_id = customer.id` | **Kesin.** Aktarımda yazılmış. |
| **K3** | Teklif | `sat_teklifler.eski_id = proposal.id` | **Kesin.** Ayrıca `eski_proje_id` ikinci yol. |
| **K4** | Teklif kalemi | `sat_teklif_kalemleri.eski_id = proposal_component.id` | **Kesin.** Analiz verisi bu anahtarla bağlı. |
| **K5** | Ürün | `sat_urunler.eski_id = product.id` | **Kesin.** |
| **K6** | Kişi | `sat_musteri_kisiler.eski_id = person.id` | **Kesin.** |
| **K7** | Sözleşme | `sat_sozlesmeler.eski_id = contract.id` | **Kesin.** |
| **K8** | Kullanıcı | e-posta (`jhi_user.email = kullanicilar.email`) | **Yüksek.** 13 kişi eşleşiyor; eski `varol`, `mahmut`, `tahir`, `yunus` kısa kullanıcı adları da var, elle karşılığı çıkarıldı. |
| **K9** | Belge kodu | `72778-TES-04`, `72778-ISE-04` ↔ `72779-İE-01` | **Orta.** Aynı desen, farklı kısaltma (ISE/İE). Kod ayrıştırılarak proje + sıra elde edilebilir. |
| **K10** | Cari ↔ Satış müşterisi | `musteriler.sat_musteri_id` | **Kesin.** Mali İşler modülünde zaten kullanılan yöntem — yeni bağlar için **örnek alınacak desen budur.** |
| **K11** | Bina/bileşen | `project_component` ↔ `proje_teslimatlari`: proje + ad + m² üçlüsü | **Düşük-orta.** Kimlik alanı yok; eşleştirme için `eski_id` kolonu eklenmeli (bkz. Yöntem-2). |
| **K12** | Malzeme ↔ Stok kartı | ad benzerliği | **Çok düşük (%1,8).** Daha önce ölçüldü, elle eşleme gerekiyor. Bu analizin kapsamı dışında, ayrı iş. |

---

## 3. Bölüm A — Zaten Aktarılmış 37 Tablo

Bunlar için yapılacak bir şey yok; yalnız **ayrışma riski** var (bkz. Bölüm 6).

| Eski tablo | Satır | Yeni karşılığı | Not |
|---|---|---|---|
| `customer` | 2.291 | `sat_musteriler` | +74 Workspace'te doğmuş müşteri |
| `person` | 2.093 | `sat_musteri_kisiler` | |
| `proposal` | 5.610 | `sat_teklifler` | 3 teklif yalnız eskide |
| `proposal_component` | 17.427 | `sat_teklif_kalemleri` | |
| `contract` | 727 | `sat_sozlesmeler` | döviz kuru dahil taşınmış |
| `project` | 4.249 | `projeler` | 2 proje yalnız eskide |
| `project_code_sequence` | 5.921 | `sat_kod_sirasi` | 4.935 satır; teklif+sözleşme sayaçları |
| `product` / `product_category` / `product_bom` / `product_price` | 5.936 / 70 / 10.282 / 1.994 | `sat_urunler` / `sat_urun_kategoriler` / `sat_urun_bom` / `sat_urun_fiyatlar` | |
| `attribute` | 849.567 | `sat_analiz_degerler` | |
| `attribute_category` | 408.839 | `sat_analiz_bolumler` | |
| `component_product` | 257.871 | `sat_analiz_urunler` | |
| `attribute_type` / `attribute_choice` | 201 / 808 | `sat_parametreler` / `sat_parametre_secenekler` | |
| `comment` | 227 | `sat_yorumlar` | |
| `proposal_term` | 206 | `sat_metinler` | |
| `component_type` (39) + `component_category` (6) | 45 | `sat_referanslar` (`bilesen_turu`, kategori=`ust_kod`) | bugün büyüklük birimi de eklendi |
| `unit_type` (16) | | `sat_referanslar.birim` + kod içindeki sembol tablosu | |
| `customer_type`, `business_type`, `how_did_you_hear_us`, `technical_spec_type`, `point_of_sales`, `sales_type`, `project_type` | 47 | `sat_referanslar` | |
| `customer_status` / `proposal_status` / `proposal_component_status` | 12 | metin durum alanları | |
| `jhi_user` / `jhi_authority` / `jhi_user_authority` | 129 | `kullanicilar` / `roller` / `rol_izinleri` / `kullanici_rolleri` | rol karşılıkları çıkarıldı |
| `currency` / `product_class` | 6 | metin alanlar (`para_birimi`, `sinif`) | |

---

## 4. Bölüm B — Aktarılmamış 38 Tablo (273.552 satır) — **Asıl Konu**

Öncelik sırasına göre, her biri için *ne olduğu, yeni sistemdeki karşılığı ve bağlama yöntemi*.

### ÖNCELİK 1 — Teslimat / Üretim zinciri (kavramsal olarak Workspace'te var, veri yok)

| Eski tablo | Satır | Ne | Yeni karşılık | Durum |
|---|---|---|---|---|
| `project_component` | **3.770** | Projedeki binalar (ad, adet, m², bileşen türü). Teklif kaleminden kopyalanır (`proposal_component_id_copied_from`!) | `proje_teslimatlari` (938) | **1.664 projede bina dökümü var, bizde yalnız 457.** En büyük veri boşluğu. |
| `deliverable` | **3.738** | Teslimat kalemi, kod: `72778-TES-04`, 12 durumlu | doğrudan yok — `proje_teslimatlari.durum` | 3.595'i "İş emri hazırlık sürecinde" |
| `work_order` | **3.717** | İş emri, kod `72778-ISE-04`, teslimata bağlı | `is_emirleri` (9) | 485 projede iş emri var; bizde 9 |
| `work_order_item` | **19.286** | İş emri satırları (ürün kategorisi + uygulayıcı) | `is_emirleri.form_snapshot` | yapı farklı: bizde JSON, eskide satır |
| `deliverable_status` / `work_order_status` | 12+12 | 12 aşamalı durum zinciri | metin durumlar | **birebir eşleştirme listesi çıkarılmalı** |
| `task` + `task_type` + `task_category` + `task_assignee` | 2.583 | İş emri altındaki üretim görevleri | yok | `yonetim_gorevleri` FARKLI kavram (yönetim taahhüdü) |

**Bağlama yöntemi:** `project_component` → `proje_teslimatlari` aktarımı K1 (proje kodu) üzerinden yapılır. `proje_teslimatlari`'na **`eski_id` kolonu eklenmeli** — bugün yok; eklenirse iş emri/teslimat zinciri de aynı anahtarla bağlanır. Ayrıca eskideki `proposal_component_id_copied_from` alanı, teslimatı doğrudan **teklif kalemine** bağlıyor: bizde bu bağ hiç yok ama K4 sayesinde tek adımda kurulabilir → *"bu bina hangi teklif kaleminden doğdu"* sorusu cevaplanabilir hâle gelir.

### ÖNCELİK 2 — Fiyat analizi geçmişi

| Eski tablo | Satır | Ne | Yeni karşılık |
|---|---|---|---|
| `component_product_price` | **197.169** | Analiz kalemlerinin her hesaplamadaki maliyet/satış fiyatı (2021-05 → **28.07.2026, bugün hâlâ yazılıyor**) | yok |
| `component_product_price_set` | 3.354 | Hesaplama turu (hangi varlık, ne zaman hesaplandı) | yok |

Yeni sistemde `sat_analiz_urunler` yalnız **son kilitlenmiş** değerleri tutuyor (`kilit_maliyet`, `kilit_satis`, `kilit_tarihi`). Yani *"bu teklifin maliyeti 2024'te neydi, 2026'da ne oldu"* sorusunun cevabı yalnız eski sistemde.

**Bağlama yöntemi:** `component_product_price.component_product_id` → `sat_analiz_urunler.eski_id` (K anahtarı hazır). Yeni bir `sat_analiz_fiyat_gecmisi` tablosu ile 1:1 taşınabilir; ekranda "fiyat geçmişi" sekmesi olarak açılır.

### ÖNCELİK 3 — Dosyalar

| Eski tablo | Satır | Ne |
|---|---|---|
| `my_file` | **1.205** | Projeye/müşteriye bağlı belgeler. Fiziksel yer: **AWS S3 — `aset-storage.aterko.com`**, dosya adı UUID |
| `my_file_type` | 16 | Teknik/İdari şartname, Sözleşme, Teklif, Fotoğraf, Video, Mimari/Statik/Elektrik/Mekanik/İmalat Projesi, Montaj Planı, Temel Planı, İş Emri, Proje Talep Formu, Diğer |
| `my_file_type_permission` | 130 | Hangi rol hangi belge türünü görür |

Dağılım: 1.076 proje belgesi, 79 kontrol listesi belgesi, 37 müşteri belgesi.
Yeni sistemde `proje_dosyalari` var ama yalnız **20 kayıt** (Supabase Storage).

**Bağlama yöntemi:** `my_file.entity_name='project' AND entity_id` → K1 ile `projeler.id`. Dosyaların kendisi S3'ten indirilip Supabase Storage'a yüklenir, `proje_dosyalari`'na `eski_id` + `tur` (my_file_type adı) ile yazılır. **AWS kapatılacaksa bu iş kapatmadan ÖNCE yapılmak zorunda.**

### ÖNCELİK 4 — Kur tablosu (aktif bir hata düzeltir)

`exchange_rate` — 2.172 satır TCMB kuru (USD ve EUR, 2020-01-09 → 2024-06-27; besleme 2024'te durmuş).

Workspace'te sözleşme oluştururken `mali_kurlar` diye **var olmayan bir tablo** sorgulanıyor; hata sessizce yutulup **kur = 1** kabul ediliyor. Sonuç: Workspace'te açılan dövizli bir sözleşmede TL karşılıkları yanlış hesaplanır. (Eskiden taşınan 91 USD + 33 EUR sözleşmenin kurları doğru — onlar eski sistemden geldi.)

**Bağlama yöntemi:** Ya `mali_kurlar` tablosu oluşturulup TCMB'den güncel besleme kurulur, ya da `sistem_ayarlari`'ndaki mevcut `mali_kurlar` ayarı kullanılacak şekilde kod düzeltilir. Eski 2.172 satır geçmiş kur olarak taşınabilir (raporlama için değerli). **Bu, tek başına ele alınabilecek küçük ve net bir düzeltme.**

### ÖNCELİK 5 — Kontrol listeleri (proje ilerleme takibi)

| Eski tablo | Satır | Ne |
|---|---|---|
| `project_check_item_def` | 18.952 | Kontrol maddesi tanımları |
| `project_check_item` | 8.858 | Gerçekleşen kontroller (**3.446 tamamlanmış**, 5.412 açık) |
| `project_check_list_def` | 236 | Liste tanımı + projedeki ağırlık (`weight_in_project`) |
| `project_check_list` | 231 | 53 projede uygulanmış |
| `project_check_item_type` | 103 | Madde türleri, proje fazına bağlı |

Eski sistemin `project.completion_rate` (proje tamamlanma yüzdesi) alanı buradan hesaplanıyordu. Workspace'te bu kavramın karşılığı **hiç yok**.

**Bağlama yöntemi:** K1 üzerinden proje bazlı. Ancak yalnız 53 projede kullanılmış — **önce "bu özelliği istiyor muyuz" kararı verilmeli**, veri taşımak ikinci mesele. Kararın kendisi bir iş kararı: proje ilerleme yüzdesi Workspace'te takip edilecek mi?

### ÖNCELİK 6 — Bütçe / gider (küçük ama kavramsal boşluk)

| Eski tablo | Satır | Ne |
|---|---|---|
| `expense_type` | 68 | Gider türleri (ürün kategorisine bağlanabilir) |
| `expense_category` | 15 | Gider grupları |
| `budget` / `budget_item` | 2 / 23 | Proje bütçesi (2021'de 2 projede denenmiş, bırakılmış) |
| `financial_analysis` | 2 | 2019-2020 yıllık işletme gideri + satış hedefi |

Mali İşler modülümüz `cari_hareketler` üzerine kurulu — **tamamen farklı bir model** (cari/nakit akış). Bütçe verisi pratikte kullanılmamış.

**Öneri:** Veri taşınmasın. **Yalnız `expense_type` + `expense_category` listesi (83 satır) referans olarak alınsın** — ileride proje maliyet takibi yapılacaksa hazır bir gider ağacı olur.

### ÖNCELİK 7 — Coğrafya ve küçük referanslar

| Eski tablo | Satır | Yeni durum |
|---|---|---|
| `city` | 3.853 | serbest metin `sehir` |
| `country` | 249 | serbest metin `ulke` |
| `sehirler_eslesmis` | 3.731 | eski sistemde de bir eşleştirme tablosu tutulmuş |
| `customer_rep` | 16 | `temsilci_email` |
| `price_type` (Alış/Satış), `comment_type` (4), `project_status` (16), `project_phase` (8), `my_month`, `attribute_data_type`, `attribute_field_type`, `configg` | ~50 | kısmen metin, kısmen kodda sabit |

`configg` özel: **öznitelik ekranı kuralları** JSON olarak burada duruyor (örn. "Bina Türü = Prefabrik seçilirse şu ürün kategorilerini gizle"). Bunun Workspace'teki karşılığı `sat_form_kurallari` (30 kayıt) — **kısmen taşınmış, tam örtüşme kontrol edilmeli.**

`project_status`'ün 16 durumu ile bizim `projeler.durum` değerlerimizin birebir eşleştirme listesi çıkarılmalı (Taslak, Teklif Sürecinde, Analiz sürecinde, Sözleşmesi imzalanan, Avans ödemesi alınan...).

### Önemsiz 15 tablo
`jhi_entity_audit_event` (7,5 milyon — eski sistemin denetim günlüğü), `jhi_persistent_audit_*`, `databasechangelog*`, `dummy`, `language`, `print_template*`, `*_lng` (çeviri), `product_category_test`, `product_price_2025_08_02` (yedek).

> **Not:** 7,5 milyonluk denetim günlüğü taşınmamalı ama **silinmemeli de** — "bu kaydı kim ne zaman değiştirdi" sorusunun tek cevabı orada. Salt-okunur arşiv olarak saklanmalı (bkz. Yöntem-4).

---

## 5. Bölüm C — Yeni Sistemde Olup Eskide Olmayanlar

Bunlar Workspace'in eski sisteme göre **kazancı**; eskiden beslenebilecek olanları işaretledim.

| Yeni modül | Tablolar | Eskide karşılığı | Eski veri besleyebilir mi? |
|---|---|---|---|
| **Stok** | `stok_kartlari` (1.407), `stok_hareketleri` (21.091), `depolar` | yok | Malzeme↔stok eşleştirmesi (ayrı iş, %1,8 otomatik) |
| **Satınalma** | `satinalma_talepleri` (262), `talep_urunleri` (552), `teklif_kayitlari`, `satinalma_siparisleri` (152), `siparis_kalemleri` (278), `tedarikciler` (491), `mal_kabul_loglari` | yok | Hayır |
| **Sevkiyat / Montaj / Üretim** | `sevkiyat_belgeleri`, `sevkiyat_kalemleri`, `montaj_hareketleri`, `uretim_is_emirleri` | `deliverable` + `work_order` **kısmen** | **Evet** — Öncelik 1 |
| **Mali İşler** | `cari_hareketler` (74), `musteriler` (110) | `budget`, `financial_analysis` (kullanılmamış) | Sınırlı |
| **Görev Takip** | `yonetim_gorevleri` (26), `gorev_notlari` | `task` FARKLI kavram | Hayır |
| **İş Emri (yeni)** | `is_emirleri` (9), `is_emri_notlari`, `urun_listesi_versiyonlari` | `work_order` (3.717) | **Evet** — Öncelik 1 |
| **Teknik Şartname** | `teknik_sartname_sablonu` (323) | `technical_spec_type` yalnız tür listesi | Kısmen |
| **Bina/Teslimat** | `proje_teslimatlari` (938), `teslimat_urunleri` | `project_component` (3.770) | **Evet** — Öncelik 1 |
| **Yetki/Bildirim/Denetim** | `roller`, `rol_izinleri`, `kullanici_rolleri`, `bildirimler`, `bildirim_kurallari`, `audit_log`, `sistem_ayarlari`, `form_tanimlari` | JHipster authority + audit | Aktarıldı / gerekmiyor |

---

## 6. Ayrışma Riski — Sayılarla

Aktarım 26 Temmuz'da alındı. İki gün içinde oluşan fark:

| Ne | Eski sistemde | Workspace'te | Sonuç |
|---|---|---|---|
| Yeni teklif | 3 | — | Workspace'te **yok** |
| Yeni proje | 3 (72901, 72902, 72903) | 1 (72901 elle girilmiş) | 2 proje eksik |
| Müşteri güncellemesi | 19 | — | Bilgiler eskide daha güncel |
| Analiz/fiyat hareketi | 3.000+ | — | Fiyat analizi **tamamen** eskide |

Bu hız devam ederse **ayda ~45 teklif, ~45 proje ve binlerce fiyat hareketi** iki sistem arasında ayrışır. Entegrasyon yöntemi seçilirken asıl belirleyici bu.

---

## 7. Entegrasyon Yöntemleri — 4 Seçenek

### Yöntem 1 — Kesme Tarihi + Tek Seferlik Tam Aktarım *(en temiz)*
Bir tarih belirlenir; o tarihten sonra **eski sisteme hiç kimse yazmaz**, yalnız okur. Aktarılmamış 38 tablodan kararlaştırılanlar tek seferde taşınır, eski sistem salt-okunur arşive döner.

- **Artı:** Ayrışma biter, tek doğru kaynak olur, AWS maliyeti kalkar.
- **Eksi:** Fiyat analizi ekranı Workspace'te eskisinin yerini **tam** tutmalı; tutmuyorsa iş durur.
- **Ön koşul:** Ayşe Bilgin ve Abdulkadir Hallı'nın günlük işi Workspace'te eksiksiz yapılabiliyor olmalı. **Bugün için en riskli nokta budur.**

### Yöntem 2 — `eski_id` Genişletmesi + Kademeli Aktarım *(önerilen ilk adım)*
Yeni tablolara eksik olan `eski_id` kolonları eklenir (`proje_teslimatlari`, `is_emirleri`, `proje_dosyalari`). Sonra her veri kümesi **tek tek**, kendi başına taşınır: önce dosyalar, sonra bina dökümü, sonra fiyat geçmişi.

- **Artı:** Her adım bağımsız, geri alınabilir, risk küçük parçalara bölünür. Zaten kurulu olan anahtar mimarisini sürdürür (K10 deseni).
- **Eksi:** Ayrışmayı tek başına çözmez — Yöntem 1 veya 3 ile birlikte anlamlı.

### Yöntem 3 — Tek Yönlü Köprü (eski → yeni, gecelik)
Eski sistem yazmaya devam eder; gece bir iş, `jhi_entity_audit_event` üzerinden değişenleri okuyup Workspace'e yazar (`eski_id` anahtarlarıyla upsert).

- **Artı:** Kimsenin alışkanlığı değişmez, ayrışma birikmez.
- **Eksi:** Kalıcı bakım yükü; **Workspace'te yapılan değişiklik eskiye gitmez** → çift yönlü düzenleme yapılan alanlarda (müşteri, teklif) çakışma kaçınılmaz. Yalnız *geçiş dönemi* için, süresi baştan belirlenerek kullanılmalı.

### Yöntem 4 — Salt-Okunur Arşiv
Eski veritabanı ucuz bir yerde (veya Supabase'de ayrı bir şema olarak) dondurulur; Workspace'ten "eski sistemde göster" bağlantısıyla erişilir.

- **Artı:** 7,5 milyonluk denetim günlüğü ve taşınmayacak veriler için **doğru cevap budur.** Ucuz.
- **Eksi:** Tek başına entegrasyon değil, tamamlayıcı.

### Önerim
**Yöntem 2 + Yöntem 1, arada kısa süreli Yöntem 3, sonunda Yöntem 4.**

1. Şimdi: `eski_id` kolonları + dosyalar + kur düzeltmesi (düşük risk, hemen değer).
2. Paralel: fiyat analizi ekranı Workspace'te eskisiyle **birebir** kullanılabilir hâle getirilir — asıl darboğaz bu.
3. O tamamlanınca: kesme tarihi ilan edilir, kalan veri taşınır.
4. Geçiş haftasında gecelik köprü (Yöntem 3) emniyet kemeri olarak açılır, sonra kapatılır.
5. Eski veritabanı salt-okunur arşive alınır, AWS kapatılır.

---

## 8. Somut İlk Adımlar (sıralı, her biri bağımsız)

| # | İş | Etki | Zorluk |
|---|---|---|---|
| 1 | **Eksik 2 proje + 3 teklif** eski sistemden Workspace'e alınsın (72902, 72903) | Ayrışma bugün sıfırlanır | Çok küçük |
| 2 | **Kur tablosu** düzeltmesi (`mali_kurlar`) + eski 2.172 kurun taşınması | Dövizli sözleşmelerdeki hesap hatası biter | Küçük |
| 3 | `proje_teslimatlari`, `is_emirleri`, `proje_dosyalari` tablolarına **`eski_id` kolonu** | Sonraki her adımın ön koşulu | Küçük |
| 4 | **Dosya aktarımı**: S3 `aset-storage.aterko.com` → Supabase Storage (1.205 dosya, 16 tür) | AWS kapatmanın ön koşulu | Orta |
| 5 | **Bina dökümü**: `project_component` (3.770) → `proje_teslimatlari`, teklif kalemine bağıyla birlikte | 1.664 projede bina bilgisi kazanılır | Orta |
| 6 | **Fiyat geçmişi**: `component_product_price` (197.169) → yeni geçmiş tablosu | Maliyet trendi görünür olur | Orta |
| 7 | **Durum eşleştirme listeleri**: 16 proje durumu, 12 teslimat/iş emri durumu, `configg` kuralları | Sonraki aktarımların doğruluğu | Küçük ama karar gerektirir |
| 8 | **Karar:** kontrol listeleri (proje ilerleme %) Workspace'e girecek mi? | Kapsam kararı | Karar |
| 9 | **Karar:** kesme tarihi ve o tarihe kadar Workspace'te tamamlanması gereken ekranlar | Tüm planın çatısı | Karar |

---

## 9. Analiz Sırasında Ortaya Çıkan Yan Bulgular

1. **`mali_kurlar` tablosu yok ama sorgulanıyor** — hata gizlendiği için fark edilmiyordu; dövizli yeni sözleşmelerde kur 1 kabul ediliyor. (Öncelik 4)
2. **Eski sistemde teslimat → iş emri zinciri bizden çok daha detaylı** (12 aşamalı durum, 19.286 iş emri satırı). Yeni İş Emri modülü tasarlanırken bu 12 aşamalı akışın ne kadarının karşılandığı gözden geçirilmeli.
3. **`proposal_component_id_copied_from`** — eski sistemde teslimat, doğrudan teklif kalemine bağlı. Bizde bu bağ yok; kurulursa "satılan bina ile üretilen bina aynı mı" kontrolü mümkün olur.
4. **`project.guid` + `customer_password`** — eski sistemde müşteri portalı altyapısı var (proje başına parola). Workspace'te C5 olarak planlanan müşteri portalı için hazır bir model.
5. **Kod sayaçları:** eski `project_code_sequence` 5.921 satır = teklif 4.203 + sözleşme 736 + **iş emri 506 + teslimat 476**. Bizde yalnız teklif (4.199) ve sözleşme (736) taşınmış; iş emri/teslimat sayaçları yok. Öncelik 1 aktarımında bu sayaçlar da taşınmazsa **kod çakışması olur** (eskiden `72778-ISE-04` varken bizde `72778-İE-01` üretilir).
6. **İki müşteri tablosu** (`musteriler` 110 = cari, `sat_musteriler` 2.364 = satış) `sat_musteri_id` ile bağlı — bu **doğru kurulmuş bir desen**; yeni bağlarda aynısı uygulanmalı.

---

*Bu belge yalnız okuma yaparak hazırlanmıştır; hiçbir veri değiştirilmemiş, silinmemiş veya taşınmamıştır.*

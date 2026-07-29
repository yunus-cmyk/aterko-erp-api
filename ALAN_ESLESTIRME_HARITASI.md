# Alan Eşleştirme Haritası — Eski Sistem ↔ Aterko Workspace

**Soru:** *Eski sistemdeki hangi alan, yeni sistemdeki hangi alanın karşılığıdır?*
**Tarih:** 28 Temmuz 2026 · Her iki veritabanı canlı okundu, değer kümeleri sayıldı, isimler değil **içerikler** karşılaştırıldı.

Yunus'un verdiği iki örnek doğrulandı ve haritanın çıkış noktası yapıldı:
- **Eski "Şartname Türü" = Yeni "Bina Türü"** ✔ (bölüm 8.1)
- **Eski "Malzeme" kategorisi = Yeni "Stok Kartları"** ✔ (bölüm 6)

---

## 0. Eşleşme türleri (tablolarda kullanılan işaretler)

| İşaret | Anlamı |
|---|---|
| **=** | Birebir aynı: aynı bilgi, aynı değerler. Doğrudan bağlanır. |
| **≈** | Aynı bilgi, **farklı isim veya farklı yazım**. Değer sözlüğü gerekir. |
| **⊃ / ⊂** | Biri diğerini kapsıyor: bir alan bölünmüş ya da birleştirilmiş. |
| **⇢** | Aynı bilgi ama **farklı seviyede** duruyor (ör. eskide teklifte, yenide binada). |
| **✖** | Karşılığı yok. |

---

## 1. MÜŞTERİ — `customer` ↔ `sat_musteriler`

Bu grup tamamen aktarılmış; harita doğrulama ve ileride yapılacak senkron için.

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `customer.name` | Kısa Ad | `sat_musteriler.ad` | **=** | |
| `customer.long_name` | Ünvan | `sat_musteriler.uzun_ad` | **=** | |
| `customer.email` / `phone` | E-posta / Telefon | `email` / `telefon` | **=** | |
| `customer.address` | Adres | `adres` | **=** | |
| `customer.billing_address` | Fatura Adresi | `fatura_adresi` | **=** | |
| `customer.tax_place` / `tax_number` | Vergi Dairesi / No | `vergi_dairesi` / `vergi_no` | **=** | |
| `customer.ibann` | IBAN | `iban` | **=** | yazım hatası eskide (`ibann`) |
| `customer.financial_note` | Mali Not | `mali_not` | **=** | yenide mali yetki ister |
| `customer_type_id` → `customer_type` | Müşteri Türü | `tip` (Kurumsal/Bireysel/Bayi) | **≈** | eskide 11 satırlık **tek tablo**, yenide **iki alana bölünmüş** |
| `customer_sub_type_id` → `customer_type` | Alt Tür | `alt_tur` (Müteahhit, Yatırımcı, Kamu Kurumu, STK, Proje Satıcısı, Bölgesel Satıcı, Malzeme Alıcısı) | **⊂** | aynı tablodan geliyor, kod ön ekiyle ayrılıyor (01→Kurumsal altı) |
| `customer_status_id` → `customer_status` | Satış Durumu | `satis_durumu` | **=** | Potansiyel / Görüşme Yapılmış / Teklif Sürecinde / Satış Gerçekleşmiş |
| `state_change_date` | Durum Tarihi | `durum_tarihi` | **=** | |
| `point_of_sales_id` | Satış Noktası | `satis_noktasi` | **=** | Merkez / Ankara / Kumburgaz |
| `how_did_you_hear_us_id` | Bizi Nereden Duydu | `nasil_duydu` | **=** | 12 değer |
| `business_type_id` | İşletme Türü | *(taşındı, kolon yok)* | **⊂** | Tüzel/Gerçek Kişi → `tip`'e katlandı |
| `customer_rep_id` → `customer_rep` | Müşteri Temsilcisi | `temsilci_email` | **≈** | eskide **ayrı 16 satırlık tablo**, yenide **kullanıcı e-postası** |
| `country_id` / `city_id` | Ülke / Şehir | `ulke` / `sehir` | **≈** | eskide tablo (249 ülke + 3.853 şehir), yenide **serbest metin** |
| `created_by` / `created_date` | | `olusturan` / `kayit_tarihi` | **=** | |
| *(yok)* | Cari / devir bakiyesi | `musteriler.*` (110 kayıt) | ✖ | yeni sistemin Mali İşler tarafı; `musteriler.sat_musteri_id` ile bağlı |

**Kişiler:** `person.name/position/email/phone/note` **=** `sat_musteri_kisiler.ad/unvan/email/telefon/notu`.

---

## 2. PROJE — `project` ↔ `projeler`

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `project.id` | Proje No | `projeler.proje_kodu` | **=** | **Eski sistemin kayıt numarası, bizim proje kodumuz.** 4.247 eşleşme. |
| `project.name` | Proje Adı | `proje_adi` | **=** | |
| `project.location` | Yer | `adres` | **≈** | |
| `country_id` / `city_id` | Ülke / Şehir | `ulke` / `sehir` | **≈** | |
| `contact_name/email/phone` | İrtibat | `irtibat_adi/email/telefon` | **=** | |
| `description` | Açıklama | `aciklama` | **=** | |
| `customer_id` | Müşteri | `sat_musteri_id` | **=** | |
| `project_type_id` | Proje Türü | `proje_turu` | **=** | Şantiye/Kamp Binası, Çok Amaçlı Bina, Konut, Modüler Ünite, Malzeme, Demontaj, Paket Konut, Foreva |
| `sales_type_id` | Satış Türü | `satis_turu` | **=** | Yurtiçi / İhracat / İhraç kayıtlı — **yenide "İhraç Kayıtlı" diye 3 kayıt yazım farkıyla duruyor, birleştirilmeli** |
| `project_status_id` (16 değer) | Proje Durumu | `satis_durumu` (11) **+** `durum` (4) **+** `faz` (2) | **⊃** | **Eskide tek alan, yenide üçe bölünmüş.** Değer sözlüğü bölüm 8.3 |
| `customer_rep_id` | Temsilci | `satis_temsilcisi` | **≈** | |
| `completion_rate` | Tamamlanma % | ✖ | ✖ | kontrol listelerinden hesaplanıyordu; yenide kavram yok |
| `total_amounts_by_unit_types` | Toplam Büyüklük | `sat_teklifler.toplam_buyukluk` | **⇢** | eskide projede, yenide **teklifte** |
| `guid` + `customer_password` | Müşteri Portalı erişimi | ✖ | ✖ | C5 portal işi için hazır model |
| `tag` | Etiket | ✖ | ✖ | eskide de boş |
| *(yok)* | Nakliye (Aterko/Müşteri) | `nakliye` | ✖ | yeni alan |
| *(yok)* | Sözleşme Tarihi / KDV / Para Birimi | `sozlesme_tarihi`, `kdv_orani`, `para_birimi` | ✖ | yenide projeye taşınmış, eskide sözleşmede |

---

## 3. TEKLİF — `proposal` ↔ `sat_teklifler`

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `proposal.code` | Teklif No | `teklif_no` | **=** | `{proje}-TEK-NN` |
| `proposal_date` | Teklif Tarihi | `teklif_tarihi` | **=** | |
| `price` / `tax` / `total` | Ara Toplam / KDV / Genel | `ara_toplam` / `kdv_tutar` / `genel_toplam` | **=** | |
| `tax_rate` | KDV Oranı | `kdv_orani` | **=** | |
| `discounted` | İskontolu Toplam | `iskontolu_toplam` | **=** | |
| `notes` | Notlar | `notlar` | **=** | |
| `terms_payment` / `terms_delivery` | Ödeme / Teslimat Koşulları | `odeme_kosullari` / `teslimat_kosullari` | **=** | |
| `scope_included` / `scope_excluded` | Dahil / Hariç İşler | `dahil_isler` / `haric_isler` | **=** | |
| `total_amounts_by_unit_types` | Teklif Edilen Proje Büyüklüğü | `toplam_buyukluk` | **=** | "68,38 m², 30,00 Gün" biçimi |
| `proposal_status_id` | Durum | `durum` | **=** | 1..5 → TASLAK/REVIZE/CEVAP_BEKLENEN/ONAYLANAN/REDDEDILEN |
| **`technical_spec_type_id`** | **Şartname Türü** | **`proje_teslimatlari.bina_turu`** | **⇢≈** | **Yunus'un örneği — bölüm 8.1** |
| `currency_id` | Para Birimi | `para_birimi` | **≈** | tablo → metin |
| *(yok)* | Opsiyonlu Toplam | `opsiyonlu_toplam` | ✖ | yenide hesaplanıyor |

---

## 4. TEKLİF KALEMİ ↔ BİNA/TESLİMAT — **haritanın kalbi**

Eski sistemde **aynı bina üç kez** kayda geçiyor ve birbirinden kopyalanıyor:
`proposal_component` (satarken) → `project_component` (sözleşme sonrası) → `deliverable` (üretime verirken).
Yeni sistemde bunun karşılığı **iki** tablo: `sat_teklif_kalemleri` (satış) ve `proje_teslimatlari` (teslimat).

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `proposal_component.name` | Kalem Adı | `sat_teklif_kalemleri.ad` **/** `proje_teslimatlari.bina_adi` | **=** | aynı ad iki tabloda yaşıyor |
| `proposal_component.note` | Açıklama | `sat_teklif_kalemleri.aciklama` | **=** | |
| **`secondary_amount`** | **Büyüklük** (m²) | `sat_teklif_kalemleri.ikincil_miktar` **/** **`proje_teslimatlari.buyukluk_m2`** | **=** | bugün form bu isimle düzeltildi |
| **`amount`** | **Miktar** (adet) | `sat_teklif_kalemleri.miktar` **/** **`proje_teslimatlari.bina_adedi`** | **=** | |
| `primary_unit_type_id` | Birim | `birim` (sabit "Adet") | **=** | eskide de sabit |
| `secondary_unit_type_id` | Büyüklük Birimi | `ikincil_birim` + `ikincil_birim_sembol` | **=** | türden türetiliyor |
| `component_type_id` (39 tür) | **Bileşen Türü** | `bilesen_turu` | **=** | Prefabrike Ofis, Monoblok Konteyner… |
| `component_type → component_category` (6) | Bileşen Kategorisi | **`proje_teslimatlari.bina_turu`** | **≈** | **Prefabrik / Konteyner / Hafif Çelik / Yapısal Çelik** — bölüm 8.1 |
| `price` / `total_price` | Birim Fiyat / Tutar | `birim_fiyat` / `toplam` | **=** | |
| `optional` | Opsiyonel | `opsiyonel` | **=** | |
| `order_no` | Sıra | `sira` | **=** | |
| `proposal_component_status_id` | Analiz Durumu | `analiz_durumu` | **=** | Belirtilmemiş / Analiz Sürecinde / Analiz Tamamlandı |
| `project_component.proposal_component_id_copied_from` | *(görünmez)* | ✖ | ✖ | **Eskide bina, doğduğu teklif kalemine bağlı. Bizde bu bağ yok — kurulabilir.** |
| `project_component.project_id` | Proje | `proje_teslimatlari.proje_id` | **=** | |
| *(yok — özniteliklerden geliyordu)* | **Bina Tipi** | `proje_teslimatlari.bina_tipi` | **⊃** | **bölüm 8.2 — üç eski alanın birleşimi** |
| *(yok)* | Kat Adedi / Kat Yüksekliği | `kat_adedi` / `kat_yuksekligi` | **⇢** | eskide öznitelik formunda, yenide binanın kolonu |
| *(yok)* | Dış/İç Duvar Kesiti | `dis_duvar_kesiti` / `ic_duvar_kesiti` | **⇢** | eskide öznitelik |
| *(yok)* | Konteyner Ebadı / Miktarı | `konteyner_ebadi` / `konteyner_miktari` | **⇢** | eskide öznitelik (`GE_KE_M`, `GE_KB_M`) |

---

## 5. SÖZLEŞME — `contract` ↔ `sat_sozlesmeler`

| Eski alan | Yeni alan | | Not |
|---|---|---|---|
| `code` / `date` | `kod` / `tarih` | **=** | `{proje}-SOZ-NN` |
| `price` / `tax_rate` | `tutar` / `kdv_orani` | **=** | |
| `currency_rate` | `kur` | **=** | sözleşme anında sabitlenir |
| `price_in_base_currency` / `tax_in_base_currency` / `total_in_base_currency` | `tutar_tl` / `kdv_tl` / `toplam_tl` | **=** | |
| `terms_payment` / `terms_delivery` | `odeme_kosullari` / `teslimat_kosullari` | **=** | |
| `scope_included` / `scope_excluded` | `dahil_isler` / `haric_isler` | **=** | |
| `notes` | `notlar` | **=** | |
| `project_id` / `proposal_id` | `proje_id` / `teklif_id` | **=** | |
| `currency_id` | `para_birimi` | **≈** | |

---

## 6. ÜRÜN / MALZEME ↔ STOK KARTI — *Yunus'un ikinci örneği*

**Doğru:** eski `product` tablosunun **"Malzeme" kategorisindeki 2.050 kaydı** = yeni **`stok_kartlari`** (1.407 kayıt). Bunlar dışarıdan tedarik edilen ilk madde/sarf malzemeler; ürün ağacı olmaz, kendi alış fiyatı olur.

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `product.name` (kategori=Malzeme) | Malzeme Adı | `stok_kartlari.stok_adi` | **≈** | **isimlendirme farklı** — otomatik eşleşme yalnız %1,8 |
| `product.short_code` | Kısa Kod | `stok_kartlari.stok_kodu` | **≈** | |
| `product.unit_type_id` | Birim | `stok_kartlari.birim` | **≈** | *Metrekare→m², Adet→adet, Kilogram→kg* — sözlük bölüm 8.4 |
| `product_category_id` | Ürün Kategorisi | `stok_kartlari.kategori` | **⊗** | **DİKKAT: iki farklı eksen** — aşağıda |
| `product_price` (ALIŞ) | Alış Fiyatı | `son_alis_fiyati` / `ortalama_alis_fiyati` | **≈** | eskide tarih aralıklı geçmiş, yenide son değer |
| `product_class_id` | Sınıf (Ürün/Hizmet) | *(stokta yok)* | **⊂** | `sat_urunler.sinif`'ta var |
| *(yok)* | Kritik Stok / Güncel Stok / Depo | `kritik_stok_miktari`, `guncel_stok_miktari`, `depolar` | ✖ | yeni sistemin kazancı |
| *(yok)* | Stok Tipi (Hammadde/Yarımamül) | `stok_tipi` | ✖ | |

### ⊗ Kategori eksenleri farklı — en önemli uyarı

| | Eski `product_category` (70) | Yeni `stok_kartlari.kategori` (64) |
|---|---|---|
| **Neyi anlatır** | **Binanın hangi parçası** (imalat ağacı) | **Malzemenin cinsi** (satın alma / depo) |
| Örnek | Duvar Paneli, Çatı Konstrüksiyonu, Kat Arası Döşeme, Konteyner Zemini, Dış Cephe | Galvanizli Sac, Vida-Civata, EPS, Taşyünü, Boyalı Trapez Sac, Hırdavat |

Tam ad eşleşen yalnız **10 kategori**: Altyapı, Asma Tavan, Cephe, Dere, Elektrik, Kapı, Köşe Direği, Mekanik, Merdiven, Pencere.
Yakın olan ~40 çift daha var (Duvar Paneli↔Sandviç Panel, H Profili↔H Profil, Nakliye↔Nakliye-Lojistik, Dere+İniş↔Dere-İniş, Dış Cephe+İç Cephe↔Cephe…).

**Sonuç:** İki kategori sistemi birbirinin yerine geçmez, **birbirini tamamlar.** Doğru çözüm kategoriyi eşleştirmek değil, stok kartına **ikinci bir etiket** (yapı elemanı / kullanıldığı bölüm) eklemek. O zaman "bu malzeme hangi imalat kaleminde kullanılıyor" ile "bu malzeme hangi cins" ayrı ayrı sorulabilir.

**Mamul tarafı ayrı:** Malzeme dışındaki 3.886 ürün (Duvar Paneli 594, Pencere 512, H Profili 288, Çatı Konstrüksiyonu 200, Kapı 192…) = yeni **`sat_urunler`** kütüphanesi, stok kartı değil. Bunlar reçeteli (`product_bom` = `sat_urun_bom`) mamullerdir.

---

## 7. ÖZNİTELİK FORMU ↔ İŞ EMRİ FORMU — **en büyük keşif**

Eski sistemin **fiyat analizi öznitelik formu** (`attribute_type` 201 alan / `attribute_choice` 808 seçenek / `configg` 30 kural) ile yeni sistemin **İş Emri formu** (`form_tanimlari` 159 soru) **aynı binayı, aynı sorularla tarif ediyor.**

| Eski (analiz formu) | Yeni (iş emri formu) | | Not |
|---|---|---|---|
| `attribute_type.name` | `form_tanimlari.soru` | **≈** | **20 soru birebir aynı ad**, 50 soru daha yakın eşleşme (~%44 örtüşme) |
| `attribute_category` (bölüm) | `form_tanimlari.bolum_adi` | **≈** | ortak bölümler: Duvar, Çatı, Kat Arası, Altyapı, Merdiven, Dere-İniş, Pencere, Kapı, Zemin, Cephe/Boya |
| `product_category` (formu şablonlar) | `form_tanimlari.bina_turu` | **⇢** | eskide ürün kategorisi, yenide bina türü sürücü |
| `attribute_field_type` (1 Tekli / 2 Sayısal / 3 Çoklu) | `giris_tipi` (TEK / ÇOK / sayı) | **=** | |
| `attribute_choice.value` | `secenekler` (JSON dizi) | **≈** | |
| `attribute_choice.code` (DU_TP_SES gibi) | ✖ | ✖ | **kritik fark:** eski kodlar formülleri ve ürün eşleştirmeyi çalıştırıyor; yenide kod yok |
| `attribute_type.required` | `zorunlu` | **=** | |
| `attribute_type.editable` | `kurallar='SALT_OKUNUR'` | **=** | |
| `configg` kuralları (`if-matches-hide`) | `kosullar` (`Dış Duvar=Yok→SORU_GIZLE`) | **=** | **aynı mantık, farklı yazım** |
| `attribute.value` (dolu cevap, 849.567 satır) | teslimat kolonları + iş emri `form_snapshot` | **⇢** | eskide her cevap ayrı satır, yenide JSON anlık görüntü |
| `attribute_type.text_of_technical_spec` | `teknik_sartname_sablonu.cevap_sablonu` | **=** | **teknik şartname metni üreten alan — ikisinde de var** |
| ✖ | `form_tanimlari.kaynak_kolon` | ✖ | yeni: soru doğrudan `proje_teslimatlari` kolonuna yazıyor (bina_tipi, kat_adedi…) |

### Birebir eşleşen 20 soru
Kat Adedi · Kat Yüksekliği (mm) · Duvar Tipi · Duvar Kalınlığı (mm) · Çatı Kaplaması · Kar Yükü (kg/m²) · Saçak Genişliği (mm) · Kat Arası İzolasyonu · Dış Cephe Boyası · İç Cephe Boyası · Tavan Boyası · Kanopi · Temel Tesviyesi · Temel İzolasyonu · Temel Betonu (+ Konteyner karşılıkları)

**Anlamı:** İki form birleştirilebilir. Satışta doldurulan öznitelikler iş emri formunu **önden doldurabilir**; tersine iş emri formundaki cevaplar fiyat analizini besleyebilir. Bugün bu bilgi iki sistemde iki kez, elle giriliyor.

---

## 8. Değer Sözlükleri (isim farklı, içerik aynı)

### 8.1 Şartname Türü = Bina Türü ✔ *(Yunus'un örneği)*

| Eski `technical_spec_type` (teklif başına) | Teklif sayısı | Yeni `bina_turu` (bina başına) | |
|---|---|---|---|
| Prefabrik | 2.054 | **Prefabrik** | **=** |
| Konteyner | 1.854 | **Konteyner** | **=** |
| Hafif Çelik | 787 | **Hafif Çelik** | **=** |
| **Ağır Çelik** | 95 | **Yapısal Çelik** | **≈** *aynı şey, iki isim — eski sistem kendi içinde de iki ad kullanıyor* |
| Birleşimli Konteyner | 249 | *(Konteyner altında)* | **⊂** |
| Prefabrik Konut | 31 | *(Prefabrik altında)* | **⊂** |
| Foreva | 0 | ✖ | kullanılmamış |
| Şartnamesiz | 297 | *(boş)* | **≈** |

**Önemli seviye farkı:** eskide bu **teklifin tamamı** için tek değer; yenide **her bina** için ayrı. Karma tekliflerde eski değer yanıltıcı: "Prefabrik" şartnameli tekliflerin içinde 714 Konteyner kalemi var. **Bu yüzden doğru kaynak teklif başlığı değil, kalemin bileşen türü kategorisidir** (Prefabrike Ofis → Prefabrik, Monoblok Konteyner → Konteyner).

### 8.2 Bina Tipi = Duvar Tipi + Kat Yüksekliği + Kat Adedi

Yeni `proje_teslimatlari.bina_tipi` değeri: **"Sandviç EPS - 2500 mm - 1 Kat"**
Eskide bu **üç ayrı öznitelik**: `Duvar Tipi` + `Kat Yüksekliği` + `Kat Adedi`.

| Eski `Duvar Tipi` seçeneği | Yeni `Bina Tipi` seçeneği | |
|---|---|---|
| Sac Eps Sac Pres Panel | Sac-EPS-Sac Sandviç Panel | **≈** |
| Sac Taşyünü Sac Pres Panel | Sac-Taşyünü-Sac Sandviç Panel | **≈** |
| Betopan Eps Betopan Pres Panel | Betopan-EPS-Betopan Pres Panel | **≈** |
| Betopan Taşyünü Betopan Karkaslı Panel | Betopan-Taşyünü-Betopan Karkaslı Panel | **≈** |
| Betopan (Derzli) Eps … | Derzli Betopan-EPS-… | **≈** |
| Sac (Trapez) Taşyünü Betopan Karkaslı | Trapez Sac-Taşyünü-Betopan Karkaslı Panel | **≈** |
| Poliüretan Dolgulu Sandviç Panel | ✖ | yenide yok |
| ✖ | Mikrolambri Sac-… (2 seçenek) | eskide yok |

### 8.3 Proje Durumu — eskide 1 alan, yenide 3

| Eski `project_status` (16) | Yeni karşılığı |
|---|---|
| Taslak / Analiz sürecinde / Analizi tamamlanan / Teklif Sürecinde / Reddedilen / İptal / Beklemede | `satis_durumu` (faz=SATIS) |
| Sözleşmesi taslak / onayda / onaylanan / imzalanan / Avans ödemesi alınan / Satışı tamamlanan | `satis_durumu` (sözleşme zinciri) |
| Devam eden / Tamamlanan | `durum` = AKTİF (faz=TESLIMAT) |
| — | `faz` = SATIS / TESLIMAT *(yeni; eskide yoktu, hepsi tek listede)* |

### 8.4 Birimler — `unit_type` ↔ `stok_kartlari.birim` / `sat_urunler.birim`

| Eski (ad = sembol) | Yeni stok | Yeni ürün |
|---|---|---|
| Adet = adet | adet | Adet |
| Metrekare = m² | m² | Metrekare |
| Metreküp = m³ | m³ | Metreküp |
| Kilogram = kg | kg / KG | Kilogram |
| Metre = m | metre | Metre |
| Litre = litre | lt | — |
| Paket = paket | paket | Paket |
| Gün / Dakika / Öğün / Kilometre / Metretül / Ton / Yevmiye / Yol-Ulaşım / kg-m² | — | Gün, Kilometre, Öğün, Dakika |

**Not:** yeni sistem stokta küçük harf (`adet`, `kg`), satışta büyük harf (`Adet`, `Kilogram`) kullanıyor; ayrıca `kg` ve `KG` birlikte duruyor. Birleştirme sırasında tek sözlüğe indirilmeli.

### 8.5 Teslimat / İş Emri Durumları — eskide 12, yenide 6

| Eski `deliverable_status` = `work_order_status` (12) | Yeni `proje_teslimatlari.durum` (6) / `is_emirleri.durum` |
|---|---|
| İş emri hazırlık sürecinde | PROJE / `HAZIRLANDI` |
| İş emri yayınlanan | İŞ EMRİ / `YAYINLANDI` |
| İmalat projesi yayınlanan / onaylanan | *(karşılığı yok)* |
| İmalat sürecinde / İmalatı tamamlanan | ÜRETİM |
| Sevkiyat ve montajı onaylanan / Yeri teslim alınan / Sevkiyatı yapılan | *(Sevkiyat modülü ayrı)* |
| Montaj sürecinde | MONTAJ |
| Teslim edilen | TESLİM EDİLDİ |
| Faturası kesilen | *(Mali İşler ayrı)* |

**Yorum:** Eski sistem tek bir durum alanında 12 aşama taşıyordu; yeni sistem bu aşamaları **ayrı modüllere** dağıttı (Üretim, Sevkiyat, Montaj, Mali). Aynı bilgi kayıp değil, **yerini değiştirdi.**

### 8.6 Diğer kısa sözlükler

| Eski | Yeni | |
|---|---|---|
| `proposal_status` 1..5 | `sat_teklifler.durum` TASLAK/REVIZE/CEVAP_BEKLENEN/ONAYLANAN/REDDEDILEN | **=** |
| `proposal_component_status` 1..3 | `analiz_durumu` BELIRTILMEMIS/ANALIZ_SURECINDE/ANALIZ_TAMAMLANDI | **=** |
| `currency` (Türk Lirası/Dolar/Euro/Sterlin) | `para_birimi` (TL/USD/EUR/GBP) | **≈** |
| `product_class` (Ürün/Hizmet) | `sat_urunler.sinif` | **=** |
| `price_type` (Alış/Satış) | `sat_urun_fiyatlar.tip` (ALIS/SATIS) | **=** |
| `comment_type` (Bilgi/Güzel haber/Uyarı/Görüşme Notu) | `sat_yorumlar.tip` | **=** |
| `my_file_type` (16 belge türü) | `proje_dosyalari.tur` (bugün yalnız MIMARI, SOZLESME) | **⊃** | eskinin listesi çok daha zengin, **doğrudan alınabilir** |
| `proposal_term_category` (4) | `sat_metinler.kategori` | **=** |
| `expense_category` (15: Proje, Üretim, Asma Tavan, Cephe, Pencere, Kapı, Zemin, Altyapı, Elektrik, Mekanik, Nakliye, Montaj, Şantiye, Komisyon, Diğer) | ✖ | ✖ — Mali İşler'de gider ağacı yok, **hazır liste olarak alınabilir** |
| `task_type` (36: Duvar Paneli, Çatı Makası, Dere ve İniş, İç Kapı, Pano, Klima…) | `is_emirleri` form bölümleri / `stok_kartlari.kategori` | **≈** | iş emri kalem kategorileri |

---

## 9. TESLİMAT / İŞ EMRİ — `deliverable` + `work_order` ↔ `proje_teslimatlari` + `is_emirleri`

| Eski alan | Ekrandaki adı | Yeni alan | | Not |
|---|---|---|---|---|
| `deliverable.code` | Teslimat No | ✖ (`proje_teslimatlari`'nda kod yok) | ✖ | eski biçim `72778-TES-04` |
| `deliverable.name` | Teslimat Adı | `proje_teslimatlari.bina_adi` | **=** | |
| `deliverable.amount` | Miktar | `bina_adedi` | **=** | |
| `deliverable.project_component_id` | Bağlı bina | *(aynı satır)* | **⊂** | yenide bina ve teslimat **tek tablo** |
| `work_order.code` | İş Emri No | `is_emirleri.emir_no` | **≈** | `72778-ISE-04` ↔ `72779-İE-01` — **kısaltma farklı, sayaç ayrı** |
| `work_order.work_order_date` | İş Emri Tarihi | `olusturma_tarihi` | **≈** | |
| `planned_start_date` / `planned_transportation_date` / `planned_delivery_date` | Planlanan başlangıç / sevk / teslim | ✖ | ✖ | **yeni İş Emri'nde planlama tarihleri yok** |
| `work_order.note` | İş Emri Notu | `is_emri_notu` + `is_emri_notlari` | **=** | yenide ek olarak not geçmişi |
| `work_order_item.product_category_id` | İş emri kalem kategorisi | `form_snapshot` / `teslimat_urunleri` | **≈** | eskide satır, yenide JSON |
| `work_order_item.provider_id` / `implementer_id` | Sağlayan / Uygulayan | ✖ | ✖ | eskide de boş bırakılmış |
| ✖ | Yayın onayı, PDF'li mail, iptal nedeni | `yayinlayan_email`, `pdf`, `iptal_nedeni` | ✖ | yeni sistemin kazancı |

---

## 10. DOSYA, KULLANICI, ANALİZ

| Eski | Yeni | | Not |
|---|---|---|---|
| `my_file.name` / `path` | `proje_dosyalari.dosya_adi` / `storage_path` | **=** | dosyalar **S3'te**, taşınmalı |
| `my_file.entity_name` + `entity_id` | `proje_id` / `teslimat_id` | **≈** | eskide "hangi tabloya ait" metni |
| `my_file.my_file_type_id` | `tur` | **⊃** | 16 tür → bugün 2 |
| `my_file.share_with_customer` | ✖ | ✖ | müşteri portalı için gerekli |
| `jhi_user.email` / `first_name` | `kullanicilar.email` / `ad_soyad` | **=** | |
| `jhi_user_authority` (ROLE_*) | `kullanici_rolleri` + `roller` | **≈** | karşılıklar çıkarıldı |
| `attribute` (cevap) | `sat_analiz_degerler` | **=** | |
| `attribute_category` (bölüm) | `sat_analiz_bolumler` | **=** | |
| `component_product` (döküm satırı) | `sat_analiz_urunler` | **=** | |
| `component_product_price` (fiyat geçmişi) | `kilit_maliyet` / `kilit_satis` *(yalnız son değer)* | **⊂** | 197.169 satırlık geçmiş taşınmadı |
| `product_bom` | `sat_urun_bom` | **=** | |
| `product.calc_count_script` | `sat_urunler.formul` | **=** | Groovy → JS'e çevrildi |
| `product.gross_profit_rate` | `kar_orani` | **=** | |
| `product.long_code` / `short_code` | `uzun_kod` / `kisa_kod` | **=** | |

---

## 11. Özet — "İsmi farklı ama aynı şey" listesi

Günlük konuşmada karışan çiftler:

| Eski sistemde denen | Yeni sistemde denen |
|---|---|
| **Şartname Türü** | **Bina Türü** |
| **Ağır Çelik** | **Yapısal Çelik** |
| **Malzeme (ürün kategorisi)** | **Stok Kartı** |
| **Teklif Bileşeni** | **Teklif Kalemi** |
| **Bileşen Kategorisi** | **Bina Türü** |
| **İkincil Miktar** | **Büyüklük** (m²) |
| **Miktar** | **Bina Adedi** |
| **Öznitelik / Öznitelik Formu** | **İş Emri Formu** *(soruların ~%44'ü aynı)* |
| **Duvar Tipi + Kat Yüksekliği + Kat Adedi** | **Bina Tipi** *(tek metin)* |
| **Proje Bileşeni / Teslimat** | **Proje Teslimatı (bina)** |
| **Müşteri Temsilcisi (ayrı tablo)** | **Temsilci E-postası (kullanıcı)** |
| **Şehir / Ülke (tablo)** | **Şehir / Ülke (serbest metin)** |
| **Proje Durumu (16 değerli tek alan)** | **Faz + Durum + Satış Durumu (üç alan)** |
| **Teslimat Durumu (12 aşama)** | **Modüllere dağılmış (Üretim/Sevkiyat/Montaj/Mali)** |

---

## 12. Bu haritadan çıkan üç somut iş

1. **Bina türü tek sözlüğe indirilsin.** Ağır Çelik = Yapısal Çelik, Birleşimli Konteyner ⊂ Konteyner, Prefabrik Konut ⊂ Prefabrik. Teklif kaleminin bileşen türü kategorisi ile teslimatın bina türü aynı listeden beslenmeli — bugün ikisi ayrı yerden geliyor.
2. **Öznitelik formu ile İş Emri formu birleştirilsin.** 20 soru zaten birebir aynı; kaynak_kolon mekanizması hazır. Satışta girilen bilgi iş emrinde ikinci kez sorulmasın.
3. **Stok kartına "yapı elemanı" etiketi eklensin.** Malzeme↔stok eşleştirmesini isim benzerliği çözemiyor (%1,8); iki kategori ekseni birleştirilmeden değil, **yan yana** konularak çözülür.

---

*Bu harita yalnız okuma yapılarak çıkarıldı; hiçbir veri değiştirilmedi.*

---

# EK A — Yukarıda Adı Geçmeyen Eski Alanlar (106 alan)

Bu ek, **eksiksizlik denetimi** sonucu eklendi. Eski sistemin teknik olmayan 372 iş alanının 266'sı yukarıdaki bölümlerde geçiyordu; kalan 106'sı burada. Böylece **eski taraf %100 kapsanmış** oluyor. (Sayıma dahil edilmeyenler: `id`, `version`, `created_by/date`, `last_modified_by/date` gibi teknik kolonlar ve JHipster altyapı tabloları.)

## A1. Aslında karşılığı VAR, yukarıda yazmayı atladıklarım

| Eski alan | Anlamı | Yeni karşılığı | |
|---|---|---|---|
| `product_price.valid_from` / `valid_to` | Fiyat geçerlilik aralığı | `sat_urun_fiyatlar.baslangic` / `bitis` | **=** |
| `product_price.price_type_id` | Alış / Satış | `sat_urun_fiyatlar.tip` | **=** |
| `product_price.product_id` | Ürün | `sat_urun_fiyatlar.urun_id` | **=** |
| `product.add_automatically` | Dökümde otomatik eklenir | `sat_urunler.otomatik_eklenir` | **=** |
| `product_bom.product_id` / `item_id` | Ürün / Bileşen | `sat_urun_bom.urun_id` / `bilesen_urun_id` | **=** |
| `comment.comment_date` / `writer_name` / `fix_comment` / `comment_type_id` | Tarih / Yazan / Sabit yorum / Tür | `sat_yorumlar.tarih` / `yazan` / `sabit` / `tip` | **=** |
| `attribute.attribute_type_id` / `attribute_category_id` | Hangi alan / hangi bölüm | `sat_analiz_degerler.parametre_id` / `bolum_eski_id` | **=** |
| `attribute_category.included_in_scope` | Bölüm kapsamda mı | `sat_analiz_bolumler.kapsamda` | **=** |
| `attribute_category.parent_id` | Üst bölüm | `sat_analiz_bolumler.ust_bolum_eski_id` | **=** |
| `attribute_choice.defauld` *(yazım hatası eskide)* | Varsayılan seçenek | `sat_parametre_secenekler.varsayilan` | **=** |
| `attribute_choice.attribute_type_id` | Bağlı alan | `sat_parametre_secenekler.parametre_eski_id` | **=** |
| `attribute_type.hint` (126 alanda dolu) | Alan ipucu | `sat_parametreler.ipucu` | **=** |
| `attribute_type.show_at_input_form` | Formda göster | `sat_parametreler.formda_goster` | **=** |
| `attribute_type.attribute_data_type_id` | Veri tipi (Metin / Sayı / Sayı listesi) | `sat_parametreler.veri_tipi` | **=** |
| `attribute_type.attribute_field_type_id` | Alan tipi (Tekli/Sayısal/Çoklu) | `sat_parametreler.alan_tipi` | **=** |
| `component_product.product_id` | Döküm satırındaki ürün | `sat_analiz_urunler.urun_id` | **=** |
| `component_product_price.cost` / `sales_price` | Kilitlenen maliyet / satış | `sat_analiz_urunler.kilit_maliyet` / `kilit_satis` | **⊂** *(yalnız son değer; geçmiş yok)* |
| `component_product_price.edited_by_user` | Elle düzenlendi | `sat_analiz_urunler.elle_duzenlendi` | **=** |
| `component_product_price_set.price_calculated_at` | Hesap tarihi | `sat_analiz_urunler.kilit_tarihi` + `sat_teklif_kalemleri.analiz_tarihi` | **=** |
| `component_product_price.component_product_id` / `..._set_id` | Bağlar | `kalem_id` / *(set kavramı yok)* | **⊂** |
| `project_code_sequence.current_value` | Sayaç değeri | `sat_kod_sirasi.deger` | **=** |
| `product_category.parent_id` | Üst kategori | `sat_urun_kategoriler.ust_id` | **=** |
| `product_category.attributes_shared` | Öznitelikler ortak mı | `sat_urun_kategoriler.parametreler_ortak` | **=** |
| `product_category.exists_by_its_own` (63 kategori) | Kendi başına var olur | `sat_urun_kategoriler.kendi_basina` | **=** |
| `product_category.min_count` / `max_count` | Bölüm tekrar sınırı | `sat_urun_kategoriler.min_adet` / `max_adet` | **=** |
| `component_type.component_category_id` | Bileşen kategorisi | `sat_referanslar.ust_kod` | **=** |
| `unit_type.symbol` / `currency.symbol` | Sembol (m², kg…) | `sat_teklif_kalemleri.ikincil_birim_sembol` + koddaki sembol sözlüğü | **=** |
| `proposal_term.proposal_term_category_id` | Metin kategorisi | `sat_metinler.kategori` | **=** |
| `configg.constant` / `content` | Ayar adı / içeriği | `sistem_ayarlari.anahtar` / `deger` **ve** `sat_form_kurallari.*` | **≈** |
| `work_order.work_order_status_id` / `deliverable_id` | Durum / bağlı teslimat | `is_emirleri.durum` / `teslimat_id` | **≈** |
| `deliverable.deliverable_status_id` | Teslimat durumu | `proje_teslimatlari.durum` | **≈** |
| `work_order_item.work_order_id` | Bağlı iş emri | `is_emirleri.form_snapshot` içi | **⊂** |
| `task.task_type_id` / `work_order_id` / `deliverable_id` / `component_product_id` | Üretim görevi bağları | ✖ | ✖ |
| `task_type.task_category_id` | Görev grubu | ✖ | ✖ |
| `my_file.image_thumbnail_path` / `image_medium_path` | Küçük/orta görsel | ✖ *(Supabase Storage kendi üretir)* | ✖ |
| `my_file.related_date` | Belge tarihi | ✖ | ✖ |
| `my_file_type.media` | Görsel/video mu | `proje_dosyalari.mime_type` | **≈** |
| `project.contact_email` / `contact_phone` | İrtibat e-posta/telefon | `projeler.irtibat_email` / `irtibat_telefon` | **=** |
| `project_component.proposal_id_copied_from` | Kopyalandığı teklif | ✖ *(bağ kurulabilir — bölüm 4)* | ✖ |
| `project_check_list.project_check_list_def_id` | Liste tanımı | ✖ | ✖ |
| `proposal_term.component_category_id` | Metnin geçerli olduğu bina türü | ✖ *(`sat_metinler`'de bina türü süzgeci yok)* | ✖ |

## A2. Eskide olup yenide karşılığı OLMAYAN, ama anlamlı alanlar

| Eski alan | Anlamı | Neden önemli |
|---|---|---|
| **`attribute_type.data_provider_id`** → `task_assignee` | **Bu alanı KİM dolduracak**: Satış (115 alan), Teknik Ofis (86 alan) *(diğer seçenekler: Üretim, Müşteri, Yok)* | **Kayda değer:** eski sistem her form alanının sorumlusunu tanımlamış. Yeni İş Emri formunda yalnız `SALT_OKUNUR` bayrağı var. Satış/Teknik Ofis iş bölümü buradan kurulabilir. |
| `attribute_type.text_of_technical_spec` | Alanın teknik şartname metni | `teknik_sartname_sablonu.cevap_sablonu` ile aynı işi yapıyor — iki sistemde iki ayrı şablon seti var, birleştirilmeli |
| `product_category.work_order_item_definable` (58 kategori) | Bu kategori iş emrinde kalem olarak tanımlanabilir mi | Yeni iş emri form bölümlerinin hangi kategorilerden doğduğunu belirler |
| `component_category.create_only_one_deliverable` | Yalnız "Diğer" kategorisinde açık | Nakliye/montaj gibi kalemler için tek teslimat üret kuralı |
| `component_type.eligible_for_project` (37 evet / 2 hayır) | Bu bileşen türü projeye taşınabilir mi | Teklif→teslimat dönüşümünde süzgeç |
| `customer_type.level` (1=ana 3 tür, 2=alt 8 tür) | Müşteri türü hiyerarşi seviyesi | Bizde ana/alt ayrımı kod ön ekiyle yapılıyor; `sat_referanslar.ust_kod` bu bilgiyi taşıyor ama seviye alanı yok |
| `project_status.closed` (Tamamlanan, İptal, Reddedilen) | Durum "kapanmış" sayılır mı | Raporlarda açık/kapalı iş ayrımı — bizde bu bayrak yok, durum adına bakılıyor |
| `proposal_status.closed` (Revize Edilen, Onaylanan, Reddedilen) | Aynı mantık teklifte | |
| `deliverable_status.closed` / `work_order_status.closed` | 12 durumun 11'i işaretli — **yalnız "Faturası kesilen" işaretsiz**; bayrağın anlamı ters kurulmuş görünüyor | Aktarımda körü körüne kopyalanmamalı |
| `proposal_component_status.closed` | Analiz durumu kapalı mı | |
| `my_file_type_permission.role` (130 satır, ROLE_* × belge türü) | **Hangi rol hangi belge türünü görür** | Yeni sistemde dosya izni yok — dosya aktarımıyla birlikte taşınmalı |
| `project_check_list_def.weight_in_project` | Kontrol listesinin proje ilerlemesindeki ağırlığı | `project.completion_rate` bundan hesaplanıyordu |
| `project_check_list_def.component_category_id` | Listenin geçerli olduğu bina türü | |
| `project_check_item_def.active` / `customer_is_responsible` | Madde aktif mi / müşteri sorumlusu mu | **`customer_is_responsible` müşteri portalının çekirdeği** |
| `project_check_item.completed` / `completed_date` / `note` | Kontrol maddesi tamamlandı mı | 3.446 tamamlanmış madde |
| `project_check_item_type.project_phase_id` | Maddenin ait olduğu proje fazı | 8 faz: Sözleşme/Proje/Üretim/Kalite Kontrol/Lojistik/Demontaj/Montaj/Teslimat |
| `work_order.planned_start_date` / `planned_transportation_date` / `planned_delivery_date` | **Planlanan başlangıç / sevkiyat / teslim tarihleri** | **Yeni İş Emri'nde planlama tarihi hiç yok** — üretim planlaması için gerekli |
| `deliverable.primary_unit_type_id` / `order_no` | Teslimat birimi / sırası | |
| `exchange_rate.currency_name` / `currency_code` | Döviz adı / kodu | Kur tablosu kurulursa gerekli |
| `exchange_rate.forex_buying` / `forex_selling` / `banknote_buying` / `banknote_selling` | **TCMB'nin dört kuru** (döviz alış/satış, efektif alış/satış) | Sözleşmede hangisinin kullanıldığı önemli — eski sistem dördünü de saklamış |
| `budget.sum_of_expected_amounts` / `sum_of_actual_amounts` | Bütçe beklenen/gerçekleşen toplam | Kullanılmamış (2 kayıt) |
| `budget_item.expected_amount` / `actual_amount` / `expense_type_id` | Bütçe kalemi | Kullanılmamış (23 kayıt) |
| `expense_type.expense_category_id` / `depends_on_product_category` | Gider türü ağacı | 68+15 satırlık hazır gider ağacı |
| `financial_analysis.year` / `operation_cost` / `sales_target` | **Yıllık işletme gideri + satış hedefi** (2019: 10M gider / 15M hedef, 2020: 4,08M / 25M) | Yeni sistemde yıllık hedef kavramı yok |
| `sehirler_eslesmis.baslik` / `ulke_id` / `veritabani_country_id` | Eski sistemin kendi şehir eşleştirme tablosu (3.731 satır) | Şehir/ülke standardı kurulacaksa hazır kaynak |
| `attribute_data_type.constant` / `attribute_field_type.constant` / `price_type.constant` | Kod sabitleri | Motorun iç işleyişi; taşındı |
| `print_template.jhi_primary` / `print_template_type_id` | Baskı şablonu | Tablo boş, PDF şablonu kodda |

**Tabloların kendi iç bağ kolonları** (yukarıdaki satırların içinde zaten anlatılan ilişkiler): `budget_item.budget_id` (kalem→bütçe), `component_product_price.component_product_price_set_id` (fiyat→hesap turu), `project_check_item.project_check_list_id` ve `project_check_item.project_check_item_type_id`, `project_check_item_def.project_check_item_type_id` (kontrol maddesi→liste/tür). Bunlar bağımsız bir bilgi taşımaz, ait oldukları tablonun yapısını kurar.

**Özet:** Kalan 106 alanın **41'inin karşılığı zaten var** (A1 — yazmayı atlamışım), **65'inin karşılığı yok** (A2). Bunlardan gerçekten değerli olan altısı: *alanı kim doldurur*, *belge türü rol izni*, *iş emri planlama tarihleri*, *durum kapalı bayrakları*, *müşteri sorumluluğu*, *TCMB dört kuru*.

---

# EK B — Yeni Sistemde Olup Eskide Karşılığı Olmayan Alanlar

Yeni sistemin 603 iş alanının 286'sı yukarıda geçti. Kalan 317 alan aşağıda; **büyük çoğunluğu eski sistemde hiç bulunmayan modüllere ait** — yani eşleştirilecek bir karşılığı yok, bunlar Workspace'in kazancı.

## B1. Eskide karşılığı olan ama yukarıda yazmadıklarım

| Yeni alan | Eski karşılığı |
|---|---|
| `sat_*.eski_id`, `eski_entity_id`, `eski_proje_id`, `eski_proje_adi` | **Aktarım köprüsü** — eski sistemin kayıt numarasını saklar |
| `sat_urunler.kategori_id` / `aktif` | `product.product_category_id` / *(eskide pasiflik yok)* |
| `sat_urun_kategoriler.*` | `product_category.*` (A1'de listelendi) |
| `sat_parametreler.kategori_id` / `zorunlu` / `duzenlenebilir` | `attribute_type.product_category_id` / `required` / `editable` |
| `sat_teklif_kalemleri.onerilen_fiyat` / `fiyat_hesap_tarihi` / `analiz_tarihi` / `analiz_eden` | `component_product_price_set.price_calculated_at` + `created_by` |
| `sat_teklifler.sartname_turu` | `proposal.technical_spec_type_id` |
| `sat_metinler.baslik` / `aktif` | `proposal_term.name` / *(yok)* |
| `sat_referanslar.ust_kod` / `ek_bilgi` / `aktif` | `component_category` / `secondary_unit_type` / *(yok)* |
| `sat_form_kurallari.*` (8 alan) | `configg` JSON kuralları |
| `projeler.musteri_adi` | `project.customer_id` → `customer.name` (metin kopyası) |
| `projeler.aset_link` | **Eski sisteme geri bağlantı** (`aset.aterko.com/entity/project/{id}`) — 12 projede dolu |
| `musteriler.firma_adi` / `yetkili_kisi` / `devir_alacak` | `customer.long_name` / `person.name` / *(yok)* |
| `kullanicilar.son_giris` | `jhi_persistent_audit_event` |
| `kullanici_rolleri.*` / `rol_izinleri.*` / `roller.sistem_rol` | `jhi_user_authority` / *(eskide izin matrisi yok)* |
| `audit_log.*` (9 alan) | `jhi_entity_audit_event` (7,5 milyon satır) |

## B2. Eskide hiç olmayan modüller — eşleştirilecek karşılık yok

| Modül | Yeni alanlar | Eskide |
|---|---|---|
| **Stok** | `stok_kartlari`: ortalama maliyet, son alış tarihi, özellikler, maliyet para birimi · `stok_hareketleri`: stok kartı, depo, birim maliyet, kullanıcı · `depolar` | ✖ Hiç yok |
| **Satınalma** | `satinalma_talepleri` 13 alan (talep no, talep eden, istenen tarih, teslim yeri, onaylayan, red gerekçe, bölünme…) · `talep_urunleri` 5 · `teklif_kayitlari` 6 (tedarikçi teklifi, vade, termin, alternatif ürün) · `satinalma_siparisleri` 20 (sipariş no, termin, ödeme vade, fatura onay zinciri, PDF) · `siparis_kalemleri` 5 · `mal_kabul_loglari` 9 · `tedarikciler` 8 | ✖ Hiç yok |
| **Sevkiyat** | `sevkiyat_belgeleri` 8 (plaka, şoför, irsaliye no, sevk tarihi) · `sevkiyat_kalemleri` | ✖ (eskide yalnız durum adı vardı) |
| **Üretim** | `uretim_is_emirleri` 3 (ustabaşı, tamamlanma) · `uretim_is_emri_kalemleri` 4 (atanan/tamamlanan miktar) | ✖ (eskide `task` vardı, hiç kullanılmamış) |
| **Montaj** | `montaj_hareketleri` 4 | ✖ |
| **Mali İşler** | `cari_hareketler` 19 alan (çek no, banka, vade, planlanan/gerçekleşen, projeksiyon, döviz, fatura yönü) | ✖ (eskide `budget` vardı, kullanılmamış) |
| **Görev Takip** | `yonetim_gorevleri` 8 (sahip, öncelik, taahhüt, taahhüt vade) · `gorev_notlari` | ✖ |
| **Bildirim** | `bildirimler` 7 · `bildirim_kurallari` 7 (olay kodu, dinamik alıcılar, cc rolleri) | ✖ |
| **İş Emri (yeni)** | `is_emirleri`: ek alıcılar, yayınlayan, iptal eden/nedeni, PDF · `is_emri_notlari` 4 · `urun_listesi_versiyonlari` 4 (kalem anlık görüntüsü) | ✖ (eskide iş emri vardı ama yayın/onay/PDF akışı yoktu) |
| **Teslimat ürünleri** | `teslimat_urunleri` 17 alan (ihtiyaç, üretilen, stoktan ayrılan, sevk edilen, saha teslim, uygulanan, teslim edilen miktarlar; ek ürün onayı, revizyon notu) | ✖ **Eskide teslimat yalnız bina adı + adet idi; malzeme kırılımı yoktu** |
| **Teslimat (bina) ek alanları** | `sevkiyat_baslangici`, `bina_yeri`, `kdvsiz_tutar`, `ek_veriler`, ürün listesi yayın zinciri (5 alan), `montaj_gerekli`, `is_sablon`, `sablon_etiketi`, `sartname_kodu` | ✖ |
| **Teknik Şartname** | `teknik_sartname_sablonu` 6 (bölüm no, gizleme, satır sırası, yeni tablo, başlık gizle) | **⊂** kısmen: `attribute_type.text_of_technical_spec` |
| **Dosya (yeni)** | `public_url`, `mime_type`, `boyut`, yükleyen bilgisi (proje/talep/sipariş dosyaları) | **≈** `my_file.path` + tür |
| **Form (yeni)** | `form_tanimlari.bolum_sirasi`, `soru_sirasi`, `secenek_metinleri` | **≈** `attribute_category.order_no`, `attribute_type.order_no` |

---

## Denetim sonucu

| | Toplam iş alanı | Haritada karşılığı belirlendi | Karşılığı yok (gerekçesiyle) |
|---|---|---|---|
| **Eski sistem** | 372 | **307** (%83) | 65 |
| **Yeni sistem** | 603 | **301** (%50) | 302 — tamamı eskide bulunmayan modüller |

Eski tarafta **açıkta tek alan kalmadı**; yeni taraftaki 302 alan ise eşleştirilemez, çünkü karşılığı olacak bir eski modül yok (Stok, Satınalma, Sevkiyat, Üretim, Montaj, Mali İşler, Görev, Bildirim).

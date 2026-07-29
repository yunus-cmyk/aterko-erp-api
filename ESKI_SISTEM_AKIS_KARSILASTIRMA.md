# Eski Sistem Akışı ↔ Workspace Bugünkü Durum — Karşılaştırma

**Tarih:** 29 Temmuz 2026 · Kaynaklar: eski sistemin çözülmüş Java kaynakları + arayüz paketi, Workspace'in bugünkü kodu (commit fc8f22e).

**İşaretler:** ✔ birebir eşleşiyor · ◐ bilinçli fark (senin kararınla eskiden ayrıldık) · ✖ eksik / bekliyor

---

## 1. Zincir adım adım

| # | Adım | Eski sistem | Workspace bugün | Durum |
|---|------|-------------|-----------------|-------|
| 1 | **Müşteri kartı** | customer + person (kişiler), 11 tür + alt tür, satış noktası, nereden duydu, temsilci | Aynı alanlar, aynı zorunluluklar, kişiler dahil | ✔ |
| 2 | **Müşteri satış durumu otomatiği** | Potansiyel → Görüşme Yapılmış (proje) → Teklif Sürecinde (teklif) → Satış Gerçekleşmiş (sözleşme) | Birebir aynı tetiklerle çalışıyor | ✔ |
| 3 | **Proje (fırsat) açılışı** | Proje ekranından, müşteri seçilerek | **Yalnız müşteri kartından**, müşteri salt okunur | ◐ *bizde daha sıkı — senin kararın* |
| 4 | **Proje numarası** | 5 haneli seri (72xxx) | Aynı serinin devamı | ✔ |
| 5 | **Proje durum otomatiği** | 16 durum, aksiyonlarla otomatik ilerler | Otomatik geçişler kodda bağlı: teklif ver→Teklif Sürecinde, kabul→Satışı Tamamlanan, ret→Reddedilen, sözleşme→Taslak→Onayda→Onaylandı→İmzalandı→Avans→Tamamlanan. **Analiz Sürecinde / Analizi Tamamlanan geçişleri 29.07 "yaşayan analiz" kararıyla kalktı** (analiz artık durum üretmez; eski kayıtlarda tarihsel durur) | ◐ *senin kararın* |
| 6 | **Durumu elle değiştirme** | updateProjectStatus (yetkili herkes?) | **Yalnız ADMIN** (uç 403 ile korur) | ◐ *senin kararın* |
| 7 | **Teklif açılışı** | YALNIZ proje içinden (CreateProposalByProjectId) | Yalnız proje içinden; `{kod}-TEK-NN`; bağımsız düğme yok; uç da id'siz isteği reddeder | ✔ |
| 8 | **Teklif başlığı** | Müşteri/proje tekliften değişmez; **Şartname Türü zorunlu alan** | Müşteri/proje/tarih salt okunur; **Şartname Türü tamamen kalktı** (şartname teslimat başına) | ◐ *senin kararın* |
| 9 | **Teklif bileşeni tanımı** | Ad + 39'luk Bileşen Türü + Büyüklük + Miktar; bina detayları (kat, duvar tipi…) ANALİZ formunda | Ad + **Bina Türü/Tipi + kat/ebat/duvar kesiti** doğrudan kalemde (teslimat formunun birebir karşılığı); 39'luk liste arşive çekildi | ◐ *senin kararın — "ilk tanım bileşende"* |
| 10 | **Opsiyonel kalem kuralları** | Toplama girmez; kabulde opsiyonel varsa engel | Birebir | ✔ |
| 11 | **Teklif durum akışı** | Taslak→Ver→Cevap Beklenen→Kabul/Ret/Revize; kabulde diğerleri revizeye | Birebir (buton görünürlükleri dahil) | ✔ |
| 12 | **Kabul yetkisi** | Satış Müdürü ayrıcalığı | `satis.teklif_onay` = YONETIM (Mahmut/Yakup/Mehmet + ADMIN) | ✔ |
| 13 | **Revize** | Yeni teklif kopyalanır, analiz verisi bölüm eşlemesiyle taşınır | Birebir (yeni bina alanları dahil) | ✔ |
| 14 | **Fiyat analizi akışı** | Öznitelik formu → Analiz Talep → (analizci) Döküm Üret → Fiyatları Tekrar Hesapla → Analizi Tamamla → önerilen fiyat | **YAŞAYAN ANALİZ (29.07 kararın):** satışçı/analizci ayrımı ve talep→tamamla adımları kalktı; analize direk başlanır, önerilen fiyat her döküm işleminde otomatik; tek kilit = teklif ONAYLANAN (revizede açılır). Hesap çekirdeği, kural motoru, fiyat kilidi ve "Bugünkü Satış" farkı korunur | ◐ *senin kararın — süreç iskeleti sadeleşti, çekirdek birebir* |
| 15 | **Analiz motoru** | Groovy formüller, ürün eşleme, fiyat kilidi | JS'e birebir çevrildi; arşivle %100 ürün / %99,3 miktar doğrulaması | ✔ |
| 16 | **Analiz çıktıları** | Analiz PDF raporu + Excel dökümü | **Henüz yok** (sırada: E1 PDF, E2 Excel) | ✖ |
| 17 | **Sözleşme** | Onaylı tekliften; tek onaylı teklif kuralı; kur sabitlenir; Ticari İşler onay zinciri | Birebir; onay = ADMIN; Sözleşme Oluştur artık Sözleşme sekmesinde | ✔ |
| 18 | **Teslimatların doğuşu** | AVANS'tan sonra, ELLE "Tüm Teslimatları Oluştur"; **adet kadar ayrı teslimat** | **Sözleşme Oluştur'da OTOMATİK**; tek satır + Bina Adedi; Diğer kalemler "Diğer" türüyle dahil | ◐ *senin kararın — biraz daha erken ve otomatik* |
| 19 | **Teslimat revizyonu** | recreate: hepsi silinip yeniden | Yalnız teklif içinden; kayıtta bağlı teslimatlar tazelenir, **iş emri açılmış teslimata dokunulmaz** (eskiden daha güvenli) | ◐ |
| 20 | **Teknik şartname** | Teklif başına tür + dosya (my_file) + analiz alan metinleri | **Teslimat başına, veritabanından dinamik PDF** (`{kod}-TŞ-NN`); satışta Teknik Şartnameler sekmesi | ◐ *yeni sistem üstün — senin kararın* |
| 21 | **Avans sonrası** | Proje "Devam eden"; üretim/teslimat takibi başlar | Avans → proje OTOMATİK Projeler modülüne (faz=TESLIMAT, SÖZLEŞME) → İş Emri/Üretim/Sevkiyat/Montaj modülleri | ◐ *eskinin 12 durumlu tek listesi bizde modüllere dağıldı* |
| 22 | **Kokpit / istatistik ekranı** | Vardı | İptal edildi (senin kararın) | ◐ |
| 23 | **Müşteri portalı** (ccenter) | Proje guid + şifre ile müşteri takibi | Yok — C5 olarak planlı | ✖ |

## 2. Proje detay sekmeleri karşılaştırması

| Eski sekme | Workspace bugün | Not |
|---|---|---|
| Genel | Genel ✔ | Proje Türü alanı bilinçli kaldırıldı ◐ |
| Teklifler | Teklifler ✔ | |
| Analiz | Analiz ✔ | bizde sıra: Şartnameler'den sonra |
| — | **Teknik Şartnameler** (yeni) | eskide sekme değildi ◐ |
| Sözleşme | Sözleşme ✔ | + teslimat listesi ve Sözleşme Oluştur burada |
| Teslimatlar | Sözleşme içinde ◐ | senin kararın |
| Yorumlar | Yorumlar ✔ | |
| Bütçe | Yok | eskide de fiilen kullanılmamıştı (2 kayıt) ✖ |
| Dosyalar | Satışta yok ✖ | 1.205 dosya S3'te — aktarım bekliyor (Projeler tarafında dosya modülü var) |
| Kontrol Listeleri | Yok ✖ | "istiyor muyuz" kararı bekliyor |

## 3. Özet sayım

- **Birebir eşleşen:** 12 adım — zincirin omurgası (müşteri, durum otomatikleri, teklif kuralları, analiz akışı+motoru, sözleşme).
- **Bilinçli fark:** 10 adım — hepsi senin kararınla ve "yeni sistemi koru" ilkesiyle: daha sıkı giriş kapıları (müşteriden fırsat, projeden teklif), bina tanımının kaleme inmesi, şartnamenin teslimata inmesi, teslimatın sözleşmede otomatik doğması, ADMIN durum istisnası.
- **Eksik / bekleyen:** 4 kalem — Analiz PDF + Excel (E1/E2, sırada), dosyalar (S3 aktarımı), müşteri portalı (C5), kontrol listeleri (karar).

**Yorum:** Satış zincirinin işleyen omurgası eski sistemle bire bir; ayrıştığımız her nokta kayıt altına alınmış bilinçli bir karar. Ekibin günlük işini engelleyebilecek tek gerçek boşluk analiz çıktıları (PDF/Excel) — kesme tarihi öncesi kapatılmalı.

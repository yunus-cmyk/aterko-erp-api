# Satınalma Modül Haritası

> Token tasarrufu için: Bir şey değiştirmeden önce bu haritaya bak, doğrudan
> ilgili satır numarasına git (Read offset/limit veya Edit). Grep yapma.
>
> **Bu dosya değişirse güncelle.** Yeni endpoint/fonksiyon eklenince satır numarası
> yazılmalı.

---

## BACKEND — `server.js`

### Talep
| Endpoint | Satır | Açıklama |
|---|---|---|
| `GET /api/satinalma-listesi` | 983 | Tüm talepler + proje listesi (filtre dropdown için) |
| `GET /api/satinalma-detay/:talepId` | 1058 | Bir talebin kalemleri |
| `POST /api/talep-durum-guncelle` | 1082 | Kalem bazlı durum (Onayla/Reddet seçilenler) |
| `POST /api/talep-onayla` | 1679 | Talep tüm kalemleri ONAYLANDI |
| `POST /api/talep-reddet` | 1709 | Talep REDDEDİLDİ |
| `POST /api/talep-iptal` | 1716 | Talep İPTAL + gerekce |
| `POST /api/talep-arsivle` | 1736 | arsiv=true |
| `POST /api/talep-guncelle` | 1763 | Talep + kalemler düzenle |
| `POST /api/talep-gerial` | 1975 | hedef_durum parametresi (forward/backward) |
| `GET /api/talep/:talepId/siparisler` | 1569 | Talebe bağlı siparişler |
| `GET /api/siparis/:siparisId/talep` | 1585 | Siparişin bağlı talebi |
| `GET /api/talep/:talepId/proje-kalem-havuzu` | 1283 | Madde 5: cross-talep için aynı projenin diğer kalemleri |

### Teklif
| Endpoint | Satır | Açıklama |
|---|---|---|
| `GET /api/teklif-havuzu` | 1602 | TEKLİF İSTENDİ kalemler |
| `POST /api/teklif-iste` | 1933 | Kalem(ler)i TEKLİF İSTENDİ yap |
| `POST /api/teklif-kaydet` | 1872 | Yapılandırılmış teklif kaydı (Madde 4) |
| `GET /api/teklifler/:talepUrunId` | 1908 | Bir kalemin tüm teklif kayıtları |
| `DELETE /api/teklif-sil/:id` | 1922 | Teklif sil |

### Sipariş
| Endpoint | Satır | Açıklama |
|---|---|---|
| `POST /api/siparis-kaydet` | 1375 | Yeni sipariş + talep bölme + cross-talep |
| `POST /api/siparis-guncelle` | 1825 | Sipariş kalemleri/başlık düzenle |
| `GET /api/siparis-listesi` | 1523 | Tüm aktif siparişler |
| `GET /api/siparis-detay/:siparisId` | 1546 | Sipariş kalemleri |
| `POST /api/siparis-onayla` | 1988 | durum=SİPARİŞ ONAYLANDI |
| `POST /api/siparis-gonder` | 2000 | durum=SİPARİŞ GÖNDERİLDİ + mail |
| `POST /api/siparis-iptal` | 2144 | (UI'dan çağrılmıyor — sadece backend) |
| `POST /api/siparis-arsivle` | 2282 | arsiv=true |
| `POST /api/siparis-gerial` | 2293 | hedef_durum parametreli geri çekme |
| `POST /api/siparis-tamamen-sil` | 2313 | Sipariş silinir + kalemler İŞLEME ALINDI'ya döner + birleştirme |
| `POST /api/siparis-teslim-al` | 2387 | Mal kabul + otomatik stok hareketi |
| `POST /api/siparis-fatura-onayla` | 2170 | Fatura no listesi + onay |
| `GET /api/siparis/:id/notlar` | yeni | İletişim notları listesi |
| `POST /api/siparis/:id/not-ekle` | yeni | Yeni not ekle |
| `DELETE /api/siparis-not-sil/:id` | yeni | Kendi notunu (veya ADMIN) sil |
| `GET /api/proje/:id/satinalma-ozeti` | yeni | Proje bütçe özeti |
| `GET /api/fatura-bekleyen-siparisler` | 2209 | TAM/KISMİ + fatura YOK |
| `GET /api/siparis-dosyalari/:siparisId` | 2587 | Eklenmiş dosyalar |
| `POST /api/siparis-dosya-yukle/:siparisId` | 2598 | Supabase Storage'a yükle |
| `DELETE /api/siparis-dosya-sil/:dosyaId` | 2639 | |
| `GET /api/siparis-pdf/:siparisId` | 2659 | Puppeteer PDF üret |

### Tedarikçi
| Endpoint | Satır |
|---|---|
| `GET /api/tedarikciler` | 1130 |
| `GET /api/tedarikci/:id` | 1150 |
| `POST /api/tedarikci-kaydet` | 1159 |
| `DELETE /api/tedarikci-sil/:id` | 1183 |

### Diğer
| Endpoint | Satır | Açıklama |
|---|---|---|
| `GET /api/kalem-durum-paneli` | 1198 | Madde 7: kalem bazlı durum tablosu |
| `GET /api/satinalma-arsiv` | 1627 | Arşivlenmiş talep+sipariş |

### Yardımcı Fonksiyonlar
| Fonksiyon | Satır | Açıklama |
|---|---|---|
| `talepBol(client, orijinalTalepId, kalanKalemler)` | ~1316 | Madde 6: kısmi siparişte alt-talep oluştur |
| `semaGuvence()` | ~5010 (sondan) | Startup'ta sequence + RLS + migration |

---

## FRONTEND — `index.html`

### HTML Yapısı
| ID | Satır | Açıklama |
|---|---|---|
| `#satinalmaArea` | 506 | Ana satınalma container |
| `#btnSubTalepler` / `#btnSubTeklif` / `#btnSubSiparisler` / `#btnSubKalemTakip` / `#btnSubTedarikciler` / `#btnSubArsiv` | 509-524 | Alt sekme butonları |
| `#satinalmaTaleplerDiv` | 538 | Talep tablosu container |
| `#talepArama` / `#talepDurumFiltre` / `#talepProjeFiltre` / `#talepTarihBas/Bit` / `#talepSayacLabel` | 543-565 | Talep filtreleri |
| `#talepTableBody` | 581 | Talep tablosu satırları |
| `#satinalmaTeklifDiv` / `#teklifHavuzuBody` | 586 / 604 | |
| `#satinalmaSiparislerDiv` | 609 | |
| `#siparisArama` / `#siparisDurumFiltre` / `#siparisTedarikciFiltre` / `#siparisTarihBas/Bit` / `#siparisTerminFiltre` / `#siparisSayacLabel` | 614-641 | Sipariş filtreleri |
| `#siparisTableBody` | 659 | |
| `#satinalmaKalemTakipDiv` (Madde 7) | 665 | |
| `#kalemTakipDurum` / `#kalemTakipProje` / `#kalemTakipArama` / `#kalemTakipOzet` / `#kalemTakipBody` | 671-712 | |
| `#satinalmaArsivDiv` / `#arsivTalepBody` | 717 / ~726 | |
| `#tedarikciArea` / `#tedarikciTableBody` | 336 / 369 | |

### Modallar
| ID | Satır | Açıklama |
|---|---|---|
| `#modalTalepOlustur` | 2311 | (eski) talep olustur — kullanılıyor mu? |
| `#modalYeniTalep` | 2371 | Aktif yeni talep modal |
| `#modalTalepDetay` | 2443 | Talep inceleme; `#dtModalTitle`, `#talepEkPanel`, `#detayTableBody`, `#dtTalepLevelBtns`, `#dtDynamicBtns` |
| `#modalSiparisOlustur` | 2500 | Sipariş kes; `#siparisKalemTableBody`, `#btnCrossTalep` |
| `#modalCrossTalep` | 2583 | (Madde 5) cross-talep picker; `#crossTalepHavuz` |
| `#modalTeklifIste` | 2612 | |
| `#modalTeklifKayitlari` (Madde 4) | 2666 | |
| `#modalSiparisDetay` | 2761 | |

### Fonksiyonlar — Talep
| Fonksiyon | Satır |
|---|---|
| `fetchSatinalmaListesi()` | 6152 |
| `renderTalepTableFiltered()` | 6177 |
| `getTalepAksiyonlari(t)` | 6253 |
| `renderTalepTable(talepler)` | 6283 |
| `toggleTalepKalemSatiri(talepId, btn)` (expand row) | ~6315 |
| `renderTalepKalemMini(kalemler)` | ~6340 |
| `talepOnayla(id)` | 6310 |
| `talepReddet(id)` | 6318 |
| `talepIslemeAl(id)` | 6328 |
| `talepGerial(id, hedef_durum)` | 6336 |
| `talepArsivle(id)` | 6345 |
| `openSiparisOlustur(talep_id, hedefKalemId)` | 6354 |
| `openYeniTalepModal(duzenlemeData)` | 6371 |
| `openTalepDuzenle(talepId)` | 6423 |
| `talepOlusturOnayla()` | 5087 |
| `openTalepDetayModal(talepId, talepNo)` | 6669 |
| `renderTalepDetayLevelButtons(talepId)` | 6696 |
| `talepOzetVeSiparisleriYukle(talepId)` | 6726 |
| `renderTalepDetayLines(kalemler)` | 6773 |

### Fonksiyonlar — Sipariş
| Fonksiyon | Satır |
|---|---|
| `openSiparisOlusturModal(duzenlemeData)` | 6927 |
| `openSiparisDuzenle(siparisId)` | 7015 |
| `renderSiparisFormLines(kalemler)` | 7032 |
| `submitPurchaseOrder()` | 7082 |
| `openCrossTalepPicker()` (Madde 5) | 7136 |
| `crossTalepEkle()` | 7184 |
| `crossKalemKaldir(btn)` | 7223 |
| `fetchSiparisListesi()` | 7622 |
| `renderSiparisTableFiltered()` | 7640 |
| `getSiparisAksiyonlari(s)` | 7686 |
| `renderSiparisTable(siparisler)` | 8124 |
| `toggleSiparisKalemSatiri(siparisId, btn)` (expand row) | ~8230 |
| `renderSiparisKalemMini(kalemler)` | ~8255 |
| `siparisOnayla(id)` | 8166 |
| `siparisGonder(id)` | 8174 |
| `siparisTamamenGerial(id)` | 8182 |
| `siparisIptal(id)` | 8191 (UI'dan çağrılmıyor) |
| `siparisGerial(id, hedef_durum)` | 8199 |
| `siparisArsivle(id)` | 8207 |
| `openSiparisDetayModal(siparisId, siparisNo)` | 7826 |
| `openSiparisTeslimAlModal(siparisId, siparisNo)` | 8221 |
| `submitOrderDelivery()` | 8288 |
| `openFiyatGecmisiModal(stokKartId, urunAdi)` | 8013 |

### Fonksiyonlar — Teklif
| Fonksiyon | Satır |
|---|---|
| `fetchTeklifHavuzu()` | 7377 |
| `renderTeklifHavuzu(kalemler)` | 7386 |
| `teklifSayisiYukle(talepUrunId, hedefSpanId)` | 7424 |
| `openTeklifKayitlariModal(talepUrunId, urunAdi)` (Madde 4) | 7436 |
| `teklifKayitlariYukle()` | 7456 |
| `teklifDuzenle(t)` | 7501 |
| `teklifKaydetSubmit()` | 7514 |
| `teklifSil(id)` | 7540 |
| `openTeklifIste(seedTalepId)` | 7747 |
| `submitTeklifIste()` | 7808 |

### Fonksiyonlar — Kalem Takibi (Madde 7)
| Fonksiyon | Satır |
|---|---|
| `fetchKalemTakipProjeler()` | 7231 |
| `fetchKalemTakip()` | 7242 |
| `renderKalemTakip(kalemler, ozet)` | 7260 |

### Fonksiyonlar — Tedarikçi / Arşiv / Sub-tab
| Fonksiyon | Satır |
|---|---|
| `switchSatinalmaSubTab(target)` | 7329 |
| `fetchArsiv()` | 7551 |
| `fetchTedarikciler()` | 8760 |

### Global State
| Değişken | Açıklama |
|---|---|
| `window.taleplerGlobal` | Son `/satinalma-listesi` yanıtı (talep filtre+detay buton için) |
| `window.siparislerGlobal` | Son `/siparis-listesi` (sipariş düzenleme için) |
| `window.satinalmaProjeler` | Proje dropdown |
| `aktifIncelenenTalepId` / `window.aktifIncelenenTalepNo` | Açık olan talep detay modal'ın talep id/no'su |
| `duzenlenenSiparisId` | Sipariş düzenleme modu (null=yeni) |
| `crossTalepKaynakId` / `crossTalepProjeId` (Madde 5) | Cross-talep picker için kaynak |
| `aktifTeklifKalemId` (Madde 4) | Teklif kayıtları modal'ı için aktif kalem |

---

## DURUM MAKİNESİ (workflow)

### Talep durumları
```
ONAY BEKLİYOR
   ↓ Onayla
ONAYLANDI ←─ (Geri Al)
   ↓ İşleme Al
İŞLEME ALINDI ←─ (Geri Al)
   ↓ Teklif İste (opsiyonel)
TEKLİF İSTENDİ ←─ (Geri Al → ONAYLANDI)
   ↓ Sipariş Oluştur
SİPARİŞ OLUŞTURULDU
   ↓ (sipariş geri alınırsa kalemler/talep → İŞLEME ALINDI)
```
- İPTAL ↔ ONAY BEKLİYOR (geri al)
- TAM TESLİM → terminal

**Sipariş açılabilir kalem durumları:** `İŞLEME ALINDI`, `TEKLİF İSTENDİ` (backend ve UI bunu enforce eder)

### Sipariş durumları
```
SİPARİŞ OLUŞTURULDU
   ↓ Onayla                ↑ Geri Al (silinir, kalemler İŞLEME ALINDI'ya)
SİPARİŞ ONAYLANDI ←─ Geri Al
   ↓ Gönder
SİPARİŞ GÖNDERİLDİ ←─ Geri Al
   ↓ Mal Kabul (parsiyel)
KISMİ TESLİM
   ↓ Mal Kabul (tam)
TAM TESLİM → Arşivle (terminal, geri al yok)
```

---

## YETKİ HARİTASI (data-izin-modul)

| Modül | Kullanım |
|---|---|
| `satinalma.talepler` | Talep CRUD + teklif iste/iptal + kalem takip |
| `satinalma.siparisler` | Sipariş CRUD + onay/gönder/iptal/geri al/dosya/arşiv |
| `satinalma.tedarikci` | Tedarikçi CRUD |

Sub-tab izin map'i: `index.html` ~3247

Backend middleware desenleri: `server.js` ~3522 (`{ pattern: /^\/api\/(...)/, modul, seviye }`)

---

## TAMAMLANAN MADDELER
1. ✅ Numaralama: ProjeNo-T/S-NNNN[-N] + sequence
2. ✅ Madde 4: Teklif Kayıtları
3. ✅ Madde 5: Cross-talep sipariş
4. ✅ Madde 6: Talep Bölme (-N alt-talep)
5. ✅ Madde 7: Kalem bazlı durum izleme paneli

## AÇIK ÖĞELER (gelecekte)
- KISMİ TESLİM için "Geri Al" (stok hareketi geri çekme)
- Sipariş İPTAL durumunda "Yeniden Aktif Et" butonu (gerekirse)
- Talep birleştirme (kardeş alt-talepleri tekrar tek talepte topla)

// 26 Temmuz yedeği sonrası eski sistemde doğan kayıtların Workspace'e aktarımı
// Kural: mevcut kayıt EZİLMEZ; yalnız yeni satır + boş alana dolgu. eski_id idempotent anahtar.
require('dotenv').config({ path: '/Users/yunus/Desktop/Aterko-API/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
    const cl = await pool.connect();
    try {
        await cl.query('BEGIN');

        // 1) MÜŞTERİ 41951 — Sabiha Kara
        let m = await cl.query('SELECT id FROM sat_musteriler WHERE eski_id=41951');
        let musteriId;
        if (m.rowCount) { musteriId = m.rows[0].id; console.log('müşteri zaten var:', musteriId); }
        else {
            const r = await cl.query(`INSERT INTO sat_musteriler
                (eski_id, ad, uzun_ad, email, telefon, adres, fatura_adresi, tip, alt_tur, durum,
                 nasil_duydu, ulke, sehir, temsilci_email, kaynak, olusturan, kayit_tarihi,
                 satis_durumu, durum_tarihi, satis_noktasi)
                VALUES (41951, 'Sabiha Kara', 'Sabiha Kara', 'sabiha@aterko.com', '+90 538 489 38 70',
                 'İstanbul', 'İstanbul', 'Bireysel', 'Bireysel', 'AKTIF',
                 'Müşteri Temsilcisi', 'Türkiye', 'İstanbul', 'Yakup Karakelle', 'aset-aktarim',
                 'aysebilgin@aterko.com', '2026-07-28T05:40:29Z', 'Teklif Sürecinde', '2026-07-28', 'Merkez')
                RETURNING id`);
            musteriId = r.rows[0].id; console.log('müşteri eklendi:', musteriId);
        }

        // 2) PROJELER 72902, 72903 (faz=SATIS) — 72901 zaten elle girilmiş (yalnız boş alan dolgusu)
        const projeler = [
            { kod: '72902', ad: 'Prefabrik Ofis Binası', sehir: 'Dakar', ulke: 'Senegal', adres: 'Dakar',
              irtibat: ['Marise DORSEMAINE', 'mdorsemaine@batinov.sn', '+221 33 824 04 28'],
              proje_turu: 'Şantiye / Kamp Binası', satis_turu: 'İhracat', satis_durumu: 'ANALIZ_SURECINDE',
              temsilci: 'Mahmut Akdağcık', eskiMusteri: 40519, tarih: '2026-07-27' },
            { kod: '72903', ad: 'Konteyner Ev Projesi', sehir: 'Ardahan', ulke: 'Türkiye', adres: 'Ardahan',
              irtibat: ['Sabiha Kara', 'sabiha@aterko.com', '+90 538 489 38 70'],
              proje_turu: 'Konut', satis_turu: 'Yurtiçi', satis_durumu: 'TEKLIF_SURECINDE',
              temsilci: 'Varol Aytekin', eskiMusteri: 41951, tarih: '2026-07-28' },
        ];
        const projeIdMap = {};
        for (const pr of projeler) {
            const v = await cl.query('SELECT id FROM projeler WHERE proje_kodu=$1', [pr.kod]);
            if (v.rowCount) { projeIdMap[pr.kod] = v.rows[0].id; console.log('proje zaten var:', pr.kod); continue; }
            const sm = await cl.query('SELECT id, ad FROM sat_musteriler WHERE eski_id=$1', [pr.eskiMusteri]);
            const r = await cl.query(`INSERT INTO projeler
                (proje_kodu, proje_adi, musteri_adi, sat_musteri_id, adres, sehir, ulke,
                 irtibat_adi, irtibat_email, irtibat_telefon, proje_turu, satis_turu,
                 faz, durum, satis_durumu, satis_temsilcisi, para_birimi, kdv_orani, olusturma_tarihi,
                 aset_link)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SATIS','TASLAK',$13,$14,'TL',20,$15,$16)
                RETURNING id`,
                [pr.kod, pr.ad, sm.rows[0]?.ad || pr.irtibat[0], sm.rows[0]?.id || null, pr.adres, pr.sehir, pr.ulke,
                 ...pr.irtibat, pr.proje_turu, pr.satis_turu, pr.satis_durumu, pr.temsilci, pr.tarih,
                 `https://aset.aterko.com/entity/project/${pr.kod}`]);
            projeIdMap[pr.kod] = r.rows[0].id;
            console.log('proje eklendi:', pr.kod, '→', r.rows[0].id);
        }
        // 72901: yalnız boş alanlar (sat_musteri_id + aset_link); mevcut hiçbir değer ezilmez
        const p901 = await cl.query(`UPDATE projeler SET
            sat_musteri_id = COALESCE(sat_musteri_id, (SELECT id FROM sat_musteriler WHERE eski_id=41855)),
            aset_link = COALESCE(aset_link, 'https://aset.aterko.com/entity/project/72901')
            WHERE proje_kodu='72901' RETURNING id, sat_musteri_id`);
        projeIdMap['72901'] = p901.rows[0].id;
        console.log('72901 boş alan dolgusu:', JSON.stringify(p901.rows[0]));

        // 3) TEKLİFLER — durum haritası eski→yeni; kalemler dahil
        const teklifler = [
            { eski: 32301, no: '72901-TEK-01', proje: '72901', eskiMusteri: 41855, tarih: '2026-07-27',
              durum: 'ONAYLANAN', para: 'EUR', kdv: 0, sartname: 'Birleşimli Konteyner',
              notlar: '• Fiyatlarımıza %20 KDV dâhil edilmemiştir. ( İhraç kayıtlı fatura kesilecektir)\n• Fiyat teklifimiz 5 gün süreyle geçerli olacaktır.',
              odemeK: `• Sözleşmenin imzalanmasını müteakip toplam bedelin %30'u nakit avans olarak, kalan %70'lik bakiye ise sevkiyat öncesinde banka havalesi/EFT yoluyla tahsil edilecektir.
• İŞVEREN, İhrac Kayıtlı satışlarda KDV miktarınca Teminat Çekini YÜKLENİCİ'ye verecektir. İşbu çek yukarıda belirtilen evrakların yasal süresi içerisinde YÜKLENİCİ' ye eksiksiz tesliminde iade edilecektir
• İŞVEREN İhraç Kayıtlı satışı yapılan ürünleri yasal süresi içerisinde yurt dışına ihraç etmek zorundadır. İŞVEREN, İhraç Kayıtlı satışlarda Gümrük Çıkış Beyannamesinin üzerinde "İmalatçı" ibaresi ile YÜKLENİCİ'nin ünvanı, vergi dairesini ve vergi numarasını belirtmeli ve aynı zamanda YÜKLENİCİ'nin faturasında bulunan ürün tanımlarını ve miktarlarını aynı şekilde hem kendi satış faturasına hem de Gümrük Çıkış Beyannamelerine yazmalıdır. Gümrük Çıkış Beyannamelerinin noter onaylı kopyası, İŞVEREN'in satış faturası kopyası ve KDV taahhütnamesi eksiksiz ve doğru bir şekilde yasal süresi içerisinde İŞVEREN tarafından YÜKLENİCİ'ye teslim edilmelidir. Belirtilen bu işlemlerin düzgün yapılmamasından dolayı YÜKLENİCİ'nin uğrayacağı tüm zararlar İŞVEREN tarafından YÜKLENİCİ'nin ilk talebinde derhal tazmin edilecektir.`,
              teslimatK: `• Konteynerler 14.08.2026 tarihinde sevk edilecektir.
• Sevkiyat, kalan ödemenin sevk gününden önce alınmasından sonra yapılmaktadır.
• İşveren kaynaklı tüm gecikmeler teslim süresine ilave edilecektir.
• Deprem, sel, yangın ve benzer afetler, seferberlik, grev, lokavt ve benzeri mücbir sebepler, nakliye veya montaj sırasındaki kaza veya hırsızlıktan doğan gecikmeler, teklif onay tarihinden sonraki değişiklikler, malzeme tedarikçilerinden doğan gecikmeler, sipariş teslim tarihine ilave edilecektir.`,
              dahil: `• Teklif ekinde bulunan plan ve teknik özelliklere uygun imalat yapılması (İç ve dış duvar panelleri ve birleşim elemanları, çatı kaplaması, tavan izolasyonu, tavan kaplaması, taban karkası, taban 14 mm fibercement kaplaması, koyu renk ahşap desenli 2 mm PVC yer kaplaması)
• Dış, iç duvarlar ve tavan 50 mm kalınlıkta PUR İzolasyonlu Sandviç Panel
• Tek kanat, çift açılımlı (tilt-and-turn) beyaz PVC pencereleri, 4+12+4 mm çift camların malzemesi 
• PVC duble dış kapısı,
• Elektrik tesisat kablo ,priz, anahtar, sigorta kutusu ve aydınlatma armatürlerinin verilmesi  

Not1: Köşe ve şaselerde minimum 2 mm profil kalınlığı olacaktır`,
              haric: `• Yukarıda belirtilen YÜKLENİCİ tarafından yapılacak işlerin dışında kalan tüm işler
• Yapının kurulması için gerekli olacak her türlü yasal izinler ve plan, proje hazırlatılması ve onaylatılması
• Yapının konulacağı zeminin ıslahı, zemin betonu, tüm hafriyat ve çevre düzenleme işlerinin yapılması
• Sıhhi tesisat borulama malzemeleri , armatür ve vitrifiyelerin temini 
• Bina harici her türlü dış bağlantıların (elektrik, pis su, temiz su, Doğalgaz vs.) yapılması
• Temiz su tesisat basınç dengeleyici ve tesisat ana bağlantı girişine havalandırması malzeme ve işçilikleri
• Elektrik ana dağıtım panosu (sayaç, kofra, ana sigorta vs.) ve topraklama malzeme ve işçilikleri
• Telefon, bilgisayar ve UPS tesisatları armatür malzemeleri ve işçilikleri
• Isıtma ve soğutma tesisatları (Kalorifer, klima vs.) 
• Petek, radyatörleri ve tüm mekanik havalandırma armatür malzeme ve işçilikleri
• Mobilya, soyunma dolap, vs tüm hareketli tefrişatlar
• Nakliye ve nakliye sigortası`,
              olusturma: '2026-07-27T06:37:26Z',
              kalemler: [{ eski: 15870651, ad: 'Tek Odalı Ofis Konteyneri',
                  aciklama: "2,40x6,00 m (3'lü birleşim) ; 7,20x6,00 m ; H: 2760 mm ; İç Net Yükseklik : 2500 mm",
                  miktar: 1, ikincil: 43.20, tur: 'Monoblok Konteyner Birleşimli Ofis', fiyat: 5290.00,
                  analiz: 'BELIRTILMEMIS', sira: 1 }] },
            { eski: 32302, no: '72902-TEK-01', proje: '72902', eskiMusteri: 40519, tarih: null,
              durum: 'TASLAK', para: 'TL', kdv: 18, sartname: null,
              notlar: null, odemeK: null, teslimatK: null, dahil: null, haric: null,
              olusturma: '2026-07-27T14:56:27Z',
              kalemler: [{ eski: 15870652, ad: 'Tek Katlı Ofis Binası',
                  aciklama: 'H:2500 mm Dış ve İç Duvar : 60 mm',
                  miktar: 1, ikincil: 219.15, tur: 'Prefabrike Ofis', fiyat: 0,
                  analiz: 'ANALIZ_SURECINDE', sira: 1 }] },
            { eski: 32303, no: '72903-TEK-01', proje: '72903', eskiMusteri: 41951, tarih: '2026-07-28',
              durum: 'CEVAP_BEKLENEN', para: 'TL', kdv: 20, sartname: 'Birleşimli Konteyner',
              notlar: '• Fiyatlarımıza %20 KDV dâhil edilmiştir.\n• Fiyat teklifimiz 5 gün süreyle geçerli olacaktır.',
              odemeK: `• Toplam sipariş bedelinin %50'si sipariş onayı ile birlikte nakit olarak, kalan %50'si ise sevkiyat öncesinde nakit olarak ödenecektir.`,
              teslimatK: `• Sipariş onayın verilmesini ve avans ödemesinin yapılmasından sonra 30 iş günü içinde sevkiyat başlayacaktır. 
• Sevkiyat, kalan ödemenin sevk gününden önce alınmasından sonra yapılmaktadır. 
• İşveren kaynaklı tüm gecikmeler teslim süresine ilave edilecektir.
• Deprem, sel, yangın ve benzer afetler, seferberlik, grev, lokavt ve benzeri mücbir sebepler, nakliye ve montaj sırasındaki kaza veya hırsızlıktan doğan gecikmeler, teklif onay tarihinden sonraki değişiklikler, malzeme tedarikçilerinden doğan gecikmeler, sipariş teslim tarihine ilave edilecektir.`,
              dahil: `• Teklif ekinde bulunan plan ve teknik özelliklere uygun imalat yapılması (İç ve dış duvar panelleri ve birleşim elemanları, çatı kaplaması (0,50 mm trapez galvaniz sac), tavan izolasyonu, tavan kaplaması, taban karkası ve izolasyonu, taban 14 mm fibercement kaplaması, 2 mm PVC yer kaplaması)
• PVC pencereleri ve 4+12+4 mm çift camların montaj yapılması 
• Boyalı sac dış kapıların montajı, Amerikan panel iç kapıların montajı
• Elektrik tesisatının çekilmesi, priz, anahtar ve aydınlatma armatürlerinin takılması
• Sıhhi tesisat borulama yapılması, armatür ve vitrifiyelerin montaj yapılması (Klozet, lavabo ve duş teknesi)
• Konteynerin nakliye aracının üzerine yüklenmesi`,
              haric: `• Yukarıda belirtilen YÜKLENİCİ tarafından yapılacak işlerin dışında kalan tüm işler
• Montaj işlerinin yapılması
• Beşik çatı montajı
• Yapının kurulması için gerekli olacak her türlü yasal izinler ve plan, proje hazırlatılması ve uygulatılması
• Yapının konulacağı zeminin ıslahı, zemin betonu, tüm hafriyat ve çevre düzenleme işlerinin yapılması 
• Bina harici her türlü dış bağlantıların (elektrik, pis su, temiz su, Doğalgaz vs.) yapılması
• Temiz su tesisat basınç dengeleyici ve tesisat ana bağlantı girişine havalandırması malzeme ve işçilikleri 
• Elektrik ana dağıtım panosu (sayaç, kofra, ana sigorta vs.) ve topraklama malzeme ve işçilikleri 
• Telefon, bilgisayar ve UPS tesisatları armatür malzemeleri ve işçilikleri 
• Her türlü Mutfak sıhhi tesisatı ve mutfak ekipmanları mutfak elektrik tesisatı malzeme ve işçilikleri
• Isıtma ve soğutma tesisatları (Kalorifer, klima vs.) 
• Petek, radyatörleri ve tüm mekanik havalandırma armatür malzeme ve işçilikleri
• Nakliye ve nakliye sigortası, 
• Malzemelerin şantiyede araç üzerinden indirilmesi
• Malzemelerin şantiyede çalınmalara karşı güvenliğinin sağlanması`,
              olusturma: '2026-07-28T05:46:22Z',
              kalemler: [{ eski: 15870653, ad: 'Konteyner Konut Binası',
                  aciklama: "3,00x7,00 m 2'li Birleşim",
                  miktar: 1, ikincil: 59.50, tur: 'Monoblok Konteyner Birleşimli Yatakhane', fiyat: 391666.67,
                  analiz: 'BELIRTILMEMIS', sira: 1 }] },
        ];

        for (const t of teklifler) {
            const v = await cl.query('SELECT id FROM sat_teklifler WHERE eski_id=$1', [t.eski]);
            if (v.rowCount) { console.log('teklif zaten var:', t.no); continue; }
            const sm = await cl.query('SELECT id FROM sat_musteriler WHERE eski_id=$1', [t.eskiMusteri]);
            const araToplam = t.kalemler.filter(k => !k.opsiyonel).reduce((s, k) => s + k.miktar * k.fiyat, 0);
            const kdvTutar = Math.round(araToplam * t.kdv) / 100;
            const buyukluk = t.kalemler.filter(k => k.ikincil).reduce((s, k) => s + k.miktar * k.ikincil, 0);
            const r = await cl.query(`INSERT INTO sat_teklifler
                (eski_id, teklif_no, musteri_id, proje_id, eski_proje_id, eski_proje_adi, teklif_tarihi,
                 durum, para_birimi, kdv_orani, ara_toplam, kdv_tutar, genel_toplam, opsiyonlu_toplam,
                 notlar, odeme_kosullari, teslimat_kosullari, dahil_isler, haric_isler, sartname_turu,
                 toplam_buyukluk, olusturan, olusturma_tarihi)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
                RETURNING id`,
                [t.eski, t.no, sm.rows[0].id, projeIdMap[t.proje], parseInt(t.proje),
                 null, t.tarih, t.durum, t.para, t.kdv, araToplam, kdvTutar, araToplam + kdvTutar, araToplam,
                 t.notlar, t.odemeK, t.teslimatK, t.dahil, t.haric, t.sartname,
                 buyukluk ? buyukluk.toLocaleString('tr-TR', { minimumFractionDigits: 2 }) + ' m²' : null,
                 'aysebilgin@aterko.com', t.olusturma]);
            for (const k of t.kalemler) {
                await cl.query(`INSERT INTO sat_teklif_kalemleri
                    (eski_id, teklif_id, ad, aciklama, miktar, birim, ikincil_miktar, ikincil_birim,
                     ikincil_birim_sembol, opsiyonel, sira, birim_fiyat, toplam, analiz_durumu, bilesen_turu)
                    VALUES ($1,$2,$3,$4,$5,'Adet',$6,'Metrekare','m²',false,$7,$8,$9,$10,$11)`,
                    [k.eski, r.rows[0].id, k.ad, k.aciklama, k.miktar, k.ikincil, k.sira,
                     k.fiyat, Math.round(k.miktar * k.fiyat * 100) / 100, k.analiz, k.tur]);
            }
            // Kod sayacı: {kod}-TEK-01 kullanıldı → sayaç en az 1 olmalı
            await cl.query(`INSERT INTO sat_kod_sirasi (proje_id, varlik, deger) VALUES ($1,'teklif',1)
                ON CONFLICT (proje_id, varlik) DO UPDATE SET deger=GREATEST(sat_kod_sirasi.deger, 1)`,
                [projeIdMap[t.proje]]);
            console.log('teklif eklendi:', t.no, '(', t.durum, ')');
        }
        await cl.query('COMMIT');
        console.log('TAMAM — aktarım bitti.');
    } catch (e) { await cl.query('ROLLBACK'); console.error('HATA, geri alındı:', e.message); process.exit(1); }
    finally { cl.release(); await pool.end(); }
})();

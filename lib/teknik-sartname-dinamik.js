// =============================================================================
// TEKNİK ŞARTNAME — DİNAMİK ÜRETİCİ
// form_tanimlari (DB) + seçenek-metin sözlüğünden PDF HTML üretir.
// Yetenekler:
//   • secenek_metinleri  — seçim → şartname cümlesi (ham cevap yerine)
//   • kaynak_soru        — bir satır BAŞKA sorunun cevabına bakar (türetilmiş satır)
//   • kosullar           — "X=Yok→SORU_GIZLE": X boş/Yok ise satır gizlenir
// =============================================================================

const { processHesap, processDuz, processEger } = require('./pdf-generator');

// Bir satırın "mini şablonunu" (cevap_sablonu) motorla işler: HESAP→DÜZ→EĞER→temizle
function motorIsle(sablon, veri) {
    let h = processHesap(String(sablon), veri);
    h = processDuz(h, veri);
    h = processEger(h, veri);
    h = h.replace(/\{\{[^}]+\}\}/g, '');     // kalan placeholder'ları boşalt
    // satır satır temizle: eşleşmeyen EĞER'ler boş döner → boş satırları at
    return h.split('\n').map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(s => s).join('\n');
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trTarih = d => { const dt = new Date(d); return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`; };

// Teslimat + form cevaplarından motor için "veri" sözlüğü kurar (PDF üretimi ile önizleme ORTAK kullanır)
function teslimatVeri(t, kullaniciAd) {
    const ek = t.ek_veriler || {};
    const veri = {
        ...ek,
        'Bina Adı': t.bina_adi, 'Bina Tipi': t.bina_tipi, 'Kat Adedi': t.kat_adedi,
        'Kat Yüksekliği (mm)': t.kat_yuksekligi, 'Büyüklük': t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : '',
        'Bina Yeri': t.bina_yeri, 'Proje No': t.proje_kodu, 'Müşteri Adı': t.musteri_adi,
        'Proje Adı': t.proje_adi, 'Nakliye': t.nakliye
    };
    veri['TARİH'] = trTarih(new Date());          // {{TARİH}} / {{DÜZENLEYEN}} Proje Bilgileri bölümü için
    // "Satış Temsilcisi" projeden gelir (projeler.satis_temsilcisi); boşsa belgeyi üreten kişi.
    // {{DÜZENLEYEN}} placeholder'ı geriye dönük uyum için aynı değeri verir (şablon satırı
    // "Satış Temsilcisi" olarak yeniden adlandırıldı, cevap_sablonu değişmedi).
    veri['DÜZENLEYEN'] = t.satis_temsilcisi || kullaniciAd || '';
    veri['SATIŞ TEMSİLCİSİ'] = veri['DÜZENLEYEN'];
    veri['Sahada Montaj'] = t.montaj_gerekli ? 'Var' : 'Yok';   // Proje: sahada montaj gerekli mi (koşullu gizleme alanı)
    if (t.montaj_gerekli === false) veri['Montaj'] = 'Yok';     // geriye dönük uyum: eski "Montaj=Yok" kuralları
    return veri;
}

// Cevap metnini biçimler: "Etiket:" → bold italik (satır sonu/içi); "*" ile başlayan → gri italik not
function cevapBicim(metin) {
    const satirlar = String(metin == null ? '' : metin).split('\n');
    const out = [];
    for (let i = 0; i < satirlar.length; i++) {
        let s = satirlar[i];
        if (!s) continue;
        if (s.startsWith('*')) { out.push(`<span class="not">${esc(s)}</span>`); continue; }
        if (/:$/.test(s) && satirlar[i + 1] && !satirlar[i + 1].startsWith('*')) { s = s + ' ' + satirlar[++i]; }
        const m = s.match(/^([^:{}]{1,45}):\s*(.+)$/);
        if (m) out.push(`<b><i>${esc(m[1])}:</i></b> ${esc(m[2])}`);
        else out.push(esc(s));
    }
    return out.join('<br>');
}

// Bölüm koşullu gizleme: "Alan=Değer||Alan2=Değer2" — koşullardan HERHANGİ biri sağlanırsa bölüm gizlenir.
//   "=Yok" özel: alan boş VEYA "Yok" ise sağlanır. Çoklu seçim (dizi) için: "=Yok"→boş dizi, "=Değer"→içerir.
function bolumGizliMi(kosulStr, veri) {
    if (!kosulStr) return false;
    return String(kosulStr).split('||').some(k => {
        const eq = k.indexOf('=');
        if (eq < 0) return false;
        const alan = k.slice(0, eq).trim();
        const beklenen = k.slice(eq + 1).trim();
        if (!alan) return false;
        const cevap = veri[alan];
        if (beklenen === 'Yok') {
            if (Array.isArray(cevap)) return cevap.length === 0;
            const c = String(cevap == null ? '' : cevap).trim();
            return c === '' || c === 'Yok';
        }
        if (Array.isArray(cevap)) return cevap.map(x => String(x).trim()).includes(beklenen);
        return String(cevap == null ? '' : cevap).trim() === beklenen;
    });
}

function teknikSartnameHTML(t, ft, kullaniciAd) {
    const veri = teslimatVeri(t, kullaniciAd);

    // Ham cevap yerine şartname cümlesi (kütüphaneden), yoksa cevabın kendisi
    const metinAl = (a, deger) => {
        const sm = a.secenek_metinleri;
        return (sm && typeof sm === 'object' && sm[deger]) ? sm[deger] : deger;
    };
    // Bir satırın baktığı değer: kaynak_soru varsa o sorunun cevabı, yoksa kendi cevabı
    const alanDeger = a => veri[a.kaynak_soru || a.soru];
    // Koşullu gizleme: "X=Yok→SORU_GIZLE" → X boş/Yok ise satır gösterilmez
    const gizliMi = a => {
        if (!a.kosullar) return false;
        const m = String(a.kosullar).match(/^\s*(.+?)\s*=\s*(.+?)\s*(?:→|->)\s*SORU_GIZLE\s*$/);
        if (!m) return false;
        const alan = m[1].trim(), beklenen = m[2].trim();
        const cevap = String(veri[alan] == null ? '' : veri[alan]).trim();
        if (beklenen === 'Yok') return cevap === '' || cevap === 'Yok';
        return cevap === beklenen;
    };


    const cevapHTML = (a, v) => {
        // Yeni model: satırın ham mini-şablonu motorla işlenir (HESAP/EĞER/düz hepsi)
        if (a.cevap_sablonu != null) { const r = cevapBicim(motorIsle(a.cevap_sablonu, veri)); return r.trim() ? r : '-'; }
        // Eski model: secenek_metinleri / kaynak_soru — boş ise "-"
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '-';
        return Array.isArray(v)
            ? '<ul class="ml">' + v.map(md => `<li>${esc(metinAl(a, md))}</li>`).join('') + '</ul>'
            : esc(metinAl(a, v));
    };

    // Form bölümleri — koşulla gizlenenler atlanır, kalan satırlar gösterilir
    const bolumler = []; const map = {};
    ft.forEach(a => {
        const key = a.bolum_sirasi;   // bölüm no — başlıksız bölümler (bolum_adi='') çakışmasın
        if (!map[key]) { map[key] = { ad: a.bolum_adi, sira: a.bolum_sirasi, gizle: a.bolum_gizle || null, aciklama: a.bolum_aciklama || null, baslik_gizle: false, alanlar: [] }; bolumler.push(map[key]); }
        if (a.baslik_gizle) map[key].baslik_gizle = true;
        map[key].alanlar.push(a);
    });

    let formHtml = '';
    const gizlenenler = [];
    bolumler.forEach(b => {
        const no = String(b.sira != null ? b.sira : 0).padStart(2, '0');
        // Bölüm koşullu gizleme: "Alan=Değer||..." koşullarından biri sağlanırsa bölüm gösterilmez (sona not düşülür)
        if (b.gizle && bolumGizliMi(b.gizle, veri)) { gizlenenler.push(`[${no}] ${esc(b.ad)}`); return; }
        // Görünür satırlar (ana soru hariç + koşulla gizlenmeyenler)
        // Yalnızca eski model "ana soru" satırını gizle (cevap_sablonu'suz + başlığı bölüm adına eşit).
        // Panel satırlarının hepsinde cevap_sablonu var → başlığı bölüm adıyla aynı olsa bile düşmez.
        const gorunur = b.alanlar.filter(a => !(a.cevap_sablonu == null && a.soru === b.ad)).filter(a => !gizliMi(a));
        if (!gorunur.length) return;
        // yeni_tablo işaretine göre bölüm içi tablolara böl (başlıksız gruplama)
        const gruplar = [];
        gorunur.forEach(a => { if (!gruplar.length || a.yeni_tablo) gruplar.push([]); gruplar[gruplar.length - 1].push(a); });
        const satirHTML = a => {
            const soruHTML = esc(a.soru || '').split('\n')
                .map((s, i) => i === 0 ? s : `<span class="alt">${s}</span>`).join('<br>');
            return `<tr><td class="soru">${soruHTML}</td><td class="cevap">${cevapHTML(a, alanDeger(a))}</td></tr>`;
        };
        const tablolar = gruplar.map(g => `<table class="ts">${g.map(satirHTML).join('')}</table>`).join('');
        if (!b.baslik_gizle) formHtml += `
        <div class="bolum-bas"><span class="ana"><span class="bno">[${no}]</span> ${esc((b.ad || '').toLocaleUpperCase('tr'))}</span></div>`;
        if (b.aciklama) { const ac = motorIsle(b.aciklama, veri); if (ac) formHtml += `<div class="bolum-aciklama">${esc(ac).replace(/\n/g, '<br>')}</div>`; }
        formHtml += tablolar;
    });
    // Gizlenen bölümler için en sona not
    if (gizlenenler.length) {
        formHtml += `<div class="gizli-not">* ${gizlenenler.join(', ')} ${gizlenenler.length > 1 ? 'bölümleri' : 'bölümü'} kapsam dışı oldukları için gösterilmemiştir.</div>`;
    }

    const binaTuruBaslik = (t.bina_turu || '').toLocaleUpperCase('tr') + ' BİNA TEKNİK ÖZELLİKLERİ';
    const param = `[ ${esc(t.bina_tipi || '')} - ${esc(t.kat_yuksekligi || '')} mm - ${esc(t.kat_adedi || '')} Kat - ${esc(t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : '')} ]`;

    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><style>
      @import url('https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,400;0,500;0,700;1,400;1,700&display=swap');
      @page { margin: 20mm; size: A4; }
      * { box-sizing: border-box; }
      body { font-family:'Rubik','Arial',sans-serif; font-size:8pt; color:#1a1a1a; margin:0; }
      .header { margin-bottom:16px; }
      .header img { width:100%; height:auto; }
      .bolum-bas { margin:14px 0 5px; page-break-inside:avoid; }
      .bolum-bas .ana { color:#1a1a1a; font-weight:700; font-size:12pt; }
      .bolum-bas .ana .bno { color:#ff4c00; }
      .bolum-aciklama { font-weight:700; font-size:8.5pt; margin:0 0 6px; }
      .bolum-ana { display:flex; flex-direction:column; }
      .bolum-ana .turuncu { color:#ff4c00; font-weight:700; font-size:11pt; line-height:1.3; }
      table.ts { width:100%; border-collapse:collapse; margin-bottom:12px; page-break-inside:auto; }
      table.ts td { border:1px solid #ffad94; padding:5px 9px; vertical-align:top; font-size:8pt; line-height:1.4; }
      table.ts td.soru { font-weight:700; width:34%; }
      table.ts td.soru .alt { font-weight:400; font-size:7.5pt; color:#666; font-style:italic; }
      table.ts td.cevap .not { color:#666; font-style:italic; }
      .gizli-not { color:#888; font-style:italic; font-size:8pt; margin-top:12px; line-height:1.5; }
      table.ts ul.ml { margin:0; padding-left:16px; }
      table.ts tr { page-break-inside:avoid; }
    </style></head><body>
      <div class="header"><img src="images/siparis_logo.png" alt="ATERKO"></div>
      <div class="bolum-bas bolum-ana">
        <span class="turuncu">${esc(t.bina_adi || '')}</span>
        <span class="turuncu">${param}</span>
        <span class="ana">${esc(binaTuruBaslik)}</span>
      </div>
      ${formHtml}
    </body></html>`;
}

// =============================================================================
// İŞ EMRİ PDF gövdesi — içerik modeli eski İMALAT İŞ EMRİ belgesiyle aynı:
//   [01] İŞ EMRİ BİLGİLERİ  [02] TESLİMAT BİLGİLERİ  [03] PROJEDEKİ TESLİMATLAR
//   [04] İMALAT (form bölümleri alt-başlıklar halinde; Elektrik/Mekanik HARİÇ)
//   [05] ELEKTRİK VE MEKANİK  [06] İŞ EMRİ NOTU (varsa)
// Cevaplar formdaki HAM cevaplar (veri[soru]); TÜM sorular yazılır (boş → "-",
// "Yok" aynen), yalnız koşulla gizlenen sorular ve montajsız projede Montaj
// bölümü atlanır. Görsel dil teknik şartname ile birebir (Rubik 8pt, turuncu).
// ft: form_tanimlari [{bolum_adi, bolum_sirasi, soru, kosullar}]
// projeTeslimatlar: projedeki tüm (iptal olmayan) teslimatlar — bölüm [03] için
// =============================================================================
function isEmriHTML(t, ft, kullaniciAd, emirNo, isEmriNotu, projeTeslimatlar) {
    const veri = teslimatVeri(t, kullaniciAd);
    const simdi = new Date();
    const tarihSaat = `${trTarih(simdi)} ${String(simdi.getHours()).padStart(2, '0')}:${String(simdi.getMinutes()).padStart(2, '0')}`;

    // Bina tipi kompozit: Konteyner → "Monoblok Konteyner - 3x7 m - 1 Adet";
    // diğerleri → "Sandviç EPS - 3000 mm - 1 Kat"
    const kompozit = x => [
        x.bina_tipi,
        (x.bina_turu === 'Konteyner')
            ? (x.konteyner_ebadi ? x.konteyner_ebadi + (String(x.konteyner_ebadi).includes('m') ? '' : ' m') : '')
            : (x.kat_yuksekligi ? x.kat_yuksekligi + ' mm' : ''),
        (x.bina_turu === 'Konteyner')
            ? (x.konteyner_miktari ? x.konteyner_miktari + ' Adet' : '')
            : (x.kat_adedi ? x.kat_adedi + ' Kat' : '')
    ].filter(v => v && String(v).trim()).join(' - ');

    // Formdaki koşullu gizleme: "X=Y→SORU_GIZLE" — form ekranıyla BİREBİR aynı:
    // yalnız değer beklenene EŞİTSE gizle. ("boş=Yok" sayılMAZ — aksi halde formda
    // hiç olmayan bir alana bağlı koşul, cevaplanmış soruyu yanlışlıkla gizler;
    // ör. Konteyner "Duvar Kalınlığı (mm)" koşulundaki "Dış Duvar")
    const gizliMi = a => {
        if (!a.kosullar) return false;
        return String(a.kosullar).split('||').some(k => {
            const m = k.match(/^\s*(.+?)\s*=\s*(.+?)\s*(?:→|->)\s*SORU_GIZLE\s*$/);
            if (!m) return false;
            const cevap = veri[m[1].trim()];
            const beklenen = m[2].trim();
            if (Array.isArray(cevap)) return cevap.includes(beklenen);
            return String(cevap == null ? '' : cevap).trim() === beklenen;
        });
    };
    const cevapHTML = v => {
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '-';
        return Array.isArray(v)
            ? '<ul class="ml">' + v.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>'
            : esc(String(v)).replace(/\n/g, '<br>');
    };
    const satirHTML = (soru, cevap) => `<tr><td class="soru">${soru}</td><td class="cevap">${cevap}</td></tr>`;
    // Dış sistem linki satırı (ASET/DRIVE) — PDF'te tıklanabilir
    const linkSatir = (ad, url) => (url && String(url).trim())
        ? satirHTML(esc(ad), `<a href="${esc(String(url).trim())}">${esc(String(url).trim())}</a>`)
        : '';

    let sayac = 0;
    const anaBaslik = ad => `<div class="bolum-bas"><span class="ana"><span class="bno">[${String(++sayac).padStart(2, '0')}]</span> ${esc(String(ad).toLocaleUpperCase('tr'))}</span></div>`;
    const ciftler = liste => liste
        .filter(([, v]) => v != null && String(v).trim() !== '')
        .map(([s, v]) => satirHTML(esc(s), esc(String(v)))).join('');

    // [01] İŞ EMRİ BİLGİLERİ
    const isEmriBilgi = anaBaslik('İş Emri Bilgileri') + `<table class="ts">` + ciftler([
        ['Müşteri Adı', t.musteri_adi],
        ['Proje Adı', t.proje_adi],
        ['Satış Temsilcisi', t.satis_temsilcisi || kullaniciAd || ''],
        ['Başlangıç Tarihi', tarihSaat],
        ['Sevkiyat Başlangıç Tarihi', t.sevkiyat_baslangici ? trTarih(t.sevkiyat_baslangici) : ''],
        ['Sevk Yeri', t.bina_yeri],
        ['Nakliye Sorumluluğu', t.nakliye]
    ]) + linkSatir('ASET', t.aset_link) + linkSatir('DRIVE', t.drive_link) + `</table>`;

    // [02] TESLİMAT BİLGİLERİ — künye satırı + alanlar
    const kunye = `${t.proje_kodu} / ${t.musteri_adi || ''} - ${t.proje_adi || ''} [ ${t.bina_adi || ''} / ${t.bina_turu || ''} ] ${kompozit(t)} — ${t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : ''}`;
    const teslimatBilgi = anaBaslik('Teslimat Bilgileri') + `<table class="ts">` +
        `<tr><td class="cevap kunye" colspan="2">${esc(kunye)}</td></tr>` +
        ciftler([
            ['Bina Adı', t.bina_adi],
            ['Bina Tipi', t.bina_tipi],
            ...(t.bina_turu === 'Konteyner'
                ? [['Konteyner Ebadı', t.konteyner_ebadi], ['Konteyner Miktarı', t.konteyner_miktari]]
                : [['Kat Adedi', t.kat_adedi], ['Kat Yüksekliği (mm)', t.kat_yuksekligi]]),
            ['Büyüklük', t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : ''],
            ['Sahada Montaj', t.montaj_gerekli ? 'Var' : 'Yok']
        ]) + `</table>`;

    // [03] PROJEDEKİ TESLİMATLAR — projedeki tüm binalar (bu iş emrindeki koyu)
    let projeTesHTML = '';
    if (Array.isArray(projeTeslimatlar) && projeTeslimatlar.length) {
        projeTesHTML = anaBaslik('Projedeki Teslimatlar') + `<table class="ts">` +
            projeTeslimatlar.map(x => {
                const satir = `${x.bina_adi || ''} / ${x.bina_turu || ''} / ${kompozit(x)} / ${x.buyukluk_m2 ? x.buyukluk_m2 + ' m²' : '-'}`;
                const buMu = Number(x.id) === Number(t.id);
                return `<tr><td class="cevap" colspan="2">${buMu ? '<b>' : ''}${esc(satir)}${buMu ? ' ◄ (bu iş emri)' : ''}${buMu ? '</b>' : ''}</td></tr>`;
            }).join('') + `</table>`;
    }

    // [04] İMALAT + [05] ELEKTRİK VE MEKANİK — form bölümleri alt-başlıklar halinde
    const bolumler = []; const map = {};
    ft.forEach(a => {
        const key = a.bolum_sirasi;
        if (!map[key]) { map[key] = { ad: a.bolum_adi, sira: Number(a.bolum_sirasi) || 0, alanlar: [] }; bolumler.push(map[key]); }
        map[key].alanlar.push(a);
    });
    const bos = v => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
    const altBolumHTML = b => {
        // Bölüm KAPSAM DIŞI ise (tüm soruları hem koşulla gizli hem boş — ör. konteynerde
        // Bina Çatısı/Merdiven) hiç yazılmaz. Aksi halde bölümdeki TÜM sorular yazılır:
        // koşulla gizlenmiş olsa bile (imalat ekibi tam listeyi görsün; boş → "-").
        if (b.alanlar.every(a => gizliMi(a) && bos(veri[a.soru]))) return '';
        const rows = b.alanlar
            .filter(a => {
                // Cevabı "Var" olan kapı-soruları (Duvar=Var gibi) yazılmaz —
                // başlık altındaki asıl soru/cevaplar zaten sıralanıyor
                const v = veri[a.soru];
                return Array.isArray(v) || String(v == null ? '' : v).trim() !== 'Var';
            })
            .map(a => satirHTML(esc((a.soru || '').split('\n')[0]), cevapHTML(veri[a.soru]))).join('');
        if (!rows) return '';
        return `<div class="alt-bas">${esc(String(b.ad || '').toLocaleUpperCase('tr'))}</div><table class="ts">${rows}</table>`;
    };
    let imalatHTML = '', elektrikMekanikHTML = '';
    bolumler.sort((x, y) => x.sira - y.sira).forEach(b => {
        // Form ekranıyla aynı: montaj gerekmeyen projede Montaj bölümü hiç yazılmaz
        if (/^montaj$/i.test(String(b.ad || '').trim()) && veri['Montaj'] === 'Yok') return;
        // "Bina Bilgileri" → başlık "ONAYA SUNULACAK PROJELER", yalnız o sorunun cevapları
        // (bina tipi / kat / ebat satırları artık Teslimat Bilgileri'nde)
        if (/^bina bilgileri$/i.test(String(b.ad || '').trim())) {
            const osp = b.alanlar.find(a => /onaya sunulacak projeler|yapılacak projeler/i.test(a.soru || ''));
            const c = osp ? cevapHTML(veri[osp.soru]) : '';
            if (c && c !== '-') imalatHTML += `<div class="alt-bas">ONAYA SUNULACAK PROJELER</div><table class="ts"><tr><td class="cevap">${c}</td></tr></table>`;
            return;
        }
        const h = altBolumHTML(b);
        if (!h) return;
        if (/elektrik|mekanik/i.test(String(b.ad || ''))) elektrikMekanikHTML += h;
        else imalatHTML += h;
    });
    const imalat = imalatHTML ? anaBaslik('İmalat') + imalatHTML : '';
    const elektrikMekanik = elektrikMekanikHTML ? anaBaslik('Elektrik ve Mekanik') + elektrikMekanikHTML : '';

    // [0N] İŞ EMRİ NOTU — en sonda
    const notHTML = (isEmriNotu && String(isEmriNotu).trim())
        ? anaBaslik('İş Emri Notu') + `<table class="ts"><tr><td class="cevap">${esc(String(isEmriNotu).trim()).replace(/\n/g, '<br>')}</td></tr></table>`
        : '';

    const ustKunye = `${t.musteri_adi || ''} [ ${t.bina_adi || ''} ] ${t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : ''} - ${t.bina_yeri || ''}`;

    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><style>
      @import url('https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,400;0,500;0,700;1,400;1,700&display=swap');
      @page { margin: 20mm; size: A4; }
      * { box-sizing: border-box; }
      body { font-family:'Rubik','Arial',sans-serif; font-size:8pt; color:#1a1a1a; margin:0; }
      .header { margin-bottom:16px; }
      .header img { width:100%; height:auto; }
      .bolum-bas { margin:14px 0 5px; page-break-inside:avoid; }
      .bolum-bas .ana { color:#1a1a1a; font-weight:700; font-size:12pt; }
      .bolum-bas .ana .bno { color:#ff4c00; }
      .bolum-ana { display:flex; flex-direction:column; }
      .bolum-ana .turuncu { color:#ff4c00; font-weight:700; font-size:11pt; line-height:1.3; }
      .alt-bas { font-weight:700; font-size:9.5pt; margin:10px 0 4px; page-break-after:avoid; }
      table.ts { width:100%; border-collapse:collapse; margin-bottom:12px; page-break-inside:auto; }
      table.ts td { border:1px solid #ffad94; padding:5px 9px; vertical-align:top; font-size:8pt; line-height:1.4; }
      table.ts td.soru { font-weight:700; width:34%; }
      table.ts td.cevap .not { color:#666; font-style:italic; }
      table.ts td.kunye { font-style:italic; color:#444; }
      table.ts ul.ml { margin:0; padding-left:16px; }
      table.ts tr { page-break-inside:avoid; }
    </style></head><body>
      <div class="header"><img src="images/siparis_logo.png" alt="ATERKO"></div>
      <div class="bolum-bas bolum-ana">
        <span class="turuncu">İMALAT İŞ EMRİ // ${esc(t.bina_turu || '')}</span>
        <span class="turuncu">${esc(emirNo || '')} · ${esc(veri['TARİH'])}</span>
        <span class="ana">${esc(ustKunye.toLocaleUpperCase('tr'))}</span>
      </div>
      ${isEmriBilgi}
      ${teslimatBilgi}
      ${projeTesHTML}
      ${imalat}
      ${elektrikMekanik}
      ${notHTML}
    </body></html>`;
}

module.exports = { teknikSartnameHTML, teslimatVeri, cevapBicim, motorIsle, bolumGizliMi, isEmriHTML };

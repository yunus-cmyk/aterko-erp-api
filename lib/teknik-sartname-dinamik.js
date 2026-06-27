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

function teknikSartnameHTML(t, ft, kullaniciAd) {
    const ek = t.ek_veriler || {};
    const veri = {
        ...ek,
        'Bina Adı': t.bina_adi, 'Bina Tipi': t.bina_tipi, 'Kat Adedi': t.kat_adedi,
        'Kat Yüksekliği (mm)': t.kat_yuksekligi, 'Büyüklük': t.buyukluk_m2 ? t.buyukluk_m2 + ' m²' : '',
        'Bina Yeri': t.bina_yeri, 'Proje No': t.proje_kodu, 'Müşteri Adı': t.musteri_adi,
        'Proje Adı': t.proje_adi, 'Nakliye': t.nakliye
    };
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const trTarih = d => { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`; };
    veri['TARİH'] = trTarih(new Date());          // {{TARİH}} / {{DÜZENLEYEN}} Proje Bilgileri bölümü için
    veri['DÜZENLEYEN'] = kullaniciAd || '';

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

    // Cevap satırlarını biçimle:
    //  "Etiket:" (: ile biten) → bold italik + sonraki satırla aynı satıra birleştir
    //  "*" ile başlayan sabit açıklama → gri italik
    const cevapBicim = metin => {
        const satirlar = metin.split('\n');
        const out = [];
        for (let i = 0; i < satirlar.length; i++) {
            let s = satirlar[i];
            if (!s) continue;
            if (s.startsWith('*')) { out.push(`<span class="not">${esc(s)}</span>`); continue; }
            // "Etiket:" satır sonunda → sonraki satırla aynı satıra birleştir
            if (/:$/.test(s) && satirlar[i + 1] && !satirlar[i + 1].startsWith('*')) {
                s = s + ' ' + satirlar[++i];
            }
            // Satır içi "Etiket: içerik" → etiketi bold italik (hem "Kanal: .." hem "Şap ve İzolasyon:Hariçtir.")
            const m = s.match(/^([^:{}]{1,45}):\s*(.+)$/);
            if (m) out.push(`<b><i>${esc(m[1])}:</i></b> ${esc(m[2])}`);
            else out.push(esc(s));
        }
        return out.join('<br>');
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
        // Bölüm gizleme (HARİCİ): kaynak alan "Yok"/boş ise tüm bölüm gösterilmez (sona not düşülür)
        if (b.gizle) {
            const c = String(veri[b.gizle.alan] == null ? '' : veri[b.gizle.alan]).trim();
            if (b.gizle.deger === 'Yok' && (c === '' || c === 'Yok')) { gizlenenler.push(`[${no}] ${esc(b.ad)}`); return; }
        }
        // Görünür satırlar (ana soru hariç + koşulla gizlenmeyenler)
        const gorunur = b.alanlar.filter(a => a.soru !== b.ad).filter(a => !gizliMi(a));
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

module.exports = { teknikSartnameHTML };

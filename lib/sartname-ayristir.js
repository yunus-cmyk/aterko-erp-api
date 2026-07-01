// =============================================================================
// ŞARTNAME SATIR AYRIŞTIRICI
// Ham "mini şablon" (cevap_sablonu) ile panel-dostu seçenek→metin arasında dönüşüm.
//   ayristir(cevap_sablonu) → { tip, karar, secenekler:{seçim:metin}, ham }
//   kur(karar, secenekler)  → cevap_sablonu  (basit satırlar için geri serileştirme)
// "basit"   = tek karara bağlı, yalnızca '=' EĞER'leri, arada sabit metin/HESAP yok → panelde tablo
// "karmasik"= HESAP, çok karar, sabit metin karışık → panelde ham metin (gelişmiş)
// =============================================================================

function ayristir(cevap_sablonu) {
    const cs = String(cevap_sablonu == null ? '' : cevap_sablonu);
    const re = /\{\{([\s\S]*?)\}\}/g;
    const parcalar = []; let m, son = 0, arasiMetin = '';
    while ((m = re.exec(cs))) {
        arasiMetin += cs.slice(son, m.index);
        parcalar.push(m[1]); son = re.lastIndex;
    }
    arasiMetin += cs.slice(son);

    const egerler = parcalar.filter(p => p.startsWith('EGER:'));
    const digerPlaceholder = parcalar.some(p => !p.startsWith('EGER:')); // HESAP/HARICI/düz
    const sabitVar = arasiMetin.trim().length > 0;

    const secenekler = {}; const kararlar = new Set(); let hepsiEsittir = true; let tekrarSecenek = false;
    for (const e of egerler) {
        const mm = e.match(/^EGER:([^=!~]+?)(=|!=|~=|!~)([^:]+?):([\s\S]*)$/);
        if (!mm) { hepsiEsittir = false; continue; }
        kararlar.add(mm[1].trim());
        if (mm[2] === '=') {
            const anahtar = mm[3].trim();
            if (Object.prototype.hasOwnProperty.call(secenekler, anahtar)) tekrarSecenek = true;  // aynı seçenek 2 kez → 'karmasik'e düş (ham korunur, veri kaybı olmaz)
            secenekler[anahtar] = mm[4];
        }
        else hepsiEsittir = false;
    }

    // Hiç placeholder yok → düz sabit metin (panelde tek kutu)
    if (parcalar.length === 0) {
        return { tip: 'sabit', karar: null, secenekler: {}, metin: cs, ham: cs };
    }

    const basit = egerler.length > 0 && !digerPlaceholder && !sabitVar
        && kararlar.size === 1 && hepsiEsittir && !tekrarSecenek;

    return {
        tip: basit ? 'basit' : 'karmasik',
        karar: kararlar.size === 1 ? [...kararlar][0] : null,
        secenekler,
        ham: cs
    };
}

function kur(karar, secenekler) {
    return Object.entries(secenekler)
        .map(([sec, metin]) => `{{EGER:${karar}=${sec}:${metin}}}`)
        .join('');
}

module.exports = { ayristir, kur };

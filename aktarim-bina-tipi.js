// ============================================================================
// BİNA TİPİ SÖZLÜK BİRLEŞTİRME (Yunus kararı 2026-07-29)
// Eski üsluptaki teslimat bina_tipi değerlerini yeni tek sözlüğe çevirir:
//   "Sandviç EPS - 2500 mm - 1 Kat" → bina_tipi="Sac-EPS-Sac Sandviç Panel"
//                                     + kat_yuksekligi=2500 + kat_adedi=1 (boşsa)
//   "ARK - 90 mm"                   → bina_tipi="ARK" + dis_duvar_kesiti="90 mm" (boşsa)
// GÜVENLİK: yalnız kalıba TAM oturan değerler dönüştürülür; Konteyner'deki serbest
// tanımlar ("Monoblok WC Konteyneri - 3x7 m - 3 Adet"...) DOKUNULMADAN kalır.
// Orijinal değer ek_veriler.eski_bina_tipi'ye yedeklenir. Idempotent.
// Kullanım: node aktarim-bina-tipi.js [--uygula]   (bayraksız = yalnız rapor)
// ============================================================================
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const UYGULA = process.argv.includes('--uygula');

// Panel kalıbı → yeni sözlük adı (yalnız kesin eşleşmeler)
const PANEL = {
    'Sandviç EPS': 'Sac-EPS-Sac Sandviç Panel',
    'Sac EPS': 'Sac-EPS-Sac Sandviç Panel',
    'Sandviç Taşyünü': 'Sac-Taşyünü-Sac Sandviç Panel',
    'Betopan EPS': 'Betopan-EPS-Betopan Pres Panel',
    'Betopan Taşyünü': 'Betopan-Taşyünü-Betopan Karkaslı Panel',
    'Derzli Betopan EPS': 'Derzli Betopan-EPS-Betopan Pres Panel',
    'Derzli Betopan Taşyünü': 'Derzli Betopan-Taşyünü-Betopan Karkaslı Panel'
};
// Konteyner: yalnız tam değer eşleşmesi (serbest tanımlara dokunma)
const KONTEYNER_TAM = new Set(['Monoblok Konteyner', 'Demonte Konteyner',
    'Monoblok Birleşimli Konteyner', 'Demonte Birleşimli Konteyner', 'Birleşimli Monoblok Konteyner']);

// Yunus'un elle kararları (BINA_TIPI_ESLESTIRME.xlsx, 2026-07-29) — tam değer eşleşmesi
const KARARLAR = {
    'İkili WCDuşlu - 3x7 m - 2x4 adet': 'Monoblok Konteyner',
    'Kenarda Duşlu - 3x7 m - 2 Adet': 'Monoblok Konteyner',
    'Klozet Banyolu - 3x7 m/3x8 mm - 12 Adet': 'Monoblok Konteyner',
    'Modüler Unite - 1,35x1,35 m - 1 Adet': 'Monoblok Konteyner',
    'Modüler Unite - 1,5x2 m - 1 Adet': 'Monoblok Konteyner',
    'Modüler Unite - 2x2,6 m - 1 Adet': 'Monoblok Konteyner',
    'Nöbetçi - 2,4x3 m - 1 Adet': 'Monoblok Konteyner',
    'Rebox': 'Monoblok Konteyner',
    'Taban Tavan Direk Panel - 3x7 m - 1 Adet': 'Demonte Konteyner',
    'Tek Katlı Birleşimli Konteyner - 3x5 m - 3 Adet': 'Monoblok Birleşimli Konteyner',
    'Tek Katlı Birleşimli Konteyner - 3x6 m - 12 Adet': 'Monoblok Birleşimli Konteyner',
    'Tek Katlı Birleşimli Konteyner - 3x7 m - 3 Adet': 'Monoblok Birleşimli Konteyner',
    'Tek Odalı - 3x7 m - 5 adet': 'Monoblok Konteyner',
    'Tek Odalı Evye Tezgahlı Konteyner - 3x7 m - 1 Adet': 'Monoblok Konteyner',
    'Tekli Alaturka WC - 1,7x1,05 m - 1 Adet': 'Monoblok Konteyner',
    'Tekli Alaturka WC - 1,7x2,10 m - 1 Adet': 'Monoblok Konteyner',
    'Tekli Klozet - 1,35x1,35 - 1 Adet': 'Monoblok Konteyner',
    'Tekli WC - 1,30x1,15 m - 18 Adet': 'Monoblok Konteyner',
    'Tekli WCDuşlu - 3x7 m - 36 adet': 'Monoblok Konteyner',
    'WC Duş - 1,30x2,30 m - 2 Adet': 'Monoblok Konteyner',
    'YAP - 6000 mm - 1 Kat': 'Yapısal Çelik Hangar'
};

function cevir(t) {
    const v = (t.bina_tipi || '').trim();
    if (!v) return null;
    // Zaten yeni sözlükte mi?
    const YENI = new Set([...Object.values(PANEL), 'Monoblok Konteyner', 'Demonte Konteyner',
        'Monoblok Birleşimli Konteyner', 'Demonte Birleşimli Konteyner', 'Hafif Çelik Bina',
        'Hafif Çelik Konut', 'ARK', 'Yapısal Çelik Hangar', 'Yapısal Çelik Diğer',
        'Trapez Sac-Taşyünü-Betopan Karkaslı Panel', 'Mikrolambri Sac-Taşyünü-Betopan Karkaslı Panel',
        'Mikrolambri Sac-Taşyünü-Mikrolambri Sac Karkaslı Panel']);
    if (YENI.has(v)) return null;

    // 0) Elle karar: tanım metnindeki ebat/adet yine ayrıştırılır
    if (KARARLAR[v]) {
        const sonuc = { bina_tipi: KARARLAR[v], tanim: v };
        const ebat = v.match(/(\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?(?:\s*m)?(?:\s*(?:ve|&|\/)\s*[\d.,x m]+)?)/i);
        if (ebat) sonuc.konteyner_ebadi = ebat[1].trim();
        const adet = v.match(/(\d+)\s*[Aa]det/);
        if (adet) sonuc.konteyner_miktari = parseInt(adet[1]);
        const kat = v.match(/(\d)\s*Kat/i);
        if (kat) sonuc.kat_adedi = kat[1];
        return sonuc;
    }
    // 1) Panel kalıbı: "<panel> - <yükseklik> mm - <kat> Kat" (parçalar opsiyonel, sıra serbest değil)
    let m = v.match(/^(.+?)\s*-\s*(\d{4})\s*(?:mm)?\s*(?:-\s*(\d)\s*Kat)?$/i);
    if (m && PANEL[m[1].trim()]) {
        return { bina_tipi: PANEL[m[1].trim()], kat_yuksekligi: m[2], kat_adedi: m[3] || null };
    }
    m = v.match(/^(.+?)\s*-\s*(\d{4})\s*mm\s*-\s*(\d)\s*Kat$/i);
    if (m && PANEL[m[1].trim()]) {
        return { bina_tipi: PANEL[m[1].trim()], kat_yuksekligi: m[2], kat_adedi: m[3] };
    }
    if (PANEL[v]) return { bina_tipi: PANEL[v] };

    // 2) ARK ailesi: "ARK - 90 mm", "ARK 90-140 mm", "ARK - 90 mm ve ARK - 140 mm"...
    if (/^ARK\b/i.test(v)) {
        const kesit = v.replace(/^ARK\s*-?\s*/i, '').trim();
        return { bina_tipi: 'ARK', dis_duvar_kesiti: kesit || null };
    }

    // 3) Konteyner tam eşleşme (Birleşimli Monoblok → Monoblok Birleşimli normalize)
    if (KONTEYNER_TAM.has(v)) {
        return { bina_tipi: v === 'Birleşimli Monoblok Konteyner' ? 'Monoblok Birleşimli Konteyner' : v };
    }
    // 4) Konteyner serbest tanımları (YENİ SİSTEMİ KORU ilkesi — Yunus 2026-07-29):
    // alan yeni sistemde kapalı liste; tanım metni tipe çevrilir, metindeki ebat/adet
    // boş alanlara ayrıştırılır, orijinal metin ek_veriler'e yedeklenir.
    if (t.bina_turu === 'Konteyner' && /monoblok|demonte/i.test(v)) {
        const birlesimli = /birleşimli|birlesimli/i.test(v);
        const demonte = /demonte/i.test(v);
        const tip = demonte
            ? (birlesimli ? 'Demonte Birleşimli Konteyner' : 'Demonte Konteyner')
            : (birlesimli ? 'Monoblok Birleşimli Konteyner' : 'Monoblok Konteyner');
        const sonuc = { bina_tipi: tip, tanim: v };
        const ebat = v.match(/(\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?(?:\s*m)?(?:\s*(?:ve|&|\/)\s*[\d.,x m]+)?)/i);
        if (ebat) sonuc.konteyner_ebadi = ebat[1].trim();
        const adet = v.match(/(\d+)\s*[Aa]det/);
        if (adet) sonuc.konteyner_miktari = parseInt(adet[1]);
        return sonuc;
    }
    return null;   // kalıba oturmuyor — dokunma
}

(async () => {
    const cl = await pool.connect();
    try {
        const satirlar = (await cl.query(`SELECT id, bina_tipi, bina_turu, kat_adedi, kat_yuksekligi,
            dis_duvar_kesiti, ek_veriler FROM proje_teslimatlari WHERE COALESCE(bina_tipi,'') <> ''`)).rows;
        let donusen = 0, dokunulmayan = 0, zatenYeni = 0;
        const ornekler = [];
        await cl.query('BEGIN');
        for (const t of satirlar) {
            const c = cevir(t);
            if (!c) {
                const YENIMI = !cevir({ ...t, bina_tipi: t.bina_tipi });   // null = yeni ya da serbest
                (t.bina_tipi && !c ? dokunulmayan++ : zatenYeni++);
                continue;
            }
            donusen++;
            if (ornekler.length < 12) ornekler.push(`${t.bina_tipi}  →  ${c.bina_tipi}${c.kat_yuksekligi ? ' | yük ' + c.kat_yuksekligi : ''}${c.kat_adedi ? ' | kat ' + c.kat_adedi : ''}${c.dis_duvar_kesiti ? ' | kesit ' + c.dis_duvar_kesiti : ''}`);
            if (UYGULA) {
                const ekVeri = Object.assign({}, t.ek_veriler || {}, { eski_bina_tipi: t.bina_tipi });
                await cl.query(`UPDATE proje_teslimatlari SET bina_tipi=$1,
                    kat_yuksekligi=COALESCE(NULLIF(kat_yuksekligi,''), $2),
                    kat_adedi=COALESCE(NULLIF(kat_adedi,''), $3),
                    dis_duvar_kesiti=COALESCE(NULLIF(dis_duvar_kesiti,''), $4),
                    konteyner_ebadi=COALESCE(NULLIF(konteyner_ebadi,''), $5),
                    konteyner_miktari=COALESCE(konteyner_miktari, $6),
                    ek_veriler=$7 WHERE id=$8`,
                    [c.bina_tipi, c.kat_yuksekligi || null, c.kat_adedi || null,
                     c.dis_duvar_kesiti || null, c.konteyner_ebadi || null,
                     c.konteyner_miktari || null, JSON.stringify(ekVeri), t.id]);
            }
        }
        if (UYGULA) await cl.query('COMMIT'); else await cl.query('ROLLBACK');
        console.log(`${UYGULA ? 'UYGULANDI' : 'RAPOR (uygulanmadı — --uygula ile çalıştırın)'}`);
        console.log(`toplam dolu: ${satirlar.length} | dönüşen: ${donusen} | dokunulmayan (serbest tanım/yeni): ${satirlar.length - donusen}`);
        console.log('örnekler:'); ornekler.forEach(o => console.log('  ' + o));
    } catch (e) {
        await cl.query('ROLLBACK').catch(() => {});
        console.error('HATA, değişiklik yok:', e.message); process.exitCode = 1;
    } finally { cl.release(); await pool.end(); }
})();

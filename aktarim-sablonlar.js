// ============================================================================
// ESKİ SİSTEM ŞABLONLARI → ŞİRKET ORTAK DRIVE'I (Yunus kararı 01.10.2026)
//
// aterkoaset@gmail.com (kişisel Gmail) hesabına ait şablonlar (Teklif / Sözleşme / İş Emri /
// Teslimat / Analiz şablonları, antetli kâğıt …) yunus@aterko.com'a DEVREDİLEMİYOR:
// Google, sahipliği yalnız aynı kuruluş içinde devrettiriyor. Bu yüzden KOPYALANIR —
// kopyaların sahibi "Aterko Yedekler" ortak drive'ı (şirket) olur; e-posta gönderilmez,
// asıllar aterkoaset@gmail.com'da olduğu gibi kalır.
//
// Yalnız sahibi aterkoaset@gmail.com olan öğeler; klasör yapısı korunur. Klasörlerdeki
// başka hesaplara ait dosyalara (hizmet hesabının teklif/sözleşme belgeleri vb.) DOKUNULMAZ.
// Tekrar çalıştırılabilir: kopyalar appProperties.kaynak_id ile işaretlenir.
//
// Kullanım: node aktarim-sablonlar.js [--uygula]   (bayraksız = yalnız plan gösterir)
// ============================================================================
const { JWT } = require('google-auth-library');
const ARSIV = process.env.HOME + '/Desktop/Aterko-Eski-Sistem-Arsivi';
const k = require(ARSIV + '/gizli/GoogleServiceAccount.json');
const g = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/drive'] });
const API = 'https://www.googleapis.com/drive/v3';
const KAYNAK = 'aterkoaset@gmail.com';
const HEDEF_DRIVE = 'Aterko Yedekler';
const HEDEF_KLASOR = 'Eski Sistem Şablonları';
const KLASOR_MIME = 'application/vnd.google-apps.folder';
const UYGULA = process.argv.includes('--uygula');

async function istek(o) {
    for (let d = 1; ; d++) {
        try { return await g.request(o); }
        catch (e) {
            const s = e.response?.status;
            if (d < 6 && (!s || s === 429 || s >= 500)) { await new Promise(r => setTimeout(r, 1500 * d)); continue; }
            throw new Error(e.response?.data?.error?.message || e.message);
        }
    }
}
async function listele(params) {
    const out = [];
    for (let s; ; ) {
        const r = (await istek({ url: `${API}/files`, params: { ...params, pageSize: 1000, pageToken: s } })).data;
        out.push(...r.files); s = r.nextPageToken; if (!s) return out;
    }
}

(async () => {
    try {
        await g.authorize();
        // 1) Kaynak: sahibi aterkoaset@gmail.com olan her şey
        const ogeler = await listele({ q: `'${KAYNAK}' in owners and trashed = false`, fields: 'nextPageToken, files(id,name,mimeType,parents)' });
        const klasorler = new Map(ogeler.filter(o => o.mimeType === KLASOR_MIME).map(o => [o.id, o]));
        const dosyalar = ogeler.filter(o => o.mimeType !== KLASOR_MIME);
        // Bir klasörün altında (alt klasörler dahil) kopyalanacak dosya var mı?
        const ust = (o) => (o.parents || []).find(p => klasorler.has(p));
        const dolu = new Set();
        for (const f of dosyalar) for (let p = ust(f); p; p = ust(klasorler.get(p))) dolu.add(p);
        const yol = (o) => { const a = []; for (let p = ust(o); p; p = ust(klasorler.get(p))) a.unshift(klasorler.get(p).name); return a.join('/'); };
        console.log(`Sahibi ${KAYNAK}: ${dosyalar.length} dosya, ${klasorler.size} klasör`);
        console.log(`  Kopyalanacak dosya içeren klasör: ${[...dolu].map(id => klasorler.get(id).name).join(', ') || '-'}`);
        const bos = [...klasorler.values()].filter(k => !dolu.has(k.id)).map(k => k.name);
        console.log(`  İçinde ${KAYNAK}'a ait dosya OLMAYAN klasör (yalnız başka hesapların belgeleri; kopyalanmaz): ${bos.join(', ') || '-'}`);
        dosyalar.sort((a, b) => (yol(a) + '/' + a.name).localeCompare(yol(b) + '/' + b.name, 'tr'))
            .forEach(f => console.log(`    ${(yol(f) ? yol(f) + '/' : '')}${f.name}`));
        if (!UYGULA) { console.log('\n(Yalnız plan — kopyalamak için --uygula)'); return; }

        // 2) Hedef: ortak drive / "Eski Sistem Şablonları"
        const d = (await istek({ url: `${API}/drives`, params: { q: `name = '${HEDEF_DRIVE}'` } })).data.drives[0];
        if (!d) throw new Error(`"${HEDEF_DRIVE}" ortak drive'ı bulunamadı`);
        const ortak = { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'drive', driveId: d.id };
        const klasorAc = async (ad, ustId) => {
            const v = await listele({ ...ortak, q: `name = '${ad.replace(/'/g, "\\'")}' and '${ustId}' in parents and mimeType = '${KLASOR_MIME}' and trashed = false`, fields: 'nextPageToken, files(id)' });
            return v[0]?.id || (await istek({ url: `${API}/files`, method: 'POST', params: { supportsAllDrives: true },
                data: { name: ad, mimeType: KLASOR_MIME, parents: [ustId],
                    description: ustId === d.id ? `Eski sistemin şablonları — asılları ${KAYNAK} hesabında. 01.10.2026 kopyalandı (sahiplik kuruluşlar arası devredilemediği için).` : undefined } })).data.id;
        };
        const kok = await klasorAc(HEDEF_KLASOR, d.id);
        const esle = new Map();   // kaynak klasör id → hedef klasör id
        const hedefKlasor = async (id) => {
            if (!id) return kok;
            if (!esle.has(id)) esle.set(id, (async () => klasorAc(klasorler.get(id).name, await hedefKlasor(ust(klasorler.get(id)))))());
            return esle.get(id);
        };
        const mevcut = new Set((await listele({ ...ortak, q: `appProperties has { key='kaynak_hesap' and value='aterkoaset' } and trashed = false`,
            fields: 'nextPageToken, files(appProperties)' })).map(f => f.appProperties.kaynak_id));
        let kopya = 0, atla = 0; const hata = [];
        for (const f of dosyalar) {
            if (mevcut.has(f.id)) { atla++; continue; }
            try {
                await istek({ url: `${API}/files/${f.id}/copy`, method: 'POST', params: { supportsAllDrives: true },
                    data: { name: f.name, parents: [await hedefKlasor(ust(f))], appProperties: { kaynak_id: f.id, kaynak_hesap: 'aterkoaset' } } });
                kopya++;
            } catch (e) { hata.push(`${f.name}: ${e.message}`); }
        }
        console.log(`\n✅ Kopyalanan: ${kopya}, zaten vardı: ${atla}, hata: ${hata.length}`);
        hata.forEach(h => console.log('  ⚠️ ' + h));
        // 3) Doğrulama: hedefte kaynak başına bir kopya
        const son = await listele({ ...ortak, q: `appProperties has { key='kaynak_hesap' and value='aterkoaset' } and trashed = false`, fields: 'nextPageToken, files(appProperties)' });
        const kapsanan = new Set(son.map(f => f.appProperties.kaynak_id));
        console.log(`Doğrulama: ${dosyalar.filter(f => kapsanan.has(f.id)).length}/${dosyalar.length} kaynak dosyanın kopyası "${HEDEF_DRIVE}/${HEDEF_KLASOR}" içinde`);
    } catch (e) { console.error('❌ HATA:', e.message); process.exitCode = 1; }
})();

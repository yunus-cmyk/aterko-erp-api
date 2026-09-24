// ============================================================================
// ESKİ SİSTEM DOSYALARI → GOOGLE DRIVE (ORTAK DRIVE) — Yunus kararı 24.09.2026
//
// Supabase ücretsiz planı 2,6 GB'ı kaldırmadığı için eski sistem (aset) belgeleri
// şirketin Google Workspace ORTAK drive'larına yüklenir (dosyalar kişiye değil şirkete ait).
//
//   "Aterko Eski Sistem Arşivi"  (ekip görür)  → 1.205 kayıtlı belge
//        Projeler/{kod} - {proje adı}/…  |  Müşteriler/{müşteri}/…  |  Sahipsiz/…
//        Yüklenen her belgenin bağlantısı eski_dosyalar.workspace_yolu'na yazılır →
//        Workspace "Eski Sistem" sekmesi bağlantıyı gösterir.
//   "Aterko Yedekler"           (yalnız Yunus) → veritabanı yedeği + kayda bağlı
//        olmayan S3 dosyaları + küçük/orta resim kopyaları + geri yükleme talimatı
//
// Kimlik: eski sistemin Google hizmet hesabı (yerel arşivde gizli/GoogleServiceAccount.json),
// iki ortak drive'a "İçerik yöneticisi" olarak eklenmiş olmalı.
// Tekrar çalıştırılabilir: yüklenmiş dosya (appProperties.eski_id / ad) atlanır.
//
// Kullanım:  node aktarim-drive.js kontrol    → drive'ları bulur, yazma izni dener
//            node aktarim-drive.js belgeler   → 1.205 belge (ekip drive'ı)
//            node aktarim-drive.js yedek      → veritabanı yedeği + kayıtsız dosyalar
// ============================================================================
const fs = require('fs');
const path = require('path');
const { JWT } = require('google-auth-library');
const { pool } = require('./aktarim-ortak');

const ARSIV = process.env.HOME + '/Desktop/Aterko-Eski-Sistem-Arsivi';
const DOSYALAR = ARSIV + '/dosyalar/';
const DUMP = ARSIV + '/aset-veritabani-20260923.dump';
const DRIVE_BELGE = 'Aterko Eski Sistem Arşivi';
const DRIVE_YEDEK = 'Aterko Yedekler';
const PARCA = 32 * 1024 * 1024;   // resumable yükleme parçası (256 KB'ın katı)
const ESZAMAN = 4;                // aynı anda yüklenen dosya

const k = require(ARSIV + '/gizli/GoogleServiceAccount.json');
const g = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/drive'] });
const API = 'https://www.googleapis.com/drive/v3';
const ORTAK = { supportsAllDrives: true, includeItemsFromAllDrives: true };

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    dwg: 'application/acad', zip: 'application/zip', rar: 'application/vnd.rar', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mp4: 'video/mp4', mov: 'video/quicktime',
    txt: 'text/plain', dump: 'application/octet-stream' };
const mimeBul = (ad) => MIME[(path.extname(ad).slice(1) || '').toLowerCase()] || 'application/octet-stream';
const tirnak = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const temizAd = (s) => String(s || '').replace(/[\/\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || '(adsız)';

async function istek(o) {
    for (let deneme = 1; ; deneme++) {
        try { return await g.request(o); }
        catch (e) {
            const s = e.response?.status;
            if (deneme < 5 && (!s || s === 429 || s >= 500)) { await new Promise(r => setTimeout(r, 2000 * deneme)); continue; }
            throw new Error(e.response?.data?.error?.message || e.message);
        }
    }
}

async function driveBul(ad) {
    const r = await istek({ url: `${API}/drives`, params: { q: `name = '${tirnak(ad)}'`, useDomainAdminAccess: false, pageSize: 10 } });
    if (!r.data.drives.length) throw new Error(`"${ad}" ortak drive'ı bulunamadı ya da hizmet hesabı üye değil.`);
    return r.data.drives[0].id;
}

// Önbellek SÖZ (promise) tutar: eşzamanlı iki yükleme aynı klasörü iki kez oluşturmasın
const klasorOnbellek = {};
function klasor(driveId, ustId, ad) {
    const anahtar = ustId + '/' + ad;
    return (klasorOnbellek[anahtar] ||= (async () => {
        const r = await istek({ url: `${API}/files`, params: { ...ORTAK, corpora: 'drive', driveId,
            q: `name = '${tirnak(ad)}' and '${ustId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id)' } });
        return r.data.files[0]?.id || (await istek({ url: `${API}/files`, method: 'POST', params: { supportsAllDrives: true },
            data: { name: ad, mimeType: 'application/vnd.google-apps.folder', parents: [ustId] } })).data.id;
    })());
}

async function varMi(driveId, sorgu) {
    const r = await istek({ url: `${API}/files`, params: { ...ORTAK, corpora: 'drive', driveId, q: `${sorgu} and trashed = false`, fields: 'files(id)' } });
    return r.data.files[0]?.id || null;
}

// Parçalı (resumable) yükleme — 2 GB'lık yedek dahil her boyut için
async function yukle(yerel, meta) {
    const boyut = fs.statSync(yerel).size, tur = meta.mimeType || mimeBul(meta.name);
    const bas = await istek({ url: 'https://www.googleapis.com/upload/drive/v3/files', method: 'POST',
        params: { uploadType: 'resumable', supportsAllDrives: true },
        headers: { 'X-Upload-Content-Type': tur, 'X-Upload-Content-Length': String(boyut) }, data: meta });
    // gaxios yeni sürümde başlıkları Headers nesnesi olarak döndürüyor
    const oturum = typeof bas.headers.get === 'function' ? bas.headers.get('location') : bas.headers.location;
    if (!oturum) throw new Error('Yükleme oturumu adresi alınamadı');
    const fd = fs.openSync(yerel, 'r');
    try {
        for (let bas = 0; ; ) {
            const son = Math.min(bas + PARCA, boyut);
            const buf = Buffer.alloc(son - bas); fs.readSync(fd, buf, 0, buf.length, bas);
            const r = await istek({ url: oturum, method: 'PUT', data: buf, validateStatus: s => s === 308 || s < 300,
                headers: { 'Content-Range': `bytes ${bas}-${son - 1}/${boyut}`, 'Content-Type': tur } });
            if (r.status !== 308) return r.data.id;
            bas = son;
            if (boyut > 200 * 1048576) process.stdout.write(`\r   ${meta.name}: %${Math.round(100 * son / boyut)}   `);
        }
    } finally { fs.closeSync(fd); }
}

async function havuz(isler, n, fn) {
    let i = 0, biten = 0; const toplam = isler.length;
    await Promise.all(Array.from({ length: n }, async () => {
        while (i < isler.length) { const is = isler[i++]; await fn(is); if (++biten % 50 === 0) console.log(`  ${biten}/${toplam} işlendi`); }
    }));
}

async function kontrol() {
    for (const ad of [DRIVE_BELGE, DRIVE_YEDEK]) {
        const id = await driveBul(ad);
        // Önceki denemeden kalan test klasörleri çöpe
        const kalan = await istek({ url: `${API}/files`, params: { ...ORTAK, corpora: 'drive', driveId: id,
            q: `name = '_yazma-testi' and trashed = false`, fields: 'files(id)' } });
        for (const f of kalan.data.files) await istek({ url: `${API}/files/${f.id}`, method: 'PATCH', params: { supportsAllDrives: true }, data: { trashed: true } });
        const t = await istek({ url: `${API}/files`, method: 'POST', params: ORTAK, data: { name: '_yazma-testi', mimeType: 'application/vnd.google-apps.folder', parents: [id] } });
        // İçerik yöneticisi ortak drive'da kalıcı silemez → çöpe taşınır
        await istek({ url: `${API}/files/${t.data.id}`, method: 'PATCH', params: { supportsAllDrives: true }, data: { trashed: true } });
        console.log(`✅ "${ad}" bulundu, hizmet hesabı yazabiliyor.`);
    }
}

async function belgeler() {
    const driveId = await driveBul(DRIVE_BELGE);
    const r = (await pool.query(`
        SELECT d.eski_id, d.ad, d.s3_yolu, d.tur, d.olusturan, d.olusturma_tarihi, d.musteri_ile_paylas,
               p.proje_kodu, p.proje_adi, m.ad AS musteri_adi
        FROM eski_dosyalar d
        LEFT JOIN projeler p ON p.id = d.proje_id
        LEFT JOIN sat_musteriler m ON m.id = d.musteri_id
        WHERE d.workspace_yolu IS NULL ORDER BY d.eski_id`)).rows;
    console.log(`Yüklenecek belge: ${r.length}`);
    const projeler = await klasor(driveId, driveId, 'Projeler');
    const musteriler = await klasor(driveId, driveId, 'Müşteriler');
    const sahipsiz = await klasor(driveId, driveId, 'Sahipsiz');
    let tamam = 0, atla = 0; const hata = [];
    await havuz(r, ESZAMAN, async (d) => {
        try {
            const yerel = DOSYALAR + d.s3_yolu;
            if (!fs.existsSync(yerel)) throw new Error('yerel arşivde yok');
            const ust = d.proje_kodu ? await klasor(driveId, projeler, temizAd(d.proje_adi ? `${d.proje_kodu} - ${d.proje_adi}` : d.proje_kodu))
                : d.musteri_adi ? await klasor(driveId, musteriler, temizAd(d.musteri_adi)) : sahipsiz;
            let id = await varMi(driveId, `appProperties has { key='eski_id' and value='${d.eski_id}' }`);
            if (id) atla++;
            else {
                id = await yukle(yerel, { name: temizAd(d.ad || d.s3_yolu), parents: [ust], mimeType: mimeBul(d.ad || d.s3_yolu),
                    appProperties: { eski_id: String(d.eski_id), kaynak: 'aset' },
                    description: `Eski sistemden (aset.aterko.com) aktarıldı. Tür: ${d.tur || '-'} | Yükleyen: ${d.olusturan || '-'} | ` +
                        `Tarih: ${d.olusturma_tarihi ? d.olusturma_tarihi.toISOString().slice(0, 10) : '-'}${d.musteri_ile_paylas ? ' | Müşteriyle paylaşılmıştı' : ''}`,
                    ...(d.olusturma_tarihi ? { createdTime: d.olusturma_tarihi.toISOString(), modifiedTime: d.olusturma_tarihi.toISOString() } : {}) });
                tamam++;
            }
            await pool.query(`UPDATE eski_dosyalar SET workspace_yolu=$1 WHERE eski_id=$2`, [`https://drive.google.com/file/d/${id}/view`, d.eski_id]);
        } catch (e) { hata.push(`${d.ad}: ${e.message}`); if (hata.length <= 3) console.log(`  ⚠️ ${d.ad}: ${e.message}`); }
    });
    console.log(`\nYüklenen: ${tamam}, zaten vardı: ${atla}, hata: ${hata.length}`);
    hata.slice(0, 20).forEach(h => console.log('  ⚠️ ' + h));
}

async function yedek() {
    const driveId = await driveBul(DRIVE_YEDEK);
    // 1) Veritabanı yedeği
    const dumpAd = path.basename(DUMP);
    if (await varMi(driveId, `name = '${tirnak(dumpAd)}' and '${driveId}' in parents`)) console.log(`${dumpAd} zaten var, atlandı.`);
    else {
        console.log(`${dumpAd} yükleniyor (${(fs.statSync(DUMP).size / 1048576).toFixed(0)} MB)…`);
        await yukle(DUMP, { name: dumpAd, parents: [driveId], mimeType: 'application/octet-stream',
            description: 'Eski sistem (aset.aterko.com) PostgreSQL tam yedeği, pg_dump -Fc (sürüm 17). 23.09.2026 kesin geçiş anı. 24.09.2026 doğrulandı: 90 tablo, 9.548.146 satır.' });
        console.log('\n✅ veritabanı yedeği yüklendi');
    }
    // 2) Belge kaydına bağlı olmayan S3 dosyaları + küçük/orta resim kopyaları
    const r = (await pool.query(`SELECT s3_yolu FROM eski_dosyalar`)).rows;
    const kayitli = new Set(r.map(x => x.s3_yolu));
    const kalanlar = fs.readdirSync(DOSYALAR).filter(f => !kayitli.has(f));
    const hedef = await klasor(driveId, driveId, 'aset-s3-kayitsiz-ve-resim-kopyalari');
    const mevcut = new Set();
    for (let sayfa; ; ) {
        const l = await istek({ url: `${API}/files`, params: { ...ORTAK, corpora: 'drive', driveId, q: `'${hedef}' in parents and trashed = false`,
            fields: 'nextPageToken, files(name)', pageSize: 1000, pageToken: sayfa } });
        l.data.files.forEach(f => mevcut.add(f.name)); sayfa = l.data.nextPageToken; if (!sayfa) break;
    }
    const yuklenecek = kalanlar.filter(f => !mevcut.has(f));
    console.log(`Kayıtsız dosya/resim kopyası: ${kalanlar.length}, yüklenecek: ${yuklenecek.length}`);
    const hata = [];
    await havuz(yuklenecek, ESZAMAN, async (f) => {
        try { await yukle(DOSYALAR + f, { name: f, parents: [hedef], mimeType: mimeBul(f) }); } catch (e) { hata.push(`${f}: ${e.message}`); }
    });
    console.log(`Kayıtsız dosyalar: ${yuklenecek.length - hata.length} yüklendi, hata: ${hata.length}`);
    hata.slice(0, 10).forEach(h => console.log('  ⚠️ ' + h));
    // 3) Geri yükleme talimatı
    const talimatAd = 'BENİOKU - Geri Yükleme.txt';
    if (!(await varMi(driveId, `name = '${tirnak(talimatAd)}' and '${driveId}' in parents`))) {
        const gecici = '/tmp/claude-501/benioku.txt';
        fs.writeFileSync(gecici, [
            'ATERKO — ESKİ SİSTEM (aset.aterko.com) YEDEĞİ', '',
            'aset-veritabani-20260923.dump', '  Eski sistemin PostgreSQL veritabanının TAM yedeği (23.09.2026, kesin geçiş anı).',
            '  Biçim: pg_dump custom (-Fc), PostgreSQL 17. 24.09.2026 doğrulandı: 90 tablo, 9.548.146 satır, hata yok.',
            '  İçinde müşteri verisi ve kullanıcı bilgileri var — yalnız yetkili kişiler erişmeli.', '',
            '  Geri yüklemek için (PostgreSQL 17 araçlarıyla):',
            '    createdb aset_arsiv',
            '    pg_restore --no-owner --no-privileges -d aset_arsiv aset-veritabani-20260923.dump', '',
            'aset-s3-kayitsiz-ve-resim-kopyalari/', '  Eski sistemin dosya deposunda olup hiçbir belge kaydına bağlı olmayan dosyalar',
            '  (büyük olasılıkla eski sistemde silinmiş belgeler) ve belge resimlerinin küçük/orta boy kopyaları.', '',
            'Kayıtlı 1.205 belge "Aterko Eski Sistem Arşivi" ortak drive\'ında, proje ve müşteri klasörlerinde.',
            'Workspace\'te her projenin "Eski Sistem" sekmesinden de açılabilir.' ].join('\n'));
        await yukle(gecici, { name: talimatAd, parents: [driveId], mimeType: 'text/plain' });
        fs.unlinkSync(gecici);
        console.log('✅ geri yükleme talimatı eklendi');
    }
}

(async () => {
    const adim = process.argv[2];
    try {
        await g.authorize();
        if (adim === 'kontrol') await kontrol();
        else if (adim === 'test') {   // tek dosya yükle → boyutu doğrula → çöpe at
            const id = await driveBul(DRIVE_BELGE);
            const dosya = DOSYALAR + fs.readdirSync(DOSYALAR).find(f => f.endsWith('.pdf'));
            const fid = await yukle(dosya, { name: '_yukleme-testi.pdf', parents: [id], mimeType: 'application/pdf' });
            const f = (await istek({ url: `${API}/files/${fid}`, params: { supportsAllDrives: true, fields: 'name,size' } })).data;
            const yerel = fs.statSync(dosya).size;
            console.log(`Test yüklemesi: Drive ${f.size} B / yerel ${yerel} B ${+f.size === yerel ? '✅ birebir' : '❌ FARKLI'}`);
            await istek({ url: `${API}/files/${fid}`, method: 'PATCH', params: { supportsAllDrives: true }, data: { trashed: true } });
        }
        else if (adim === 'belgeler') await belgeler();
        else if (adim === 'yedek') await yedek();
        else console.log('Kullanım: node aktarim-drive.js kontrol | belgeler | yedek');
    } catch (e) { console.error('❌ HATA:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();

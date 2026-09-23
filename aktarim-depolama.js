// ============================================================================
// DOSYA DEPOSU TAŞIMA — Supabase Seul → Frankfurt (Yunus onayı 23.09.2026)
// Ağustos'taki bölge taşımasında yalnız veritabanı taşınmıştı; dosya deposu
// (kova "siparis-ekleri") Seul projesinde kalmıştı. Seul kapatılırsa kaybolurdu.
//
// .env'de gerekenler:
//   SUPABASE_URL / SUPABASE_SERVICE_KEY           → Seul (kaynak; geçişten sonra Frankfurt olur)
//   SUPABASE_FRA_URL / SUPABASE_FRA_SERVICE_KEY   → Frankfurt (hedef)
//
// Adımlar (her biri tekrar çalıştırılabilir; var olan dosya atlanır):
//   node aktarim-depolama.js kopyala        → kovayı oluştur + Seul'deki tüm dosyaları kopyala
//   node aktarim-depolama.js adres          → DB'deki Seul adreslerini Frankfurt'a çevir
//   node aktarim-depolama.js eski-dosyalar  → eski sistemin 1.205 dosyasını yerel arşivden yükle
// ============================================================================
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pool } = require('./aktarim-ortak');

const KOVA = 'siparis-ekleri';
const SEUL_URL = process.env.SUPABASE_SEUL_URL || 'https://xhcamvwsexyvxngxidvx.supabase.co';
const FRA_URL = process.env.SUPABASE_FRA_URL || 'https://iwauehmnranjilddkmkz.supabase.co';
const ARSIV = process.env.HOME + '/Desktop/Aterko-Eski-Sistem-Arsivi/dosyalar/';

const seulAnahtar = process.env.SUPABASE_SEUL_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const fraAnahtar = process.env.SUPABASE_FRA_SERVICE_KEY;
if (!fraAnahtar) { console.error('❌ .env içinde SUPABASE_FRA_SERVICE_KEY yok.'); process.exit(1); }
const seul = createClient(SEUL_URL, seulAnahtar);
const fra = createClient(FRA_URL, fraAnahtar);

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', dwg: 'application/acad', zip: 'application/zip', rar: 'application/vnd.rar',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp4: 'video/mp4', mov: 'video/quicktime', txt: 'text/plain' };
const mimeBul = (ad) => MIME[(path.extname(ad).slice(1) || '').toLowerCase()] || 'application/octet-stream';

async function listele(istemci, yol = '') {
    let out = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await istemci.storage.from(KOVA).list(yol, { limit: 1000, offset: off });
        if (error) throw new Error('Listeleme: ' + error.message);
        for (const o of data) {
            const p = yol ? `${yol}/${o.name}` : o.name;
            if (o.id === null) out = out.concat(await listele(istemci, p)); else out.push({ p, boyut: o.metadata?.size || 0, tur: o.metadata?.mimetype });
        }
        if (data.length < 1000) break;
    }
    return out;
}

async function kovaHazirla() {
    const { data: kaynak } = await seul.storage.getBucket(KOVA);
    const { data: var_ } = await fra.storage.getBucket(KOVA);
    if (var_) { console.log(`Frankfurt'ta "${KOVA}" kovası zaten var.`); return; }
    const { error } = await fra.storage.createBucket(KOVA, {
        public: kaynak ? kaynak.public : true,
        fileSizeLimit: kaynak?.file_size_limit || undefined,
        allowedMimeTypes: kaynak?.allowed_mime_types || undefined,
    });
    if (error) throw new Error('Kova oluşturma: ' + error.message);
    console.log(`Frankfurt'ta "${KOVA}" kovası oluşturuldu (herkese açık: ${kaynak ? kaynak.public : true}).`);
}

async function kopyala() {
    await kovaHazirla();
    const kaynak = await listele(seul);
    const hedef = new Set((await listele(fra)).map(o => o.p));
    console.log(`Seul: ${kaynak.length} dosya | Frankfurt'ta zaten olan: ${[...hedef].length}`);
    let kopyalanan = 0, hata = 0;
    for (const o of kaynak) {
        if (hedef.has(o.p)) continue;
        const { data, error } = await seul.storage.from(KOVA).download(o.p);
        if (error) { console.error('  indirme hatası', o.p, error.message); hata++; continue; }
        const buf = Buffer.from(await data.arrayBuffer());
        const up = await fra.storage.from(KOVA).upload(o.p, buf, { contentType: o.tur || mimeBul(o.p), upsert: false });
        if (up.error) { console.error('  yükleme hatası', o.p, up.error.message); hata++; continue; }
        kopyalanan++;
    }
    const son = await listele(fra);
    const eksik = kaynak.filter(o => !son.find(x => x.p === o.p));
    console.log(`Kopyalanan: ${kopyalanan}, hata: ${hata} | DOĞRULAMA: Seul ${kaynak.length} / Frankfurt ${son.length}, eksik ${eksik.length}`);
    if (eksik.length) console.log('  eksikler:', eksik.map(e => e.p).slice(0, 10));
}

async function adres() {
    const tablolar = [['talep_dosyalari', 'public_url'], ['proje_dosyalari', 'public_url'], ['siparis_dosyalari', 'public_url']];
    const cl = await pool.connect();
    try {
        await cl.query('BEGIN');
        for (const [t, c] of tablolar) {
            const r = await cl.query(`UPDATE ${t} SET ${c} = replace(${c}, $1, $2) WHERE ${c} LIKE $3`, [SEUL_URL, FRA_URL, SEUL_URL + '%']);
            console.log(`  ${t}.${c}: ${r.rowCount} adres Frankfurt'a çevrildi`);
        }
        // Başka bir yerde Seul adresi kalmış mı?
        const kol = (await cl.query(`SELECT table_name t, column_name c FROM information_schema.columns
            WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json')`)).rows;
        let kalan = 0;
        for (const { t, c } of kol) {
            const n = +(await cl.query(`SELECT COUNT(*) n FROM "${t}" WHERE "${c}"::text LIKE '%xhcamvwsexyvxngxidvx%'`)).rows[0].n;
            if (n) { kalan += n; console.log(`  ⚠️ ${t}.${c}: ${n} satırda Seul adresi hâlâ var`); }
        }
        await cl.query('COMMIT');
        console.log(kalan ? `⚠️ ${kalan} satırda Seul adresi kaldı` : '✅ Veritabanında Seul adresi kalmadı.');
    } catch (e) { await cl.query('ROLLBACK'); throw e; } finally { cl.release(); }
}

async function eskiDosyalar() {
    await kovaHazirla();
    const r = (await pool.query(`SELECT eski_id, ad, s3_yolu FROM eski_dosyalar WHERE workspace_yolu IS NULL ORDER BY eski_id`)).rows;
    console.log(`Yüklenecek eski dosya: ${r.length}`);
    let tamam = 0, hata = 0;
    for (const d of r) {
        const yerel = ARSIV + d.s3_yolu;
        if (!fs.existsSync(yerel)) { console.error('  arşivde yok:', d.s3_yolu); hata++; continue; }
        const hedefYol = `eski-sistem/${d.s3_yolu}`;
        const up = await fra.storage.from(KOVA).upload(hedefYol, fs.readFileSync(yerel), { contentType: mimeBul(d.ad || d.s3_yolu), upsert: true });
        if (up.error) { console.error('  yükleme hatası', d.ad, '-', up.error.message); hata++; continue; }
        const { data } = fra.storage.from(KOVA).getPublicUrl(hedefYol);
        await pool.query(`UPDATE eski_dosyalar SET workspace_yolu=$1 WHERE eski_id=$2`, [data.publicUrl, d.eski_id]);
        if (++tamam % 100 === 0) console.log(`  ${tamam} dosya yüklendi…`);
    }
    console.log(`Yüklenen: ${tamam}, hata: ${hata}`);
}

(async () => {
    const adim = process.argv[2];
    try {
        if (adim === 'kopyala') await kopyala();
        else if (adim === 'adres') await adres();
        else if (adim === 'eski-dosyalar') await eskiDosyalar();
        else console.log('Kullanım: node aktarim-depolama.js kopyala | adres | eski-dosyalar');
    } catch (e) { console.error('❌ HATA:', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();

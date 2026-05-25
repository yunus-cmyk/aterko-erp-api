// =============================================================================
// SATINALMA MIGRATION
// satinalma-old-talepler.tsv → satinalma_talepleri + talep_urunleri
//                            + satinalma_siparisleri + siparis_kalemleri
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const TSV_PATH = path.join(__dirname, 'satinalma-old-talepler.tsv');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function parseTRNumber(s) {
    if (!s) return 0;
    return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

function parseTarih(s) {
    if (!s) return null;
    // "24.11.2025 12:22:46" veya "27.11.2025" veya "2026-01-12"
    const trMatch = String(s).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (trMatch) {
        const [_, dd, mm, yyyy, hh, mn, ss] = trMatch;
        return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')} ${(hh||'00').padStart(2,'0')}:${(mn||'00').padStart(2,'0')}:${(ss||'00').padStart(2,'0')}`;
    }
    const isoMatch = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return isoMatch[0];
    return null;
}

function extractProjeKodu(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{5})/);
    return m ? m[1] : null;
}

function normalizeDurum(d) {
    const dd = (d || '').trim();
    if (!dd) return 'ONAY BEKLİYOR';
    if (dd === 'TEKLİF İSTENDİ') return 'İŞLEME ALINDI';
    return dd;
}

async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU');
    console.log('═'.repeat(70));

    // Preload eşleştirmeler
    const stokR = await pool.query('SELECT id, stok_adi FROM stok_kartlari');
    const stokMap = new Map();
    stokR.rows.forEach(r => stokMap.set(r.stok_adi.trim().toLowerCase(), r.id));

    const projeR = await pool.query('SELECT id, proje_kodu FROM projeler');
    const projeMap = new Map();
    projeR.rows.forEach(r => projeMap.set(r.proje_kodu, r.id));

    const tedR = await pool.query('SELECT id, firma_adi FROM tedarikciler');
    const tedMap = new Map();
    tedR.rows.forEach(r => tedMap.set(r.firma_adi.trim().toLowerCase(), r.id));

    console.log(`📚 Stok kartı: ${stokMap.size} | Proje: ${projeMap.size} | Tedarikçi: ${tedMap.size}\n`);

    // TSV oku
    const raw = fs.readFileSync(TSV_PATH, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const H = lines[0].split('\t').map(s => s.trim());
    const idx = {
        talepNo: H.indexOf('Talep No'),
        tarih: H.indexOf('Tarih'),
        personel: H.indexOf('Personel'),
        proje: H.indexOf('Proje'),
        teslimTarihi: H.indexOf('Teslim Tarihi'),
        teslimYeri: H.indexOf('Teslim Yeri'),
        kategori: H.indexOf('Kategori'),
        urun: H.indexOf('Ürün'),
        miktar: H.indexOf('Miktar'),
        aciklama: H.indexOf('Açıklama'),
        durum: H.indexOf('Durum'),
        tedarikci: H.indexOf('Tedarikçi'),
        fiyat: H.indexOf('Fiyat'),
        kdv: H.indexOf('KDV Oranı'),
        genelAciklama: H.indexOf('Genel Açıklama'),
        satirId: H.indexOf('Satır ID'),
        siparisTarihi: H.indexOf('Sipariş Tarihi'),
        odemeKosul: H.indexOf('Ödeme Koşulları'),
        nakliye: H.indexOf('Nakliye Sorumluluğu'),
        teslimAdresi: H.indexOf('Teslim Adresi'),
        siparisAciklama: H.indexOf('Sipariş Açıklaması'),
        birimFiyat: H.indexOf('Birim Fiyat'),
        paraBirimi: H.indexOf('Para Birimi'),
        terminTarihi: H.indexOf('Termin Tarihi (Sipariş)'),
        siparisNo: H.indexOf('Sipariş No'),
        siparisTedarikci: H.indexOf('Sipariş Verilen Tedarikçi'),
        teslimAlinan: H.indexOf('Teslim Alınan Miktar'),
        arsiv: H.indexOf('Arşiv')
    };

    const veri = lines.slice(1).map(l => l.split('\t'));
    console.log(`📊 Toplam satır: ${veri.length}\n`);

    // Talep No'ya göre grupla
    const talepGruplari = new Map();
    for (const r of veri) {
        const tNo = (r[idx.talepNo] || '').trim();
        if (!tNo) continue;
        if (!talepGruplari.has(tNo)) talepGruplari.set(tNo, []);
        talepGruplari.get(tNo).push(r);
    }
    console.log(`📋 Eşsiz Talep: ${talepGruplari.size}`);

    // Sipariş No'ya göre grupla (kalemler bazında)
    const siparisGruplari = new Map();
    for (const r of veri) {
        const sNo = (r[idx.siparisNo] || '').trim();
        if (!sNo) continue;
        if (!siparisGruplari.has(sNo)) siparisGruplari.set(sNo, []);
        siparisGruplari.get(sNo).push(r);
    }
    console.log(`📋 Eşsiz Sipariş: ${siparisGruplari.size}`);

    // Eşleşme istatistikleri
    let urunBulundu = 0, urunYok = 0;
    let projeBulundu = 0, projeYok = 0;
    let tedBulundu = 0, tedYok = 0;
    const eksikTedarikciler = new Set();

    for (const r of veri) {
        const u = (r[idx.urun] || '').trim();
        if (u) (stokMap.has(u.toLowerCase()) ? urunBulundu++ : urunYok++);
        const p = extractProjeKodu(r[idx.proje]);
        if (p) (projeMap.has(p) ? projeBulundu++ : projeYok++);
        const t = (r[idx.siparisTedarikci] || r[idx.tedarikci] || '').trim();
        if (t) {
            if (tedMap.has(t.toLowerCase())) tedBulundu++;
            else { tedYok++; if (eksikTedarikciler.size < 10) eksikTedarikciler.add(t); }
        }
    }
    console.log(`  Ürün eşleşme:      ${urunBulundu} ✅ / ${urunYok} ⚠️ (eşleşmeyen ozel_urun_adi olarak yazılır)`);
    console.log(`  Proje eşleşme:     ${projeBulundu} ✅ / ${projeYok} ⚠️`);
    console.log(`  Tedarikçi eşleşme: ${tedBulundu} ✅ / ${tedYok} ⚠️`);
    if (eksikTedarikciler.size > 0) {
        console.log('\n  Eşleşmeyen tedarikçi örnekleri:');
        [...eksikTedarikciler].forEach(t => console.log('    •', t));
    }

    if (!APPLY) {
        console.log(`\n💡 Aktarmak için: node migrate-satinalma.js --apply`);
        await pool.end();
        return;
    }

    // ============== APPLY ==============
    let talepOk = 0, talepFail = 0;
    let kalemOk = 0, kalemFail = 0;
    let siparisOk = 0, siparisFail = 0;
    let sipKalemOk = 0;
    const talepIdMap = new Map();   // Talep No → DB id
    const satirToKalemMap = new Map(); // Satır ID → talep_urunleri.id (sipariş kalemini bağlamak için)

    // Gerçek tek tedarikçi mi yoksa "Firmalar: A, B - Tarih:..." notu mu?
    function gercekTedarikciMi(s) {
        if (!s) return false;
        const t = s.trim();
        if (t.length > 80) return false;  // Çok uzunsa not
        if (/firmalar\s*:/i.test(t)) return false;
        if (/tarih\s*:/i.test(t)) return false;
        if (t.split(',').length > 2) return false; // 2'den fazla virgül → liste
        return true;
    }

    // Sadece gerçek isim olan eşleşmeyenleri otomatik ekle
    const tedYeniSet = new Set();
    for (const r of veri) {
        const t = (r[idx.siparisTedarikci] || '').trim();
        if (t && !tedMap.has(t.toLowerCase()) && gercekTedarikciMi(t)) {
            tedYeniSet.add(t);
        }
    }
    console.log(`\n➕ Otomatik eklenecek tedarikçi: ${tedYeniSet.size}`);
    for (const t of tedYeniSet) {
        try {
            const r = await pool.query("INSERT INTO tedarikciler (firma_adi, durum) VALUES ($1,'AKTİF') RETURNING id", [t]);
            if (r.rows[0]) tedMap.set(t.toLowerCase(), r.rows[0].id);
        } catch (e) { /* duplicate ise atla */ }
    }
    const tedRetake = await pool.query('SELECT id, firma_adi FROM tedarikciler');
    tedRetake.rows.forEach(r => tedMap.set(r.firma_adi.trim().toLowerCase(), r.id));

    console.log('\n📤 Talepler ekleniyor...');
    for (const [tNo, kalemler] of talepGruplari) {
        try {
            const ilk = kalemler[0];
            const projeKodu = extractProjeKodu(ilk[idx.proje]);
            const projeId = projeKodu ? (projeMap.get(projeKodu) || null) : null;
            const r = await pool.query(`
                INSERT INTO satinalma_talepleri
                (talep_no, proje_id, talep_eden, istenen_tarih, teslim_yeri, genel_aciklama, durum, kayit_tarihi, arsiv)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
            `, [
                tNo,
                projeId,
                (ilk[idx.personel] || '').trim() || null,
                parseTarih(ilk[idx.teslimTarihi]),
                (ilk[idx.teslimYeri] || '').trim() || null,
                (ilk[idx.genelAciklama] || '').trim() || null,
                normalizeDurum(ilk[idx.durum]),
                parseTarih(ilk[idx.tarih]) || new Date().toISOString(),
                (ilk[idx.arsiv] || '').toString().trim().toLowerCase() === 'true' || (ilk[idx.arsiv] || '') === 'EVET'
            ]);
            const talepId = r.rows[0].id;
            talepIdMap.set(tNo, talepId);
            talepOk++;

            // Her kalem
            for (const k of kalemler) {
                try {
                    const urunAdi = (k[idx.urun] || '').trim();
                    const stokId = stokMap.get(urunAdi.toLowerCase()) || null;
                    const bMatch = urunAdi.match(/\[\s*([^\]]+?)\s*\]/);
                    const birim = bMatch ? bMatch[1].trim() : null;

                    const kr = await pool.query(`
                        INSERT INTO talep_urunleri
                        (talep_id, stok_kart_id, ozel_urun_adi, ozel_urun_birim, miktar, aciklama, durum)
                        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
                    `, [
                        talepId,
                        stokId,
                        stokId ? null : urunAdi,   // Eşleşmezse ozel_urun_adi'na yaz
                        stokId ? null : birim,
                        parseTRNumber(k[idx.miktar]),
                        (k[idx.aciklama] || '').trim() || null,
                        normalizeDurum(k[idx.durum])
                    ]);
                    kalemOk++;
                    const satirId = (k[idx.satirId] || '').trim();
                    if (satirId) satirToKalemMap.set(satirId, kr.rows[0].id);
                } catch (e) {
                    kalemFail++;
                    console.log(`  ❌ Kalem (${tNo}):`, e.message.substring(0, 80));
                }
            }
        } catch (e) {
            talepFail++;
            console.log(`  ❌ Talep ${tNo}:`, e.message.substring(0, 80));
        }
        if (talepOk % 20 === 0) console.log(`  ⏳ ${talepOk} talep, ${kalemOk} kalem`);
    }
    console.log(`\n  ✅ Talep: ${talepOk}, Kalem: ${kalemOk} | ❌ Talep: ${talepFail}, Kalem: ${kalemFail}`);

    console.log('\n📤 Siparişler ekleniyor...');
    for (const [sNo, kalemler] of siparisGruplari) {
        try {
            const ilk = kalemler[0];
            const tedAdi = (ilk[idx.siparisTedarikci] || ilk[idx.tedarikci] || '').trim();
            const tedId = tedAdi ? (tedMap.get(tedAdi.toLowerCase()) || null) : null;
            // Eşleşmeyen tedarikçi adı varsa not olarak siparis_notu'na ekle
            let siparisNotuExt = (ilk[idx.siparisAciklama] || '').trim();
            if (tedAdi && !tedId) {
                siparisNotuExt = (siparisNotuExt ? siparisNotuExt + ' | ' : '') + 'Tedarikçi notu: ' + tedAdi;
            }
            const kdv = parseInt(ilk[idx.kdv]) || 20;

            const r = await pool.query(`
                INSERT INTO satinalma_siparisleri
                (siparis_no, tedarikci_id, siparis_tarihi, termin_tarihi, odeme_vade,
                 teslim_nakliye, teslim_adresi, siparis_notu, para_birimi, kdv_orani, durum, arsiv)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id
            `, [
                sNo, tedId,
                parseTarih(ilk[idx.siparisTarihi]),
                parseTarih(ilk[idx.terminTarihi]),
                (ilk[idx.odemeKosul] || '').trim() || null,
                (ilk[idx.nakliye] || '').trim() || null,
                (ilk[idx.teslimAdresi] || '').trim() || null,
                siparisNotuExt || null,
                (ilk[idx.paraBirimi] || 'TL').trim() || 'TL',
                kdv,
                normalizeDurum(ilk[idx.durum]),
                (ilk[idx.arsiv] || '').toString().trim().toLowerCase() === 'true' || (ilk[idx.arsiv] || '') === 'EVET'
            ]);
            const siparisId = r.rows[0].id;
            siparisOk++;

            // Sipariş kalemleri
            for (const k of kalemler) {
                const satirId = (k[idx.satirId] || '').trim();
                const talepUrunId = satirToKalemMap.get(satirId);
                if (!talepUrunId) continue; // talep eşleşmediyse atla
                try {
                    await pool.query(`
                        INSERT INTO siparis_kalemleri
                        (siparis_id, talep_urun_id, birim_fiyat, siparis_miktari, teslim_alinan_miktar, durum)
                        VALUES ($1,$2,$3,$4,$5,$6)
                    `, [
                        siparisId, talepUrunId,
                        parseTRNumber(k[idx.birimFiyat]),
                        parseTRNumber(k[idx.miktar]),
                        parseTRNumber(k[idx.teslimAlinan]),
                        normalizeDurum(k[idx.durum])
                    ]);
                    sipKalemOk++;
                } catch (e) {
                    console.log(`  ❌ Sipariş kalemi:`, e.message.substring(0, 80));
                }
            }
        } catch (e) {
            siparisFail++;
            console.log(`  ❌ Sipariş ${sNo}:`, e.message.substring(0, 80));
        }
        if (siparisOk % 10 === 0) console.log(`  ⏳ ${siparisOk} sipariş, ${sipKalemOk} kalem`);
    }
    console.log(`\n  ✅ Sipariş: ${siparisOk}, Kalem: ${sipKalemOk} | ❌ Sipariş: ${siparisFail}`);

    console.log('\n' + '═'.repeat(70));
    console.log('🎉 Migration tamam.');
    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

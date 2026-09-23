// ============================================================================
// SON AKTARIM — ESKİ SİSTEMDEN KESİN GEÇİŞ (Yunus kararı 2026-09-23 14:26)
// "Eski sistemde kalan her şeyi şu an itibariyle taşıyalım. Ekip eski sistemde
//  yeni bir şey yapmayacak."
//
// BÖLÜM A — Daha önce taşınmış varlıkların 29.07 sonrası ayrışması:
//   müşteri, kişi, proje, teklif, teklif kalemi, sözleşme, ürün fiyatı, kod sayaçları,
//   fiyat analizi (bölüm/değer/döküm).
//
// KURALLAR (Yunus'un kalıcı talimatları):
//  • Workspace'te TESLİMAT fazındaki / Projeler listesindeki projelerin durumuna
//    DOKUNULMAZ; yalnız boş alan doldurulur, çakışma raporlanır.
//  • Workspace'te 29.07 sonrası elle düzenlenmiş kayıt EZİLMEZ; yalnız boş alan
//    doldurulur, raporlanır.
//  • Eskide silinmiş kayıt Workspace'ten SİLİNMEZ; raporlanır.
//  • Değer dönüşümleri, ilk aktarımla eşleşmiş kayıtlardan çıkarılan sözlüklerle
//    yapılır (ilk aktarımla birebir aynı kural).
//
// Kullanım:  node aktarim-son.js            → DENEME (her şey yapılır, sonda ROLLBACK)
//            node aktarim-son.js --uygula   → kalıcı yazar (COMMIT)
// ============================================================================
const fs = require('fs');
const { pool, eskiSorgu, eposta } = require('./aktarim-ortak');

const UYGULA = process.argv.includes('--uygula');
const AYRISMA = '2026-07-29';          // son eşitleme günü
const ANALIZ_KESIM = '2026-07-29 07:02:58.644923+00';
const FIYAT_TARIHI = '2026-09-18';     // Varol'un toplu fiyat kaydı
const rapor = { eklenen: {}, guncellenen: {}, dolgu: {}, atlanan: [], uyari: [] };
const say = (grup, tur, n = 1) => { rapor[tur][grup] = (rapor[tur][grup] || 0) + n; };

// ---------------------------------------------------------------------------
// Sözlükler: eski kimlik → Workspace değeri (ilk aktarım çiftlerinden)
// ---------------------------------------------------------------------------
function sozlukKur(eskiSatir, wsMap, eskiAlan, wsAlan) {
    const s = {};
    for (const e of eskiSatir) {
        const w = wsMap.get(String(e.id)); if (!w) continue;
        const k = String(e[eskiAlan]); const v = JSON.stringify(w[wsAlan] ?? null);
        (s[k] ||= {})[v] = (s[k][v] || 0) + 1;
    }
    const out = {};
    for (const [k, m] of Object.entries(s)) out[k] = JSON.parse(Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]);
    return out;
}
function cevir(sozluk, anahtar, yedek, etiket) {
    if (anahtar === null || anahtar === undefined) return null;
    const k = String(anahtar);
    if (k in sozluk) return sozluk[k];
    if (yedek && yedek[k] !== undefined) { rapor.uyari.push(`${etiket}: ${k} sözlükte yok, eski ad kullanıldı → "${yedek[k]}"`); return yedek[k]; }
    rapor.uyari.push(`${etiket}: ${k} karşılığı bulunamadı → boş`);
    return null;
}
const adSozlugu = (tablo, kolon = 'name') => {
    try { return Object.fromEntries(eskiSorgu(`SELECT id, ${kolon} AS ad FROM ${tablo}`).map(r => [String(r.id), r.ad])); }
    catch { return {}; }
};
const yuvarla = (x) => Math.round(x * 100) / 100;

(async () => {
    let cl;
    try {
        console.log(`\n=== SON AKTARIM — ${UYGULA ? 'UYGULAMA (COMMIT)' : 'DENEME (ROLLBACK)'} ===\n`);

        // ---------------- Eski veriyi çek ----------------
        const E = {
            musteri: eskiSorgu(`SELECT * FROM customer`),
            kisi: eskiSorgu(`SELECT * FROM person`),
            proje: eskiSorgu(`SELECT * FROM project`),
            teklif: eskiSorgu(`SELECT * FROM proposal`),
            kalem: eskiSorgu(`SELECT * FROM proposal_component`),
            sozlesme: eskiSorgu(`SELECT * FROM contract`),
            fiyat: eskiSorgu(`SELECT * FROM product_price`),
        };
        const Y = {   // ad yedekleri (sözlükte olmayan yeni kimlikler için)
            ulke: adSozlugu('country'), sehir: adSozlugu('city'),
            temsilci: adSozlugu('customer_rep'), satisTuru: adSozlugu('sales_type'),
            projeTuru: adSozlugu('project_type'), bilesenTuru: adSozlugu('component_type'),
            sartname: adSozlugu('technical_spec_type'),
        };
        // Fiyat analizi: 29.07 sonrası dokunulan kalemler + tüm analiz verisi (işlem dışında çekilir)
        const K = `'${ANALIZ_KESIM}'`;
        const etkilenen = eskiSorgu(`
            SELECT DISTINCT e FROM (
                SELECT entity_id e FROM attribute WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM attribute_category WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM component_product WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM component_product_price_set WHERE entity_name='proposalComponent' AND created_date>${K}
                UNION SELECT id FROM proposal_component WHERE last_modified_date>${K}
            ) y`).map(r => r.e);
        const A = { bolumler: [], degerler: [], urunler: [], kalemMeta: [] };
        if (etkilenen.length) {
            const idListe = etkilenen.join(',');
            A.bolumler = eskiSorgu(`SELECT id, entity_id, name, order_no, included_in_scope, parent_id, product_category_id
                FROM attribute_category WHERE entity_name='proposalComponent' AND entity_id IN (${idListe})`);
            A.degerler = eskiSorgu(`SELECT id, entity_id, value, attribute_type_id, attribute_category_id
                FROM attribute WHERE entity_name='proposalComponent' AND entity_id IN (${idListe})`);
            A.urunler = eskiSorgu(`SELECT cp.id, cp.entity_id, cp.product_id, cp.amount, cp.order_no, cp.note,
                    p.cost, p.sales_price, p.edited_by_user, cu.code AS para, s.price_calculated_at
                FROM component_product cp
                LEFT JOIN LATERAL (SELECT * FROM component_product_price WHERE component_product_id=cp.id ORDER BY id DESC LIMIT 1) p ON true
                LEFT JOIN currency cu ON cu.id=p.currency_id
                LEFT JOIN component_product_price_set s ON s.id=p.component_product_price_set_id
                WHERE cp.entity_name='proposalComponent' AND cp.entity_id IN (${idListe})`);
            A.kalemMeta = eskiSorgu(`SELECT pc.id, pc.proposal_component_status_id AS durum, ps.price_calculated_at, ps.created_by
                FROM proposal_component pc
                LEFT JOIN LATERAL (SELECT * FROM component_product_price_set WHERE entity_name='proposalComponent' AND entity_id=pc.id ORDER BY id DESC LIMIT 1) ps ON true
                WHERE pc.id IN (${idListe})`);
        }
        const eskiSimdi = eskiSorgu(`SELECT now()::text AS t`)[0].t;

        // Workspace bağlantısı eski veri ÇEKİLDİKTEN sonra açılır: uzun SSH sorguları sırasında
        // boşta bekleyen bağlantıyı havuz (pgbouncer) kapatabiliyor
        cl = await pool.connect();
        cl.on('error', (e) => console.error('Bağlantı hatası:', e.message));
        console.log(`Eski: ${E.musteri.length} müşteri, ${E.proje.length} proje, ${E.teklif.length} teklif, ${E.kalem.length} kalem, ${E.sozlesme.length} sözleşme, ${E.fiyat.length} fiyat`);

        // ---------------- Workspace durumunu çek ----------------
        const wsMap = async (sql, anahtar = 'eski_id') =>
            new Map((await cl.query(sql)).rows.map(r => [String(r[anahtar]), r]));
        const W = {
            musteri: await wsMap(`SELECT * FROM sat_musteriler WHERE eski_id IS NOT NULL`),
            kisi: await wsMap(`SELECT * FROM sat_musteri_kisiler WHERE eski_id IS NOT NULL`),
            proje: await wsMap(`SELECT * FROM projeler`, 'proje_kodu'),
            teklif: await wsMap(`SELECT * FROM sat_teklifler WHERE eski_id IS NOT NULL`),
            kalem: await wsMap(`SELECT * FROM sat_teklif_kalemleri WHERE eski_id IS NOT NULL`),
            sozlesme: await wsMap(`SELECT * FROM sat_sozlesmeler WHERE eski_id IS NOT NULL`),
            fiyat: await wsMap(`SELECT * FROM sat_urun_fiyatlar WHERE eski_id IS NOT NULL`),
        };
        // Workspace'te 29.07 sonrası elle dokunulmuş kayıtlar (audit izi)
        const wsDokunulan = new Set((await cl.query(`
            SELECT DISTINCT tablo || ':' || kayit_id AS k FROM audit_log
            WHERE kayit_tarihi > $1 AND tablo IN ('projeler','sat_teklifler','sat_teklif_kalemleri','sat_musteriler')`, [AYRISMA])).rows.map(r => r.k));

        // ---------------- Sözlükler ----------------
        const wpSatis = new Map([...W.proje].filter(([, r]) => r.faz === 'SATIS'));
        const S = {
            mTip: sozlukKur(E.musteri, W.musteri, 'customer_type_id', 'tip'),
            mAltTur: sozlukKur(E.musteri, W.musteri, 'customer_sub_type_id', 'alt_tur'),
            mSatisDurumu: sozlukKur(E.musteri, W.musteri, 'customer_status_id', 'satis_durumu'),
            mDurum: sozlukKur(E.musteri, W.musteri, 'customer_status_id', 'durum'),
            mSatisNoktasi: sozlukKur(E.musteri, W.musteri, 'point_of_sales_id', 'satis_noktasi'),
            mTemsilci: sozlukKur(E.musteri, W.musteri, 'customer_rep_id', 'temsilci_email'),
            mNasilDuydu: sozlukKur(E.musteri, W.musteri, 'how_did_you_hear_us_id', 'nasil_duydu'),
            mUlke: sozlukKur(E.musteri, W.musteri, 'country_id', 'ulke'),
            mSehir: sozlukKur(E.musteri, W.musteri, 'city_id', 'sehir'),
            pSatisTuru: sozlukKur(E.proje, W.proje, 'sales_type_id', 'satis_turu'),
            pProjeTuru: sozlukKur(E.proje, W.proje, 'project_type_id', 'proje_turu'),
            pSatisDurumu: sozlukKur(E.proje, wpSatis, 'project_status_id', 'satis_durumu'),
            pTemsilci: sozlukKur(E.proje, W.proje, 'customer_rep_id', 'satis_temsilcisi'),
            pUlke: sozlukKur(E.proje, W.proje, 'country_id', 'ulke'),
            pSehir: sozlukKur(E.proje, W.proje, 'city_id', 'sehir'),
            tDurum: sozlukKur(E.teklif, W.teklif, 'proposal_status_id', 'durum'),
            tSartname: sozlukKur(E.teklif, W.teklif, 'technical_spec_type_id', 'sartname_turu'),
            tPara: sozlukKur(E.teklif, W.teklif, 'currency_id', 'para_birimi'),
            kBilesen: sozlukKur(E.kalem, W.kalem, 'component_type_id', 'bilesen_turu'),
            kBinaTuru: sozlukKur(E.kalem, W.kalem, 'component_type_id', 'bina_turu'),
            kBirim: sozlukKur(E.kalem, W.kalem, 'primary_unit_type_id', 'birim'),
            kIkBirim: sozlukKur(E.kalem, W.kalem, 'secondary_unit_type_id', 'ikincil_birim'),
            kIkSembol: sozlukKur(E.kalem, W.kalem, 'secondary_unit_type_id', 'ikincil_birim_sembol'),
            kAnaliz: sozlukKur(E.kalem, W.kalem, 'proposal_component_status_id', 'analiz_durumu'),
            sPara: sozlukKur(E.sozlesme, W.sozlesme, 'currency_id', 'para_birimi'),
        };
        // Yardımcı: eski kaydın değişmiş sayılması
        const degismis = (e) => (e.last_modified_date || '') > AYRISMA;

        await cl.query('BEGIN');

        // =====================================================================
        // 1) MÜŞTERİLER
        // =====================================================================
        const musteriAlan = (e) => ({
            ad: e.name, uzun_ad: e.long_name, email: e.email, telefon: e.phone, adres: e.address,
            fatura_adresi: e.billing_address, vergi_dairesi: e.tax_place, vergi_no: e.tax_number,
            iban: e.ibann, mali_not: e.financial_note,
            tip: cevir(S.mTip, e.customer_type_id, null, 'müşteri tipi'),
            alt_tur: cevir(S.mAltTur, e.customer_sub_type_id, null, 'müşteri alt tür'),
            satis_durumu: cevir(S.mSatisDurumu, e.customer_status_id, null, 'müşteri satış durumu'),
            durum: cevir(S.mDurum, e.customer_status_id, null, 'müşteri durum') || 'AKTIF',
            satis_noktasi: cevir(S.mSatisNoktasi, e.point_of_sales_id, null, 'satış noktası'),
            temsilci_email: cevir(S.mTemsilci, e.customer_rep_id, Y.temsilci, 'müşteri temsilcisi'),
            nasil_duydu: cevir(S.mNasilDuydu, e.how_did_you_hear_us_id, null, 'nasıl duydu'),
            ulke: cevir(S.mUlke, e.country_id, Y.ulke, 'müşteri ülke'),
            sehir: cevir(S.mSehir, e.city_id, Y.sehir, 'müşteri şehir'),
            durum_tarihi: e.state_change_date,
        });
        const musteriId = {};   // eski_id → ws id
        W.musteri.forEach((r, k) => { musteriId[k] = r.id; });
        for (const e of E.musteri) {
            const w = W.musteri.get(String(e.id));
            const a = musteriAlan(e);
            if (!w) {
                const kol = Object.keys(a);
                const r = await cl.query(`INSERT INTO sat_musteriler (eski_id, ${kol.join(',')}, kaynak, olusturan, kayit_tarihi, guncelleme)
                    VALUES ($1, ${kol.map((_, i) => '$' + (i + 2)).join(',')}, 'aset-aktarim', $${kol.length + 2}, $${kol.length + 3}, $${kol.length + 4}) RETURNING id`,
                    [e.id, ...Object.values(a), eposta(e.created_by), e.created_date, e.last_modified_date]);
                musteriId[e.id] = r.rows[0].id; say('müşteri', 'eklenen');
            } else if (degismis(e)) {
                const elle = (w.guncelleme && w.guncelleme.toISOString() > AYRISMA)
                    || wsDokunulan.has('sat_musteriler:' + w.id);
                const kol = Object.keys(a);
                if (elle) {
                    await cl.query(`UPDATE sat_musteriler SET ${kol.map((c, i) => `${c}=COALESCE(NULLIF(${c}::text,'')::${c === 'durum_tarihi' ? 'date' : 'text'}, $${i + 2})`).join(',')} WHERE id=$1`,
                        [w.id, ...Object.values(a)]);
                    say('müşteri', 'dolgu'); rapor.atlanan.push(`Müşteri ${e.id} ${e.name}: Workspace'te de düzenlenmiş → yalnız boş alanlar dolduruldu`);
                } else {
                    await cl.query(`UPDATE sat_musteriler SET ${kol.map((c, i) => `${c}=$${i + 2}`).join(',')}, guncelleme=$${kol.length + 2} WHERE id=$1`,
                        [w.id, ...Object.values(a), e.last_modified_date]);
                    say('müşteri', 'guncellenen');
                }
            }
        }

        // =====================================================================
        // 2) KİŞİLER
        // =====================================================================
        for (const e of E.kisi) {
            const w = W.kisi.get(String(e.id));
            const mId = musteriId[e.customer_id];
            if (!mId) { rapor.uyari.push(`Kişi ${e.id}: müşterisi (${e.customer_id}) yok, atlandı`); continue; }
            if (!w) {
                await cl.query(`INSERT INTO sat_musteri_kisiler (eski_id, musteri_id, ad, unvan, email, telefon, notu)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.id, mId, e.name, e.position, e.email, e.phone, e.note]);
                say('kişi', 'eklenen');
            } else if (degismis(e)) {
                await cl.query(`UPDATE sat_musteri_kisiler SET ad=$2, unvan=$3, email=$4, telefon=$5, notu=$6 WHERE id=$1`,
                    [w.id, e.name, e.position, e.email, e.phone, e.note]);
                say('kişi', 'guncellenen');
            }
        }

        // =====================================================================
        // 3) PROJELER
        // =====================================================================
        const eMusteriAd = Object.fromEntries(E.musteri.map(m => [String(m.id), m.name]));
        const projeAlan = (e) => ({
            proje_adi: e.name, musteri_adi: eMusteriAd[e.customer_id] || null,
            sat_musteri_id: musteriId[e.customer_id] || null,
            adres: e.location, sehir: cevir(S.pSehir, e.city_id, Y.sehir, 'proje şehir'),
            ulke: cevir(S.pUlke, e.country_id, Y.ulke, 'proje ülke'),
            irtibat_adi: e.contact_name, irtibat_email: e.contact_email, irtibat_telefon: e.contact_phone,
            aciklama: e.description,
            proje_turu: cevir(S.pProjeTuru, e.project_type_id, Y.projeTuru, 'proje türü'),
            satis_turu: cevir(S.pSatisTuru, e.sales_type_id, Y.satisTuru, 'satış türü'),
            satis_temsilcisi: cevir(S.pTemsilci, e.customer_rep_id, Y.temsilci, 'proje temsilcisi'),
        });
        const projeId = {};   // eski proje id → ws id
        W.proje.forEach((r, k) => { projeId[k] = r.id; });
        const korunanProjeler = [];
        for (const e of E.proje) {
            const kod = String(e.id);
            if (!/^[0-9]{5}$/.test(kod)) { rapor.uyari.push(`Proje ${kod}: 5 haneli değil, atlandı`); continue; }
            const w = W.proje.get(kod);
            if (w && !degismis(e)) continue;
            const a = projeAlan(e);
            if (w && !degismis(e)) continue;
            const satisDurumu = cevir(S.pSatisDurumu, e.project_status_id, null, 'proje satış durumu');
            if (!w) {
                const kol = Object.keys(a);
                const r = await cl.query(`INSERT INTO projeler (proje_kodu, ${kol.join(',')}, faz, durum, satis_durumu, para_birimi, kdv_orani, olusturma_tarihi, aset_link)
                    VALUES ($1, ${kol.map((_, i) => '$' + (i + 2)).join(',')}, 'SATIS', 'TASLAK', $${kol.length + 2}, 'TL', 20, $${kol.length + 3}, $${kol.length + 4}) RETURNING id`,
                    [kod, ...Object.values(a), satisDurumu, e.created_date, `https://aset.aterko.com/entity/project/${kod}`]);
                projeId[kod] = r.rows[0].id; say('proje', 'eklenen');
            } else if (degismis(e)) {
                const kol = Object.keys(a);
                const dolgu = `UPDATE projeler SET ${kol.map((c, i) => `${c}=COALESCE(NULLIF(${c}::text,'')${c === 'sat_musteri_id' ? '::int' : ''}, $${i + 2})`).join(',')} WHERE id=$1`;
                if (w.faz !== 'SATIS') {
                    // Kural: Projeler listesindeki (teslimat fazı) projenin durumuna dokunulmaz
                    await cl.query(dolgu, [w.id, ...Object.values(a)]);
                    say('proje', 'dolgu');
                    korunanProjeler.push(`${kod} (Workspace: ${w.faz}/${w.durum}/${w.satis_durumu || '-'}; eskide: durum kodu ${e.project_status_id} → ${satisDurumu})`);
                } else if (wsDokunulan.has('projeler:' + w.id)) {
                    await cl.query(dolgu, [w.id, ...Object.values(a)]);
                    say('proje', 'dolgu');
                    rapor.atlanan.push(`Proje ${kod}: Workspace'te de düzenlenmiş → yalnız boş alanlar dolduruldu (satış durumu değişmedi: ${w.satis_durumu}, eskide ${satisDurumu})`);
                } else {
                    await cl.query(`UPDATE projeler SET ${kol.map((c, i) => `${c}=$${i + 2}`).join(',')}, satis_durumu=$${kol.length + 2} WHERE id=$1`,
                        [w.id, ...Object.values(a), satisDurumu]);
                    say('proje', 'guncellenen');
                }
            }
        }

        // =====================================================================
        // 4) TEKLİFLER + KALEMLER
        // =====================================================================
        const eProjeMusteri = Object.fromEntries(E.proje.map(p => [String(p.id), p.customer_id]));
        const kalemlerTeklif = {};
        E.kalem.forEach(k => { (kalemlerTeklif[k.proposal_id] ||= []).push(k); });
        const teklifId = {};  // eski → ws
        W.teklif.forEach((r, k) => { teklifId[k] = r.id; });
        const korunanTeklif = new Set();
        const teklifAlan = (e) => {
            const ks = kalemlerTeklif[e.id] || [];
            const zorunlu = yuvarla(ks.filter(k => !k.optional).reduce((s, k) => s + (+k.total_price || 0), 0));
            const tum = yuvarla(ks.reduce((s, k) => s + (+k.total_price || 0), 0));
            const kdv = +e.tax_rate || 0;
            const kdvTutar = yuvarla(zorunlu * kdv / 100);
            if (ks.length && Math.abs(zorunlu - (+e.price || 0)) > 0.02 && (!W.teklif.get(String(e.id)) || degismis(e)))
                rapor.uyari.push(`Teklif ${e.code}: eskide saklı ara toplam ${e.price}, kalemlerden ${zorunlu} hesaplandı (bayat toplam, kalemden alındı)`);
            return {
                teklif_no: e.code,
                musteri_id: musteriId[eProjeMusteri[String(e.project_id)]] || null,
                proje_id: projeId[String(e.project_id)] || null,
                eski_proje_id: e.project_id,
                teklif_tarihi: e.proposal_date,
                durum: cevir(S.tDurum, e.proposal_status_id, null, 'teklif durumu'),
                para_birimi: cevir(S.tPara, e.currency_id, null, 'teklif para birimi') || 'TL',
                kdv_orani: kdv,
                ara_toplam: ks.length ? zorunlu : e.price,
                kdv_tutar: ks.length ? kdvTutar : e.tax,
                genel_toplam: ks.length ? yuvarla(zorunlu + kdvTutar) : e.total,
                opsiyonlu_toplam: ks.length ? tum : e.price,
                iskontolu_toplam: e.discounted,
                notlar: e.notes, odeme_kosullari: e.terms_payment, teslimat_kosullari: e.terms_delivery,
                dahil_isler: e.scope_included, haric_isler: e.scope_excluded,
                sartname_turu: cevir(S.tSartname, e.technical_spec_type_id, Y.sartname, 'şartname türü'),
                toplam_buyukluk: e.total_amounts_by_unit_types,
                guncelleme: e.last_modified_date,
            };
        };
        const yerliNo = new Set((await cl.query(`SELECT teklif_no FROM sat_teklifler WHERE eski_id IS NULL`)).rows.map(r => r.teklif_no));
        for (const e of E.teklif) {
            const w = W.teklif.get(String(e.id));
            if (w && !degismis(e)) continue;
            if (!w && yerliNo.has(e.code)) rapor.uyari.push(`Teklif ${e.code}: Workspace'te aynı numarayla YERLİ bir teklif var — iki kayıt olacak, kontrol edilmeli`);
            const a = teklifAlan(e);
            if (!a.proje_id) { rapor.uyari.push(`Teklif ${e.code}: projesi (${e.project_id}) Workspace'te yok, atlandı`); continue; }
            if (!w) {
                const kol = Object.keys(a);
                const r = await cl.query(`INSERT INTO sat_teklifler (eski_id, ${kol.join(',')}, olusturan, olusturma_tarihi)
                    VALUES ($1, ${kol.map((_, i) => '$' + (i + 2)).join(',')}, $${kol.length + 2}, $${kol.length + 3}) RETURNING id`,
                    [e.id, ...Object.values(a), eposta(e.created_by), e.created_date]);
                teklifId[e.id] = r.rows[0].id; say('teklif', 'eklenen');
            } else if (degismis(e)) {
                const wsIleride = (w.guncelleme && w.guncelleme.toISOString() > AYRISMA) || wsDokunulan.has('sat_teklifler:' + w.id);
                if (wsIleride) {
                    korunanTeklif.add(e.id);
                    rapor.atlanan.push(`Teklif ${e.code}: Workspace'te ${w.durum} ve ${w.guncelleme?.toISOString().slice(0, 16)} tarihinde düzenlenmiş (eskideki son değişiklik ${String(e.last_modified_date).slice(0, 16)}) → Workspace korundu`);
                } else {
                    const kol = Object.keys(a);
                    await cl.query(`UPDATE sat_teklifler SET ${kol.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`,
                        [w.id, ...Object.values(a)]);
                    say('teklif', 'guncellenen');
                }
            }
        }
        // Kalemler
        const kalemAlan = (e) => ({
            teklif_id: teklifId[e.proposal_id],
            ad: e.name, aciklama: e.note, miktar: e.amount,
            birim: cevir(S.kBirim, e.primary_unit_type_id, null, 'kalem birimi') || 'Adet',
            ikincil_miktar: e.secondary_amount,
            ikincil_birim: cevir(S.kIkBirim, e.secondary_unit_type_id, null, 'ikincil birim'),
            ikincil_birim_sembol: cevir(S.kIkSembol, e.secondary_unit_type_id, null, 'ikincil sembol'),
            opsiyonel: !!e.optional, sira: e.order_no, birim_fiyat: e.price, toplam: e.total_price,
            analiz_durumu: cevir(S.kAnaliz, e.proposal_component_status_id, null, 'analiz durumu') || 'BELIRTILMEMIS',
            bilesen_turu: cevir(S.kBilesen, e.component_type_id, Y.bilesenTuru, 'bileşen türü'),
        });
        for (const e of E.kalem) {
            if (korunanTeklif.has(e.proposal_id)) continue;
            if (!teklifId[e.proposal_id]) continue;   // teklifi atlandıysa
            const w = W.kalem.get(String(e.id));
            const a = kalemAlan(e);
            if (!w) {
                a.bina_turu = cevir(S.kBinaTuru, e.component_type_id, null, 'bina türü');
                const kol = Object.keys(a);
                await cl.query(`INSERT INTO sat_teklif_kalemleri (eski_id, ${kol.join(',')})
                    VALUES ($1, ${kol.map((_, i) => '$' + (i + 2)).join(',')})`, [e.id, ...Object.values(a)]);
                say('teklif kalemi', 'eklenen');
            } else if (degismis(e)) {
                // Yalnız eski sistemin sahip olduğu ticari alanlar; Workspace'e özgü
                // alanlar (bina tipi, şartname cevapları, bina türü) korunur.
                const kol = Object.keys(a).filter(c => c !== 'teklif_id');
                await cl.query(`UPDATE sat_teklif_kalemleri SET ${kol.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`,
                    [w.id, ...kol.map(c => a[c])]);
                say('teklif kalemi', 'guncellenen');
            }
        }
        // Eskide silinmiş ama Workspace'te duran kalemler — SİLİNMEZ, raporlanır
        const eskiKalemIds = new Set(E.kalem.map(k => String(k.id)));
        for (const [eid, w] of W.kalem) if (!eskiKalemIds.has(eid)) {
            const t = await cl.query(`SELECT teklif_no FROM sat_teklifler WHERE id=$1`, [w.teklif_id]);
            rapor.atlanan.push(`Teklif kalemi "${w.ad}" (${t.rows[0]?.teklif_no}): eskide SİLİNMİŞ, Workspace'te duruyor → dokunulmadı`);
        }

        // =====================================================================
        // 5) SÖZLEŞMELER
        // =====================================================================
        for (const e of E.sozlesme) {
            if (W.sozlesme.get(String(e.id))) {
                if (degismis(e)) rapor.atlanan.push(`Sözleşme ${e.code}: eskide değişmiş, Workspace'teki korundu`);
                continue;
            }
            const pId = projeId[String(e.project_id)];
            if (!pId) { rapor.uyari.push(`Sözleşme ${e.code}: projesi yok, atlandı`); continue; }
            await cl.query(`INSERT INTO sat_sozlesmeler (eski_id, kod, proje_id, teklif_id, tarih, tutar, kdv_orani, para_birimi, kur,
                tutar_tl, kdv_tl, toplam_tl, odeme_kosullari, teslimat_kosullari, dahil_isler, haric_isler, notlar, olusturan, olusturma_tarihi)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
                [e.id, e.code, pId, teklifId[e.proposal_id] || null, e.date, e.price, e.tax_rate,
                 cevir(S.sPara, e.currency_id, null, 'sözleşme para birimi') || 'TL', e.currency_rate,
                 e.price_in_base_currency, e.tax_in_base_currency, e.total_in_base_currency,
                 e.terms_payment, e.terms_delivery, e.scope_included, e.scope_excluded, e.notes,
                 eposta(e.created_by), e.created_date]);
            say('sözleşme', 'eklenen');
        }

        // =====================================================================
        // 6) KOD SAYAÇLARI — yeni kod çakışmasın ({proje}-TEK-NN / -SOZ-NN)
        // =====================================================================
        const sayac = {};   // proje_id|varlik → en büyük NN
        const isle = (kod, varlik) => {
            const m = /^(\d{5})-(TEK|SOZ)-(\d+)/.exec(kod || ''); if (!m) return;
            const pid = projeId[m[1]]; if (!pid) return;
            const k = pid + '|' + varlik; sayac[k] = Math.max(sayac[k] || 0, parseInt(m[3]));
        };
        E.teklif.forEach(t => isle(t.code, 'teklif'));
        E.sozlesme.forEach(s => isle(s.code, 'sozlesme'));
        let sayacDegisen = 0;
        for (const [k, deger] of Object.entries(sayac)) {
            const [pid, varlik] = k.split('|');
            const r = await cl.query(`INSERT INTO sat_kod_sirasi (proje_id, varlik, deger) VALUES ($1,$2,$3)
                ON CONFLICT (proje_id, varlik) DO UPDATE SET deger=GREATEST(sat_kod_sirasi.deger, EXCLUDED.deger)
                WHERE sat_kod_sirasi.deger < EXCLUDED.deger RETURNING 1`, [pid, varlik, deger]);
            sayacDegisen += r.rowCount;
        }
        if (sayacDegisen) say('kod sayacı', 'guncellenen', sayacDegisen);

        // =====================================================================
        // 7) ÜRÜN FİYATLARI — geçmiş korunarak (Workspace fiyat girişiyle aynı mantık)
        // =====================================================================
        for (const e of E.fiyat) {
            const w = W.fiyat.get(String(e.id));
            if (!w) { rapor.uyari.push(`Fiyat ${e.id}: Workspace karşılığı yok`); continue; }
            if (Math.abs(parseFloat(w.fiyat) - parseFloat(e.price)) < 0.0001) continue;
            // Aynı ürün+tip için o tarihte zaten satır var mı (tekrar çalıştırma koruması)
            const var_ = await cl.query(`SELECT id FROM sat_urun_fiyatlar WHERE urun_id=$1 AND tip=$2 AND baslangic=$3::date`,
                [w.urun_id, w.tip, FIYAT_TARIHI]);
            if (var_.rowCount) continue;
            await cl.query(`UPDATE sat_urun_fiyatlar SET bitis=$2::date, eski_id=NULL WHERE id=$1`, [w.id, FIYAT_TARIHI]);
            await cl.query(`UPDATE sat_urun_fiyatlar SET bitis=$3::date
                WHERE urun_id=$1 AND tip=$2 AND bitis IS NULL AND baslangic <= $3::date`, [w.urun_id, w.tip, FIYAT_TARIHI]);
            await cl.query(`INSERT INTO sat_urun_fiyatlar (eski_id, urun_id, tip, fiyat, miktar, para_birimi, birim, baslangic, kayit_tarihi, olusturan)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)`,
                [e.id, w.urun_id, w.tip, e.price, e.amount ?? w.miktar, w.para_birimi, w.birim, FIYAT_TARIHI,
                 e.last_modified_date, eposta(e.last_modified_by)]);
            say('ürün fiyatı', 'guncellenen');
        }

        // =====================================================================
        // 8) FİYAT ANALİZİ — 29.07 sonrası dokunulan kalemler (aktarim-analiz-fark mantığı)
        // =====================================================================
        const wsK = (await cl.query(`SELECT k.id, k.eski_id, t.eski_id AS teklif_eski FROM sat_teklif_kalemleri k
            JOIN sat_teklifler t ON t.id=k.teklif_id WHERE k.eski_id = ANY($1::int[])`, [etkilenen])).rows;
        const e2w = {}; wsK.forEach(r => { if (!korunanTeklif.has(r.teklif_eski)) e2w[r.eski_id] = r.id; });
        let hedef = etkilenen.filter(e => e2w[e]);
        const yerli = await cl.query(`SELECT DISTINCT kalem_id FROM (
                SELECT kalem_id FROM sat_analiz_bolumler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL
                UNION ALL SELECT kalem_id FROM sat_analiz_degerler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL
                UNION ALL SELECT kalem_id FROM sat_analiz_urunler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL) y`,
            [hedef.map(e => e2w[e])]);
        if (yerli.rowCount) {
            const korunan = new Set(yerli.rows.map(r => r.kalem_id));
            const adlar = (await cl.query(`SELECT k.ad, t.teklif_no FROM sat_teklif_kalemleri k JOIN sat_teklifler t ON t.id=k.teklif_id WHERE k.id = ANY($1::int[])`, [[...korunan]])).rows;
            adlar.forEach(x => rapor.atlanan.push(`Analiz "${x.ad}" (${x.teklif_no}): Workspace'te de analiz yapılmış → Workspace analizi korundu`));
            hedef = hedef.filter(e => !korunan.has(e2w[e]));
        }
        if (hedef.length) {
            const hs = new Set(hedef.map(String));
            const bolumler = A.bolumler.filter(x => hs.has(String(x.entity_id)));
            const degerler = A.degerler.filter(x => hs.has(String(x.entity_id)));
            const urunler = A.urunler.filter(x => hs.has(String(x.entity_id)));
            const kalemMeta = A.kalemMeta.filter(x => hs.has(String(x.id)));
            const pMap = {}; (await cl.query('SELECT id, eski_id FROM sat_parametreler WHERE eski_id IS NOT NULL')).rows.forEach(r => { pMap[r.eski_id] = r.id; });
            const uMap = {}; (await cl.query('SELECT id, eski_id FROM sat_urunler WHERE eski_id IS NOT NULL')).rows.forEach(r => { uMap[r.eski_id] = r.id; });
            const wsIdler = hedef.map(e => e2w[e]);
            await cl.query(`DELETE FROM sat_analiz_degerler WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);
            await cl.query(`DELETE FROM sat_analiz_urunler  WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);
            await cl.query(`DELETE FROM sat_analiz_bolumler WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);
            // Toplu yazım (satır satır yerine) — 10 binlerce satır olabilir
            const topluEkle = async (tablo, kolonlar, satirlar) => {
                for (let i = 0; i < satirlar.length; i += 1000) {
                    const parca = satirlar.slice(i, i + 1000); const deg = [];
                    const yer = parca.map((s, j) => '(' + s.map((v, x) => { deg.push(v); return '$' + (j * s.length + x + 1); }).join(',') + ')');
                    await cl.query(`INSERT INTO ${tablo} (${kolonlar.join(',')}) VALUES ${yer.join(',')}`, deg);
                }
            };
            await topluEkle('sat_analiz_bolumler', ['eski_id', 'kaynak', 'kalem_id', 'eski_entity_id', 'ad', 'sira', 'kapsamda', 'ust_bolum_eski_id', 'urun_kategori_eski_id'],
                bolumler.map(b => [b.id, 'TEKLIF_KALEMI', e2w[b.entity_id], b.entity_id, b.name, b.order_no, b.included_in_scope, b.parent_id, b.product_category_id]));
            const dSat = degerler.filter(d => pMap[d.attribute_type_id]);
            if (dSat.length < degerler.length) rapor.uyari.push(`Analiz: ${degerler.length - dSat.length} değerin parametresi eşleşmedi`);
            await topluEkle('sat_analiz_degerler', ['eski_id', 'kaynak', 'kalem_id', 'eski_entity_id', 'parametre_id', 'deger', 'bolum_eski_id'],
                dSat.map(d => [d.id, 'TEKLIF_KALEMI', e2w[d.entity_id], d.entity_id, pMap[d.attribute_type_id], d.value, d.attribute_category_id]));
            const uSat = urunler.filter(u => uMap[u.product_id]);
            if (uSat.length < urunler.length) rapor.uyari.push(`Analiz: ${urunler.length - uSat.length} döküm satırının ürünü eşleşmedi`);
            await topluEkle('sat_analiz_urunler', ['eski_id', 'kaynak', 'kalem_id', 'eski_entity_id', 'urun_id', 'miktar', 'sira', 'notu', 'kilit_maliyet', 'kilit_satis', 'kilit_para_birimi', 'kilit_tarihi', 'elle_duzenlendi'],
                uSat.map(u => [u.id, 'TEKLIF_KALEMI', e2w[u.entity_id], u.entity_id, uMap[u.product_id], u.amount, u.order_no, u.note, u.cost, u.sales_price, u.para || null, u.price_calculated_at, !!u.edited_by_user]));
            const DURUM = { 1: 'BELIRTILMEMIS', 2: 'ANALIZ_SURECINDE', 3: 'ANALIZ_TAMAMLANDI' };
            for (const m of kalemMeta) {
                const wsId = e2w[m.id]; const durum = DURUM[m.durum] || 'BELIRTILMEMIS';
                let oneri = null;
                if (durum === 'ANALIZ_TAMAMLANDI') {
                    const t = await cl.query(`SELECT SUM(miktar * kilit_satis) s FROM sat_analiz_urunler WHERE kalem_id=$1`, [wsId]);
                    oneri = t.rows[0].s != null ? parseFloat(t.rows[0].s) : null;
                }
                await cl.query(`UPDATE sat_teklif_kalemleri SET analiz_durumu=$1, analiz_tarihi=COALESCE($2, analiz_tarihi),
                    analiz_eden=COALESCE($3, analiz_eden), onerilen_fiyat=COALESCE($4, onerilen_fiyat),
                    fiyat_hesap_tarihi=COALESCE($5, fiyat_hesap_tarihi) WHERE id=$6`,
                    [durum, m.price_calculated_at, eposta(m.created_by), oneri, oneri != null ? m.price_calculated_at : null, wsId]);
            }
            say('analiz (kalem)', 'guncellenen', hedef.length);
            say('analiz bölüm', 'eklenen', bolumler.length);
            say('analiz değer', 'eklenen', dSat.length);
            say('analiz döküm satırı', 'eklenen', uSat.length);
        }
        await cl.query(`INSERT INTO sistem_ayarlari (anahtar, deger, guncelleme) VALUES ('aset_analiz_fark_son', $1, now())
            ON CONFLICT (anahtar) DO UPDATE SET deger=$1, guncelleme=now()`, [JSON.stringify(eskiSimdi)]);

        // ---------------- Bitiş ----------------
        if (UYGULA) { await cl.query('COMMIT'); console.log('✅ COMMIT — değişiklikler kalıcı.'); }
        else { await cl.query('ROLLBACK'); console.log('↩️  DENEME — hiçbir şey yazılmadı (ROLLBACK).'); }

        console.log('\n--- EKLENEN ---'); Object.entries(rapor.eklenen).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
        console.log('--- GÜNCELLENEN ---'); Object.entries(rapor.guncellenen).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
        console.log('--- YALNIZ BOŞ ALAN DOLDURULAN ---'); Object.entries(rapor.dolgu).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
        console.log('--- KORUNAN PROJELER (durumuna dokunulmadı) ---'); korunanProjeler.forEach(x => console.log('  ' + x));
        console.log('--- ATLANAN / KORUNAN ---'); rapor.atlanan.forEach(x => console.log('  ' + x));
        const uy = {}; rapor.uyari.forEach(x => { uy[x] = (uy[x] || 0) + 1; });
        console.log('--- UYARILAR ---'); Object.entries(uy).forEach(([x, n]) => console.log(`  ${n > 1 ? n + '× ' : ''}${x}`));
        fs.writeFileSync(__dirname + '/aktarim-son-rapor.json', JSON.stringify({ zaman: new Date(), UYGULA, rapor, korunanProjeler }, null, 1));
    } catch (e) {
        if (cl) await cl.query('ROLLBACK').catch(() => {});
        console.error('❌ HATA — hiçbir şey değiştirilmedi:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n'));
        process.exitCode = 1;
    } finally { cl?.release(); await pool.end(); }
})();

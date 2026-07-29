// ============================================================================
// ANALİZ FARK AKTARIMI — eski sistemde (aset.aterko.com) çalışılmaya devam eden
// fiyat analizlerini Workspace'e taşır. Kesme tarihine kadar periyodik çalıştırılır.
//
// Mantık: son aktarımdan beri eski sistemde DOKUNULAN teklif kalemlerini bulur,
// o kalemlerin analiz verisini (bölümler + değerler + döküm + fiyat kilitleri)
// Workspace'te KOMPLE TAZELER (sil + yeniden yaz). Eski sistem analiz için tek
// doğru kaynak olduğundan güvenlidir; yine de Workspace'te elle üretilmiş
// (eski_id'siz) satırı olan kalem ATLANIR ve raporlanır.
//
// Idempotent: aynı kesimle tekrar çalıştırmak aynı sonucu üretir. Son aktarım
// zamanı sistem_ayarlari.aset_analiz_fark_son'da tutulur.
//
// Kullanım: node aktarim-analiz-fark.js          (kayıtlı kesimden bugüne)
//           node aktarim-analiz-fark.js 2026-07-26   (kesimi elle ver)
// ============================================================================
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Eski RDS'e salt-okunur erişim EC2 üzerinden (SSH anahtarı 2026-07-26'da kuruldu)
const ESKI_PSQL = "PGPASSWORD='Asdvg--jdk35sdf+a23--' psql -h database-aset-5.c2bvmn8gndok.eu-west-1.rds.amazonaws.com -U aterko_prod_db_user -d aterko_prod_db -t -A -f -";
function eskiSorgu(sql) {
    // SQL stdin'den gider — tırnak kaçırma derdi yok. Çıktı tek satır JSON.
    const out = execFileSync('ssh',
        ['-i', process.env.HOME + '/.ssh/aterko_ec2', '-o', 'ConnectTimeout=15', 'ubuntu@52.18.78.68', ESKI_PSQL],
        { input: `SELECT COALESCE(json_agg(x), '[]') FROM (${sql}) x;`, maxBuffer: 512 * 1024 * 1024 }).toString().trim();
    return JSON.parse(out || '[]');
}

// Eski jhi_user login → e-posta (analiz_eden alanı için)
const LOGIN_EMAIL = {
    yunus: 'yunus@aterko.com', yakup: 'yakup@aterko.com', mahmut: 'mahmut@aterko.com',
    tahir: 'tahir@aterko.com', mehmetuysal: 'mehmetuysal@aterko.com', varol: 'varol@aterko.com',
    ais: 'ais@aterko.com', ayse: 'aysesozan@aterko.com', ofb: 'ofb@aterko.com',
    muratongudu: 'muratongudu@gmail.com', yaa: 'asimaksoy@gmail.com'
};
const DURUM_MAP = { 1: 'BELIRTILMEMIS', 2: 'ANALIZ_SURECINDE', 3: 'ANALIZ_TAMAMLANDI' };

(async () => {
    const cl = await pool.connect();
    try {
        // 1) Kesim zamanı: parametre > kayıtlı ayar > ilk aktarım günü
        let kesim = process.argv[2];
        if (!kesim) {
            const a = await pool.query(`SELECT deger FROM sistem_ayarlari WHERE anahtar='aset_analiz_fark_son'`);
            kesim = a.rows[0]?.deger?.replace(/"/g, '') || '2026-07-26';
        }
        // Yeni kesim = eski veritabanının ŞU ANI (saat farkı/replikasyon derdi olmasın)
        const eskiSimdi = eskiSorgu(`SELECT now()::text AS t`)[0].t;
        console.log(`Kesim: ${kesim} → ${eskiSimdi}`);

        // 2) Eski sistemde dokunulan teklif kalemleri
        const K = `'${kesim}'`;
        const etkilenen = eskiSorgu(`
            SELECT DISTINCT e FROM (
                SELECT entity_id e FROM attribute WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM attribute_category WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM component_product WHERE entity_name='proposalComponent' AND (created_date>${K} OR last_modified_date>${K})
                UNION SELECT entity_id FROM component_product_price_set WHERE entity_name='proposalComponent' AND created_date>${K}
                UNION SELECT id FROM proposal_component WHERE last_modified_date>${K}
            ) y`).map(r => r.e);
        console.log(`Eski sistemde dokunulan kalem: ${etkilenen.length}`);
        if (!etkilenen.length) { console.log('Fark yok, çıkılıyor.'); return; }

        // 3) Workspace karşılıkları
        const wsK = await pool.query(
            `SELECT id, eski_id FROM sat_teklif_kalemleri WHERE eski_id = ANY($1::int[])`, [etkilenen]);
        const eski2ws = {}; wsK.rows.forEach(r => { eski2ws[r.eski_id] = r.id; });
        const eksikKalem = etkilenen.filter(e => !eski2ws[e]);
        if (eksikKalem.length) {
            console.log(`⚠️ ${eksikKalem.length} kalemin Workspace karşılığı yok (önce teklif fark aktarımı gerekli): ${eksikKalem.join(', ')}`);
        }
        let hedefEski = etkilenen.filter(e => eski2ws[e]);

        // 4) Koruma: Workspace'te elle üretilmiş (eski_id'siz) analiz satırı olan kalem tazelenmez
        const wsIdler = hedefEski.map(e => eski2ws[e]);
        const yerli = await pool.query(`
            SELECT DISTINCT kalem_id FROM (
                SELECT kalem_id FROM sat_analiz_bolumler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL
                UNION ALL SELECT kalem_id FROM sat_analiz_degerler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL
                UNION ALL SELECT kalem_id FROM sat_analiz_urunler WHERE kalem_id = ANY($1::int[]) AND eski_id IS NULL
            ) y`, [wsIdler]);
        if (yerli.rowCount) {
            const korunan = new Set(yerli.rows.map(r => r.kalem_id));
            console.log(`⚠️ ${korunan.size} kalemde Workspace'te elle üretilmiş analiz var, ATLANDI: ${[...korunan].join(', ')}`);
            hedefEski = hedefEski.filter(e => !korunan.has(eski2ws[e]));
        }
        if (!hedefEski.length) { console.log('Taşınacak kalem kalmadı.'); return; }
        const idListe = hedefEski.join(',');

        // 5) Eski veriyi çek
        const bolumler = eskiSorgu(`
            SELECT id, entity_id, name, order_no, included_in_scope, parent_id, product_category_id
            FROM attribute_category WHERE entity_name='proposalComponent' AND entity_id IN (${idListe})`);
        const degerler = eskiSorgu(`
            SELECT id, entity_id, value, attribute_type_id, attribute_category_id
            FROM attribute WHERE entity_name='proposalComponent' AND entity_id IN (${idListe})`);
        const urunler = eskiSorgu(`
            SELECT cp.id, cp.entity_id, cp.product_id, cp.amount, cp.order_no, cp.note,
                   p.cost, p.sales_price, p.edited_by_user, cu.code AS para, s.price_calculated_at
            FROM component_product cp
            LEFT JOIN LATERAL (SELECT * FROM component_product_price
                WHERE component_product_id=cp.id ORDER BY id DESC LIMIT 1) p ON true
            LEFT JOIN currency cu ON cu.id=p.currency_id
            LEFT JOIN component_product_price_set s ON s.id=p.component_product_price_set_id
            WHERE cp.entity_name='proposalComponent' AND cp.entity_id IN (${idListe})`);
        const kalemMeta = eskiSorgu(`
            SELECT pc.id, pc.proposal_component_status_id AS durum,
                   ps.price_calculated_at, ps.created_by
            FROM proposal_component pc
            LEFT JOIN LATERAL (SELECT * FROM component_product_price_set
                WHERE entity_name='proposalComponent' AND entity_id=pc.id ORDER BY id DESC LIMIT 1) ps ON true
            WHERE pc.id IN (${idListe})`);
        console.log(`Eski veri: ${bolumler.length} bölüm, ${degerler.length} değer, ${urunler.length} döküm satırı, ${kalemMeta.length} kalem`);

        // 6) Workspace kimlik haritaları
        const pMap = {}; (await pool.query('SELECT id, eski_id FROM sat_parametreler WHERE eski_id IS NOT NULL')).rows
            .forEach(r => { pMap[r.eski_id] = r.id; });
        const uMap = {}; (await pool.query('SELECT id, eski_id FROM sat_urunler WHERE eski_id IS NOT NULL')).rows
            .forEach(r => { uMap[r.eski_id] = r.id; });

        // 7) Tazele — tek işlem: ya hepsi ya hiçbiri
        await cl.query('BEGIN');
        await cl.query(`DELETE FROM sat_analiz_degerler WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);
        await cl.query(`DELETE FROM sat_analiz_urunler  WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);
        await cl.query(`DELETE FROM sat_analiz_bolumler WHERE kaynak='TEKLIF_KALEMI' AND kalem_id = ANY($1::int[])`, [wsIdler]);

        for (const b of bolumler) {
            await cl.query(`INSERT INTO sat_analiz_bolumler
                (eski_id, kaynak, kalem_id, eski_entity_id, ad, sira, kapsamda, ust_bolum_eski_id, urun_kategori_eski_id)
                VALUES ($1,'TEKLIF_KALEMI',$2,$3,$4,$5,$6,$7,$8)`,
                [b.id, eski2ws[b.entity_id], b.entity_id, b.name, b.order_no, b.included_in_scope, b.parent_id, b.product_category_id]);
        }
        let parametresiz = 0;
        for (const d of degerler) {
            const pid = pMap[d.attribute_type_id];
            if (!pid) { parametresiz++; continue; }
            await cl.query(`INSERT INTO sat_analiz_degerler
                (eski_id, kaynak, kalem_id, eski_entity_id, parametre_id, deger, bolum_eski_id)
                VALUES ($1,'TEKLIF_KALEMI',$2,$3,$4,$5,$6)`,
                [d.id, eski2ws[d.entity_id], d.entity_id, pid, d.value, d.attribute_category_id]);
        }
        let urunsuz = 0;
        for (const u of urunler) {
            const uid = uMap[u.product_id];
            if (!uid) { urunsuz++; continue; }
            await cl.query(`INSERT INTO sat_analiz_urunler
                (eski_id, kaynak, kalem_id, eski_entity_id, urun_id, miktar, sira, notu,
                 kilit_maliyet, kilit_satis, kilit_para_birimi, kilit_tarihi, elle_duzenlendi)
                VALUES ($1,'TEKLIF_KALEMI',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [u.id, eski2ws[u.entity_id], u.entity_id, uid, u.amount, u.order_no, u.note,
                 u.cost, u.sales_price, u.para || null, u.price_calculated_at, !!u.edited_by_user]);
        }
        // Kalem üstbilgisi: durum + analiz tarihi/eden + (tamamlandıysa) önerilen fiyat
        for (const m of kalemMeta) {
            const wsId = eski2ws[m.id];
            const durum = DURUM_MAP[m.durum] || 'BELIRTILMEMIS';
            const eden = m.created_by ? (LOGIN_EMAIL[m.created_by] || m.created_by) : null;
            let oneri = null;
            if (durum === 'ANALIZ_TAMAMLANDI') {
                const t = await cl.query(
                    `SELECT SUM(miktar * kilit_satis) s FROM sat_analiz_urunler WHERE kalem_id=$1`, [wsId]);
                oneri = t.rows[0].s != null ? parseFloat(t.rows[0].s) : null;
            }
            await cl.query(`UPDATE sat_teklif_kalemleri SET
                analiz_durumu=$1, analiz_tarihi=COALESCE($2, analiz_tarihi), analiz_eden=COALESCE($3, analiz_eden),
                onerilen_fiyat=COALESCE($4, onerilen_fiyat), fiyat_hesap_tarihi=COALESCE($5, fiyat_hesap_tarihi)
                WHERE id=$6`, [durum, m.price_calculated_at, eden, oneri, oneri != null ? m.price_calculated_at : null, wsId]);
        }
        // Kesim ilerlet
        await cl.query(`INSERT INTO sistem_ayarlari (anahtar, deger, guncelleme) VALUES ('aset_analiz_fark_son', $1, now())
            ON CONFLICT (anahtar) DO UPDATE SET deger=$1, guncelleme=now()`, [JSON.stringify(eskiSimdi)]);
        await cl.query('COMMIT');
        console.log(`TAMAM: ${hedefEski.length} kalem tazelendi (${bolumler.length} bölüm, ${degerler.length - parametresiz} değer, ${urunler.length - urunsuz} döküm).`);
        if (parametresiz) console.log(`⚠️ ${parametresiz} değer parametre eşleşmediği için atlandı.`);
        if (urunsuz) console.log(`⚠️ ${urunsuz} döküm satırı ürün eşleşmediği için atlandı.`);
        console.log(`Yeni kesim kaydedildi: ${eskiSimdi}`);
    } catch (e) {
        await cl.query('ROLLBACK').catch(() => {});
        console.error('HATA, hiçbir şey değiştirilmedi:', e.message);
        process.exitCode = 1;
    } finally { cl.release(); await pool.end(); }
})();

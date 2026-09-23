// ============================================================================
// SON AKTARIM — BÖLÜM B: ESKİ SİSTEMDE HİÇ TAŞINMAMIŞ TABLOLAR
// (Yunus kararı 2026-09-23: "Eski sistemde kalan her şeyi taşıyalım")
//
// Eski bina/teslimat/iş emri zinciri Workspace'in CANLI teslimat tablolarına
// YAZILMAZ: projeler.durum teslimatlardan hesaplanıyor; 3.700 eski bina canlı
// tabloya girse Projeler listesindeki durumlar değişirdi (Yunus kuralı: dokunma).
// Bu yüzden eski_* ARŞİV tablolarına, proje_id ile bağlı olarak yazılır.
//
// Idempotent: her tablo eski_id ile UPSERT edilir; tekrar çalıştırmak güvenli.
// Kullanım:  node aktarim-arsiv.js            → DENEME (ROLLBACK)
//            node aktarim-arsiv.js --uygula   → COMMIT
// ============================================================================
const { pool, eskiSorgu, eskiSayfali, eposta } = require('./aktarim-ortak');
const UYGULA = process.argv.includes('--uygula');
const rapor = [];

const DDL = `
CREATE TABLE IF NOT EXISTS eski_binalar (
  eski_id bigint PRIMARY KEY, proje_id int REFERENCES projeler(id) ON DELETE SET NULL, proje_kodu text,
  ad text, notu text, miktar numeric, ikincil_miktar numeric, birim text, ikincil_birim text, sira int,
  bilesen_turu text, kaynak_teklif_eski_id bigint, kaynak_kalem_eski_id bigint,
  kaynak_kalem_id int REFERENCES sat_teklif_kalemleri(id) ON DELETE SET NULL,
  olusturan text, olusturma_tarihi timestamptz, guncelleyen text, guncelleme timestamptz);
CREATE TABLE IF NOT EXISTS eski_teslimatlar (
  eski_id bigint PRIMARY KEY, kod text, bina_eski_id bigint, proje_id int REFERENCES projeler(id) ON DELETE SET NULL,
  ad text, sira int, miktar numeric, birim text, durum text);
CREATE TABLE IF NOT EXISTS eski_is_emirleri (
  eski_id bigint PRIMARY KEY, kod text, teslimat_eski_id bigint, proje_id int REFERENCES projeler(id) ON DELETE SET NULL,
  tarih timestamptz, planlanan_baslangic timestamptz, planlanan_sevk timestamptz, planlanan_teslim timestamptz,
  notu text, durum text, olusturan text, olusturma_tarihi timestamptz, guncelleyen text, guncelleme timestamptz);
CREATE TABLE IF NOT EXISTS eski_is_emri_kalemleri (
  eski_id bigint PRIMARY KEY, is_emri_eski_id bigint, urun_kategorisi text, urun_kategori_eski_id bigint,
  saglayan text, uygulayan text, notu text);
CREATE TABLE IF NOT EXISTS eski_gorevler (
  eski_id bigint PRIMARY KEY, is_emri_eski_id bigint, teslimat_eski_id bigint, analiz_urun_eski_id bigint,
  gorev_turu text, saglayan text, uygulayan text, notu text);
CREATE TABLE IF NOT EXISTS sat_analiz_fiyat_gecmisi (
  eski_id bigint PRIMARY KEY, analiz_urun_eski_id bigint, hesap_eski_id bigint, varlik text, varlik_eski_id bigint,
  maliyet numeric, satis numeric, para_birimi text, elle_duzenlendi boolean, hesap_tarihi timestamptz,
  olusturan text, olusturma_tarihi timestamptz);
CREATE TABLE IF NOT EXISTS eski_kontrol_madde_turleri (
  eski_id bigint PRIMARY KEY, ad text, sira int, proje_asamasi text);
CREATE TABLE IF NOT EXISTS eski_kontrol_listesi_tanimlari (
  eski_id bigint PRIMARY KEY, ad text, projedeki_agirlik numeric, proje_id int REFERENCES projeler(id) ON DELETE SET NULL,
  proje_kodu text, bina_eski_id bigint, bilesen_kategorisi text, sira int, olusturan text, olusturma_tarihi timestamptz);
CREATE TABLE IF NOT EXISTS eski_kontrol_madde_tanimlari (
  eski_id bigint PRIMARY KEY, liste_tanim_eski_id bigint, madde_turu_eski_id bigint, aktif boolean, musteri_sorumlu boolean);
CREATE TABLE IF NOT EXISTS eski_kontrol_listeleri (
  eski_id bigint PRIMARY KEY, proje_id int REFERENCES projeler(id) ON DELETE SET NULL, proje_kodu text, bina_eski_id bigint,
  liste_tanim_eski_id bigint, olusturan text, olusturma_tarihi timestamptz, guncelleyen text, guncelleme timestamptz);
CREATE TABLE IF NOT EXISTS eski_kontrol_maddeleri (
  eski_id bigint PRIMARY KEY, liste_eski_id bigint, madde_turu_eski_id bigint, tamamlandi boolean,
  tamamlanma_tarihi timestamptz, notu text);
CREATE TABLE IF NOT EXISTS doviz_kur_gecmisi (
  tarih date, doviz_kodu text, doviz_adi text, doviz_alis numeric, doviz_satis numeric,
  efektif_alis numeric, efektif_satis numeric, kaynak text, PRIMARY KEY (tarih, doviz_kodu));
CREATE TABLE IF NOT EXISTS gider_kategorileri (eski_id bigint PRIMARY KEY, ad text, sira int);
CREATE TABLE IF NOT EXISTS gider_turleri (
  eski_id bigint PRIMARY KEY, kategori_eski_id bigint, ad text, sira int, urun_kategori_eski_id bigint, urun_kategorisine_bagli boolean);
CREATE TABLE IF NOT EXISTS eski_dosyalar (
  eski_id bigint PRIMARY KEY, ad text, s3_yolu text, kucuk_resim_yolu text, orta_resim_yolu text,
  tur text, medya boolean, varlik text, varlik_eski_id bigint,
  proje_id int REFERENCES projeler(id) ON DELETE SET NULL, musteri_id int REFERENCES sat_musteriler(id) ON DELETE SET NULL,
  musteri_ile_paylas boolean, ilgili_tarih timestamptz, olusturan text, olusturma_tarihi timestamptz,
  guncelleyen text, guncelleme timestamptz, workspace_yolu text);
CREATE TABLE IF NOT EXISTS eski_sistem_arsivi (tablo text, eski_id bigint, veri jsonb, PRIMARY KEY (tablo, eski_id));
CREATE INDEX IF NOT EXISTS idx_eski_binalar_proje ON eski_binalar(proje_id);
CREATE INDEX IF NOT EXISTS idx_eski_teslimatlar_proje ON eski_teslimatlar(proje_id);
CREATE INDEX IF NOT EXISTS idx_eski_is_emirleri_proje ON eski_is_emirleri(proje_id);
CREATE INDEX IF NOT EXISTS idx_eski_iek_emir ON eski_is_emri_kalemleri(is_emri_eski_id);
CREATE INDEX IF NOT EXISTS idx_eski_gorev_emir ON eski_gorevler(is_emri_eski_id);
CREATE INDEX IF NOT EXISTS idx_fiyat_gecmisi_urun ON sat_analiz_fiyat_gecmisi(analiz_urun_eski_id);
CREATE INDEX IF NOT EXISTS idx_fiyat_gecmisi_varlik ON sat_analiz_fiyat_gecmisi(varlik, varlik_eski_id);
CREATE INDEX IF NOT EXISTS idx_eski_kl_proje ON eski_kontrol_listeleri(proje_id);
CREATE INDEX IF NOT EXISTS idx_eski_km_liste ON eski_kontrol_maddeleri(liste_eski_id);
CREATE INDEX IF NOT EXISTS idx_eski_dosya_proje ON eski_dosyalar(proje_id);
CREATE INDEX IF NOT EXISTS idx_eski_dosya_musteri ON eski_dosyalar(musteri_id);
`;
const YENI_TABLOLAR = ['eski_binalar', 'eski_teslimatlar', 'eski_is_emirleri', 'eski_is_emri_kalemleri', 'eski_gorevler',
    'sat_analiz_fiyat_gecmisi', 'eski_kontrol_madde_turleri', 'eski_kontrol_listesi_tanimlari', 'eski_kontrol_madde_tanimlari',
    'eski_kontrol_listeleri', 'eski_kontrol_maddeleri', 'doviz_kur_gecmisi', 'gider_kategorileri', 'gider_turleri',
    'eski_dosyalar', 'eski_sistem_arsivi'];

// Ham halleriyle genel arşive giden küçük tablolar
const HAM_TABLOLAR = ['budget', 'budget_item', 'financial_analysis', 'city', 'country', 'sehirler_eslesmis', 'customer_rep',
    'price_type', 'comment_type', 'project_status', 'project_phase', 'my_month', 'attribute_data_type', 'attribute_field_type',
    'configg', 'task_type', 'task_category', 'task_assignee', 'deliverable_status', 'work_order_status', 'my_file_type',
    'my_file_type_permission', 'project_check_item_type', 'expense_type', 'expense_category', 'component_category', 'unit_type'];

(async () => {
    const cl = await pool.connect();
    // Toplu UPSERT: satırlar dizi-dizisi; pk çakışırsa tüm kolonlar tazelenir
    const upsert = async (tablo, kolonlar, pk, satirlar) => {
        const guncel = kolonlar.filter(c => !pk.includes(c)).map(c => `${c}=EXCLUDED.${c}`).join(',');
        for (let i = 0; i < satirlar.length; i += 1000) {
            const parca = satirlar.slice(i, i + 1000); const deg = [];
            const yer = parca.map((s, j) => '(' + s.map((v, x) => { deg.push(v); return '$' + (j * s.length + x + 1); }).join(',') + ')');
            await cl.query(`INSERT INTO ${tablo} (${kolonlar.join(',')}) VALUES ${yer.join(',')}
                ON CONFLICT (${pk.join(',')}) DO ${guncel ? 'UPDATE SET ' + guncel : 'NOTHING'}`, deg);
        }
        rapor.push(`${tablo}: ${satirlar.length}`);
    };
    const adlar = (tablo) => { try { return Object.fromEntries(eskiSorgu(`SELECT id, name FROM ${tablo}`).map(r => [String(r.id), r.name])); } catch { return {}; } };
    try {
        console.log(`\n=== BÖLÜM B — ${UYGULA ? 'UYGULAMA (COMMIT)' : 'DENEME (ROLLBACK)'} ===\n`);
        // ---- Eşleme haritaları ----
        const projeId = Object.fromEntries((await cl.query(`SELECT proje_kodu, id FROM projeler`)).rows.map(r => [r.proje_kodu, r.id]));
        const pid = (eskiProje) => (eskiProje == null ? null : projeId[String(eskiProje)] || null);
        const kalemId = Object.fromEntries((await cl.query(`SELECT eski_id, id FROM sat_teklif_kalemleri WHERE eski_id IS NOT NULL`)).rows.map(r => [String(r.eski_id), r.id]));
        const musteriId = Object.fromEntries((await cl.query(`SELECT eski_id, id FROM sat_musteriler WHERE eski_id IS NOT NULL`)).rows.map(r => [String(r.eski_id), r.id]));
        const N = {
            birim: adlar('unit_type'), bilesen: adlar('component_type'), tesDurum: adlar('deliverable_status'),
            ieDurum: adlar('work_order_status'), kategori: adlar('product_category'), gorevTuru: adlar('task_type'),
            kisi: adlar('task_assignee'), asama: adlar('project_phase'), bilesenKat: adlar('component_category'),
            dosyaTuru: adlar('my_file_type'),
        };
        const ad = (m, k) => (k == null ? null : (m[String(k)] ?? String(k)));

        await cl.query('BEGIN');
        await cl.query(DDL);

        // ---- 1) Binalar (project_component) ----
        const binalar = eskiSorgu(`SELECT * FROM project_component`);
        await upsert('eski_binalar', ['eski_id', 'proje_id', 'proje_kodu', 'ad', 'notu', 'miktar', 'ikincil_miktar', 'birim', 'ikincil_birim', 'sira',
            'bilesen_turu', 'kaynak_teklif_eski_id', 'kaynak_kalem_eski_id', 'kaynak_kalem_id', 'olusturan', 'olusturma_tarihi', 'guncelleyen', 'guncelleme'], ['eski_id'],
            binalar.map(b => [b.id, pid(b.project_id), String(b.project_id), b.name, b.note, b.amount, b.secondary_amount,
                ad(N.birim, b.primary_unit_type_id), ad(N.birim, b.secondary_unit_type_id), b.order_no, ad(N.bilesen, b.component_type_id),
                b.proposal_id_copied_from, b.proposal_component_id_copied_from, kalemId[String(b.proposal_component_id_copied_from)] || null,
                eposta(b.created_by), b.created_date, eposta(b.last_modified_by), b.last_modified_date]));
        const binaProje = Object.fromEntries(binalar.map(b => [String(b.id), b.project_id]));

        // ---- 2) Teslimatlar (deliverable) ----
        const tes = eskiSorgu(`SELECT * FROM deliverable`);
        await upsert('eski_teslimatlar', ['eski_id', 'kod', 'bina_eski_id', 'proje_id', 'ad', 'sira', 'miktar', 'birim', 'durum'], ['eski_id'],
            tes.map(t => [t.id, t.code, t.project_component_id, pid(binaProje[String(t.project_component_id)]), t.name, t.order_no, t.amount,
                ad(N.birim, t.primary_unit_type_id), ad(N.tesDurum, t.deliverable_status_id)]));

        // ---- 3) İş emirleri + kalemleri + görevler ----
        const ie = eskiSorgu(`SELECT * FROM work_order`);
        await upsert('eski_is_emirleri', ['eski_id', 'kod', 'teslimat_eski_id', 'proje_id', 'tarih', 'planlanan_baslangic', 'planlanan_sevk', 'planlanan_teslim',
            'notu', 'durum', 'olusturan', 'olusturma_tarihi', 'guncelleyen', 'guncelleme'], ['eski_id'],
            ie.map(w => [w.id, w.code, w.deliverable_id, pid(w.project_id), w.work_order_date, w.planned_start_date, w.planned_transportation_date,
                w.planned_delivery_date, w.note, ad(N.ieDurum, w.work_order_status_id), eposta(w.created_by), w.created_date,
                eposta(w.last_modified_by), w.last_modified_date]));
        const iek = eskiSorgu(`SELECT * FROM work_order_item`);
        await upsert('eski_is_emri_kalemleri', ['eski_id', 'is_emri_eski_id', 'urun_kategorisi', 'urun_kategori_eski_id', 'saglayan', 'uygulayan', 'notu'], ['eski_id'],
            iek.map(k => [k.id, k.work_order_id, ad(N.kategori, k.product_category_id), k.product_category_id,
                ad(N.kisi, k.provider_id), ad(N.kisi, k.implementer_id), k.note]));
        const gorev = eskiSorgu(`SELECT * FROM task`);
        await upsert('eski_gorevler', ['eski_id', 'is_emri_eski_id', 'teslimat_eski_id', 'analiz_urun_eski_id', 'gorev_turu', 'saglayan', 'uygulayan', 'notu'], ['eski_id'],
            gorev.map(g => [g.id, g.work_order_id, g.deliverable_id, g.component_product_id, ad(N.gorevTuru, g.task_type_id),
                ad(N.kisi, g.provider_id), ad(N.kisi, g.implementer_id), g.note]));

        // ---- 4) Fiyat analizi geçmişi (component_product_price + set) ----
        const setler = Object.fromEntries(eskiSorgu(`SELECT id, entity_name, entity_id, price_calculated_at FROM component_product_price_set`)
            .map(s => [String(s.id), s]));
        const para = Object.fromEntries(eskiSorgu(`SELECT id, code FROM currency`).map(r => [String(r.id), r.code]));
        const fg = eskiSayfali(`SELECT id, component_product_id, component_product_price_set_id, cost, sales_price, currency_id,
            edited_by_user, created_by, created_date FROM component_product_price`, 25000);
        await upsert('sat_analiz_fiyat_gecmisi', ['eski_id', 'analiz_urun_eski_id', 'hesap_eski_id', 'varlik', 'varlik_eski_id', 'maliyet', 'satis',
            'para_birimi', 'elle_duzenlendi', 'hesap_tarihi', 'olusturan', 'olusturma_tarihi'], ['eski_id'],
            fg.map(f => { const s = setler[String(f.component_product_price_set_id)] || {};
                return [f.id, f.component_product_id, f.component_product_price_set_id, s.entity_name || null, s.entity_id || null,
                    f.cost, f.sales_price, para[String(f.currency_id)] || null, !!f.edited_by_user, s.price_calculated_at || null,
                    eposta(f.created_by), f.created_date]; }));

        // ---- 5) Kontrol listeleri ----
        const kmt = eskiSorgu(`SELECT * FROM project_check_item_type`);
        await upsert('eski_kontrol_madde_turleri', ['eski_id', 'ad', 'sira', 'proje_asamasi'], ['eski_id'],
            kmt.map(t => [t.id, t.name, t.order_no, ad(N.asama, t.project_phase_id)]));
        const klt = eskiSorgu(`SELECT * FROM project_check_list_def`);
        await upsert('eski_kontrol_listesi_tanimlari', ['eski_id', 'ad', 'projedeki_agirlik', 'proje_id', 'proje_kodu', 'bina_eski_id',
            'bilesen_kategorisi', 'sira', 'olusturan', 'olusturma_tarihi'], ['eski_id'],
            klt.map(t => [t.id, t.name, t.weight_in_project, pid(t.project_id), t.project_id == null ? null : String(t.project_id),
                t.project_component_id, ad(N.bilesenKat, t.component_category_id), t.order_no, eposta(t.created_by), t.created_date]));
        const kmd = eskiSorgu(`SELECT * FROM project_check_item_def`);
        await upsert('eski_kontrol_madde_tanimlari', ['eski_id', 'liste_tanim_eski_id', 'madde_turu_eski_id', 'aktif', 'musteri_sorumlu'], ['eski_id'],
            kmd.map(d => [d.id, d.project_check_list_def_id, d.project_check_item_type_id, d.active, d.customer_is_responsible]));
        const kl = eskiSorgu(`SELECT * FROM project_check_list`);
        await upsert('eski_kontrol_listeleri', ['eski_id', 'proje_id', 'proje_kodu', 'bina_eski_id', 'liste_tanim_eski_id',
            'olusturan', 'olusturma_tarihi', 'guncelleyen', 'guncelleme'], ['eski_id'],
            kl.map(l => [l.id, pid(l.project_id), l.project_id == null ? null : String(l.project_id), l.project_component_id,
                l.project_check_list_def_id, eposta(l.created_by), l.created_date, eposta(l.last_modified_by), l.last_modified_date]));
        const km = eskiSorgu(`SELECT * FROM project_check_item`);
        await upsert('eski_kontrol_maddeleri', ['eski_id', 'liste_eski_id', 'madde_turu_eski_id', 'tamamlandi', 'tamamlanma_tarihi', 'notu'], ['eski_id'],
            km.map(m => [m.id, m.project_check_list_id, m.project_check_item_type_id, m.completed, m.completed_date, m.note]));
        const listeProje = Object.fromEntries(kl.map(l => [String(l.id), l.project_id]));

        // ---- 6) Döviz kurları ----
        const kur = eskiSorgu(`SELECT * FROM exchange_rate`);
        const kurTekil = {};   // (tarih, kod) tekil — aynı gün iki kayıt varsa sonuncusu
        kur.forEach(k => { kurTekil[String(k.date).slice(0, 10) + '|' + k.currency_code] = k; });
        await upsert('doviz_kur_gecmisi', ['tarih', 'doviz_kodu', 'doviz_adi', 'doviz_alis', 'doviz_satis', 'efektif_alis', 'efektif_satis', 'kaynak'],
            ['tarih', 'doviz_kodu'], Object.values(kurTekil).map(k => [String(k.date).slice(0, 10), k.currency_code, k.currency_name,
                k.forex_buying, k.forex_selling, k.banknote_buying, k.banknote_selling, 'aset (TCMB)']));

        // ---- 7) Gider kategorileri ve türleri ----
        await upsert('gider_kategorileri', ['eski_id', 'ad', 'sira'], ['eski_id'],
            eskiSorgu(`SELECT * FROM expense_category`).map(k => [k.id, k.name, k.order_no]));
        await upsert('gider_turleri', ['eski_id', 'kategori_eski_id', 'ad', 'sira', 'urun_kategori_eski_id', 'urun_kategorisine_bagli'], ['eski_id'],
            eskiSorgu(`SELECT * FROM expense_type`).map(t => [t.id, t.expense_category_id, t.name, t.order_no, t.product_category_id, t.depends_on_product_category]));

        // ---- 8) Dosya kayıtları (içerikleri ayrı adımda taşınır) ----
        const dosya = eskiSorgu(`SELECT * FROM my_file`);
        const turMedya = Object.fromEntries(eskiSorgu(`SELECT id, media FROM my_file_type`).map(r => [String(r.id), r.media]));
        await upsert('eski_dosyalar', ['eski_id', 'ad', 's3_yolu', 'kucuk_resim_yolu', 'orta_resim_yolu', 'tur', 'medya', 'varlik', 'varlik_eski_id',
            'proje_id', 'musteri_id', 'musteri_ile_paylas', 'ilgili_tarih', 'olusturan', 'olusturma_tarihi', 'guncelleyen', 'guncelleme'], ['eski_id'],
            dosya.map(d => {
                const projeEski = d.entity_name === 'project' ? d.entity_id : d.entity_name === 'projectCheckList' ? listeProje[String(d.entity_id)] : null;
                return [d.id, d.name, d.path, d.image_thumbnail_path, d.image_medium_path, ad(N.dosyaTuru, d.my_file_type_id),
                    turMedya[String(d.my_file_type_id)] ?? null, d.entity_name || null, d.entity_id, pid(projeEski),
                    d.entity_name === 'customer' ? (musteriId[String(d.entity_id)] || null) : null, d.share_with_customer,
                    d.related_date, eposta(d.created_by), d.created_date, eposta(d.last_modified_by), d.last_modified_date];
            }));

        // ---- 9) Küçük tablolar — ham hâlleriyle genel arşive ----
        for (const t of HAM_TABLOLAR) {
            let satir; try { satir = eskiSorgu(`SELECT * FROM ${t}`); } catch { rapor.push(`${t}: okunamadı`); continue; }
            await upsert('eski_sistem_arsivi', ['tablo', 'eski_id', 'veri'], ['tablo', 'eski_id'],
                satir.map((r, i) => [t, r.id ?? i + 1, JSON.stringify(r)]));
        }
        // Projede taşınmamış alanlar (portal kimliği, tamamlanma oranı, etiket, büyüklük) —
        // müşteri portal ŞİFRESİ bilerek alınmaz (tam veritabanı yedeğinde duruyor)
        await upsert('eski_sistem_arsivi', ['tablo', 'eski_id', 'veri'], ['tablo', 'eski_id'],
            eskiSorgu(`SELECT id, guid, completion_rate, tag, total_amounts_by_unit_types FROM project`)
                .map(p => ['project_ek_alanlar', p.id, JSON.stringify(p)]));

        // ---- Bağ kontrolü ----
        const bag = async (sql) => (await cl.query(sql)).rows[0];
        console.log('Bağ kontrolü:');
        console.log('  bina → proje      :', await bag(`SELECT COUNT(*) FILTER (WHERE proje_id IS NOT NULL) bagli, COUNT(*) toplam FROM eski_binalar`));
        console.log('  bina → teklif kal.:', await bag(`SELECT COUNT(*) FILTER (WHERE kaynak_kalem_id IS NOT NULL) bagli, COUNT(*) FILTER (WHERE kaynak_kalem_eski_id IS NOT NULL) kaynakli FROM eski_binalar`));
        console.log('  teslimat → proje  :', await bag(`SELECT COUNT(*) FILTER (WHERE proje_id IS NOT NULL) bagli, COUNT(*) toplam FROM eski_teslimatlar`));
        console.log('  iş emri → proje   :', await bag(`SELECT COUNT(*) FILTER (WHERE proje_id IS NOT NULL) bagli, COUNT(*) toplam FROM eski_is_emirleri`));
        console.log('  dosya → proje/müş.:', await bag(`SELECT COUNT(*) FILTER (WHERE proje_id IS NOT NULL) proje, COUNT(*) FILTER (WHERE musteri_id IS NOT NULL) musteri, COUNT(*) toplam FROM eski_dosyalar`));
        console.log('  kontrol l. → proje:', await bag(`SELECT COUNT(*) FILTER (WHERE proje_id IS NOT NULL) bagli, COUNT(*) toplam FROM eski_kontrol_listeleri`));

        // RLS: diğer tablolar gibi açık (erişim yalnız API üzerinden)
        for (const t of YENI_TABLOLAR) await cl.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);

        if (UYGULA) { await cl.query('COMMIT'); console.log('\n✅ COMMIT'); } else { await cl.query('ROLLBACK'); console.log('\n↩️  DENEME — ROLLBACK'); }
        console.log('\nYazılan satırlar:'); rapor.forEach(r => console.log('  ' + r));
    } catch (e) {
        await cl.query('ROLLBACK').catch(() => {});
        console.error('❌ HATA — hiçbir şey değiştirilmedi:', e.message);
        process.exitCode = 1;
    } finally { cl.release(); await pool.end(); }
})();

// =============================================================================
// STOK HAREKETLERİ + DEPOLAR MIGRATION
//
// Adımlar:
//   1. depolar-import.tsv → depolar tablosu
//   2. stok-hareketleri-import.tsv → stok_hareketleri tablosu (batched)
//   3. Her stok kartının guncel_stok_miktari yeniden hesaplanır (toplu)
//
// Kullanım:
//   node migrate-stok-hareketleri.js          → DRY RUN
//   node migrate-stok-hareketleri.js --apply  → GERÇEK GÖÇ
// =============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const TSV_HAREKET = path.join(__dirname, 'stok-hareketleri-import.tsv');
const TSV_DEPO    = path.join(__dirname, 'depolar-import.tsv');
const BATCH       = 500;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------- Yardımcılar ----------
function parseTRNumber(s) {
    if (!s) return 0;
    return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

// "03.01.2022 00:00:00" → "2022-01-03 00:00:00"
function parseTarih(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (!m) return null;
    const dd = m[1].padStart(2,'0'), mm = m[2].padStart(2,'0'), yyyy = m[3];
    const hh = (m[4]||'00').padStart(2,'0'), mn = (m[5]||'00').padStart(2,'0'), ss = (m[6]||'00').padStart(2,'0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mn}:${ss}`;
}

function extractProjeKodu(projeStr) {
    if (!projeStr) return null;
    // "70239 / Müşteri - Proje" → 70239
    const m = String(projeStr).trim().match(/^(\d{5})\s*\//);
    return m ? m[1] : null;
}

async function main() {
    console.log(APPLY ? '🔴 GERÇEK GÖÇ MODU' : '🟢 DRY RUN MODU');
    console.log('═'.repeat(70));

    // ============== ADIM 1: DEPOLAR ==============
    console.log('\n📦 ADIM 1: Depolar');
    const depoRaw = fs.readFileSync(TSV_DEPO, 'utf8');
    const depoLines = depoRaw.split('\n').map(l => l.trim()).filter(Boolean);
    // İlk satır başlık ise atla
    const depolarRaw = depoLines.slice(depoLines[0].toLowerCase().includes('depo') ? 1 : 0);
    const depolar = [];
    depolarRaw.forEach(line => {
        const cols = line.split('\t').map(c => c.trim()).filter(Boolean);
        if (cols[0]) depolar.push({ ad: cols[0], adres: cols[1] || null });
    });
    console.log(`  Bulunan: ${depolar.length} depo →`, depolar.map(d => d.ad).join(', '));

    if (APPLY) {
        for (const d of depolar) {
            try {
                await pool.query("INSERT INTO depolar (ad, adres) VALUES ($1, $2) ON CONFLICT (ad) DO NOTHING", [d.ad, d.adres]);
            } catch (e) { console.log(`  ❌ Depo "${d.ad}":`, e.message); }
        }
    }

    // Depo adı → id eşleştirmesi
    const depoMapRes = await pool.query("SELECT id, ad FROM depolar");
    const depoMap = new Map();
    depoMapRes.rows.forEach(r => depoMap.set(r.ad.trim().toLowerCase(), r.id));
    console.log(`  ✅ DB'de toplam ${depoMap.size} depo`);

    // ============== ADIM 2: PRELOAD ==============
    console.log('\n📚 ADIM 2: Stok kartları ve projeler yükleniyor (eşleştirme için)...');
    const stokRes = await pool.query("SELECT id, stok_adi FROM stok_kartlari");
    const stokMap = new Map();
    stokRes.rows.forEach(r => stokMap.set(r.stok_adi.trim().toLowerCase(), r.id));
    console.log(`  Stok kartı: ${stokMap.size}`);

    const projeRes = await pool.query("SELECT id, proje_kodu FROM projeler");
    const projeMap = new Map();
    projeRes.rows.forEach(r => projeMap.set(r.proje_kodu, r.id));
    console.log(`  Proje:      ${projeMap.size}`);

    // ============== ADIM 3: HAREKETLER ==============
    console.log('\n📊 ADIM 3: Hareketler okunuyor...');
    const haraketRaw = fs.readFileSync(TSV_HAREKET, 'utf8');
    const hLines = haraketRaw.split('\n').filter(l => l.trim());
    const hHeader = hLines[0].split('\t').map(s => s.trim());
    console.log(`  Başlıklar:`, hHeader.slice(0, 10).join(' | '));
    const idx = {
        tarih:   hHeader.indexOf('Tarih'),
        urun:    hHeader.indexOf('Ürün Adı'),
        tip:     hHeader.indexOf('İşlem Tipi'),
        miktar:  hHeader.indexOf('Miktar'),
        proje:   hHeader.indexOf('Proje'),
        depo:    hHeader.indexOf('Depo'),
        aciklama:hHeader.indexOf('Açıklama'),
        kul:     hHeader.indexOf('Kullanıcı'),
        kategori: hHeader.indexOf('Kategori'),
        stokTipi: hHeader.indexOf('Stok Tipi')
    };

    const veri = hLines.slice(1).map(l => l.split('\t'));
    console.log(`  Okunan satır sayısı: ${veri.length}`);

    // ============== ADIM 3a: EKSİK DEPO/ÜRÜN TESPİT ==============
    const yeniDepolar = new Set();
    const yeniUrunler = new Map(); // urunAdi → { kategori, stokTipi }
    for (const r of veri) {
        const urunAdi = (r[idx.urun] || '').trim();
        if (urunAdi && !stokMap.has(urunAdi.toLowerCase())) {
            const kategori = (r[idx.kategori] || 'Genel').trim() || 'Genel';
            const stokTipi = (r[idx.stokTipi] || 'Hammadde').trim() || 'Hammadde';
            if (!yeniUrunler.has(urunAdi)) yeniUrunler.set(urunAdi, { kategori, stokTipi });
        }
        const depoAdi = (r[idx.depo] || '').trim();
        if (depoAdi && depoAdi !== 'Seçiniz...' && !depoMap.has(depoAdi.toLowerCase())) {
            yeniDepolar.add(depoAdi);
        }
    }
    console.log(`  ➕ Otomatik eklenecek depo:       ${yeniDepolar.size}`);
    console.log(`  ➕ Otomatik eklenecek stok kartı: ${yeniUrunler.size}`);

    if (APPLY) {
        for (const d of yeniDepolar) {
            await pool.query("INSERT INTO depolar (ad) VALUES ($1) ON CONFLICT (ad) DO NOTHING", [d]);
        }
        const depoTekrarRes = await pool.query("SELECT id, ad FROM depolar");
        depoTekrarRes.rows.forEach(r => depoMap.set(r.ad.trim().toLowerCase(), r.id));
        console.log(`  ✅ Toplam depo: ${depoMap.size}`);

        let urunEkli = 0;
        let urunSira = 0;
        for (const [urunAdi, info] of yeniUrunler) {
            const bMatch = urunAdi.match(/\[\s*([^\]]+?)\s*\]/);
            const birim = bMatch ? bMatch[1].trim() : 'adet';
            const tipKisa = info.stokTipi.substring(0,3).toUpperCase();
            const katKisa = info.kategori.replace(/[^A-Za-zĞÜŞİÖÇğüşıöç]/g,'').substring(0,3).toUpperCase();
            const kod = `${tipKisa}-${katKisa}-X${String(++urunSira).padStart(4,'0')}`;
            try {
                const r = await pool.query(`
                    INSERT INTO stok_kartlari (stok_tipi, kategori, stok_kodu, stok_adi, birim, kritik_stok_miktari, para_birimi, guncel_stok_miktari)
                    VALUES ($1,$2,$3,$4,$5,0,'TL',0) RETURNING id
                `, [info.stokTipi, info.kategori, kod, urunAdi, birim]);
                stokMap.set(urunAdi.toLowerCase(), r.rows[0].id);
                urunEkli++;
            } catch (e) {
                // Çakışma olursa stok_kodu'na timestamp ekle
                try {
                    const altKod = kod + '-' + Date.now().toString().slice(-5);
                    const r = await pool.query(`
                        INSERT INTO stok_kartlari (stok_tipi, kategori, stok_kodu, stok_adi, birim, kritik_stok_miktari, para_birimi, guncel_stok_miktari)
                        VALUES ($1,$2,$3,$4,$5,0,'TL',0) RETURNING id
                    `, [info.stokTipi, info.kategori, altKod, urunAdi, birim]);
                    stokMap.set(urunAdi.toLowerCase(), r.rows[0].id);
                    urunEkli++;
                } catch (e2) {
                    console.log(`  ❌ ${urunAdi.substring(0,60)}: ${e2.message.substring(0,80)}`);
                }
            }
        }
        console.log(`  ✅ ${urunEkli} yeni stok kartı eklendi`);
    }

    let bulundu = 0, urunEksik = 0, projeEksik = 0, depoEksik = 0, gecersiz = 0;
    const eksikUrunler = new Set();
    const eksikProjeler = new Set();
    const eksikDepolar = new Set();
    const kayitlar = [];

    for (let i = 0; i < veri.length; i++) {
        const r = veri[i];
        const urunAdi = (r[idx.urun] || '').trim();
        const tip = (r[idx.tip] || '').trim();
        const miktar = parseTRNumber(r[idx.miktar]);
        const tarih = parseTarih(r[idx.tarih]);
        if (!urunAdi || !tip || miktar <= 0 || !tarih) { gecersiz++; continue; }
        if (tip !== 'Giriş' && tip !== 'Çıkış') { gecersiz++; continue; }

        const stokId = stokMap.get(urunAdi.toLowerCase());
        if (!stokId) {
            urunEksik++;
            if (eksikUrunler.size < 20) eksikUrunler.add(urunAdi);
            continue; // Eşleşmeyenleri ATLA (kullanıcının kararı)
        }
        bulundu++;

        let projeId = null;
        const projeStr = r[idx.proje] || '';
        if (projeStr.trim()) {
            const kodu = extractProjeKodu(projeStr);
            if (kodu) {
                projeId = projeMap.get(kodu) || null;
                if (!projeId) {
                    projeEksik++;
                    if (eksikProjeler.size < 20) eksikProjeler.add(kodu + ' (' + projeStr.substring(0, 50) + ')');
                }
            }
        }

        let depoId = null;
        const depoAdi = (r[idx.depo] || '').trim();
        if (depoAdi) {
            depoId = depoMap.get(depoAdi.toLowerCase()) || null;
            if (!depoId) {
                depoEksik++;
                if (eksikDepolar.size < 10) eksikDepolar.add(depoAdi);
            }
        }

        kayitlar.push({
            tarih, stok_kart_id: stokId, tip, miktar,
            proje_id: projeId, depo_id: depoId,
            aciklama: (r[idx.aciklama] || '').trim() || null,
            kullanici_adsoyad: (r[idx.kul] || '').trim() || null
        });
    }

    console.log('\n📋 ÖZET:');
    console.log(`  ✅ İşlenecek:       ${bulundu.toLocaleString()}`);
    console.log(`  ⚠️  Stok bulunamadı: ${urunEksik.toLocaleString()} (eşleşmeyen ürün adı)`);
    console.log(`  ⚠️  Proje eşleşmedi: ${projeEksik.toLocaleString()} (proje_id null olur)`);
    console.log(`  ⚠️  Depo eşleşmedi:  ${depoEksik.toLocaleString()} (depo_id null olur)`);
    console.log(`  ❌ Geçersiz satır:   ${gecersiz.toLocaleString()}`);

    if (eksikUrunler.size > 0) {
        console.log('\n  Eşleşmeyen ürün örnekleri (ilk 5):');
        [...eksikUrunler].slice(0, 5).forEach(u => console.log('    •', u));
    }
    if (eksikProjeler.size > 0) {
        console.log('\n  Eşleşmeyen proje örnekleri (ilk 5):');
        [...eksikProjeler].slice(0, 5).forEach(p => console.log('    •', p));
    }
    if (eksikDepolar.size > 0) {
        console.log('\n  Eşleşmeyen depo örnekleri:');
        [...eksikDepolar].forEach(d => console.log('    •', d));
    }

    if (!APPLY) {
        console.log(`\n💡 ${bulundu} hareket yüklemek için: node migrate-stok-hareketleri.js --apply`);
        await pool.end();
        return;
    }

    // ============== ADIM 4: BATCH INSERT ==============
    console.log('\n📤 ADIM 4: Hareketler batch ile kaydediliyor...');
    let yuklenen = 0, hata = 0;
    for (let i = 0; i < kayitlar.length; i += BATCH) {
        const slice = kayitlar.slice(i, i + BATCH);
        // VALUES ($1,$2,...), ($N+1,...) ...
        const params = [];
        const places = slice.map((k, j) => {
            const b = j * 8;
            params.push(k.tarih, k.stok_kart_id, k.tip, k.miktar, k.proje_id, k.depo_id, k.aciklama, k.kullanici_adsoyad);
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
        }).join(', ');
        try {
            await pool.query(`
                INSERT INTO stok_hareketleri
                (tarih, stok_kart_id, tip, miktar, proje_id, depo_id, aciklama, kullanici_adsoyad)
                VALUES ${places}
            `, params);
            yuklenen += slice.length;
            if ((i / BATCH) % 4 === 0) console.log(`  ⏳ ${yuklenen.toLocaleString()} / ${kayitlar.length.toLocaleString()}`);
        } catch (e) {
            hata += slice.length;
            console.log(`  ❌ Batch ${i}-${i + slice.length}: ${e.message.substring(0, 200)}`);
        }
    }
    console.log(`\n  ✅ Yüklendi: ${yuklenen.toLocaleString()}, ❌ Hata: ${hata.toLocaleString()}`);

    // ============== ADIM 5: STOK BAKIYESI YENİDEN HESAPLA ==============
    console.log('\n🧮 ADIM 5: Stok kartlarının güncel miktarı yeniden hesaplanıyor...');
    await pool.query(`
        UPDATE stok_kartlari sk SET guncel_stok_miktari = COALESCE(t.bakiye, 0)
        FROM (
            SELECT stok_kart_id,
                   SUM(CASE WHEN tip='Giriş' THEN miktar ELSE -miktar END) as bakiye
            FROM stok_hareketleri GROUP BY stok_kart_id
        ) t
        WHERE sk.id = t.stok_kart_id
    `);
    console.log('  ✅ Tüm stok bakiyeleri güncellendi.');

    const dolu = await pool.query("SELECT COUNT(*) FROM stok_kartlari WHERE guncel_stok_miktari <> 0");
    console.log(`  📊 Bakiyesi 0 olmayan stok kartı: ${dolu.rows[0].count}`);

    console.log('\n' + '═'.repeat(70));
    await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

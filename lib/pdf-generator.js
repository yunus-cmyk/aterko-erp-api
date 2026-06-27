// =============================================================================
// PDF GENERATOR v2 — HTML şablon + placeholder motoru + Puppeteer
//
// İşlem sırası önemli:
//   1. HESAP   — placeholder içinde başka placeholder yok
//   2. Düz     — {{Alan}} değerleri yerine yazılır (EGER içindeki nested'lar dahil)
//   3. EGER    — Artık içinde {{}} yok, düzgün parse edilir
//   4. HARICI  — Cheerio ile DOM manipulation (tablo satırlarını sil)
//   5. Cleanup — Kalan placeholder'ları boşalt
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const cheerio = require('cheerio');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function escapeRegex(s) {
    return s.replace(/[.+*?^=!:${}()|[\]/\\]/g, '\\$&');
}

function kosulSaglandi(mevcut, op, beklenen) {
    const mevcutStr = String(mevcut == null ? '' : mevcut).trim();
    const beklenenStr = String(beklenen).trim();
    const tokens = mevcutStr.split(',').map(s => s.trim()).filter(Boolean);
    const icerir = tokens.includes(beklenenStr);
    return (op === '=' && mevcutStr === beklenenStr) ||
           (op === '!=' && mevcutStr !== beklenenStr) ||
           (op === '~=' && icerir) ||
           (op === '!~' && !icerir);
}

function formatSayi(n) {
    return (n === Math.floor(n)) ? String(Math.floor(n)) : parseFloat(n.toFixed(2)).toString();
}

// ---------- 1) HESAP ----------
function processHesap(html, degerler) {
    const regex = /\{\{HESAP:([^:}]+)(?::([^}]+))?\}\}/g;
    return html.replace(regex, (match, ifade, mod) => {
        const m2 = ifade.match(/^(.*)([+\-*/])\s*(\d+(?:[.,]\d+)?)$/);
        if (!m2) return '?';
        const alan = m2[1].trim();
        const op = m2[2];
        const sabit = parseFloat(m2[3].replace(',', '.'));
        const ham = String(degerler[alan] || '');
        const sayiM = ham.match(/\d+(?:[.,]\d+)?/);
        if (!sayiM) return '?';
        const alanDeger = parseFloat(sayiM[0].replace(',', '.'));
        if (isNaN(alanDeger) || isNaN(sabit)) return '?';
        let sonuc;
        if (op === '+') sonuc = alanDeger + sabit;
        else if (op === '-') sonuc = alanDeger - sabit;
        else if (op === '*') sonuc = alanDeger * sabit;
        else if (op === '/') sonuc = sabit !== 0 ? alanDeger / sabit : 0;
        const sonucStr = formatSayi(sonuc);
        const m = (mod || 'DENKLEM').toUpperCase();
        return m === 'SONUC' ? sonucStr : `${formatSayi(alanDeger)}${op}${formatSayi(sabit)}=${sonucStr}`;
    });
}

// ---------- 2) Düz placeholder ----------
function processDuz(html, degerler) {
    // Birden fazla geçiş yap — bir değer içinde başka placeholder olabilir
    let prev = '';
    let iter = 0;
    while (html !== prev && iter < 5) {
        prev = html;
        Object.keys(degerler).forEach(alan => {
            const val = degerler[alan];
            const safe = Array.isArray(val) ? val.join(', ') : String(val == null ? '' : val);
            const escaped = safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const regex = new RegExp('\\{\\{' + escapeRegex(alan) + '\\}\\}', 'g');
            html = html.replace(regex, escaped);
        });
        iter++;
    }
    return html;
}

// ---------- 3) EGER ----------
function processEger(html, degerler) {
    const regex = /\{\{EGER:([^=!~]+?)(!=|!~|~=|=)([^:]+?):([\s\S]*?)\}\}/g;
    return html.replace(regex, (match, alan, op, beklenen, yazilacak) => {
        const mevcut = degerler[alan.trim()];
        return kosulSaglandi(mevcut, op, beklenen.trim()) ? yazilacak : '';
    });
}

// ---------- 4) HARICI (cheerio ile DOM manipülasyonu) ----------
function processHarici($, degerler) {
    const hariciRegex = /\{\{HARICI:([^=!~]+?)(!=|!~|~=|=)([^:]+?)(?::(\d+))?\}\}/g;
    const gizlenen = []; // NOTLAR bölümü için gizlenen bölüm adları

    // Tüm metin içeriklerini tara
    $('*').contents().each(function () {
        if (this.type !== 'text') return;
        const txt = this.data;
        if (!txt || !txt.includes('{{HARICI:')) return;

        const matches = [...txt.matchAll(hariciRegex)];
        if (matches.length === 0) return;

        // Bu metni içeren tüm HARICI placeholderları işle
        matches.forEach(m => {
            const tam = m[0];
            const alan = m[1].trim();
            const op = m[2];
            const beklenen = m[3].trim();
            const N = parseInt(m[4]) || 0;
            const mevcut = degerler[alan];
            // "X=Yok" HARICI'sinde değer boş/seçilmemişse de gizle (form doldurulmamış bölüm = yok)
            const bosDeger = (mevcut == null || String(mevcut).trim() === '');
            const sagladi = kosulSaglandi(mevcut, op, beklenen) || (op === '=' && beklenen === 'Yok' && bosDeger);

            // Bu text node'unun parent'larını bul
            const $textNode = $(this);
            const $parent = $textNode.parent();

            if (sagladi) {
                if (!gizlenen.includes(alan)) gizlenen.push(alan);
                const $tr = $parent.closest('tr');
                if ($tr.length) {
                    // Tablo içi: bu satırdan sonraki satırları + bu satırı sil
                    this.data = this.data.replace(tam, '');
                    let $next = $tr.next('tr');
                    while ($next.length) { const $rm = $next; $next = $next.next('tr'); $rm.remove(); }
                    $tr.remove();
                } else {
                    // Tablo dışı (Google Docs: bölüm başlığı tablosu → <p>{{HARICI}}</p> → içerik tablosu)
                    const $blok = $textNode.closest('p').length ? $textNode.closest('p') : $parent;
                    // Bölüm başlığı tablosu: ilk hücresi "[N] BAŞLIK" (Google Docs) veya sadece sayı
                    const bolBas = $el => $el.is('table') &&
                        /^(\[\d+\]|\d+$)/.test($el.find('td,th').first().text().trim());
                    // TÜM HARICI bölümleri komple gizlenir (başlık tablosu + içerik, sonraki bölüm başlığına kadar)
                    let $p = $blok.prev();
                    while ($p.length) { const dur = bolBas($p); const $rm = $p; $p = $p.prev(); $rm.remove(); if (dur) break; }
                    let $n = $blok.next();
                    while ($n.length) { if (bolBas($n)) break; const $rm = $n; $n = $n.next(); $rm.remove(); }
                    $blok.remove();
                }
            } else {
                // Koşul yanlış → sadece placeholder'ı kaldır
                this.data = this.data.replace(tam, '');
            }
        });
    });
    return gizlenen;
}

// ---------- 5) Cleanup ----------
function cleanupRemaining(html) {
    return html.replace(/\{\{[^}]+\}\}/g, '');
}

// ---------- Ana ----------
function renderTemplate(templateName, degerler) {
    const templatePath = path.join(TEMPLATES_DIR, templateName + '.html');
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Şablon bulunamadı: ${templateName}.html`);
    }
    let html = fs.readFileSync(templatePath, 'utf8');

    html = processHesap(html, degerler);
    html = processDuz(html, degerler);
    html = processEger(html, degerler);

    const $ = cheerio.load(html);
    const gizlenen = processHarici($, degerler);

    // Gizlenen bölümler için sona NOTLAR bölümü ekle
    if (gizlenen.length) {
        const liste = gizlenen.join(', ');
        $('body').append(`<div class="notlar-bolum"><div class="notlar-baslik">NOTLAR</div>` +
            `<p class="notlar-icerik">${liste} bölüm${gizlenen.length > 1 ? 'leri' : 'ü'} kapsam dışında oldukları için gösterilmemiştir.</p></div>`);
    }

    // Print için sabit table layout ekleyelim
    $('head').append(`<style>
        @page { margin: 8mm 10mm; }
        body { margin: 0 !important; padding: 0 !important; }
        table { table-layout: auto; }
        td, th { word-wrap: break-word; }
        img { max-width: 100% !important; height: auto !important; }
        .notlar-bolum { margin-top: 18px; page-break-inside: avoid; }
        .notlar-baslik { font-weight: 700; font-size: 12.5pt; color: #1a1a1a; border-bottom: 1.5px solid #ff4c00; padding: 5px 2px 4px; margin: 16px 0 8px; }
        .notlar-icerik { font-size: 10pt; padding: 4px 2px; line-height: 1.5; }
    </style>`);

    html = $.html();
    html = cleanupRemaining(html);
    return html;
}

// ---------- PDF ----------
async function renderToPDF(templateName, degerler, opts) {
    return htmlToPDF(renderTemplate(templateName, degerler), opts);
}

// Hazır HTML string'i doğrudan PDF'e çevirir (dinamik üretim için — şablon dosyası gerekmez)
// opts: { headerTemplate, footerTemplate, margin } — her sayfada üst/alt bilgi için
async function htmlToPDF(html, opts = {}) {
    // Geçici dosyayı OS tmpdir'e yaz — proje klasöründe olursa Live Server reload tetikler.
    // images klasörünü de tmpdir'e symlink'liyoruz, çünkü resim yolları relative.
    const tmpRoot = path.join(os.tmpdir(), 'aterko-pdf-' + Date.now());
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tempFile = path.join(tmpRoot, 'render.html');
    const tempImages = path.join(tmpRoot, 'images');
    try {
        fs.symlinkSync(path.join(TEMPLATES_DIR, 'images'), tempImages);
    } catch (e) {
        // Symlink başarısız olursa kopyala (Windows fallback)
        if (e.code !== 'EEXIST') {
            // Basit kopyala — yalnızca gerekli durumlarda
        }
    }
    fs.writeFileSync(tempFile, html);

    // Render/production: @sparticuz/chromium (npm paketi — cache/path sorunu yok)
    // Lokal geliştirme: sistemdeki puppeteer Chrome'u
    let browser;
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
        const chromium = require('@sparticuz/chromium').default;
        const puppeteerCore = require('puppeteer-core');
        browser = await puppeteerCore.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true
        });
    } else {
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
    }
    try {
        const page = await browser.newPage();
        await page.goto(`file://${tempFile}`, { waitUntil: 'networkidle0' });
        const pdfAyar = {
            format: 'A4',
            margin: opts.margin || { top: '8mm', bottom: '8mm', left: '10mm', right: '10mm' },
            printBackground: true,
            preferCSSPageSize: false
        };
        if (opts.headerTemplate) {
            pdfAyar.displayHeaderFooter = true;
            pdfAyar.headerTemplate = opts.headerTemplate;
            pdfAyar.footerTemplate = opts.footerTemplate || '<span></span>';
        }
        const pdf = await page.pdf(pdfAyar);
        return pdf;
    } finally {
        await browser.close();
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    }
}

module.exports = { renderTemplate, renderToPDF, htmlToPDF };

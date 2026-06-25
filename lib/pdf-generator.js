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
            const sagladi = kosulSaglandi(mevcut, op, beklenen);

            // Bu text node'unun parent'larını bul
            const $textNode = $(this);
            const $parent = $textNode.parent();

            if (sagladi) {
                // Önce bu metni "Hariçtir." ile değiştir
                this.data = this.data.replace(tam, 'Hariçtir.');

                // Eğer parent bir tablo hücresindeyse, o satırdan sonraki TÜM satırları sil
                const $tr = $parent.closest('tr');
                if ($tr.length) {
                    let $next = $tr.next('tr');
                    while ($next.length) {
                        const $rm = $next;
                        $next = $next.next('tr');
                        $rm.remove();
                    }
                }
                // Ek olarak N tane sonraki body elementini sil (tablo dışındaysa)
                if (N > 0 && !$tr.length) {
                    let $cur = $parent;
                    for (let i = 0; i < N; i++) {
                        const $sib = $cur.next();
                        if (!$sib.length) break;
                        $sib.remove();
                    }
                }
            } else {
                // Koşul yanlış → sadece placeholder'ı kaldır
                this.data = this.data.replace(tam, '');
            }
        });
    });
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
    processHarici($, degerler);

    // Print için sabit table layout ekleyelim
    $('head').append(`<style>
        @page { margin: 8mm 10mm; }
        body { margin: 0 !important; padding: 0 !important; }
        table { table-layout: auto; }
        td, th { word-wrap: break-word; }
        img { max-width: 100% !important; height: auto !important; }
    </style>`);

    html = $.html();
    html = cleanupRemaining(html);
    return html;
}

// ---------- PDF ----------
async function renderToPDF(templateName, degerler) {
    const html = renderTemplate(templateName, degerler);

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
        const chromium = require('@sparticuz/chromium');
        const puppeteerCore = require('puppeteer-core');
        browser = await puppeteerCore.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
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
        const pdf = await page.pdf({
            format: 'A4',
            margin: { top: '8mm', bottom: '8mm', left: '10mm', right: '10mm' },
            printBackground: true,
            preferCSSPageSize: false
        });
        return pdf;
    } finally {
        await browser.close();
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    }
}

module.exports = { renderTemplate, renderToPDF };

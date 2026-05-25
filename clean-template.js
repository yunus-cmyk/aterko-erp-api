// Şablondaki placeholder'larda HTML entity'lerini çöz,
// resim yollarını düzelt (relative path), gerekli temizlikleri yap.
// Kullanım: node clean-template.js
const fs = require('fs');
const path = require('path');
const he = require('he');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'prefabrik.html');
let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

console.log('🔍 Önişleme başladı...');
const oncePlaceholder = (html.match(/\{\{[^}]+\}\}/g) || []).length;
console.log(`  Başlangıç placeholder sayısı: ${oncePlaceholder}`);

// 1. Placeholder içindeki HTML entity'leri decode et
//    {{D&#305;&#351; Duvar...}} → {{Dış Duvar...}}
html = html.replace(/\{\{([^}]+)\}\}/g, (match, inner) => {
    // İçerideki entity'leri decode et ama placeholder yapısını koru
    const decoded = he.decode(inner);
    return `{{${decoded}}}`;
});

// 2. Resim yollarını düzelt: images/imageXX.png → ./images/imageXX.png
//    (Puppeteer file:// olarak yükleyecek)
html = html.replace(/src="images\//g, 'src="./images/');

// 3. Sayfa boyutu (PDF için A4 hazır olsun)
// Google Docs zaten @page kuralı koyuyor, kontrol et
const hasPageRule = /@page/.test(html);
console.log(`  @page kuralı var mı: ${hasPageRule}`);

fs.writeFileSync(TEMPLATE_PATH, html);

const sonrasiPlaceholder = (html.match(/\{\{[^}]+\}\}/g) || []).length;
console.log(`  Bitiş placeholder sayısı: ${sonrasiPlaceholder}`);

// Örnek placeholder'lar
const ornekler = [...new Set(html.match(/\{\{[A-Za-zĞÜŞİÖÇğüşıöç ]+\}\}/g) || [])].slice(0, 8);
console.log('\n  Örnek temiz placeholder\'lar:');
ornekler.forEach(p => console.log('    ' + p));

console.log('\n✅ Tamamlandı.');

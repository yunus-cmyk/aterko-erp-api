function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Aterko Stok Yönetimi')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function kullaniciBilgisiGetir() {
  var email = Session.getActiveUser().getEmail(); 
  if (!email || email.indexOf("@aterko.com") === -1) {
    return { email: email || "Bilinmiyor", isim: "Yetkisiz Kişi", yetki: "Yetkisiz" };
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Kullanicilar");
  var varsayilanIsim = email.split('@')[0]; 
  if (!sheet) return { email: email, isim: varsayilanIsim, yetki: "İzleyici" };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase() === email.toLowerCase()) {
      var isim = data[i][1].toString().trim() || varsayilanIsim; 
      var yetki = data[i][2].toString().trim(); 
      if (yetki === "Admin") return { email: email, isim: isim, yetki: "Admin" };
      if (yetki === "Standart") return { email: email, isim: isim, yetki: "Standart" };
    }
  }
  return { email: email, isim: varsayilanIsim, yetki: "İzleyici" };
}

// 1. GÜNCEL FONKSİYON: Artık hem Kategoriyi hem Stok Tipini e-tablodan okuyoruz
function urunTipKategoriEslesmesiniGetir(ss) {
  var sheetUrun = ss.getSheetByName("Urunler");
  var map = {};
  if (sheetUrun && sheetUrun.getLastRow() > 1) {
    var data = sheetUrun.getRange(2, 1, sheetUrun.getLastRow() - 1, 3).getValues();
    data.forEach(function(r) {
      if(r[2]) map[r[2].toString().trim()] = { tip: r[0].toString().trim(), kategori: r[1].toString().trim() || "-" };
    });
  }
  return map;
}

// --- SADECE BU FONKSİYONU DEĞİŞTİRİYORUZ ---
function tumListeleriGetir() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrun = ss.getSheetByName("Urunler");
  
  // YENİ: [Stok Tipi][Kategori] = [Ürünler] şeklinde iç içe harita
  var tipKategoriUrunMap = {}; 
  
  if (sheetUrun && sheetUrun.getLastRow() > 1) {
    // Artık A, B ve C olmak üzere 3 sütun okuyoruz
    var data = sheetUrun.getRange(2, 1, sheetUrun.getLastRow() - 1, 3).getValues();
    data.forEach(function(r) {
      var tip = r[0].toString().trim();      // A Sütunu: Stok Tipi
      var kategori = r[1].toString().trim(); // B Sütunu: Kategori
      var urun = r[2].toString().trim();     // C Sütunu: Ürün Adı
      
      if(tip && kategori && urun) {
        if(!tipKategoriUrunMap[tip]) tipKategoriUrunMap[tip] = {};
        if(!tipKategoriUrunMap[tip][kategori]) tipKategoriUrunMap[tip][kategori] = [];
        
        tipKategoriUrunMap[tip][kategori].push(urun);
      }
    });
  }

  var sheetTanim = ss.getSheetByName("Tanimlar");
  var projeler = [], depolar = [];
  if (sheetTanim && sheetTanim.getLastRow() > 1) {
    var data = sheetTanim.getRange(2, 1, sheetTanim.getLastRow() - 1, 2).getValues();
    projeler = data.map(r => r[0]).filter(String);
    depolar = data.map(r => r[1]).filter(String);
  }
  
  // Artık ön yüze tipKategoriUrunMap gönderiyoruz
  return { tipKategoriUrunMap: tipKategoriUrunMap, projeler: projeler, depolar: depolar, kullanici: kullaniciBilgisiGetir() };
}

// --- SADECE BU FONKSİYONU DEĞİŞTİRİYORUZ ---
function veriKaydet(veri) {
  var kullanici = kullaniciBilgisiGetir();
  if (kullanici.yetki === "İzleyici" || kullanici.yetki === "Yetkisiz") return "HATA: İşlem yapmak için yetkiniz bulunmamaktadır.";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Veriler");
  
  if (veri.tip === "Çıkış") {
    var data = sheet.getDataRange().getValues();
    var mevcutStok = 0;
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] === veri.urun) { 
        if (data[i][2] === "Giriş") mevcutStok += parseFloat(data[i][3] || 0);
        else mevcutStok -= parseFloat(data[i][3] || 0);
      }
    }
    if (parseFloat(veri.miktar) > mevcutStok) return "HATA: Yetersiz Stok! Mevcut: " + mevcutStok;
  }
  
  var tarih = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
  var kaydedilecekMiktar = veri.miktar.toString().replace(',', '.');
  
  // DİKKAT: veri.stokTipi bilgisi dizinin en sonuna (10. Sütun / J Sütunu) eklendi!
  sheet.appendRow([tarih, veri.urun, veri.tip, kaydedilecekMiktar, veri.proje, veri.depo, veri.aciklama, kullanici.isim, veri.kategori, veri.stokTipi]);
  return "İşlem Başarılı!";
}

// 2. GÜNCEL FONKSİYON: Stok özeti çekerken Stok Tipini de (6. indeks olarak) diziye ekledik
function stokGetir() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Veriler");
  var data = sheet.getDataRange().getDisplayValues(); 
  var stokDurumu = {};
  var urunInfoMap = urunTipKategoriEslesmesiniGetir(ss); 
  
  for (var i = 1; i < data.length; i++) {
    var tarih = data[i][0];
    var urun = data[i][1]; 
    var tip = data[i][2]; 
    var hamMiktar = data[i][3].toString().replace(',', '.');
    var miktar = parseFloat(hamMiktar) || 0;
    
    if (!stokDurumu[urun]) {
      var info = urunInfoMap[urun] || {tip: "-", kategori: "-"};
      stokDurumu[urun] = { miktar: 0, sonTarih: "", sonTip: "", kategori: info.kategori, stokTipi: info.tip };
    }
    
    if (tip === "Giriş") stokDurumu[urun].miktar += miktar; 
    else stokDurumu[urun].miktar -= miktar;
    
    stokDurumu[urun].sonTarih = tarih;
    stokDurumu[urun].sonTip = tip;
  }
  
  var sonuc = []; 
  for (var key in stokDurumu) {
    var birim = "-";
    var match = key.match(/\[(.*?)\]$/);
    if (match) birim = match[1];
    
    sonuc.push([ key, stokDurumu[key].kategori, stokDurumu[key].miktar, birim, stokDurumu[key].sonTarih, stokDurumu[key].sonTip, stokDurumu[key].stokTipi ]);
  }
  return sonuc;
}

// 3. GÜNCEL FONKSİYON: Geçmiş işlemleri okurken 10 sütun (J sütunu dahil) okuyoruz
function gecmisGetir() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Veriler");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  
  var urunInfoMap = urunTipKategoriEslesmesiniGetir(ss); 
  var data = sheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues(); // 10 Sütun okunuyor
  
  var islenmisData = data.map(function(row, i) { 
    var urun = row[1];
    var info = urunInfoMap[urun] || {tip: "-", kategori: "-"};
    
    var dbKategori = row[8] ? row[8] : info.kategori;
    var dbStokTipi = row[9] ? row[9] : info.tip;
    
    row[8] = dbKategori;
    row[9] = dbStokTipi; 
    
    return [i + 2].concat(row); 
  });
  return islenmisData.reverse(); 
}

// --- SADECE BU FONKSİYONU DEĞİŞTİRİYORUZ ---
function kayitGuncelle(satirNo, veri) {
  var kullanici = kullaniciBilgisiGetir();
  if (kullanici.yetki !== "Admin") return "HATA: Bu işlemi sadece Yöneticiler yapabilir.";
  
  var kaydedilecekMiktar = veri.miktar.toString().replace(',', '.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Veriler");
  
  // DİKKAT: Artık B sütunundan başlayıp 9 hücre genişliğinde (J sütununa kadar) güncelliyoruz.
  sheet.getRange(satirNo, 2, 1, 9).setValues([[
    veri.urun, 
    veri.tip, 
    kaydedilecekMiktar, 
    veri.proje, 
    veri.depo, 
    veri.aciklama, 
    kullanici.isim, 
    veri.kategori, 
    veri.stokTipi // YENİ: Stok Tipi eklendi
  ]]);
  
  return "Kayıt Güncellendi!";
}

function kayitSil(satirNo) {
  var kullanici = kullaniciBilgisiGetir();
  if (kullanici.yetki !== "Admin") return "HATA: Bu işlemi sadece Yöneticiler yapabilir.";
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Veriler");
  sheet.deleteRow(satirNo);
  return "Kayıt Silindi!";
}
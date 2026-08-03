// SÖZLEŞME METNİ — eski sistemin 'Sözleşme Şablonu.docx' belgesinden birebir
// çıkarıldı (Yunus 2026-08-03). 17 madde + künye tablosu + taraflar girişi.
// Yer tutucular {{alan}} biçiminde; sozlesmeVerisi() ile doldurulur.
// DEĞİŞTİRİRKEN: hukuki metindir — madde sırası ve numaraları korunmalıdır
// (17. madde metninde 'Sözleşme 17 (onyedi) maddeden ibaret' ifadesi geçer).
module.exports = {
    "kunye": [
        {
            "etiket": "İŞİN ADI",
            "deger": "{{proje_adi}}"
        },
        {
            "etiket": "ALICI",
            "deger": "{{musteri_uzun_ad}}"
        },
        {
            "etiket": "SATICI",
            "deger": "Aterko Yapı Danışmanlık Sanayi ve Ticaret Anonim Şirketi"
        },
        {
            "etiket": "İŞİN YERİ",
            "deger": "{{ulke}} / {{sehir}} / {{adres}}"
        },
        {
            "etiket": "İŞİN TÜRÜ",
            "deger": "{{satis_turu}} / {{proje_turu}}"
        },
        {
            "etiket": "ALICI TEMSİLCİSİ",
            "deger": "{{irtibat_adi}} / {{irtibat_email}} / {{irtibat_telefon}}"
        },
        {
            "etiket": "SATICI TEMSİLCİSİ",
            "deger": "{{satis_temsilcisi}}"
        },
        {
            "etiket": "SÖZLEŞME BEDELİ",
            "deger": "{{ara_toplam}} {{para_birimi}}"
        },
        {
            "etiket": "KDV (% {{kdv_orani}})",
            "deger": "{{kdv_tutar}}"
        },
        {
            "etiket": "KDV’Lİ SÖZLEŞME BEDELİ",
            "deger": "{{genel_toplam}} {{para_birimi}}"
        },
        {
            "etiket": "SÖZLEŞME KODU",
            "deger": "{{sozlesme_kodu}}"
        },
        {
            "etiket": "SÖZLEŞME TARİHİ",
            "deger": "{{sozlesme_tarihi}}"
        },
        {
            "etiket": "TESLİM KOŞULLARI",
            "deger": "{{teslimat_kosullari}}"
        }
    ],
    "giris": [
        "İşbu {{proje_adi}} sözleşmesi (bundan sonra “Sözleşme” olarak anılacaktır; bir tarafta,",
        "{{musteri_uzun_ad}}",
        "{{fatura_adresi}}",
        "{{vergi_dairesi}} V.D. - V.No: {{vergi_no}}",
        "(bundan sonra “Alıcı” olarak anılacaktır)",
        "ile diğer tarafta,",
        "Aterko Yapı Danışmanlık Sanayi ve Ticaret Anonim Şirketi",
        "Esentepe Mah. Anadolu Cad. AND Ticari Blok No:5/2 D:346 Kartal - İstanbul",
        "Kartal V.D. - V.No: 099 054 9662",
        "(bundan sonra “Satıcı” olarak anılacaktır)",
        "arasında aşağıda yazılı koşullarda tanzim edilmiştir ve imzalanmıştır.",
        "Bundan böyle Alıcı ve Satıcı ayrı ayrı “Taraf” birlikte ise “Taraflar” olarak anılacaktır."
    ],
    "maddeler": [
        {
            "baslik": "SÖZLEŞMENİN KONUSU",
            "govde": [
                "Satıcı, aşağıda belirtilen ve Taraflar arasında mutabık kalınan, işbu Sözleşme ekinde yer alan Teknik Özellikler ile Proje ve Görünüşlerde (bundan böyle hep beraber “Teknik Şartlar” olarak anılacaktır) detaylandırılan nitelikte ve nicelikte {{proje_adi}} kapsamındaki ürün/hizmetlerin üretimini, tedarikini ve kapsam dahilinde ise {{ulke}} / {{sehir}} / {{adres}} adresindeki uygulamasını Teknik Şartname’ye uygun olarak yapacaktır. Alıcı da 2. Maddede belirtilen sözleşme bedelini, 3. Maddede belirtilen plana göre Satıcı’ya ödeyecektir."
            ]
        },
        {
            "baslik": "KEŞİF ÖZETİ VE SÖZLEŞMENİN BEDELİ",
            "govde": [
                "NO",
                "AÇIKLAMA",
                "MİKTAR",
                "BİRİM",
                "BİRİM FİYAT [{{para_birimi}}]",
                "TOPLAM FİYAT[{{para_birimi}}]",
                "ARA TOPLAM",
                "{{ara_toplam}}",
                "KDV (%{{kdv_orani}})",
                "{{kdv_tutar}}",
                "TOPLAM",
                "{{genel_toplam}}"
            ]
        },
        {
            "baslik": "ÖDEME PLANI",
            "govde": [
                "3.1. Ödeme koşulları şöyledir;",
                "{{odeme_kosullari}}",
                "3.2. Satış faturaları sözleşmede belirtilen para birimi üzerinden düzenlenecektir. Yabancı Para cinsinden (Türk Lirası Harici) yapılmış sözleşmelerde Alıcı Türk Lirası cinsinden ödeme yapmak isterse (Çek, Senet, Nakit,  v.s.) bu ödeme, ancak Satıcı’nın onayı ile gerçekleşebilecek ve ödemenin yapıldığı tarihteki Merkez Bankası Döviz Satış Kuru dikkate alınarak Satıcı’nın hesabına yatırılacaktır.",
                "3.3. Vadesi geçen tüm ödemelerde, TL bazındaki geç ödemeler için aylık %1,5, USD ve EUR bazındaki geç ödemeler için ise aylık %0,5 oranında gecikme cezası tahsil edilecektir. Taraflar, söz konusu cezai şart tutarının, işbu Sözleşme'ye konu işin ticari iş niteliğinde olması, Tarafların basiretli tacir olmaları ve Satıcı’nın sorumluluğunda bulunan işe özel üretim faaliyetleri dikkate alındığında fahiş olmadığı ve hiçbir şekilde tenkise (indirime) tabi tutulamayacağı konusunda mutabıktırlar.",
                "3.4. İşbu Sözleşmenin 3.1. Maddesinde avans olarak nakit havale şeklinde ödenmesi gereken bir tutar belirtilmişse ve bunun, Satıcı’nın önceden yazılı onayı alınarak, daha sonraki bir tarihte ödenmesi kararlaştırılmışsa, bu ödemelerin en geç iş kapsamındaki ürünlerin Satıcı’nın üretim tesisinden Alıcı’nın adresine sevkiyatı gerçekleşmeden önce yapılması gerekmektedir. İşbu Sözleşme’nin imza tarihi ile Alıcı tarafından söz konusu avans ödemesinin gerçekleştirildiği tarih arasında malzeme ya da işçilik bedellerinde yaşanacak artışlar sözleşme bedeline ilave edilip Satıcı’dan tahsil edilecektir.",
                "3.5. Sözleşme kapsamında Alıcı tarafından Satıcı’ya yapılacak olan ödemeler, işbu Sözleşmenin 3.1. Maddesinde kararlaştırıldığı şekilde yapılmaz ise veya Alıcı tarafından geciktirilirse, Satıcı, ödemelerin zamanında yapılmaması nedeniyle işleri durdurma, geciken ödemeler yapılıncaya kadar işleri geçici olarak askıya alma ve/veya bu gecikmeden doğan zararları yasal faizi ile birlikte Alıcı’dan talep etme hakkına sahiptir. Satıcı’nın yazılı uyarısına karşılık Alıcı işbu Sözleşme kapsamındaki ödemelerini zamanında veya gerektiği gibi yapmaktan imtina ederse Satıcı Sözleşmeyi tek taraflı olarak, derhal ve tazminatsız feshetme hak ve yetkisine sahiptir."
            ]
        },
        {
            "baslik": "TESLİM SÜRESİ VE KOŞULLARI",
            "govde": [
                "4.1. Teslim koşulları şöyledir;",
                "{{teslimat_kosullari}}",
                "4.2. Alıcı’dan kaynaklanan gecikmeler (Teknik Şartlara aykırı zemin betonu, gerekli izinlerin zamanında alınmaması, Alıcı tarafından Sözleşme imzalandıktan sonra Sözleşme kapsamında talep edilen değişiklikler vs.) ve işbu Sözleşme ve ekleri kapsamında Satıcı’nın sorumluluğunda olmayıp üçüncü kişilerce yüklenilen ve yapılması gereken işlerin gerektiği gibi veya zamanında yapılmamasından/sağlanamamasından kaynaklanan gecikmeler nihai teslim süresine ilave edilecektir. Satıcı tarafından sevk edilen malların gümrükte beklemesi nedeniyle oluşabilecek gecikmeler ve masraflar hiçbir surette Satıcı’nın sorumluluğunda değildir. Gümrükte yaşanan gecikmeler nihai teslim ve varsa montaj sürelerine eklenecek ve bundan dolayı oluşacak tüm zarar, kar kayıpları, ek ödemeler ve nakliye masrafları Alıcı’nın sorumluluğunda olacaktır.",
                "4.3. Sevk edilecek ürünler, nakliye sorumluluğunun Satıcı’da olması durumunda Alıcı’nın belirlediği ve ürünlerin gönderildiği adreste, nakliye sorumluluğunun Alıcı’da olması durumunda ise Satıcı’nın üretim tesisinde, Alıcı tarafından yazılı olarak Satıcı’ya bildirilecek olan Alıcı Yetkilisi/Temsilcine teslim edilecektir. Bu husus taraflarca imzalanacak bir tutanakla tespit edilecektir. Eğer Alıcı bir yetkili bildirmediyse; sevkiyat adresinde veya Satıcı’nın üretim tesisinde Satıcı tarafından tutulacak bir tutanak teslim tutanağı yerine geçecektir. Alıcı yetkilisi ile tutulacak tutanak veya Alıcı tarafından bir yetkili tayin edilmediği durumda Satıcı tarafından tutulacak tutanak üretilen ve nakledilen ürünlerin, eksiksiz, Teknik Şartlar’a uygun ve ayıpsız olarak teslim edildiğine dair yeterli belge olacaktır. Alıcı, teslimatı (Satıcı’nın üretim tesisinde veya sevkiyat adresinde) bağımsız üçüncü taraf denetleme ve danışmanlık firmaları (SGS, Bureau Veritas, vb.) eliyle gerçekleştirmek ve/veya süreç kontrolü yaptırmak isterse, söz konusu hizmetlerin bedelini kendisi karşılayacaktır.",
                "4.4. İşbu Sözleşmede yazılı ve ifası Alıcı’nın sorumluluğunda olan tüm vecibe ve mükellefiyetlerden herhangi biri zamanında ifa edilemez ise belirtilen teslim tarihi gecikilen süre kadar ertelenecektir. Söz konusu gecikme dolayısıyla Satıcı’nın katlanmak durumunda kaldığı tüm masraflar (depolama, nakliye, işçilik ücretleri vb.) talep edildiğinde Alıcı tarafından Satıcı’ya ödenecektir. Benzer şekilde, Alıcı’dan kaynaklı gecikmelerden dolayı montaj sahasında, Satıcı’nın deposunda veya nakliye sırasında ürünlerde meydana gelebilecek hasarlardan Alıcı sorumlu olacaktır.",
                "4.5. Alıcı, nakliye sorumluluğunun kendisine ait olduğu durumlarda, sevkiyata hazır olan ürünleri, Satıcı tarafından belirlenen tarihte, Satıcı tarafından belirtilen adresten nakliyesini gerçekleştirmek için söz konusu ürünleri taşımaya uygun bir aracı hazır edecektir. Sözleşme şartlarına göre uygulama/montaj sorumluluğunun Satıcı’da olması durumunda, ürünlerin gönderileceği adres, belirtilen sevk tarihinden önce Alıcı tarafından uygulamaya/montaja hazır hale getirilmelidir. Alıcı’dan kaynaklanan uygulama/montaj sahasının Satıcı’ya tesliminin gecikmesi ve/veya nakliye sorumluluğunun Alıcı’ya ait olduğu durumlarda, üretilen ürünleri taşımaya uygun nakliye araçlarının temininin gecikmesinden dolayı sevkiyatın gecikmesi, Alıcı’nın işbu sözleşmenin 3.1. Maddesinde belirtilen ödemelerini tehir ettirmeyecek ve bu gecikmelerden dolayı Satıcı tarafından üstlenilmesi gereken kalan tüm ek masraflar ve maruz kalınan zararlar Alıcı tarafından karşılanacaktır. Satıcı, işbu Sözleşme ve Teknik Şartlar uyarınca Alıcı tarafından sağlanacak hususlarda (uygun nakliye aracının temini, uygulama/montaj sahasının hazırlanması vs.) yaşanan gecikmelerden dolayı teslim tarihini revize etme hakkına sahiptir."
            ]
        },
        {
            "baslik": "MÜCBİR SEBEPLER",
            "govde": [
                "Kararlaştırılan teslim süresi ve koşulları aşağıdaki durumlardan birinin gerçekleşmesi halinde değişebilecektir. Mücbir sebebin kalkmasından sonra ortaya çıkacak zararların tazmini ve eski hale getirme masrafları Alıcı tarafından karşılanacaktır.",
                "● Savaş, savaş hali (ilan edilsin ya da edilmesin), istila.",
                "● İsyan, terörizm, devrim, askeri darbe, başkaldırı veya iç savaş,",
                "● Ayaklanma, kargaşa, düzensizlik, grev ya da lokavt,",
                "● Nakliye ve depolama sırasında yaşanan hırsızlık ve montaj anında yaşanan iş kazası,",
                "●Olumsuz hava koşulları nedeniyle montaj sırasında gerçekleşebilecek gecikmeler,",
                "● Doğal afetler, deprem, fırtına, yangın, sel veya volkanik aktivite,",
                "● Salgın hastalıklar,",
                "● Hükümetin montajı, nakliyeyi ve projenin diğer gerekliliklerini etkileyecek icraatları,",
                "● İthalat veya ihracat kısıtlamaları,",
                "● Yukarıdaki sebeplerden dolayı malzeme ve hammadde temininin aksaması ya da imkansız hale gelmesi.",
                "Mücbir sebep halinin 30 günü aşması durumunda, mücbir sebep tesiri altında kalan Satıcı, mücbir sebep halini, sonuçlarını, alınan tedbirleri ve tahmini süresini Alıcı’ya derhal bildirecektir. Satıcı’nın işbu Sözleşme’den doğan yükümlülükleri bu hal sona erene kadar ertelenebilir. Ancak mücbir sebep halinin her halükârda 60 günü aşması durumunda, Satıcı, Sözleşme’yi tek taraflı yazılı bildirim ile tazminatsız olarak sona erdirebilir. Mücbir sebep halleri nedeniyle Satıcı’nın katlanmak zorunda kaldığı nakliye, işçilik, konaklama ve sair her türlü zarar, ek maliyet ve giderleri ile Satıcı’nın ekipman, ürün ve donanımında meydana gelecek tüm zararları Alıcı, ilk talep anında Satıcı’ya ödeyecektir."
            ]
        },
        {
            "baslik": "İŞ BÖLÜMÜ",
            "govde": [
                "6.1. Aşağıda 6.2 ve 6.3 numaralı maddelerde genel hatlarıyla belirtilen iş bölümleri Teknik Şartlar kapsamında değerlendirilecek ve yorumlanacaktır. İşbu Sözleşme’nin 6.2 ve 6.3 numaralı maddeleri ile Teknik Şartlar arasında bir çelişki bulunması halinde, Teknik Şartlar esas alınacak ve uygulanacaktır.",
                "6.2. Satıcı’nın Sorumluluğunda Olan İşler",
                "{{dahil_isler}}",
                "6.3. Alıcı’nın Sorumluluğunda Olan İşler",
                "{{haric_isler}}"
            ]
        },
        {
            "baslik": "UYGULAMALAR",
            "govde": [
                "7.1. Teknik Şartlar uyarınca sözleşme kapsamında olup da montajı yapılan ve Alıcı’ya teslim edilen işlerden sonra montaj sahasında kalan ve Satıcı tarafından gönderilmiş olan fazla malzeme, ekipman, donanım vs. Satıcı’nın mülkiyetindedir. Söz konusu malzeme, ekipman, donanım vs. üzerinde Satıcı dilediği gibi tasarrufta bulunabilir. Satıcı’nın söz konusu fazla malzeme, ekipman, donanımı geri götürmek istememesi durumunda montaj sahasının temizliği Alıcı’nın sorumluluğundadır.",
                "7.2. Montaj sahasında oluşabilecek tüm hasar ve risklere karşı Alıcı “All Risk Sigortası” yaptırmak zorundadır. Yaptırmadığı takdirde doğabilecek iş güvenliği sorunları, ceza ve tazminatlardan sorumludur. Montaj sahasının güvenliğinden Alıcı sorumludur. Montaj sahasında Alıcı’nın doğrudan kusuru bulunmaksızın, Satıcı’nın çalışanlarına veya herhangi üçüncü bir kişiye verilecek zararlardan Alıcı sorumludur. Alıcı ve Satıcı montaj sahasında işyeri ve işçi güvenliği ile ilgili bütün yasal yükümlülükleri yerine getirecektir.",
                "7.3. Satıcı tarafından montaj sahasına sevk edilecek malzeme ve donanımda, Satıcı’nın kontrolü dışında Alıcı’nın veya personelinin veya üçüncü kişilerin kusurundan dolayı meydana gelecek hasar ve ziyandan dolayı Satıcı’nın hiçbir sorumluluğu bulunmamaktadır. Malzeme ve donanımın korunmasına ilişkin olarak, Satıcı’nın alacağı bütün tedbirlerin Satıcı’nın personelinin montaj sahasında bulunmadığı zamanlarda korunması, başka şahısların çalışma mahalline girmemesi, Alıcı’nın sorumluluğunda olup, Alıcı’nın bu sorumluluğuna aykırı hareketleri nedeniyle malzeme ve donanımların, montaj sahasından her ne suretle olursa olsun kaybolması ve/veya çalınması veya zarar görmesi halinde, meydana gelecek hasar ve ziyan ile buna bağlı olarak tüm işlerin tesliminde yaşanabilecek gecikmelerden dolayı sorumluluk Alıcı’ya aittir. Alıcı, zarar ve ziyana maruz kalan malzeme ve donanımın yenilenmesi için Satıcı tarafından tespit edilecek yeni bedel üzerinden belirlenen ödemeyi yapmayı kabul ve taahhüt eder. Bu yeni malzeme ve donanımın temini ve montaj sahasına sevki için geçen süre nihai teslim tarihine ilave edilecektir. Satıcı’nın işbu Sözleşme kapsamında varsa montaj işlemlerini tamamlamış olduğu donanım/cihazların yetkili olmayan kişilerce yerinden sökülmesi, yerinin değiştirilmesi durumunda meydana gelen hiçbir zarar, kayıp, ziyan ve/veya ek maliyetlerden dolayı Satıcı sorumlu tutulamaz.",
                "7.4. İşbu Sözleşme kapsamına giren tüm muamele/işlemler ile ilgili oluşacak tüm vergiler, resimler, ücretler, kayıt tescil harçları, sözleşme damga vergisi, inşaat işi ile ilgili inşaat sigortası primleri vb. masraflar Alıcı tarafından ödenecektir.",
                "7.5.  Satıcı üretim tesisinde ürettiği ürünlerin montajı işbu Sözleşme kapsamında ise, kendisi ya da alt yüklenicileri eliyle Alıcı’nın hazırlayacağı sahada gerçekleştirecektir. Bu montaj işlemi, Satıcı’nın üretim tesisinde üretilmiş ürünlerin devamı niteliğinde olduğu için personeli ve alt yüklenicileri “geçici görevlendirme yazısı” ile çalıştırılacaktır ve ayrıca bir SGK alt yüklenici dosya açılışı yapılmayacaktır.",
                "7.6. Alıcı, işbu Sözleşme kapsamında montajın Satıcı’nın sorumluluğunda olması durumunda, ürünlerin montajı için gereken tüm gerekli plan, proje ve yasal izinleri alacaktır ve montaj için uygun yasal ortamı sağlayacaktır. Satıcı, Alıcı tarafından alınması gereken bu izinlerin alınmamasından kaynaklanan gecikmelerden ve yasal işlemlerden sorumlu tutulamaz. Montaj devam ederken yasal mercilerce montajın durdurulması söz konusu olursa Alıcı, Satıcı’ya yazılı olarak bu durumu bildirecektir.. Satıcı bu durumda montaja devam etmeye zorlanamaz. Gerekli yasal izinlerin alınması ve uygun yasal ortamın sağlanmasının ardından Alıcı, Satıcı’yı yazılı olarak bilgilendirecek ve montaj Satıcı’nın vereceği yeni programa göre devam edecektir. Alıcı bu yeni montaj programına herhangi bir itirazda bulunmayacaktır. Yukarıda belirtilen hususlar teslimde gecikme kapsamında değerlendirilmeyecektir. Bu kapsamda gerçekleşecek gecikme sebebiyle Satıcı’nın üstlendiği ek ödemeler ve maruz kaldığı zararlar Alıcı tarafından tazmin edilecektir.",
                "7.7. Yapılan binaların fotoğraflarının çekilmesi ve reklam amacıyla kullanım hakkına Satıcı da sahiptir.",
                "7.8. Yurtdışına gönderilmesi gereken montaj danışmanı (süpervizör) veya montaj ekibi olması durumunda işçi çalışma vizeleri Alıcı tarafından alınacaktır. İşçi vizesi alınması sırasında gecikme yaşanması halinde, bu gecikmeden dolayı teslimatta oluşabilecek gecikmelerden Satıcı sorumlu olmayacaktır. Alıcı’nın işçi çalışma vizesi alamadığı ve onun yerine turist vizesi aldığı durumlarda doğabilecek her türlü zarar, ceza ve diğer sorunlardan Alıcı sorumlu olacaktır.",
                "7.9. Alıcı, montaj sahasında çalıştırılan tüm personelin, işin yapılacağı ülkenin tüm kanun ve nizamlarına ve ayrıca Türkiye Cumhuriyeti mevzuatına uygun olarak işçi sağlığı ve iş güvenliği tüzük ve yönetmeliklerine göre çalışılmasını sağlamaktan ve tüm emniyet tedbirlerini almaktan ve işçileri bilgilendirmekten sorumludur. Bu hükme uyulmaması halinde doğabilecek her türlü zarar, ceza ve diğer sorunlardan Alıcı sorumlu olacaktır."
            ]
        },
        {
            "baslik": "GARANTİ SÜRESİ",
            "govde": [
                "8.1. 2. Maddede belirtilen işler üretim hatalarına karşı 1 ( Bir ) yıl süreyle Satıcı’nın garantisi kapsamında olacaktır. Garanti süresi fatura kesim tarihinden sonra başlayacaktır. Alıcı’nın kullanımından kaynaklanan hatalar garanti kapsamında olmayacaktır.",
                "8.2. Alıcı, garanti süresi kapsamında hata olarak değerlendirdiği durumları Satıcı’ya yazılı olarak bildirecektir. Satıcı tarafından yapılan inceleme neticesinde söz konusu durumun Satıcı’dan kaynaklı bir üretim veya montaj hatası olduğu kanaatine varılır ise ilgili sorun makul süre içerisinde bizzat Satıcı tarafından veya sorumluluğu Satıcı’ya ait olmak kaydıyla 3. şahıslarca giderilecektir.",
                "8.3. Satıcı’nın işin yapılmasında kullandığı ve kendisi dışındaki başka üretici firmalardan tedarik ettiği ürün, malzeme ve donanımlar için belirtilen garanti süreleri ve şartları Alıcı’ya aynen yansıtılır. Bu ürün ve malzemelerin üretim kusurları Alıcı tarafından tespit edildikten sonra Satıcı’ya yazılı olarak bildirilir. Satıcı ilgili üretici firma ile irtibat kurarak üçüncü taraf üretici firma tarafından sağlanan garanti şartları çerçevesinde gerekli tamirat veya değişikliği yaptıracaktır. Satıcı kendisi dışındaki bir firmadan temin edilen malzeme ve donanımlar için Alıcı’ya karşı sorumlu tutulamaz. Bu malzeme ve donanımlardan kaynaklı tüm gecikme, zarar veya kar kaybı sorumluluğu münhasıran üçüncü taraf üretici firmaya ait olacaktır.",
                "8.4. İşin Satıcı tarafından Alıcı’ya tesliminden sonra ürünlerin herhangi bir yerinde Alıcı tarafından yapılacak ilave işlerden veya değişikliklerden dolayı meydana gelecek zararlardan veya 3. kişilerde doğuracağı zararlardan Satıcı sorumlu tutulamaz."
            ]
        },
        {
            "baslik": "ALICI TARAFINDAN SONRADAN YAPILAN DEĞİŞİKLİKLER",
            "govde": [
                "Alıcı, Satıcı üretime başladıktan sonra onaylanmış olan projelerde ve teknik özelliklerde değişiklik yapamaz. Gerekçelerini belirtmek ve Satıcı tarafından kabul edilmek şartıyla yapılan proje değişiklikleri yeni teknik şartlara uygulanabiliyorsa yapılacak ek masrafların Alıcı tarafından karşılanmasını müteakip üretim yeni teknik şartlara uygun hale getirilebilir. Bu hususta yazılı mutabakat şarttır. Proje değişiklikleri sebebiyle uygulanacak yeni teslim süresi ve yeni sözleşme bedeli Satıcı tarafından belirlenecektir."
            ]
        },
        {
            "baslik": "İŞİN ALICI TARAFINDAN İPTALİ",
            "govde": [
                "10.1. İşin, Satıcı üretime başlamadan önce, Alıcı tarafından iptal edilmesi durumunda Alıcı, Satıcı’nın işbu Sözleşme’de belirtilen işlerin üretim hazırlığı için gerçekleştirdiği masrafları karşılamakla yükümlüdür. Satıcı bu amaçla, eğer tahsil edilmiş olan bir avans ödemesi varsa bu ödemeden kesinti gerçekleştirebilir. Aşağıda belirtilen cezai şart miktarları ve işbu madde kapsamındaki kesintiler düşüldükten sonra avans ödemesinden kalan tutar Alıcı’ya iade edilir.",
                "10.2. İşin iptali Satıcı üretime başladıktan sonra yapılırsa Alıcı, iptal beyanına kadar yapılmış olan üretim masraflarını, işbu Sözleşme kapsamında temin edilen malzeme, ekipman ve hammadde masraflarını, Satıcı’nın katlanmak durumunda kaldığı tüm zararları, sair masraf ve ek ödemeleri, hurda masraflarını ve nakliye bedellerini karşılamakla yükümlüdür. Satıcı bu amaçla tahsil edilen bir avans ödemesi varsa bu ödemeden kesinti gerçekleştirebilir. Aşağıda belirtilen cezai şart miktarları ve işbu madde kapsamındaki kesintiler düşüldükten sonra avans ödemesinden kalan tutar Alıcı’ya iade edilir. Tahsil edilen herhangi bir avans ödemesi yoksa veya var olan avans ödemesi tutarı, yapılan kesintileri ve cezai şart miktarını karşılamaya yetmiyorsa Satıcı’nın, uğradığı zararları tazmin ve talep etme hakkı ayrıca saklıdır.",
                "10.3. İşin iptali üretim tamamlanıp sevke hazır hale geldiğinde yapılmışsa Alıcı, Satıcı’nın üretim masraflarını, Sözleşme kapsamında temin edilen malzeme, ekipman ve hammadde masraflarını, Satıcı’nın katlanmak durumunda kaldığı tüm zararları, sair masraf ve ek ödemeleri, hurda masraflarını, nakliye bedellerini ve depolama masraflarını karşılamakla yükümlüdür. Satıcı bu amaçla tahsil edilen bir avans ödemesi varsa bu ödemeden kesinti gerçekleştirebilir. Aşağıda belirtilen cezai şart miktarları ve işbu madde kapsamındaki kesintiler düşüldükten sonra avans ödemesinden kalan tutar Alıcı’ya iade edilir. Tahsil edilen herhangi bir avans ödemesi yoksa veya var olan avans ödemesi tutarı, yapılan kesintileri ve cezai şart miktarını karşılamaya yetmiyorsa Satıcı’nın, uğradığı zararları tazmin ve talep etme hakkı ayrıca saklıdır.",
                "10.4. Alıcı tarafından gerçekleştirilen iptal neticesinde, Satıcı’nın üretim tesisinde veya deposunda kalan, kısmen veya tamamen üretilmiş ürünlerin mülkiyeti tamamen Satıcı’ya aittir. Alıcı, aşağıda belirtilen cezai şart miktarlarının, Satıcı’nın elinde bulunan ürünler oranında mahsup edilmesini teklif edemez.",
                "10.5. Sözleşme imza tarihinde işbu Sözleşme bedelinin bir kısmı vadeli çek olarak alınmışsa, aşağıda belirtilen cezai şart miktarlarının nakden ödendiği veya verilen avans ödemelerden tahsil edildiği ve 10.1, 10.2 ve 10.3 numaralı maddelerde belirtilen ödemeler Alıcı’dan tahsil edildiği takdirde söz konusu çekler Alıcı’ya iade edilir. Aksi halde söz konusu çekler tahsil edilecektir."
            ]
        },
        {
            "baslik": "İŞİN TESLİM ALINMASINDAN İMTİNA",
            "govde": [
                "Üretimin tamamlandığı Alıcı’ya e-posta ile bildirilir. Alıcı bildirimin kendisine ulaşmasından sonra beş gün içinde ürünleri teslim almadığı takdirde teslim almadığı her gün için teslim alınmayan iş bedelinin %1’i nispetinde depolama ücreti öder. Depolama süresi 30 (otuz) günü geçemez. 30 (otuz) günden sonra sözleşme Satıcı tarafından tek taraflı olarak fesh edilir ve ürünler Alıcı adına kiralanan bir depoya aktarılarak tasfiye işlemi uygulanır. İş kapsamındaki ürünler, Alıcı adına malzeme ve işçilik maliyetlerini karşılayacak şekilde satılmaya çalışılır. Eğer 20 (yirmi) gün içinde satılmazsa Alıcı için özel üretilmiş ürünlerin bedeli tahsil edilen bedelden düşülür. Tahsil edilen bedelden depolama ücreti ve varsa Satıcı’nın sözleşmeden doğan zararları mahsup edilir. Varsa kalan bakiye Alıcı’ya iade edilir. Satıcı’nın tahsil edilen bedelden daha fazla zararı varsa Alıcı’dan talep edilir."
            ]
        },
        {
            "baslik": "CEZAİ ŞARTLAR",
            "govde": [
                "12.1. İşin, Satıcı üretime başlamadan önce Alıcı tarafından iptal edilmesi durumunda, işbu Sözleşme’nin 3.1. Maddesi uyarınca tahsil edilen nakit avanstan, sözleşme bedelinin %5’i cezai şart olarak tenzil edilir. Cezai şart ve işbu Sözleşmenin 10.1. Maddesinde belirtilen miktarlar düşüldükten sonra bakiye tutar Alıcı’ya iade edilir.",
                "12.2. İşin iptali üretim başladıktan sonra yapılırsa iptal beyanına kadar yapılmış olan üretim bedeli tahsil edilen avanstan cezai şart olarak tenzil edilir. Tenzil edilen miktar sözleşme bedelinin %20'sinden aşağı olamaz. Cezai şart ve işbu Sözleşmenin 10.2. Maddesinde belirtilen miktarlar düşüldükten sonra bakiye tutar Alıcı’ya iade edilir.",
                "12.3. İşin iptali üretim tamamlanıp ürünlerin sevke hazır hale geldiği anda yapılmışsa tahsil edilen avans iade edilmez. Söz konusu nakit avansın tamamı cezai şart olarak Satıcı tarafından tahsil edilmiş sayılır.",
                "12.4. Taraflar, söz konusu cezai şart tutarının, işbu Sözleşme'ye konu işin ticari iş niteliğinde olması, Tarafların basiretli tacir olmaları ve Satıcı’nın sorumluluğunda bulunan işe özel üretim faaliyetleri dikkate alındığında fahiş olmadığı ve hiçbir şekilde tenkise (indirime) tabi tutulamayacağı konusunda mutabıktırlar.",
                "12.5. Satıcı’ya atfedilebilecek kusurlu veya ihmali olan bir davranış olması durumunda, Satıcı’nın işbu Sözleşme’nin 2. Maddesinde belirtilen İşleri, 4. Maddede belirtilen teslim süresinde Alıcı’ya teslim etmemesi durumunda, gecikilen her iş günü için Satıcı işbu Sözleşme bedelinin %0.3’ü oranında gecikme cezası ödemeyi kabul eder. İşbu Sözleşme kapsamında Satıcı’dan talep edilecek cezaların (İSG, teslimatın gecikmesi, personel bulundurmama vs.) toplamı işbu Sözleşme bedelinin %5’ini geçemez. Alıcı işbu cezai şart dışında Satıcı’dan doğrudan veya dolaylı zarar adı altında herhangi bir tazminat talebinde bulunamaz."
            ]
        },
        {
            "baslik": "SÖZLEŞMENİN FESHİ",
            "govde": [
                "13.1. 3.1. Maddede belirtildiği halde Alıcı’nın avans ödemesini yapmaması ve/veya işbu Sözleşmenin imzasından itibaren 15 gün içerisinde taraflarca sözleşmenin ifası için herhangi bir faaliyette bulunulmaması durumunda Satıcı, Sözleşme’yi derhal ve tazminatsız olarak fesh etme hakkına sahiptir. İşbu fesih nedeniyle Satıcı’nın uğradığı zararları tazmin ve talep etme hakkı ayrıca saklıdır.",
                "13.2. Satıcı aşağıdaki hallerde dilerse sözleşmeyi tek taraflı olarak ve derhal, tazminatsız fesh etme hak ve yetkisine sahiptir;",
                "● Alıcı’nın işbu Sözleşmeden kaynaklı yükümlülüklerini yerine getirmemesi üzerine, Satıcı’nın Alıcı’ya söz konusu ihlalin giderilmesini istediğini yazılı olarak (e-posta, iadeli taahhütlü mektup ve noter kanalıyla ihtarname) bildirmesini takip eden 10 gün süre içerisinde Alıcı tarafından söz konusu ihlalin giderilmemesi durumunda,",
                "● Alıcı’nın iflası, konkordato ilan etmesi ve/veya acz içine düşmesi durumunda,",
                "● Mücbir sebep hallerinin öngörülen makul süreden daha fazla sürmesi halinde."
            ]
        },
        {
            "baslik": "ANLAŞMAZLIK VE ÖNCELİK",
            "govde": [
                "Anlaşmazlık olduğu takdirde dostane bir anlaşmaya varılması için her iki taraf da iyi niyetli bir şekilde ellerinden geleni yapacaklardır. Eğer söz konusu anlaşmazlık, anlaşmazlığın karşı Taraf’a bildirildiği tarihten itibaren 30 gün içinde çözüme kavuşturulamazsa, anlaşmazlıkların çözümü için İstanbul Anadolu Mahkemeleri yetkili olacaktır."
            ]
        },
        {
            "baslik": "DİĞER HUSUSLAR",
            "govde": [
                "15.1. İşbu Sözleşme, sözleşme metni, ek olarak İmza Sirkülerleri, Teknik Şartlar, Teknik Çizimler ve Görünüşlerden oluşmaktadır.",
                "15.2. Bu sözleşme ile ilgili her türlü değişiklik yazılı olarak yapılacak ve her iki tarafın imzasını taşıyacaktır.",
                "15.3. İşbu Sözleşme ve Sözleşme’nin ayrılmaz bir parçasını oluşturan ekleri, Taraflar arasında işbu Sözleşme'nin konusu ile ilgili olarak yegâne geçerli mutabakatı teşkil etmekte olup Taraflar arasında önceden yapılmış olan gerek yazılı gerekse sözlü yazışma, sözleşme ve anlaşmaların yerine geçer.",
                "15.4. Tarafların birbirlerine verdiği çizimler, teknik dokümantasyon veya sair teknik bilgiler sözleşme kapsamı dışında başka amaçla ve birbirlerinin yazılı onayı olmadan kullanılamayacak, kopyalanmayacak, çoğaltılamayacak, yayınlanmayacak veya üçüncü şahıslara iletilmeyecektir. Satıcı tarafından Alıcı’ya verilen teknik çizimlere ve teknik dokümanlara ait telif hakları münhasıran Satıcı’ya ait olarak kalacaktır.",
                "15.5. Ürünlerin üretiminde ithal malzeme ve ekipman kullanıldığı durumlarda, Alıcı tarafından gerçekleştirilecek ödemelerde yaşanan gecikme dolayısıyla söz konusu malzeme ve ekipmanın 24 saatten fazla gümrükte beklemesi halinde tahakkuk edecek gümrük, ardiye, demuraj ve her türlü yasal masraflar ayrıca Alıcı’ya fatura edilecektir.",
                "15.6. Taraflar, Sözleşme’den doğabilecek ihtilaflarda her iki Tarafın da ticari defter ve kayıtları ile bilgisayar kayıtlarının ve elektronik ortamdaki yazışmalar ve bildirimlerinin HMK 193. Madde anlamında muteber, bağlayıcı, kesin ve münhasır delil teşkil edeceğini ve bu maddenin delil sözleşmesi niteliğinde olduğunu, kabul, beyan ve taahhüt eder."
            ]
        },
        {
            "baslik": "YASAL ADRESLER VE BANKA BİLGİLERİ",
            "govde": [
                "Aşağıdaki adresler Tarafların yasal irtibat adresleridir. Ve bu adreslere yapılan tebligatlar Tarafların kendisine yapılmış sayılacaktır.",
                "ALICI",
                "{{musteri_uzun_ad}}",
                "{{fatura_adresi}}",
                "{{vergi_dairesi}} V.D. - V.No: {{vergi_no}}",
                "{{musteri_telefon}} - {{musteri_email}}",
                "SATICI",
                "Aterko Yapı Danışmanlık Sanayi ve Ticaret Anonim Şirketi",
                "Esentepe Mah. Anadolu Cad. AND Ticari Blok No:5/2 D:346 Kartal - İstanbul",
                "Kartal V.D. - V.No: 099 054 9662",
                "0 216 473 2203 - aterko@aterko.com",
                "Satıcının Banka Bilgileri",
                "Banka / Şube Adı",
                "Hesap Türü",
                "IBAN",
                "Dünya Katılım Bankası / Maltepe Şubesi",
                "TL",
                "TR13 0021 4010 0000 0000 1303 69",
                "Dünya Katılım Bankası / Maltepe Şubesi",
                "USD",
                "TR83 0021 4010 0000 0000 1303 70",
                "Dünya Katılım Bankası / Maltepe Şubesi",
                "EUR",
                "TR56 0021 4010 0000 0000 1303 71"
            ]
        },
        {
            "baslik": "SÖZLEŞME TARİHİ",
            "govde": [
                "İşbu Sözleşme 17 (onyedi) maddeden ibaret olup iki nüsha olarak {{sozlesme_tarihi}} tarihinde Tarafların karşılıklı imzası ile yürürlüğe girmiştir.",
                "SATICI",
                "ALICI",
                "Aterko Yapı Danışmanlık Sanayi ve Ticaret Anonim Şirketi",
                "{{musteri_uzun_ad}}"
            ]
        }
    ]
};

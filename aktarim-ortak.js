// ============================================================================
// ESKİ SİSTEM (aset.aterko.com) AKTARIM ORTAK YARDIMCILARI
// Eski RDS'e salt-okunur erişim EC2 üzerinden. Parola koda YAZILMAZ: sunucudaki
// application-prod.yml'den o anda okunur.
// ============================================================================
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const { execFileSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
// Boştaki bağlantı havuz tarafından kapatılırsa süreç çökmesin (işlem zaten ROLLBACK olur)
pool.on('error', (e) => console.error('Havuz bağlantı hatası:', e.message));

const UZAK_KOMUT = [
    'Y=/home/ubuntu/backend/config/application-prod.yml;',
    'export PGPASSWORD=$(grep -A8 -i datasource $Y | grep -i password | head -1',
    "| sed -E 's/.*password:[[:space:]]*//; s/^[\"'\\'']//; s/[\"'\\'']$//');",
    'psql "host=database-aset-5.c2bvmn8gndok.eu-west-1.rds.amazonaws.com dbname=aterko_prod_db',
    'user=aterko_prod_db_user sslmode=require" -t -A -v ON_ERROR_STOP=1 -f -'
].join(' ');

// SQL stdin'den gider; sonuç tek satır JSON dizi olarak döner.
function eskiSorgu(sql) {
    const out = execFileSync('ssh',
        ['-i', process.env.HOME + '/.ssh/aterko_ec2', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes',
         'ubuntu@52.18.78.68', UZAK_KOMUT],
        { input: `SELECT COALESCE(json_agg(x), '[]') FROM (${sql}) x;`, maxBuffer: 1024 * 1024 * 1024 })
        .toString().trim();
    return JSON.parse(out || '[]');
}

// Büyük tabloları sayfa sayfa çeker (id sıralı).
function eskiSayfali(sql, sayfa = 20000) {
    const sonuc = [];
    for (let son = -1; ; ) {
        const parca = eskiSorgu(`SELECT * FROM (${sql}) q WHERE q.id > ${son} ORDER BY q.id LIMIT ${sayfa}`);
        sonuc.push(...parca);
        if (parca.length < sayfa) break;
        son = parca[parca.length - 1].id;
    }
    return sonuc;
}

// Eski jhi_user login → e-posta
const LOGIN_EMAIL = {
    yunus: 'yunus@aterko.com', yakup: 'yakup@aterko.com', mahmut: 'mahmut@aterko.com',
    tahir: 'tahir@aterko.com', mehmetuysal: 'mehmetuysal@aterko.com', varol: 'varol@aterko.com',
    ais: 'ais@aterko.com', ayse: 'aysesozan@aterko.com', ofb: 'ofb@aterko.com',
    muratongudu: 'muratongudu@gmail.com', yaa: 'asimaksoy@gmail.com'
};
const eposta = (login) => (login ? (LOGIN_EMAIL[login] || login) : null);

// Kesme anı: bu andan sonra eski sisteme yazılmaz (Yunus kararı 2026-09-23)
const KESME = '2026-09-23 14:26:51+03';

module.exports = { pool, eskiSorgu, eskiSayfali, eposta, LOGIN_EMAIL, KESME };

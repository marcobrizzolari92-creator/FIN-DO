import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_HTML } from "./index-html.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 120) * 1000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
const VERSION = "9.2.0";

app.use(express.json({limit:"16mb"}));
app.use(express.raw({type:"application/octet-stream",limit:"5mb"}));

// ── Static files: on Vercel, public/ is served by CDN automatically ──
// ── express.static() is ignored on Vercel (docs: use public/ directory) ──
// ── Locally, express.static works fine for development ──
app.use(express.static(join(__dirname, "public")));

// ── Data directory for JSON persistence ──
// On Vercel serverless, use /tmp; locally use ./data
const DATA_DIR = process.env.VERCEL === "1"
  ? join("/tmp", "findo-data")
  : join(__dirname, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, {recursive:true});
const DB_PATH = join(DATA_DIR, "findo.json");

function loadDB() {
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return { priceHistory: [], savedSearches: [], users: {} }; }
}
function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db), "utf-8");
}

const cache = new Map();
const rate = new Map();
let amadeusToken = {value:null, expires:0};

const clean = s => String(s ?? "").trim();
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./,""); } catch { return "web"; } };
const now = () => Date.now();

function limited(ip){
  const t = now(), bucket = rate.get(ip);
  if (!bucket || t-bucket.t >= 60000) { rate.set(ip,{t,n:1}); return false; }
  bucket.n++;
  return bucket.n > RATE_LIMIT;
}
function cacheGet(k){ const x=cache.get(k); if(!x || now()-x.t>CACHE_TTL){cache.delete(k);return null} return x.v; }
function cacheSet(k,v){ cache.set(k,{t:now(),v}); if(cache.size>800) { const keys=[...cache.keys()]; for(let i=0;i<100;i++) cache.delete(keys[i]); } }

/* ========== CAR & MOTO MODELS ========== */
const CAR_MODELS=/\b(discovery|range\s*rover|land\s*rover|defender|panda|punto|grande\s*punto|500|500e|c\s*hr|yaris|corolla|auris|rav\s*4|golf|passat|tiguan|touareg|polo|up!|focus|fiesta|mustang|kuga|civic|cr[- ]?v|hr[- ]?v|jazz|accord|clio|captur|megane|kadjar|scenic|twingo|corsa|mokka|astra|zafira|insignia|leon|ibiza|ateca|tarraco|arona|sportage|ceed|picanto|rio|i20|i30|tucson|santa\s*fe|sorento|juke|qashqai|x[- ]?trail|micra|pulsar|note|308|208|3008|5008|2008|c3|c4|c5|c3\s*aircross|duster|sandero|logan|s\s*cross|compass|renegade|wrangler|cherokee|grand\s*cherokee|124\s*spider|giulietta|stelvio|giulia|models?\s*[s3x]|model\s*y|cybertruck|leaf|ariya|gtr|clubman|countryman|cooper|swift|vitara|ignis|sx4|s[- ]?cross|space\s*star|colt|l200|pajero|outlander|asx|eclipse\s*cross|yaris\s*cross|aygo\s*x|land\s*cruiser|hilux|supra|gt86|prius|avensis|verso|ranger|explorer|ecosport|puma|mondeo|s[- ]?max|galaxy|c[- ]?max|transit|caddy|transporter|california|c\s*class|e\s*class|s\s*class|a\s*class|b\s*class|gla|glb|glc|gle|gls|cla|cle|clk|slc|slk|sl|amg|gt|eqs|eqe|eqa|eqb|eqc|id\s*\.?[34]|golf\s*gti|golf\s*r|r[- ]?s[2346]|tt|q[23578]|rs[345678]|m[23568]|x[1234567]|z[34]|i[34568]|ix|serie\s*[12345678]|m[23568]\s*serie|arkana|dacia|spring|arkana|t\s*cross|t\s*roc|taigo|nivus|virtus|vento|amarok|caddy|touareg|artega|porsche|cayenne|macan|taycan|panamera|boxster| cayman|maserati|levante|ghibli|quattroporte|mc20|lamborghini|urus|huracan|aventador|ferrari|roma|sf90|f8|296|purosangue|bentley|continental|flying\s*spur|bentayga|rolls\s*royce|ghost|phantom|cullinan|aston\s*martin|db[0-9]+|vantage|volvo|xc[0-9]+|s[0-9]+|v[0-9]+| Polestar)\b/i;

const MOTO_MODELS=/\b(mt[- ]?0[1-9]|mt[- ]?[1-9]\d|cb[0-9]{3,4}|cbr[0-9]{3,4}|gsx[- ]?r|gsx[- ]?s|ninja|z[0-9]{3,4}|r[1-9]|f[0-9]{3,4}|monster|multistrada|panigale|scrambler|diavel|hypermotard|superbike|supersport|streetfighter|v[- ]?max|xsr|t[- ]?max|t[- ]?ray|mt[- ]?0[1-9]|n[- ]?max|x[- ]?adv|tracer|tenere|afric\s*twin|gold\s*wing|fireblade|hornet|cb\d+rr|rc[0-9]+|ducati|yamaha|honda|ktm|bmw\s*moto|suzuki|kawasaki|aprilia|triumph|harley|piaggio|vespa|moto\s*guzzi|benelli|mv\s*agusta|beta|gas\s*gas|sherco|crf|africa\s*twin|super\s*tenere|fjr|v\s*strom|dr[- ]?[z0-9]+|rm[- ]?[z0-9]+|klx|kdx|te[0-9]+|fe[0-9]+|freeride|enduro|supermoto|cross|trial)\b/i;

/* ========== DETECTION ========== */
function detect(q){
  const s = q.toLowerCase();
  if (CAR_MODELS.test(s) && /\b(km|chilometri|chilometraggio|anno|anni|usata|usato|diesel|benzina|elettrica|gpl|metano|cv|km\/l|manual|automatic|potenza|cilindrata)\b/i.test(s)) return "car";
  if (CAR_MODELS.test(s) && /\b(meno\s+di\s+\d|sotto\s+i\s+\d|max\s+\d|fino\s+a\s+\d|a\s+meno)\b/i.test(s)) return "car";
  if (CAR_MODELS.test(s)) return "car";
  if (MOTO_MODELS.test(s) && /\b(km|chilometri|cc|usata|usato|anno|cv|moto|motocicletta)\b/i.test(s)) return "motorcycle";
  if (/\bmoto\b/.test(s) && !/\bmotore\b/.test(s)) return "motorcycle";
  if (/(volo|voli|aereo|aerei|flight|andata|ritorno|mxp|lin|fco|cdg|lhr|jfk)\b/.test(s)) return "flight";
  if (/\b(hotel|albergo|resort|b&b|bed and breakfast|ostello|camera|stanza|pernottare|pernottamento|per\s+notte)\b/.test(s)) return "hotel";
  if (/\b(ristorante|ristoranti|pizzeria|sushi|bar|cena|pranzo|tavolo|pub|trattoria|osteria|mangiare|mangi|pasta|pizza|hamburger|cucina|braceria|agriturismo)\b/.test(s)) return "restaurant";
  if (/\b(farmacia|farmacie)\b/.test(s)) return "pharmacy";
  if (/\b(benzina|diesel|distributore|carburante|metano|gpl|self|fai\s+da\s+te)\b/.test(s)) return "gas";
  if (/(moto|scooter|ducati|yamaha|honda|ktm|bmw|vespa)\b/.test(s)) return "motorcycle";
  if (/\b(auto|macchina|automobile|fiat|audi|mercedes|volkswagen|toyota|ford|renault|peugeot|opel|tesla|jeep|mini|alfa|lancia|suzuki|mazda|subaru|volvo|dacia|seat|skoda|hyundai|kia|ssangyong)\b/.test(s)) return "car";
  if (/\b(iphone|samsung|xiaomi|pixel|macbook|computer|pc|tv|televisore|smartphone|telefono|tablet|cuffie|monitor|ipad|airpods|galaxy|huawei|oneplus|oppo|realme|nothing)\b/.test(s)) return "product";
  if (/\b(lavoro|offerta di lavoro|assumere|curriculum|annuncio di lavoro|job|carriera|posizione|impiego|recruiting|stage|tirocinio)\b/.test(s)) return "job";
  if (/\b(casa|appartamento|villa|loft|attico|monolocale|bilocale|trilocale|affitto|vendita|immobile|immobiliare|proprieta|mq|metri quadrati)\b/.test(s)) return "realestate";
  return "general";
}

/* ========== INTENT PARSING ========== */
function parseIntent(q, kind, lat, lon){
  const original = clean(q);
  const s = original.toLowerCase();
  const intent = {
    kind, original, near:false, openNow:false, cheap:false, expensive:false,
    maxPrice:null, maxMileage:null, minYear:null, city:null, terms:[], sort:"best", used:false, coreTerms:[],
    fuel:null, transmission:null
  };

  intent.near = /\b(vicino a me|vicino|qui vicino|nelle vicinanze|nei dintorni|near me|nearby)\b/i.test(s);
  intent.openNow = /\b(aperto|aperta|aperti|aperte|open|adesso|ora|stasera|questa sera)\b/i.test(s);
  intent.cheap = /\b(economico|economica|economici|economiche|piu economico|più economico|cheap|low cost|spendere poco|risparmiare|più basso|più bassa)\b/i.test(s);
  intent.expensive = /\b(lusso|di lusso|premium|costoso|costosa|costosi|costose)\b/i.test(s);
  intent.used = /\b(usato|usata|usati|usate|seconda mano|occasion[ei]|km\d|chilometri|chilometraggio)\b/i.test(s);

  const fuelMatch = s.match(/\b(diesel|benzina|elettrica|elettrico|gpl|metano|hybrid|ibrida|ibrido)\b/i);
  if (fuelMatch) intent.fuel = fuelMatch[1].toLowerCase();
  if (/\b(manuale|manual)\b/i.test(s)) intent.transmission = "manuale";
  else if (/\b(automatica|automatico|automatic)\b/i.test(s)) intent.transmission = "automatica";

  const euro = s.match(/(?:sotto|meno di|max|massimo|entro|fino a|più basso di|under|less than)\s*(?:€|eur|euro)?\s*(\d+(?:[.,]\d+)?)/i);
  if (euro) intent.maxPrice = Number(euro[1].replace(',','.'));

  const mileage = s.match(/(?:meno di|sotto i?s?|sotto i|max|massimo|entro|fino a|al massimo|less than|under|più basso di|fino a)\s*(\d{1,3}(?:[., ]?\d{3})*)\s*km\b/i);
  if (mileage) { const raw = mileage[1].replace(/[. ]/g,'').replace(',','.'); const km = Number(raw); if(km>=100&&km<=500000) intent.maxMileage=km; }
  const mileage2 = s.match(/a\s+meno\s+di\s+(\d{1,3}(?:[., ]?\d{3})*)\s*km/i);
  if (mileage2 && !intent.maxMileage) { const raw = mileage2[1].replace(/[. ]/g,'').replace(',','.'); const km = Number(raw); if(km>=100&&km<=500000) intent.maxMileage=km; }

  const yearMatch = s.match(/\b(?:dal|dall'|da|from)\s+(20\d{2})\b/i);
  if (yearMatch) intent.minYear = Number(yearMatch[1]);
  if (intent.cheap) intent.sort = "price";
  if (intent.near) intent.sort = "distance";

  let termText = s;
  const stopPhrases = [
    /(?:voglio|vorrei|cerca|cercami|trova|trovami|fammi vedere|mostrami|mi serve|cerco|vorrei trovare)\b/gi,
    /(?:vicino a me|qui vicino|nelle vicinanze|nei dintorni|near me|nearby)\b/gi,
    /(?:aperto|aperta|aperti|aperte|open|adesso|ora|stasera|questa sera)\b/gi,
    /(?:economico|economica|economici|economiche|piu economico|più economico|cheap|low cost|spendere poco|risparmiare|più basso|più bassa)\b/gi,
    /(?:lusso|di lusso|premium|costoso|costosa|costosi|costose)\b/gi,
    /(?:usato|usata|usati|usate|seconda mano|occasion[ei])\b/gi,
    /(?:sotto|meno di|massimo|max|entro|fino a|a meno di|al massimo|più basso di|under|less than)\s*(?:€|eur|euro)?\s*\d+(?:[.,]\d+)?/gi,
    /(?:€|eur|euro)\s*\d+(?:[.,]\d+)?/gi,
    /(?:a meno di|sotto i?s?|sotto|max|massimo|entro|fino a|al massimo)\s*\d{1,3}(?:[., ]?\d{3})*\s*km/gi,
    /\d{1,3}(?:[., ]?\d{3})*\s*km/gi,
    /\b(diesel|benzina|elettrica|elettrico|gpl|metano|hybrid|ibrida|ibrido|manuale|manual|automatica|automatico|automatic)\b/gi
  ];
  for (const rx of stopPhrases) termText = termText.replace(rx, ' ');
  termText = termText.replace(/\b20\d{2}\b/g, ' ').replace(/\b\d{3,}\b/g, ' ');

  const categoryWords = {
    restaurant: /\b(ristorante|ristoranti|pizzeria|bar|cena|pranzo|tavolo|pub|trattoria|osteria|mangiare|mangi|pasta|pizza|cucina)\b/gi,
    hotel: /\b(hotel|albergo|resort|ostello|camera|stanza|b&b|bed and breakfast|pernottare|pernotto|per\s+notte)\b/gi,
    pharmacy: /\b(farmacia|farmacie)\b/gi,
    gas: /\b(benzina|diesel|distributore|carburante|metano|gpl|self|fai\s+da\s+te)\b/gi,
    motorcycle: /\b(moto|motocicletta|motociclette|scooter)\b/gi,
    car: /\b(auto|macchina|automobile|automobili)\b/gi,
    product: /\b(smartphone|telefono|telefoni|prodotto|prodotti)\b/gi,
    job: /\b(lavoro|offerta|assumere|curriculum|annuncio|job|carriera|posizione|impiego|stage|tirocinio)\b/gi,
    realestate: /\b(casa|appartamento|villa|loft|attico|monolocale|bilocale|trilocale|affitto|vendita|immobile|immobiliare)\b/gi
  };
  if (categoryWords[kind]) termText = termText.replace(categoryWords[kind], ' ');

  const city = s.match(/\b(?:a|in)\s+([a-zà-ÿ][a-zà-ÿ' -]{2,35}?)(?=\s+(?:domani|oggi|stasera|ora|adesso|vicino|econom|sotto|meno|aperto|con|per|$))/i);
  if (city) intent.city = city[1].trim().replace(/[.,;]+$/, '');
  if (intent.city) { const esc = intent.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); termText = termText.replace(new RegExp('\\b'+esc+'\\b','ig'), ' '); }

  const stopWords = new Set(['voglio','vorrei','cerca','cercami','trova','trovami','fammi','vedere','mostrami','mi','serve','cerco','un','una','uno','il','lo','la','i','gli','le','a','in','da','per','con','me','qui','e','di','del','della','dei','degli','delle','che','come','euro','eur','near','now','today','tomorrow','senza','anche','meno','massimo','max','sotto','fino','entro','più','piu','basso','bassa']);
  const tokens = termText.split(/[^a-zà-ÿ0-9_-]+/i).map(x=>x.trim().toLowerCase()).filter(x=>x.length>1 && !stopWords.has(x));

  const brandModel = original.match(/\b(land\s*rover|yamaha|honda|ducati|ktm|bmw|suzuki|kawasaki|aprilia|triumph|harley|piaggio|vespa|fiat|ford|audi|mercedes|volkswagen|toyota|renault|peugeot|opel|tesla|jeep|mini|alfa|lancia|seat|skoda|dacia|hyundai|kia|mazda|subaru|volvo|ssangyong|porsche|maserati|lamborghini|ferrari|bentley|rolls\s*royce|aston\s*martin|polestar)\s+([a-z0-9][-a-z0-9 ]{0,30}?)(?=\s+(?:a|usata|usato|km|\d{4}|diesel|benzina|$))/i);
  if (brandModel) { tokens.push(brandModel[1].toLowerCase().replace(/\s+/g,' ')); tokens.push(brandModel[2].trim().toLowerCase()); }

  const modelNum = original.match(/\b(discovery|range\s*rover|defender|panda|punto|golf|passat|polo|focus|civic|clio|corsa|astra|leon|ibiza|megane|captur|juke|qashqai|tiguan|tucson|compass|wrangler|cooper|clubman|vitara|swift|micra|yaris|corolla|prius|leaf|supra|gtr|mustang)\s*([0-9]{1,2}[a-z]?)\b/i);
  if (modelNum) { tokens.push((modelNum[1]+' '+modelNum[2]).toLowerCase().trim()); tokens.push(modelNum[1].toLowerCase().replace(/\s+/g,' ')); }

  intent.terms = [...new Set(tokens)];
  intent.coreTerms = intent.terms;
  return intent;
}

function buildSearchText(intent) {
  const bits = [...intent.coreTerms];
  if (!bits.length) { const defaults={restaurant:"ristorante",hotel:"hotel",pharmacy:"farmacia",gas:"distributore",car:"auto",motorcycle:"moto",job:"lavoro",realestate:"casa"}; if(defaults[intent.kind]) bits.push(defaults[intent.kind]); }
  if (intent.kind==='car') { bits.push('auto usata'); if(intent.fuel) bits.push(intent.fuel); if(intent.maxMileage) bits.push(`${intent.maxMileage} km`); if(intent.minYear) bits.push(`dal ${intent.minYear}`); }
  if (intent.kind==='motorcycle') { bits.push('moto usata'); if(intent.maxMileage) bits.push(`${intent.maxMileage} km`); }
  if (intent.city) bits.push(intent.city);
  return bits.join(' ').trim();
}

function intentQuery(q, intent) {
  return [intent.coreTerms?.join(" ")||intent.terms.join(" "), intent.city, intent.kind==='car'&&intent.used?'usata':(intent.used?'usato':''), intent.maxPrice!=null?`sotto ${intent.maxPrice} euro`:'', intent.openNow?'aperto adesso':'', intent.fuel||'', intent.maxMileage?`meno di ${intent.maxMileage} km`:'', intent.minYear?`dal ${intent.minYear}`:''].filter(Boolean).join(' ').trim()||q;
}

/* ========== SEMANTIC & KIND ENFORCEMENT ========== */
function semanticMatch(x, intent) {
  const title=String(x.title||"").toLowerCase(); const text=`${title} ${x.description||""}`.toLowerCase();
  const terms=(intent.coreTerms||intent.terms||[]).map(clean).filter(t=>t.length>=2);
  if(!terms.length) return 0;
  let hit=0;
  for(const t of terms){const z=t.toLowerCase(); if(title.includes(z)) hit+=1.25; else if(text.includes(z)) hit+=1;}
  const phrase=terms.filter(t=>t.includes(" ")).sort((a,b)=>b.length-a.length)[0];
  if(phrase && text.includes(phrase.toLowerCase())) hit+=1.5;
  return Math.min(1,hit/Math.max(1,Math.min(terms.length,3)));
}
function kindEnforcement(x, intent) {
  const text = `${x.title||''} ${x.description||''}`.toLowerCase();
  const kind = intent.kind;
  if (kind==='car'||kind==='motorcycle') {
    // Strict blacklist: reject any result that is clearly not a vehicle
    if (/\b(ristorante|pizzeria|hotel|albergo|farmacia|volo|camera|cena|pranzo|mangiare|trattoria|osteria|the\s+fork|trip\s*advisor|booking|airbnb|menu|menù|chef|colazione|breakfast|noleggio|leasing|rent|affitt|prestito|mutuo|finanzi|rate|mese|mensile|abbonamento)\b/i.test(text)) return false;
    if (!/\b(auto|macchina|motor[io]|veicolo|moto|km|chilometr|diesel|benzina|elettric|cv|cc|usata|usato|potenza|cilindrata|marce|abs|airbag|autonomia|trazione|coupè|sedan|berlina|suv|cabrio|concessionar|autocar|km\s*0|nuova|nuovo|accessori|optional|allestiment|discovery|range|rover|defender|fiat|audi|bmw|mercedes|volkswagen|toyota|ford|renault|peugeot|jeep|opel|tesla|mini|alfa|lancia|seat|skoda|dacia|hyundai|kia|mazda|subaru|volvo|suzuki|porsche|maserati|lamborghini|ferrari|€|eur|prezzo|vendita|compra|annuncio)\b/i.test(text)) return false;
  }
  if (kind==='restaurant') { if (/\b(auto|macchina|motor[io]|veicolo|moto|usata|usato|km\s*0|diesel|benzina|cilindrata|concessionar|prenota\s+volo|voli|flight|hotel\s+room|noleggio|leasing|smartphone|iphone|tv|laptop)\b/i.test(text)) return false; }
  if (kind==='hotel') { if (/\b(auto|macchina|motor[io]|veicolo|moto|usata|usato|km\s*0|diesel|benzina|cilindrata|concessionar|voli|flight|noleggio|leasing|ristorante\s+recensione|smartphone|iphone|tv)\b/i.test(text)) return false; }
  if (kind==='product') { if (/\b(ristorante|pizzeria|hotel|albergo|volo|voli|usata|usato|diesel|benzina|cilindrata|farmacia|distributore|noleggio|leasing|affitt|camera|cena|mangiare)\b/i.test(text)) return false; }
  if (kind==='flight') { if (/\b(ristorante|pizzeria|hotel|albergo|auto|macchina|motor[io]|farmacia|distributore|smartphone|iphone|tv|noleggio|leasing)\b/i.test(text)) return false; }
  if (kind==='job') { if (/\b(auto\s+usata|macchina|motor[io]|volo|hotel|ristorante|pizzeria|farmacia|distributore|noleggio|leasing|compra|vendita\s+auto)\b/i.test(text)) return false; }
  if (kind==='realestate') { if (/\b(auto|macchina|motor[io]|volo|ristorante|pizzeria|farmacia|distributore|smartphone|iphone|tv|noleggio|leasing|auto\s+usata)\b/i.test(text)) return false; }
  return true;
}

/* ========== PRICE / RATING PARSING ========== */
function priceOf(s, kind=null) {
  const text=String(s||"").replace(/\u00a0/g," ");
  const candidates=[]; const re=/(?:€|EUR)\s*([\d.]+(?:,\d+)?)|([\d.]+(?:,\d+)?)\s*(?:€|EUR)/gi;
  let m;
  while((m=re.exec(text))){
    const raw=(m[1]||m[2]).replace(/\.(?=\d{3}(?:\D|$))/g,"").replace(",","."); const n=Number(raw); if(!Number.isFinite(n)) continue;
    const ctx=text.slice(Math.max(0,m.index-45),Math.min(text.length,m.index+45));
    if(/\b(al\s*mese|mensile|mese|rate|rata|settimana|giorno|a\s*partire\s*da)\b/i.test(ctx)) continue;
    candidates.push({n,idx:m.index,ctx});
  }
  if(!candidates.length) return null;
  let plausible=candidates;
  if(kind==='motorcycle'||kind==='car') plausible=candidates.filter(x=>x.n>=500&&x.n<=500000);
  else if(kind==='realestate') plausible=candidates.filter(x=>x.n>=5000&&x.n<=5000000);
  else if(kind==='product') plausible=candidates.filter(x=>x.n>=1&&x.n<=1000000);
  if(!plausible.length) plausible=candidates;
  plausible.sort((a,b)=>{
    const wa=/\b(prezzo|offerta|costo|totale|listino|vendita)\b/i.test(a.ctx)?-1:0;
    const wb=/\b(prezzo|offerta|costo|totale|listino|vendita)\b/i.test(b.ctx)?-1:0;
    return wa-wb || a.idx-b.idx;
  });
  return plausible[0].n;
}
function ratingOf(s) {
  const m = String(s).match(/([1-5](?:[.,]\d)?)\s*(?:\/\s*5|⭐|stelle|stars?)/i);
  return m ? Number(m[1].replace(',','.')) : null;
}

/* ========== NORMALIZE & DEDUPE ========== */
function normalize(x) {
  return {
    id: x.id || crypto.createHash("sha1").update(`${x.url||""}|${x.title||""}`).digest("hex").slice(0,12),
    title: clean(x.title)||"Risultato", description: clean(x.description), url: x.url||"",
    bookingUrl: x.bookingUrl||x.url||"", buyUrl: x.buyUrl||x.url||"",
    source: clean(x.source)||"web", kind: x.kind||"web", provider: x.provider||"web",
    price: x.price??null, currency: x.currency||"EUR", rating: x.rating??null,
    distanceKm: x.distanceKm??null, availability: x.availability||null, openNow: x.openNow??null,
    userRatingCount: x.userRatingCount??0, primaryType: x.primaryType||null,
    updatedAt: x.updatedAt || new Date().toISOString(), score: 0, why: [],
    image: x.image||null, phone: x.phone||null, address: x.address||null,
    year: x.year??null, mileage: x.mileage??null, fuel: x.fuel??null,
    priceHistory: x.priceHistory||null
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(x => {
    const k = (x.url||x.title).toLowerCase().replace(/^https?:\/\/(www\.)?/,"").replace(/[?#].*$/,"").replace(/\/$/,"");
    if(!k||seen.has(k)) return false; seen.add(k); return true;
  });
}

/* ========== RANKING ========== */
function rank(items, intent={sort:"best"}) {
  const arr = items.map(normalize);
  const sort = intent.sort||"best";
  for (const x of arr) {
    let score = 25;
    const match = semanticMatch(x, intent);
    if (match) { score += match*38; if(match>=0.66) x.why.push("corrisponde alla richiesta"); else if(match<0.34 && intent.kind!=="general") score-=12; }
    if (x.rating!=null) { score += (intent.cheap||intent.maxPrice!=null)?x.rating*2.5:x.rating*5; x.why.push(`valutazione ${x.rating}/5`); }
    if (x.price!=null) {
      const p = Number(x.price);
      if (intent.maxPrice!=null) { if(p<=intent.maxPrice){const ratio=p/Math.max(1,intent.maxPrice);score+=18+Math.round((1-ratio)*22);x.why.push("entro il budget");}else{score-=40;x.why.push("oltre il budget");} }
      if (intent.cheap && p>0) { const allPrices=arr.filter(a=>a.price!=null).map(a=>Number(a.price)); const min=Math.min(...allPrices); const max=Math.max(...allPrices); if(max>min){const norm=(p-min)/(max-min);score+=Math.round((1-norm)*15);} }
    }
    if (x.distanceKm!=null && intent.near) { score += Math.max(0, 25-x.distanceKm); x.why.push(`${x.distanceKm} km da te`); }
    if (x.openNow===true && intent.openNow) { score+=20; x.why.push("aperto ora"); }
    if (intent.maxMileage!=null && x.mileage!=null) { if(Number(x.mileage)<=intent.maxMileage){score+=15;x.why.push("chilometraggio ok");}else{score-=30;} }
    if (intent.minYear!=null && x.year!=null) { if(Number(x.year)>=intent.minYear){score+=10;x.why.push(`anno ${x.year}`);}else{score-=15;} }
    if (intent.fuel && x.fuel && x.fuel.toLowerCase()===intent.fuel.toLowerCase()) { score+=15; x.why.push(`alimentazione ${x.fuel}`); }
    if (x.userRatingCount>100) score+=5; if(x.userRatingCount>500) score+=5;
    if (x.image) score+=3;
    const src = (x.source||"").toLowerCase();
    // Italian source boost: prioritize Italian domains
    if (src.includes("autoscout24.it")||src.includes("subito.it")||src.includes("amazon.it")||src.includes("idealo.it")||src.includes("trovaprezzi")||src.includes("immobiliare.it")||src.includes("thefork.it")||src.includes("skyscanner.it")||src.includes("infojobs.it")||src.includes("moto.it")||src.includes("casa.it")||src.includes("idealista.it")||src.includes("motor1.it")||src.includes("quattroruote")||src.includes("volagratis")||src.includes("hotel.it")||src.includes("zoomia")||src.includes("kelkoo")||src.includes("monster.it")) score+=12;
    else if (src.includes("autoscout")||src.includes("subito")||src.includes("amazon")||src.includes("idealo")||src.includes("ebay")||src.includes("booking")||src.includes("thefork")||src.includes("google")) score+=6;
    // Penalize generic/non-Italian sources for car/product searches
    if ((intent.kind==='car'||intent.kind==='motorcycle'||intent.kind==='product')&&!src.includes(".it")&&!src.includes("autoscout")&&!src.includes("subito")&&!src.includes("amazon")&&!src.includes("ebay")&&!src.includes("idealo")&&!src.includes("google")&&!src.includes("thefork")&&!src.includes("booking")) score-=5;
    x.score = Math.max(0, Math.min(100, Math.round(score)));
  }
  arr.sort((a,b) => {
    if (sort==="price") return (a.price??1e12)-(b.price??1e12);
    if (sort==="distance") return (a.distanceKm??1e12)-(b.distanceKm??1e12);
    return b.score-a.score;
  });
  return arr.slice(0,40);
}

/* ========== OFFER CHUNKS (multi-offer per page) ========== */
const SOURCE_PLANS = {
  car: [{name:"AutoScout24.it",domains:["autoscout24.it"]},{name:"Subito Auto",domains:["subito.it"]},{name:"Automobile.it",domains:["automobile.it"]},{name:"Motor1.it",domains:["motor1.it"]},{name:"Quattroruote",domains:["quattroruote.it"]}],
  motorcycle: [{name:"AutoScout24.it",domains:["autoscout24.it"]},{name:"Subito Moto",domains:["subito.it"]},{name:"Moto.it",domains:["moto.it"]}],
  product: [{name:"Amazon.it",domains:["amazon.it"]},{name:"eBay.it",domains:["ebay.it"]},{name:"Idealo.it",domains:["idealo.it"]},{name:"Trovaprezzi.it",domains:["trovaprezzi.it"]},{name:"Zoomia.it",domains:["zoomia.it"]},{name:"Kelkoo.it",domains:["kelkoo.it"]}],
  hotel: [{name:"Booking.com",domains:["booking.com"]},{name:"Trivago.it",domains:["trivago.it"]},{name:"Hotel.it",domains:["hotel.it"]}],
  restaurant: [{name:"TheFork.it",domains:["thefork.it"]},{name:"Google Maps",domains:["google.com"]}],
  flight: [{name:"Skyscanner.it",domains:["skyscanner.it"]},{name:"Google Flights",domains:["google.com"]},{name:"Volagratis.com",domains:["volagratis.com"]}],
  job: [{name:"Indeed.it",domains:["indeed.it"]},{name:"LinkedIn Jobs",domains:["linkedin.com"]},{name:"InfoJobs.it",domains:["infojobs.it"]},{name:"Monster.it",domains:["monster.it"]}],
  realestate: [{name:"Immobiliare.it",domains:["immobiliare.it"]},{name:"Subito Casa",domains:["subito.it"]},{name:"Casa.it",domains:["casa.it"]},{name:"Idealista.it",domains:["idealista.it"]}],
  pharmacy: [{name:"Google Maps",domains:["google.com"]}],
  gas: [{name:"Google Maps",domains:["google.com"]}],
};

function offerChunks(title, content, intent) {
  const text = `${title||""} ${content||""}`;
  const blocks = text.split(/(?=\n\s*[-–·▪▸►]|(?:(?:€|EUR)\s*[\d.,]+))/i);
  const out = [];
  for (const block of blocks) {
    if (out.length >= 25) break;
    const price = priceOf(block, intent.kind);
    if (price == null) continue;
    const yearMatch = block.match(/\b(20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const mileageMatch = block.match(/(\d{1,3}(?:[., ]?\d{3})*)\s*km/i);
    const mileage = mileageMatch ? Number(mileageMatch[1].replace(/[. ]/g,'').replace(',','.')) : null;
    const fuelMatch = block.match(/\b(diesel|benzina|elettrica|elettrico|gpl|metano|hybrid|ibrida|ibrido)\b/i);
    const fuel = fuelMatch ? fuelMatch[1].toLowerCase() : null;
    const displayTitle = compactDescription(block.slice(0,100), 80);
    const details = [
      year ? `Anno ${year}` : '',
      mileage!=null ? `${mileage.toLocaleString("it-IT")} km` : '',
      fuel || '',
      `€ ${price.toLocaleString("it-IT")}`
    ].filter(Boolean).join(' · ');
    out.push({ title: displayTitle, description: details, price, year, mileage, fuel });
  }
  return out;
}

function compactDescription(s, max=280) {
  return clean(String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')
    .replace(/(?:Passa al contenuto principale|Condizioni del veicolo|Annunci del rivenditore|Queste informazioni sono fornite.*?pubblicitato\.)/gi,' ')
    .replace(/\s*(?:##|#)\s*/g,' · ')
  ).slice(0,max).replace(/[|#]+$/g,'').trim();
}

/* ========== TAVILY SEARCH + EXTRACT ========== */
async function tavilySearch(q, intent={}, plan=null) {
  if (!process.env.TAVILY_API_KEY) return [];
  const searchQuery = intentQuery(q, intent);
  // Italian market optimization: add context for more precise results
  const itQuery = intent.kind === 'car' || intent.kind === 'motorcycle'
    ? searchQuery + ' prezzo Italia'
    : intent.kind === 'product'
    ? searchQuery + ' dove comprare prezzo Italia'
    : intent.kind === 'hotel' || intent.kind === 'restaurant'
    ? searchQuery
    : searchQuery + ' Italia';

  const body = {
    query: itQuery,
    search_depth: "basic",
    max_results: plan ? 7 : 10,
    include_answer: false,
    include_raw_content: false
  };
  if (plan?.domains?.length) body.include_domains = plan.domains;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {"Content-Type":"application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`},
    body: JSON.stringify(body)
  });
  if (!r.ok) { const msg = await r.text().catch(() => ""); throw new Error(`Tavily ${r.status}${msg ? `: ${msg.slice(0,180)}` : ""}`); }
  const d = await r.json();
  const aiAnswer = null;
  const out = [];
  for (const x of (d.results || [])) {
    const source = plan?.name || hostOf(x.url);
    const offers = offerChunks(x.title, x.content, intent);
    if (offers.length) {
      for (const o of offers) out.push(normalize({title:o.title,description:o.description,url:x.url,source,provider:"Tavily",kind:"web",price:o.price,rating:ratingOf(x.content),year:o.year,mileage:o.mileage,fuel:o.fuel}));
    } else {
      const candidate = normalize({title:compactDescription(x.title,100),description:compactDescription(x.content,300),url:x.url,source,provider:"Tavily",kind:"web",price:priceOf(`${x.title} ${x.content}`),rating:ratingOf(`${x.title} ${x.content}`)});
      if(!kindEnforcement(candidate,intent)) continue;
      const match=semanticMatch(candidate,intent);
      const low=`${candidate.title} ${candidate.description}`.toLowerCase();
      const unrelated=intent.kind!=='general'&&intent.coreTerms?.length&&match<0.25;
      const rental=/\b(noleggio|leasing|rent|affitt|rate\s+mensili|finanziamento|abbonamento)\b/i.test(low);
      const overBudget=intent.maxPrice!=null&&candidate.price!=null&&candidate.price>intent.maxPrice;
      const overMileage=intent.maxMileage!=null&&candidate.mileage!=null&&candidate.mileage>intent.maxMileage;
      if(!unrelated&&!rental&&!overBudget&&!overMileage) out.push(candidate);
    }
  }
  return { results: out, aiAnswer };
}

async function tavilyExtract(urls) {
  if (!process.env.TAVILY_API_KEY || !urls.length) return [];
  const r = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {"Content-Type":"application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`},
    body: JSON.stringify({ urls: urls.slice(0, 5) })
  });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).filter(x => x.raw_content).map(x => ({
    url: x.url,
    content: String(x.raw_content || "").slice(0, 3000)
  }));
}

async function multiSourceWeb(q, intent) {
  if (!process.env.TAVILY_API_KEY) return { results: [], aiAnswer: null };
  const plans = SOURCE_PLANS[intent.kind] || [];
  if (!plans.length) return tavilySearch(q, intent);
  const settled = await Promise.allSettled(plans.map(plan => tavilySearch(q, intent, plan)));
  const allResults = settled.flatMap(x => x.status==='fulfilled'?x.value.results:[]);
  const aiAnswer = settled.find(x => x.status==='fulfilled' && x.value.aiAnswer)?.value?.aiAnswer || null;
  return { results: allResults, aiAnswer };
}

/* ========== GOOGLE PLACES ========== */
const PLACE_TYPES = {restaurant:"restaurant",hotel:"hotel",pharmacy:"pharmacy",gas:"gas_station"};

function haversineKm(lat1,lon1,lat2,lon2) {
  const a=Number(lat1),b=Number(lon1),c=Number(lat2),d=Number(lon2);
  if(![a,b,c,d].every(Number.isFinite)) return null;
  const R=6371,rad=x=>x*Math.PI/180;
  const p1=rad(a),p2=rad(c),dp=rad(c-a),dl=rad(d-b);
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))*10)/10;
}

async function places(q, lat, lon, intent) {
  if (!process.env.GOOGLE_MAPS_API_KEY||lat==null||lon==null) return [];
  if (!["restaurant","hotel","pharmacy","gas","general"].includes(intent.kind)) return [];
  const textQuery = buildSearchText(intent)||q;
  const body = {textQuery,pageSize:20,languageCode:"it",rankPreference:intent.near?"DISTANCE":"RELEVANCE"};
  if (PLACE_TYPES[intent.kind]) body.includedType=PLACE_TYPES[intent.kind];
  body.locationBias={circle:{center:{latitude:Number(lat),longitude:Number(lon)},radius:intent.near?15000:30000}};
  if (intent.cheap) body.priceLevels=["PRICE_LEVEL_FREE","PRICE_LEVEL_INEXPENSIVE","PRICE_LEVEL_MODERATE"];
  if (intent.expensive) body.priceLevels=["PRICE_LEVEL_EXPENSIVE","PRICE_LEVEL_VERY_EXPENSIVE"];
  const r = await fetch("https://places.googleapis.com/v1/places:searchText",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-Goog-Api-Key":process.env.GOOGLE_MAPS_API_KEY,"X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.googleMapsUri,places.priceLevel,places.location,places.primaryType,places.regularOpeningHours.openNow,places.nationalPhoneNumber,places.photos"},
    body:JSON.stringify(body)
  });
  if(!r.ok){const msg=await r.text().catch(()=>""); throw new Error(`Google Places ${r.status}${msg?`: ${msg.slice(0,220)}`:""}`);}
  const d=await r.json();
  const priceMap={PRICE_LEVEL_FREE:0,PRICE_LEVEL_INEXPENSIVE:1,PRICE_LEVEL_MODERATE:2,PRICE_LEVEL_EXPENSIVE:3,PRICE_LEVEL_VERY_EXPENSIVE:4};
  return (d.places||[]).map(p=>{
    const plat=p.location?.latitude,plon=p.location?.longitude;
    const distanceKm=haversineKm(lat,lon,plat,plon);
    const price=p.priceLevel?(priceMap[p.priceLevel]??null):null;
    const photoRef=p.photos?.[0]?.name;
    const image=photoRef?`https://places.googleapis.com/v1/${photoRef}/media?maxWidthPx=400&key=${process.env.GOOGLE_MAPS_API_KEY}`:null;
    const parts=[p.formattedAddress];
    if(p.rating!=null) parts.push(`★ ${p.rating}`);
    if(p.userRatingCount) parts.push(`${p.userRatingCount} recensioni`);
    if(p.regularOpeningHours?.openNow===true) parts.push("Aperto ora");
    else if(p.regularOpeningHours?.openNow===false) parts.push("Chiuso ora");
    return normalize({id:p.id,title:p.displayName?.text||"Attività",description:parts.filter(Boolean).join(" · "),url:p.websiteUri||p.googleMapsUri||`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.displayName?.text||"")}`,source:"Google Places",provider:"Google",kind:"place",rating:p.rating??null,price,distanceKm,userRatingCount:p.userRatingCount??0,primaryType:p.primaryType??null,openNow:p.regularOpeningHours?.openNow===true,image,phone:p.nationalPhoneNumber||null,address:p.formattedAddress||null});
  });
}

/* ========== AMADEUS FLIGHTS ========== */
function flightParams(q) {
  const s=q.toUpperCase();
  const codes=[...s.matchAll(/\b[A-Z]{3}\b/g)].map(m=>m[0]).filter(x=>!["EUR","AND","PER","DAL","AL"].includes(x));
  const dm=s.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  const adults=Number((s.match(/(\d+)\s*(?:ADULTI|ADULTS|PERSONE|PASSENGERS)/)||[])[1]||1);
  return {origin:codes[0]||"",destination:codes[1]||"",date:dm?`${dm[1]}-${String(dm[2]).padStart(2,"0")}-${String(dm[3]).padStart(2,"0")}`:"",adults:Math.min(9,Math.max(1,adults))};
}

async function amadeusAuth() {
  const id=process.env.AMADEUS_CLIENT_ID,secret=process.env.AMADEUS_CLIENT_SECRET;
  if(!id||!secret) return null;
  if(amadeusToken.value&&now()<amadeusToken.expires) return amadeusToken.value;
  const base=process.env.AMADEUS_ENV==="production"?"https://api.amadeus.com":"https://test.api.amadeus.com";
  const r=await fetch(`${base}/v1/security/oauth2/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:id,client_secret:secret})});
  if(!r.ok) throw new Error(`Amadeus auth ${r.status}`);
  const d=await r.json();
  amadeusToken={value:d.access_token,expires:now()+(Number(d.expires_in)-60)*1000};
  return amadeusToken.value;
}

async function flights(q) {
  const p=flightParams(q); if(!p.origin||!p.destination||!p.date) return [];
  const t=await amadeusAuth(); if(!t) return [];
  const base=process.env.AMADEUS_ENV==="production"?"https://api.amadeus.com":"https://test.api.amadeus.com";
  const u=new URL(`${base}/v2/shopping/flight-offers`);
  u.searchParams.set("originLocationCode",p.origin);
  u.searchParams.set("destinationLocationCode",p.destination);
  u.searchParams.set("departureDate",p.date);
  u.searchParams.set("adults",String(p.adults));
  u.searchParams.set("currencyCode","EUR");
  u.searchParams.set("max","50");
  const r=await fetch(u,{headers:{Authorization:`Bearer ${t}`}});
  if(!r.ok) throw new Error(`Amadeus flights ${r.status}`);
  const d=await r.json();
  return (d.data||[]).map(x=>{
    const it=x.itineraries?.[0],seg=it?.segments||[],carrier=seg[0]?.carrierCode||'';
    return normalize({title:`${carrier} · ${p.origin} → ${p.destination}`,description:`${x.price?.grandTotal||x.price?.total||"?"} ${x.price?.currency||"EUR"} · ${seg.length>1?seg.length-1+" scali":"diretto"} · ${x.numberOfBookableSeats??"?"} posti`,url:`https://www.google.com/search?q=${encodeURIComponent(`${p.origin} ${p.destination} voli ${p.date}`)}`,source:"Amadeus",provider:"Amadeus",kind:"flight",price:Number(x.price?.grandTotal||x.price?.total)||null,availability:x.numberOfBookableSeats?`${x.numberOfBookableSeats} posti`:null});
  });
}

/* ========== PRICE HISTORY ========== */
function recordPriceHistory(results) {
  const db = loadDB();
  const today = new Date().toISOString().slice(0,10);
  for (const r of results) {
    if (r.price == null || !r.url) continue;
    const existing = db.priceHistory.find(h => h.url === r.url);
    if (existing) {
      if (!existing.prices.find(p => p.date === today)) {
        existing.prices.push({ date: today, price: r.price, currency: r.currency || "EUR" });
        // Keep last 90 days
        existing.prices = existing.prices.filter(p => {
          const d = new Date(p.date); const diff = (Date.now() - d.getTime())/(86400000); return diff <= 90;
        });
      }
    } else {
      db.priceHistory.push({ url: r.url, title: r.title, prices: [{ date: today, price: r.price, currency: r.currency || "EUR" }] });
    }
    if (db.priceHistory.length > 5000) db.priceHistory = db.priceHistory.slice(-5000);
  }
  saveDB(db);
}

function getPriceHistory(url) {
  const db = loadDB();
  return db.priceHistory.find(h => h.url === url) || null;
}

/* ========== SAVED SEARCHES + ALERTS ========== */
function saveSearch(query, alertConfig={}) {
  const db = loadDB();
  const id = crypto.createHash("sha1").update(query + Date.now()).digest("hex").slice(0,10);
  const existing = db.savedSearches.find(s => s.query === query);
  if (existing) {
    existing.lastRun = new Date().toISOString();
    existing.alert = alertConfig;
  } else {
    db.savedSearches.push({
      id, query, kind: alertConfig.kind || "general",
      alert: alertConfig,
      lastRun: new Date().toISOString(),
      created: new Date().toISOString(),
      lastResults: []
    });
  }
  if (db.savedSearches.length > 200) db.savedSearches = db.savedSearches.slice(-200);
  saveDB(db);
  return id;
}

function deleteSavedSearch(id) {
  const db = loadDB();
  db.savedSearches = db.savedSearches.filter(s => s.id !== id);
  saveDB(db);
}

function listSavedSearches() {
  return loadDB().savedSearches || [];
}

/* ========== COMPARISON ========== */
function compareItems(ids) {
  const db = loadDB();
  // Find items from recent cache or price history
  const items = [];
  for (const id of ids) {
    const ph = db.priceHistory.find(h => h.url && h.url.includes(id));
    if (ph) items.push({ id, title: ph.title, url: ph.url, priceHistory: ph.prices });
  }
  return items;
}

/* ========== ROUTES ========== */
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (limited(ip)) return res.status(429).json({error:"Troppe richieste. Riprova tra poco."});
  next();
});


// ── Lightweight learning: anonymous preference statistics sent by the client ──
app.post("/api/learn", (req,res)=>{
  try {
    const {events=[]}=req.body||{};
    if(!Array.isArray(events)) return res.status(400).json({error:"events non valido"});
    const db=loadDB(); db.learning=db.learning||{sources:{},kinds:{},terms:{},updated:0};
    for(const ev of events.slice(0,100)){
      const type=clean(ev.type); const source=clean(ev.source).toLowerCase(); const kind=clean(ev.kind).toLowerCase();
      const delta=type==="negative"?-1:type==="positive"?1:0.25;
      if(source) db.learning.sources[source]=(db.learning.sources[source]||0)+delta;
      if(kind) db.learning.kinds[kind]=(db.learning.kinds[kind]||0)+delta;
      for(const term of String(ev.term||"").toLowerCase().split(/\s+/).filter(x=>x.length>=3).slice(0,8)) db.learning.terms[term]=(db.learning.terms[term]||0)+delta;
    }
    db.learning.updated=Date.now();
    saveDB(db);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:"Apprendimento non disponibile"}); }
});

app.get("/api/health", (req, res) => res.json({
  ok: true, version: VERSION,
  providers: {web:!!process.env.TAVILY_API_KEY,places:!!process.env.GOOGLE_MAPS_API_KEY,flights:!!(process.env.AMADEUS_CLIENT_ID&&process.env.AMADEUS_CLIENT_SECRET),gemini:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY)}
}));

app.get("/api/search", async (req, res) => {
  const q = clean(req.query.q), lat = req.query.lat, lon = req.query.lon;
  if (!q) return res.status(400).json({error:"Inserisci cosa stai cercando."});
  const kind = detect(q);
  const intent = parseIntent(q, kind, lat, lon);
  const cacheKey = JSON.stringify([q, lat, lon, intent]);
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({...cached, cached:true});

  const shouldSearchPlaces = ["restaurant","hotel","pharmacy","gas","general"].includes(kind);

  const settled = await Promise.allSettled([
    multiSourceWeb(q, intent),
    shouldSearchPlaces ? places(q, lat, lon, intent) : Promise.resolve([]),
    kind === 'flight' ? flights(q) : Promise.resolve([])
  ]);

  const webResult = settled[0].status==='fulfilled' ? settled[0].value : { results:[], aiAnswer:null };
  const raw = dedupe([
    ...webResult.results,
    ...(settled[1].status==='fulfilled'?settled[1].value:[]),
    ...(settled[2].status==='fulfilled'?settled[2].value:[])
  ]);

  const filtered = raw.filter(x => kindEnforcement(x, intent));
  const results = rank(filtered, intent);

  // Record price history for all results with prices
  recordPriceHistory(results);

  // Extract detailed data from top URLs
  const topUrls = results.slice(0,3).map(r => r.url).filter(u => u && !u.includes('google.com/maps'));
  let extractedData = [];
  if (topUrls.length && (kind==='car'||kind==='motorcycle'||kind==='product'||kind==='realestate')) {
    try {
      const extracts = await tavilyExtract(topUrls);
      for (const ext of extracts) {
        const existing = results.find(r => r.url === ext.url);
        if (existing && ext.content) {
          // Enrich existing result with extracted data
          const ep = priceOf(ext.content, kind);
          if (ep != null && existing.price == null) existing.price = ep;
          const er = ratingOf(ext.content);
          if (er != null && existing.rating == null) existing.rating = er;
          const km = ext.content.match(/(\d{1,3}(?:[., ]?\d{3})*)\s*km/i);
          if (km && existing.mileage == null) existing.mileage = Number(km[1].replace(/[. ]/g,'').replace(',','.'));
          const yr = ext.content.match(/\b(20\d{2})\b/);
          if (yr && existing.year == null) existing.year = Number(yr[1]);
          const fl = ext.content.match(/\b(diesel|benzina|elettrica|elettrico|gpl|metano|hybrid|ibrida|ibrido)\b/i);
          if (fl && !existing.fuel) existing.fuel = fl[1].toLowerCase();
          existing.extractedContent = ext.content.slice(0, 500);
        }
      }
    } catch(e) { /* Extract failures are non-critical */ }
  }

  const warnings = settled.filter(x => x.status==='rejected').map(x => x.reason?.message||'provider error');

  const out = {
    query: q, kind, aiAnswer: webResult.aiAnswer,
    total: results.length,
    intent: {
      near:intent.near,cheap:intent.cheap,expensive:intent.expensive,
      maxPrice:intent.maxPrice,maxMileage:intent.maxMileage,minYear:intent.minYear,
      fuel:intent.fuel,openNow:intent.openNow,city:intent.city,used:intent.used,
      terms:intent.terms,coreTerms:intent.coreTerms,sort:intent.sort
    },
    results,
    providers: {
      web:!!process.env.TAVILY_API_KEY,
      places:!!(process.env.GOOGLE_MAPS_API_KEY&&lat!=null&&lon!=null),
      flights:!!(process.env.AMADEUS_CLIENT_ID&&process.env.AMADEUS_CLIENT_SECRET)
    },
    warnings
  };
  cacheSet(cacheKey, out);
  res.json(out);
});

// Price history endpoint
app.get("/api/price-history", (req, res) => {
  const url = clean(req.query.url);
  if (!url) return res.status(400).json({error:"URL richiesto"});
  const history = getPriceHistory(url);
  if (!history) return res.json({url, prices:[]});
  res.json(history);
});

// Saved searches + alerts
app.get("/api/saved-searches", (req, res) => res.json(listSavedSearches()));
app.post("/api/saved-searches", (req, res) => {
  const { query, alert } = req.body || {};
  if (!query) return res.status(400).json({error:"Query richiesta"});
  const id = saveSearch(query, alert || {});
  res.json({ok:true, id});
});
app.delete("/api/saved-searches/:id", (req, res) => {
  deleteSavedSearch(req.params.id);
  res.json({ok:true});
});

// Extract endpoint for on-demand page extraction
app.post("/api/extract", async (req, res) => {
  const { urls } = req.body || {};
  if (!urls?.length) return res.status(400).json({error:"URLs richiesti"});
  try {
    const data = await tavilyExtract(urls);
    res.json({results:data});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// ========== PRECISION HELPERS ==========
function normalizeBarcodeCode(raw) {
  const code = clean(raw).replace(/[^0-9]/g, "");
  if (![8,12,13,14].includes(code.length)) return null;
  // Accept valid EAN/UPC checksums; for unknown 8/12/13/14 digit codes keep the code
  // because some regional databases contain incomplete/legacy entries.
  const digits = code.split("").map(Number);
  if (digits.every(Number.isInteger) && digits.length >= 8) {
    let sum = 0;
    for (let i = digits.length - 2, pos = 0; i >= 0; i--, pos++) sum += digits[i] * (pos % 2 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    const actual = digits[digits.length - 1];
    if (check !== actual) return null;
  }
  return code;
}

function parseJsonLoose(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

function visualSearchQuery(info, fallback="") {
  const parts = [info.brand, info.model, info.product, info.variant, info.color, info.category]
    .map(clean).filter(Boolean);
  const unique=[]; for (const p of parts) if (!unique.some(x=>x.toLowerCase()===p.toLowerCase())) unique.push(p);
  return unique.join(" ").trim() || clean(info.search_query) || clean(fallback) || "prodotto";
}

function strictVisualRelevant(text, info) {
  const t=String(text||"").toLowerCase();
  const terms=[info.brand,info.model,info.product,info.variant].map(clean).filter(x=>x.length>=3).map(x=>x.toLowerCase());
  if (!terms.length) return true;
  const hits=terms.filter(x=>t.includes(x)).length;
  return hits >= Math.min(2, terms.length) || terms.some(x=>x.length>=6 && t.includes(x));
}

async function geminiVision(image, description="") {
  const key=process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if(!key) return {info:null,error:"GEMINI_API_KEY non configurata"};
  const match=String(image||"").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if(!match) return {info:null,error:"Formato immagine non valido"};
  const model=process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const schema={type:"object",properties:{product:{type:"string"},brand:{type:"string"},model:{type:"string"},variant:{type:"string"},category:{type:"string"},color:{type:"string"},visible_text:{type:"string"},barcode:{type:"string"},search_query:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}},required:["product","brand","model","variant","category","color","visible_text","barcode","search_query","confidence"],additionalProperties:false};
  const prompt=`Sei il motore di riconoscimento visivo di FINDO. Identifica un prodotto reale per una ricerca di acquisto precisa. NON inventare marca, modello, codice o caratteristiche: se un dato non è chiaramente leggibile o riconoscibile, lascialo vuoto. Analizza logo, etichette, testo, numero modello, EAN/UPC, packaging e dettagli distintivi. Se compare un barcode, riportalo solo se le cifre sono realmente leggibili. search_query deve contenere SOLO termini affidabili per trovare lo stesso prodotto, privilegiando marca + modello/codice + variante. confidence è 0..1. Descrizione utente: ${clean(description)||"nessuna"}`;
  const body={contents:[{parts:[{inline_data:{mime_type:match[1],data:match[2]}},{text:prompt}]}],generationConfig:{temperature:0,maxOutputTokens:700,responseMimeType:"application/json",responseJsonSchema:schema}};
  const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r;
  try{r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify(body)})}catch(e){return {info:null,error:`Connessione Gemini non riuscita: ${e.message}`}}
  if(!r.ok){const msg=await r.text().catch(()=>""); try{const retry={...body,generationConfig:{temperature:0,maxOutputTokens:700,responseMimeType:"application/json"}}; r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify(retry)}); if(!r.ok)return {info:null,error:`Gemini ${r.status}: ${msg.slice(0,300)}`}}catch{return {info:null,error:`Gemini ${r.status}: ${msg.slice(0,300)}`}}}
  const d=await r.json().catch(()=>null); const parts=d?.candidates?.[0]?.content?.parts||[]; const text=parts.map(p=>typeof p.text==="string"?p.text:"").join(" ").trim();
  let info=parseJsonLoose(text); if(!info){for(const p of parts){if(p?.json&&typeof p.json==="object"){info=p.json;break} if(p?.structuredOutput&&typeof p.structuredOutput==="object"){info=p.structuredOutput;break}}}
  if(!info||typeof info!=="object"){const reason=d?.candidates?.[0]?.finishReason||d?.promptFeedback?.blockReason||"JSON non disponibile";return {info:null,raw:text,error:`Risposta Gemini non interpretabile (${reason})`}}
  for(const k of ["product","brand","model","variant","category","color","visible_text","barcode","search_query"])info[k]=clean(info[k]); info.confidence=Math.max(0,Math.min(1,Number(info.confidence)||0));
  return {info,raw:text,error:null};
}

async function lookupBarcodeProduct(code) {
  const sources=[
    [`https://world.openfoodfacts.org/api/v2/product/${code}.json`,"Open Food Facts"],
    [`https://world.openproductsfacts.org/api/v2/product/${code}.json`,"Open Products Facts"],
    [`https://world.openbeautyfacts.org/api/v2/product/${code}.json`,"Open Beauty Facts"]
  ];
  for (const [url,source] of sources) {
    try {
      const r=await fetch(url,{headers:{"User-Agent":"FINDO/9.0 barcode-search (contact: findo)"}});
      if(!r.ok) continue;
      const d=await r.json();
      if(d.status===1 && d.product){
        const p=d.product;
        return {source,productName:p.product_name_it||p.product_name||p.generic_name_it||p.generic_name||null,brand:p.brands||null,image:p.image_front_url||p.image_url||null,description:p.generic_name_it||p.generic_name||null,categories:p.categories_it||p.categories||null};
      }
    } catch {}
  }
  return null;
}

async function exactWebSearch(query, intent, domains=[]) {
  if(!process.env.TAVILY_API_KEY) return {results:[],answer:null};
  const body={query,search_depth:"basic",max_results:8,include_answer:false,include_raw_content:false};
  if(domains.length) body.include_domains=domains;
  const r=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.TAVILY_API_KEY}`},body:JSON.stringify(body)});
  if(!r.ok) return {results:[],answer:null};
  const d=await r.json(); const out=[];
  for(const x of (d.results||[])){
    const txt=`${x.title||""} ${x.content||""}`;
    const c=normalize({title:compactDescription(x.title,110),description:compactDescription(x.content,260),url:x.url,source:hostOf(x.url),provider:"Tavily",kind:intent.kind||"product",price:priceOf(txt,intent.kind),rating:ratingOf(txt)});
    if(kindEnforcement(c,intent)) out.push(c);
  }
  return {results:dedupe(out),answer:null};
}

// ── Visual Search: identify image, then search the web for matching products ──
app.post("/api/visual-search", async (req, res) => {
  try {
    const { image, description } = req.body || {};
    if (!image && !description) return res.status(400).json({error:"Scatta/carica una foto oppure inserisci una descrizione."});

    let info={product:"",brand:"",model:"",variant:"",category:"",color:"",visible_text:"",barcode:"",search_query:"",confidence:0};
    let visionError=null;
    if(image){
      const vr=await geminiVision(image,description);
      if(vr.info) info={...info,...vr.info}; else visionError=vr.error;
    }
    const barcode=normalizeBarcodeCode(info.barcode||"");
    if(barcode){
      const p=await lookupBarcodeProduct(barcode);
      if(p){ info={...info,product:p.productName||info.product,brand:p.brand||info.brand,category:p.categories||info.category}; }
      const b=await exactWebSearch(`EAN ${barcode} ${visualSearchQuery(info,description)} prezzo Italia dove comprare`,{kind:"product",coreTerms:[barcode,...[info.product,info.brand,info.model].filter(Boolean)],terms:[barcode]},["amazon.it","ebay.it","idealo.it","trovaprezzi.it"]);
      const ranked=rank(b.results,{kind:"product",coreTerms:[barcode,...[info.product,info.brand,info.model].filter(Boolean)],terms:[barcode],cheap:true,sort:"price"});
      return res.json({query:visualSearchQuery(info,description),kind:"product",aiAnswer:`Codice ${barcode}${info.product?` · ${info.product}`:""}`,identified:info,barcode,visionError,total:ranked.length,results:ranked});
    }

    const query=visualSearchQuery(info,description);
    const core=[info.brand,info.model,info.product].map(clean).filter(x=>x.length>=3);
    const intent={kind:detect(query)==="general"?"product":detect(query),coreTerms:core.length?core:[query],terms:core.length?core:[query],cheap:false,maxPrice:null,near:false,openNow:false,sort:"best"};
    if(!["product","car","motorcycle"].includes(intent.kind)) intent.kind="product";
    const domains=["amazon.it","ebay.it","idealo.it","trovaprezzi.it","subito.it","mediaworld.it","unieuro.it"];
    // Purchase-first: never spend a visual-search request on reviews/descriptions.
    // First query the main Italian shops, then use a broader shopping query only if needed.
    const searches=[
      exactWebSearch(`"${query}" prezzo comprare acquisto Italia`,intent,domains),
      exactWebSearch(`${query} comprare prezzo negozio online Italia`,intent,[])
    ];
    const settled=await Promise.all(searches);
    const all=dedupe(settled.flatMap(x=>x.results));
    const filtered=all.filter(x=>strictVisualRelevant(`${x.title} ${x.description}`,info) || !core.length);
    const ranked=rank(filtered,intent);
    const answer=ranked.length
      ? `Ho identificato ${[info.brand,info.model,info.product,info.variant].filter(Boolean).join(" ") || "il prodotto"}. Ho cercato dove acquistarlo e ordinato le offerte trovate.`
      : (info.product||info.brand||info.model
        ? `Ho identificato: ${[info.brand,info.model,info.product,info.variant].filter(Boolean).join(" ")}. Non ho trovato ancora un'offerta affidabile: prova una foto più ravvicinata oppure aggiungi marca/modello.`
        : (visionError||"Non riesco a identificare con sufficiente precisione il prodotto. Prova una foto più ravvicinata e nitida."));
    res.json({query,kind:intent.kind,aiAnswer:answer,identified:info,visionError,total:ranked.length,results:ranked});
  } catch(e) { console.error("visual-search:",e); res.status(500).json({error:"Ricerca visiva non disponibile in questo momento."}); }
});

// ── Barcode / EAN lookup: camera/photo -> code -> verified product -> offers ──
app.get("/api/barcode", async (req, res) => {
  try {
    const code=normalizeBarcodeCode(req.query.code);
    if(!code) return res.status(400).json({error:"Codice EAN/UPC non valido. Usa 8, 12, 13 o 14 cifre e controlla il codice."});
    const p=await lookupBarcodeProduct(code);
    const baseName=[p?.brand,p?.productName].filter(Boolean).join(" ").trim();
    const intent={kind:"product",original:baseName||code,near:false,openNow:false,cheap:true,expensive:false,maxPrice:null,city:null,terms:[code,...(baseName?baseName.split(/\s+/):[])],coreTerms:[code,...(baseName?baseName.split(/\s+/):[])],sort:"price"};
    const results=[]; let aiAnswer=null;
    const queries=[
      [`EAN ${code} ${baseName} prezzo Italia dove comprare`,["amazon.it","ebay.it","idealo.it","trovaprezzi.it"]],
      [`"${code}" ${baseName} prezzo`,["mediaworld.it","unieuro.it","eprice.it","subito.it"]]
    ];
    if(process.env.TAVILY_API_KEY){
      const settled=await Promise.all(queries.map(([q,domains])=>exactWebSearch(q,intent,domains)));
      aiAnswer=settled.find(x=>x.answer)?.answer||null;
      for(const s of settled) results.push(...s.results);
    }
    let ranked=rank(dedupe(results),intent);
    // Barcode is an exact identifier: discard results that don't contain the code when code is visible.
    const exact=ranked.filter(x=>`${x.title} ${x.description}`.includes(code));
    if(exact.length) ranked=exact;
    res.json({ok:true,kind:"product",code,productName:p?.productName||null,brand:p?.brand||null,image:p?.image||null,description:p?.description||null,categories:p?.categories||null,source:p?.source||null,aiAnswer:aiAnswer|| (p?`Prodotto identificato: ${[p.brand,p.productName].filter(Boolean).join(" ")}`:`Codice ${code} identificato, ma non presente nei cataloghi FINDO.`),total:ranked.length,results:ranked.slice(0,40)});
  } catch(e){ console.error("barcode:",e); res.status(500).json({error:"Ricerca barcode non disponibile in questo momento."}); }
});

app.get("/api/config", (req, res) => res.json({
  app:"FINDO", version:VERSION,
  features:["multi-source-search","natural-language-intent","semantic-ranking","geolocation","favorites","history","pwa","mobile-wrapper","dark-mode","categories","filters","detail-view","i18n","mileage-filter","kind-enforcement","vehicle-parsing","tavily-extract","ai-answer","price-history","saved-searches","alerts","compare","voice-search","job-search","real-estate","barcode-scanner","visual-search","share"]
}));

// SPA catch-all for client-side routes — serves index.html for any non-API, non-static path
// On Vercel, the CDN serves /index.html from public/ directly;
// this catches /search, /about, etc. for client-side routing
// ── SPA catch-all: serve index.html for all non-API routes ──
// The HTML is imported from index-html.js (bundled with the function)
// so it works even when Vercel doesn't serve public/ from CDN.
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({error: "Endpoint non trovato"});
  }
  res.type("html").send(INDEX_HTML);
});

// Vercel serverless export
export default app;

// Local development only
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => console.log(`FINDO ${VERSION} su http://localhost:${PORT}`));
}
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
const VERSION = "10.18.0-PRO";

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

/* ========== RESILIENT PROVIDER LAYER ========== */
const providerState = { tavily:{idx:0,downUntil:0,cooldowns:{}}, gemini:{idx:0,downUntil:0,cooldowns:{}} };
function providerKeys(primary,listEnv){ return [...new Set([process.env[listEnv]||'',primary||''].join(',').split(',').map(clean).filter(Boolean))]; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function keyAvailable(name,key){ return (providerState[name]?.cooldowns?.[key]||0) <= Date.now(); }
function rotateProvider(name,keys,badKey=null,retryAfterMs=1500){ const st=providerState[name]; if(!st)return; if(badKey)st.cooldowns[badKey]=Date.now()+Math.max(1200,retryAfterMs); if(keys.length>1){for(let n=1;n<=keys.length;n++){const next=(st.idx+n)%keys.length;if(keyAvailable(name,keys[next])){st.idx=next;break;}}} st.downUntil=Date.now()+Math.min(10000,Math.max(1200,retryAfterMs)); }
function providerHealth(){ const tk=providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS'),gk=providerKeys(process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY,'GEMINI_API_KEYS'); return {tavily:{configured:tk.length>0,keys:tk.length,downUntil:providerState.tavily.downUntil},gemini:{configured:gk.length>0,keys:gk.length,downUntil:providerState.gemini.downUntil}}; }
async function tavilyFetch(body,timeoutMs=15000,retries=4,endpoint='/search'){ const keys=providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS'); if(!keys.length)throw new Error('TAVILY_API_KEY non configurata'); let last; for(let a=0;a<retries;a++){ let key=null; for(let n=0;n<keys.length;n++){const k=keys[(providerState.tavily.idx+n)%keys.length];if(keyAvailable('tavily',k)){key=k;providerState.tavily.idx=(providerState.tavily.idx+n)%keys.length;break;}} if(!key){await sleep(1200);continue;} const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs); try{const r=await fetch(`https://api.tavily.com${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},signal:c.signal,body:JSON.stringify(body)});const txt=await r.text();let d=null;try{d=JSON.parse(txt)}catch{} if(r.ok){providerState.tavily.cooldowns[key]=0;providerState.tavily.downUntil=0;return d||{};} const retryHeader=Number(r.headers.get('retry-after')||0),wait=retryHeader>0?Math.min(60000,retryHeader*1000):Math.min(10000,800*2**a+Math.random()*500);last=new Error(`Tavily ${r.status}: ${txt.slice(0,180)}`);if(r.status===432){break;} if([401,403].includes(r.status)){rotateProvider('tavily',keys,key,60000);break;} if([429,433,500,502,503,504].includes(r.status)){rotateProvider('tavily',keys,key,wait);await sleep(Math.min(wait,8000));} else break;}catch(e){last=e;rotateProvider('tavily',keys,key,1200);await sleep(Math.min(5000,700*2**a+Math.random()*500));}finally{clearTimeout(t)}} throw last||new Error('Tavily non disponibile'); }

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
    fuel:null, transmission:null, vehicleMake:null, vehicleModel:null, requiredPhrases:[], strictConstraints:false
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
  if (modelNum) {
    const modelPhrase=(modelNum[1]+' '+modelNum[2]).toLowerCase().trim();
    tokens.push(modelPhrase); tokens.push(modelNum[1].toLowerCase().replace(/\s+/g,' '));
    intent.vehicleModel=modelPhrase;
    intent.requiredPhrases.push(modelPhrase);
  }
  if (/\b(?:land\s*rover\s+)?discovery\s*4\b/i.test(original)) {
    intent.vehicleMake='land rover';
    intent.vehicleModel='discovery 4';
    intent.requiredPhrases.push('discovery 4');
  }
  if (intent.kind==='car' || intent.kind==='motorcycle') {
    intent.strictConstraints = Boolean(intent.maxMileage!=null || intent.maxPrice!=null || intent.minYear!=null || intent.vehicleModel);
    if (intent.vehicleModel && intent.vehicleMake==='land rover') intent.requiredPhrases.push('land rover');
  }

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
  const exact=intent.vehicleModel ? `\"${intent.vehicleMake?intent.vehicleMake+' ':''}${intent.vehicleModel}\"` : (intent.coreTerms?.join(' ')||intent.terms.join(' '));
  return [exact, intent.city, intent.near?'vicino a me':'', intent.kind==='car'&&intent.used?'usata':(intent.used?'usato':''), intent.maxPrice!=null?`sotto ${intent.maxPrice} euro`:'', intent.openNow?'aperto adesso':'', intent.fuel||'', intent.maxMileage?`meno di ${intent.maxMileage} km`:'', intent.minYear?`dal ${intent.minYear}`:''].filter(Boolean).join(' ').trim()||q;
}

function extractMileage(s){
  const t=String(s||'');
  const ms=[...t.matchAll(/(?:\b|^)(\d{1,3}(?:[. ]\d{3})+|\d{4,6})\s*km\b/gi)];
  if(!ms.length) return null;
  const vals=ms.map(m=>Number(String(m[1]).replace(/[. ]/g,''))).filter(n=>Number.isFinite(n)&&n>=100&&n<=1000000);
  return vals.length?Math.min(...vals):null;
}
function extractYear(s){
  const vals=[...String(s||'').matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m=>Number(m[1])).filter(y=>y>=1950&&y<=2035);
  return vals.length?Math.max(...vals):null;
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
  if(intent.vehicleModel){
    const vp=intent.vehicleModel.toLowerCase();
    if(text.includes(vp)) hit+=2.5; else return 0;
  }
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
  if (kind==='car' || kind==='motorcycle') {
    const model=intent.vehicleModel ? intent.vehicleModel.toLowerCase() : '';
    if (model) {
      const modelTokens=model.split(/\s+/).filter(Boolean);
      const modelHit=modelTokens.every(t=>text.includes(t));
      if (!modelHit) return false;
    }
    // Prevent non-vehicle homonyms such as Discovery Channel / Discovery documentaries.
    if (/\b(channel|canale|tv|televisione|documentario|documentary|serie\s+tv|discovery\s+channel|science|media|streaming|programma|episodio)\b/i.test(text)) return false;
    if (intent.maxMileage!=null) {
      const mm=extractMileage(text);
      if (mm==null || mm>intent.maxMileage) return false;
    }
    if (intent.maxPrice!=null) {
      const pp=priceOf(text,intent.kind);
      if (pp==null || pp>intent.maxPrice) return false;
    }
    if (intent.minYear!=null) {
      const yy=extractYear(text);
      if (yy!=null && yy<intent.minYear) return false;
    }
  }
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
    bookingUrl: x.bookingUrl||x.url||"", buyUrl: x.buyUrl||x.url||"", directUrl: x.directUrl||x.url||"",
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


// Resolve the best direct destination and a real social/OG preview image when the
// source page exposes them. Search engines sometimes return category/search pages;
// canonical metadata is safer than blindly opening the first indexed URL.
function looksLikeSearchPage(url){
  const u=String(url||'').toLowerCase();
  return /(?:[?&](?:q|query|search|keyword|text|filter|page|sort|order)=)|\/(?:search|ricerca|search-results|results|listing|listings|catalog|category|categorie|inventory|vehicles|cars|auto|offerte|annunci)(?:[/?#]|$)|\/marketplace(?:[/?#]|$)/i.test(u);
}
function looksLikeDirectListing(url){
  const u=String(url||'').toLowerCase();
  if(!/^https?:\/\//.test(u) || looksLikeSearchPage(u)) return false;
  return /\/(?:annunci|offerte|offer|item|itm|product|products|dp|p|veicolo|vehicle|car|cars|moto|listing|ad|ads)(?:[\/-]|[?]|$)/i.test(u)
    || /[a-f0-9]{8,}[-_][a-f0-9]{4,}/i.test(u)
    || /(?:amazon\.[^/]+\/[^?#]*\/(?:dp|gp\/product)\/|ebay\.[^/]+\/itm\/|autoscout24\.[^/]+\/(?:annunci|offerte)\/|subito\.[^/]+\/annunci\/)/i.test(u);
}

function decodeHtml(s){ return String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'\"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
function metaTag(html, prop){
  const re1=new RegExp(`<meta[^>]+(?:property|name)=[\\\"']${prop.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}[\\\"'][^>]+content=[\\\"']([^\\\"']+)[\\\"'][^>]*>`,`i`);
  const re2=new RegExp(`<meta[^>]+content=[\\\"']([^\\\"']+)[\\\"'][^>]+(?:property|name)=[\\\"']${prop.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}[\\\"'][^>]*>`,`i`);
  return decodeHtml((html.match(re1)?.[1]||html.match(re2)?.[1]||'').trim());
}
async function pageMeta(url){
  if(!/^https?:\/\//i.test(String(url||''))) return null;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),5000);
  try{
    const r=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (compatible; FINDO/10.6; +https://findo.app)','Accept':'text/html,application/xhtml+xml'}});
    if(!r.ok) return null;
    const finalUrl=r.url||url;
    const html=(await r.text()).slice(0,600000);
    const canonical=metaTag(html,'og:url') || (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]||'');
    const image=metaTag(html,'og:image') || metaTag(html,'twitter:image') || metaTag(html,'og:image:url');
    const title=metaTag(html,'og:title');
    const abs=(v)=>{try{return v?new URL(v,finalUrl).href:null}catch{return null}};
    let structured={};
    try{
      const blocks=[...html.matchAll(/<script[^>]+type=[\"']application\/ld\+json[\"'][^>]*>([\s\S]*?)<\/script>/gi)].slice(0,12);
      for(const b of blocks){
        const raw=b[1].trim(); if(!raw) continue;
        const j=JSON.parse(raw);
        const arr=Array.isArray(j)?j:[j];
        for(const z of arr){
          const cand=z?.itemListElement?.[0]?.item || z;
          if(!structured.title && cand?.name) structured.title=String(cand.name);
          if(!structured.url && cand?.url) structured.url=String(cand.url);
          if(!structured.image && cand?.image) structured.image=Array.isArray(cand.image)?cand.image[0]:cand.image;
          const a=cand?.address || cand?.seller?.address || cand?.offers?.seller?.address;
          if(!structured.address && a) structured.address=typeof a==='string'?a:[a.streetAddress,a.postalCode,a.addressLocality,a.addressRegion,a.addressCountry].filter(Boolean).join(', ');
        }
      }
    }catch{}

    // Some marketplaces expose the real listing only as an anchor inside a
    // search/category page. Recover the best listing-looking link before
    // accepting the page URL as the destination.
    let listingUrl=null;
    if(looksLikeSearchPage(finalUrl)){
      const anchors=[];
      const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while((m=re.exec(html)) && anchors.length<1200){
        const href=abs(decodeHtml(m[1]));
        const text=decodeHtml(m[2].replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
        if(!href || !/^https?:\/\//i.test(href) || looksLikeSearchPage(href)) continue;
        if(text.length<8) continue;
        anchors.push({href,text});
      }
      const base=clean(title||'').toLowerCase();
      const tokens=normalizedWords(base).filter(w=>w.length>2).slice(0,12);
      let best=null;
      for(const a of anchors){
        const t=a.text.toLowerCase();
        const hits=tokens.filter(w=>t.includes(w)).length;
        const score=hits/Math.max(1,tokens.length) + (tokens.length && t.includes(base)?0.65:0) + (/[\/]annunci?[\/-]|\/offerte?[\/-]|\/auto\//i.test(a.href)?0.18:0);
        if(!best || score>best.score) best={...a,score};
      }
      if(best && best.score>=0.35) listingUrl=best.href;
    }
    return {url:finalUrl,directUrl:listingUrl||abs(structured.url)||abs(canonical)||finalUrl,image:abs(image)||abs(structured.image),title:title||structured.title||null,address:structured.address||null};
  }catch{return null}
  finally{clearTimeout(timer)}
}

async function rescueDirectUrl(item){
  if(!item) return item;
  if(!providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS').length) return item;
  const host=hostOf(item.url||item.directUrl);
  const title=clean(item.title||'');
  if(!title || !host) return item;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),7000);
  try{
    const detailHints=[item.price!=null?`€${item.price}`:'',item.mileage!=null?`${item.mileage} km`:''].filter(Boolean).join(' ');
    const q=`"${title.slice(0,180)}" ${detailHints} site:${host}`;
    const body={query:q,search_depth:'advanced',max_results:8,include_answer:false,include_raw_content:false,include_domains:[host]};
    const d=await tavilyFetch(body,7000,2);
    const tokens=normalizedWords(title).filter(w=>w.length>2).slice(0,14);
    let best=null;
    for(const x of (d.results||[])){
      const u=String(x.url||''); if(!u || looksLikeSearchPage(u)) continue;
      const txt=`${x.title||''} ${x.content||''}`.toLowerCase();
      const hits=tokens.filter(w=>txt.includes(w)).length;
      const directBoost=looksLikeDirectListing(u)?0.55:0;
      const detailHits=[item.price!=null?String(Math.round(item.price)):'',item.mileage!=null?String(Math.round(item.mileage)):''].filter(Boolean).filter(v=>txt.includes(v)).length;
      const score=hits/Math.max(1,tokens.length) + (String(x.title||'').toLowerCase().includes(title.toLowerCase())?0.7:0) + directBoost + detailHits*.12;
      if(!best || score>best.score) best={url:u,title:x.title||'',score};
    }
    if(best && best.score>=0.35){
      item.directUrl=best.url; item.linkQuality='direct'; item.pageResolved=true;
      const m=await pageMeta(best.url);
      if(m?.directUrl && !looksLikeSearchPage(m.directUrl)) item.directUrl=m.directUrl;
      if(m?.image) item.image=m.image;
      if(m?.address) item.address=m.address;
      if(m?.title && (!item.title || item.title==='Risultato')) item.title=compactDescription(m.title,110);
    }
  }catch{}
  finally{clearTimeout(timer)}
  return item;
}

async function enrichResultMetadata(results, limit=30){
  const out=[...results];
  // First pass: canonical/OG metadata and link extraction.
  for(let i=0;i<Math.min(limit,out.length);i+=5){
    const batch=out.slice(i,i+5);
    const metas=await Promise.all(batch.map(x=>pageMeta(x.directUrl||x.url)));
    metas.forEach((m,j)=>{
      if(!m) return;
      const x=batch[j];
      if(m.directUrl && (!looksLikeSearchPage(m.directUrl) || !looksLikeSearchPage(x.url))) x.directUrl=m.directUrl;
      if(m.image) x.image=m.image;
      if(m.address) x.address=m.address;
      if(m.title && (!x.title || x.title==='Risultato')) x.title=compactDescription(m.title,110);
      x.pageResolved=true;
      x.linkQuality=looksLikeSearchPage(x.directUrl||x.url)?'search':'direct';
    });
  }
  // Second pass: every shopping/vehicle result is checked. This is deliberate:
  // FINDO must open the exact item shown, never the site's generic result page.
  const shoppingLike = out.filter(x=>['product','car','motorcycle'].includes(x.kind) || looksLikeSearchPage(x.directUrl||x.url));
  for(let i=0;i<shoppingLike.length;i+=4) await Promise.all(shoppingLike.slice(i,i+4).map(rescueDirectUrl));
  for(const x of out){
    const u=x.directUrl||x.url;
    x.linkQuality=looksLikeSearchPage(u)?'search':(looksLikeDirectListing(u)?'direct':'unknown');
    if(x.linkQuality==='direct') x.score=Math.min(100,(x.score||0)+12);
    else if(x.linkQuality==='search') x.score=Math.max(0,(x.score||0)-28);
  }
  return out.sort((a,b)=>(b.score||0)-(a.score||0));
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(x => {
    const k = (x.url||x.title).toLowerCase().replace(/^https?:\/\/(www\.)?/,"").replace(/[?#].*$/,"").replace(/\/$/,"");
    if(!k||seen.has(k)) return false; seen.add(k); return true;
  });
}

/* ========== LOCAL MARKET PRIORITY + CONTEXT RELEVANCE ========== */
function countryFromRequest(req){
  const forced=clean(req.query?.country||req.headers['x-findo-country']);
  if(/^[A-Z]{2}$/i.test(forced)) return forced.toUpperCase();
  const lang=String(req.headers['accept-language']||'').toLowerCase();
  const m=lang.match(/(?:^|,|;|-)\s*([a-z]{2})(?:-|_|$)/i);
  return (m?.[1]||'it').toUpperCase();
}
const COUNTRY_PROFILE={
  IT:{name:'Italia',domains:['amazon.it','ebay.it','vinted.it','subito.it','facebook.com','etsy.com','mediaworld.it','unieuro.it','eprice.it','trovaprezzi.it','idealo.it','kelkoo.it','backmarket.it','zalando.it','decathlon.it']},
  US:{name:'USA',domains:['amazon.com','ebay.com','walmart.com','target.com','bestbuy.com','facebook.com','etsy.com','mercari.com','newegg.com','bhphotovideo.com']},
  GB:{name:'Regno Unito',domains:['amazon.co.uk','ebay.co.uk','facebook.com','etsy.com','argos.co.uk','currys.co.uk','johnlewis.com','ao.com']},
  DE:{name:'Germania',domains:['amazon.de','ebay.de','facebook.com','etsy.com','kaufland.de','otto.de','mediamarkt.de','saturn.de','idealo.de']},
  FR:{name:'Francia',domains:['amazon.fr','ebay.fr','facebook.com','etsy.com','cdiscount.com','fnac.com','darty.com','idealo.fr']},
  ES:{name:'Spagna',domains:['amazon.es','ebay.es','facebook.com','etsy.com','mediamarkt.es','pccomponentes.com','idealo.es']}
};
function localProfile(country){ return COUNTRY_PROFILE[country]||COUNTRY_PROFILE.IT; }
function normalizedWords(text){ return clean(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z0-9]+/).filter(w=>w.length>1); }
function contextualRelevance(x,intent){
  const title=clean(x.title).toLowerCase();
  const desc=clean(x.description).toLowerCase();
  const all=`${title} ${desc}`;
  const terms=(intent.coreTerms||intent.terms||[]).map(clean).filter(t=>t.length>1);
  if(!terms.length) return 0;
  let titleHits=0, bodyHits=0;
  for(const term of terms){
    const t=term.toLowerCase();
    if(title.includes(t)) titleHits++;
    else if(all.includes(t)) bodyHits++;
  }
  const coverage=(titleHits*1.5+bodyHits)/Math.max(1,terms.length*1.5);
  const exactPhrase=terms.filter(t=>t.includes(' ')&&title.includes(t.toLowerCase())).length;
  const numberTokens=terms.filter(t=>/\d/.test(t));
  const numbersOk=numberTokens.length===0 || numberTokens.some(t=>all.includes(t.toLowerCase()));
  let score=Math.min(1,coverage + exactPhrase*.15);
  if(!numbersOk) score*=.55;
  return score;
}
function localSourceScore(src,country){
  const h=String(src||'').toLowerCase();
  const p=localProfile(country);
  const localHints=p.domains.map(x=>x.replace(/^www\./,''));
  if(localHints.some(d=>h.includes(d))) return 16;
  const cc=country.toLowerCase();
  if(cc==='it' && /\.it\b/.test(h)) return 10;
  if(cc==='us' && /\.com\b/.test(h)) return 7;
  return 0;
}

/* ========== DISTANCE ENRICHMENT ========== */
const geoCache=new Map();
async function geocodeAddress(address){
  const key=clean(address).toLowerCase(); if(!key) return null;
  if(geoCache.has(key)) return geoCache.get(key);
  if(!process.env.GOOGLE_MAPS_API_KEY) return null;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),3500);
  try{
    const u=`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(process.env.GOOGLE_MAPS_API_KEY)}`;
    const r=await fetch(u,{signal:controller.signal}); if(!r.ok) return null;
    const d=await r.json(); const loc=d.results?.[0]?.geometry?.location;
    if(!loc) return null; const v={lat:Number(loc.lat),lon:Number(loc.lng)}; geoCache.set(key,v); return v;
  }catch{return null} finally{clearTimeout(timer)}
}
async function enrichDistances(results,lat,lon){
  if(lat==null||lon==null) return results;
  const candidates=results.filter(x=>x.distanceKm==null && x.address).slice(0,24);
  for(let i=0;i<candidates.length;i+=4){
    const batch=candidates.slice(i,i+4); const pts=await Promise.all(batch.map(x=>geocodeAddress(x.address)));
    pts.forEach((p,j)=>{ if(p) batch[j].distanceKm=Number(haversineKm(Number(lat),Number(lon),p.lat,p.lon).toFixed(1)); });
  }
  return results;
}

/* ========== RANKING ========== */
function rank(items, intent={sort:"best"}) {
  const arr = items.map(normalize);
  const sort = intent.sort||"best";
  for (const x of arr) {
    let score = 25;
    const match = Math.max(semanticMatch(x, intent), contextualRelevance(x, intent));
    if (match) { score += match*52; if(match>=0.66) x.why.push("corrisponde alla richiesta"); else if(match<0.34 && intent.kind!=="general") score-=12; }
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
    const country=intent.country||"IT";
    score += localSourceScore(src,country);
    if (src.includes("facebook.com")) score += 4;
    if ((intent.kind==='car'||intent.kind==='motorcycle') && /(autoscout24|automobile\.it|subito|autouncle|mobile\.de|leboncoin|lacentrale|coches\.net|autotrader|cars\.com|cargurus|kijiji|bakeca)/i.test(src)) score += 8;
    if ((intent.kind==='car'||intent.kind==='motorcycle'||intent.kind==='product') && match<0.22) score-=22;
    if (intent.kind==='general' && match<0.18) score-=18;
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
  if (!providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS').length) return [];
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
  let d;
  try { d=await tavilyFetch(body,15000,3); }
  catch(e) {
    const fallback={...body,search_depth:"basic",max_results:8};
    try { d=await tavilyFetch(fallback,12000,2); } catch(e2) { throw e2; }
  }
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
  if (!providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS').length || !urls.length) return [];
  let d; try { d=await tavilyFetch({urls:urls.slice(0,5)},12000,3,'/extract'); } catch { return []; }
  return (d.results || []).filter(x => x.raw_content).map(x => ({url:x.url,content:String(x.raw_content||'').slice(0,3000)}));
}

async function multiSourceWeb(q, intent) {
  if (!providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS').length) return { results: [], aiAnswer: null };
  const plans = SOURCE_PLANS[intent.kind] || [];
  if (!plans.length) return tavilySearch(q, intent);
  const settled = await Promise.allSettled(plans.map(plan => tavilySearch(q, intent, plan)));
  const allResults = settled.flatMap(x => x.status==='fulfilled'?x.value.results:[]);
  const aiAnswer = settled.find(x => x.status==='fulfilled' && x.value.aiAnswer)?.value?.aiAnswer || null;
  return { results: allResults, aiAnswer };
}

async function reverseGeocodeCity(lat,lon){
  if(!process.env.GOOGLE_MAPS_API_KEY || lat==null || lon==null) return null;
  try{
    const u=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lon)}&language=it&key=${encodeURIComponent(process.env.GOOGLE_MAPS_API_KEY)}`;
    const r=await fetch(u,{signal:AbortSignal.timeout(5000)});
    if(!r.ok) return null; const d=await r.json();
    for(const item of (d.results||[])){
      const c=item.address_components||[];
      const city=c.find(x=>x.types?.includes('locality'))||c.find(x=>x.types?.includes('postal_town'))||c.find(x=>x.types?.includes('administrative_area_level_3'));
      if(city?.long_name) return city.long_name;
    }
  }catch{}
  return null;
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


/* ========== UNIVERSAL SEARCH SECTIONS ========== */
const VEHICLE_MARKET_DOMAINS = [
  "autoscout24.it","autoscout24.com","autoscout24.de","autoscout24.fr","autoscout24.es",
  "automobile.it","subito.it","facebook.com","ebay.it","ebay.com","autosupermarket.it",
  "autouncle.it","autouncle.com","automobile.it","kijiji.it","secondamano.it","bakeca.it",
  "carvago.com","spoticar.it","dasweltauto.it","brumbrum.it","heycar.com","cazoo.com",
  "cars.com","autotrader.com","carfax.com","truecar.com","cargurus.com","cars.co.uk",
  "motors.co.uk","mobile.de","leboncoin.fr","lacentrale.fr","coches.net","wallapop.com"
];
const UNIVERSAL_MARKET_DOMAINS = {
  car: VEHICLE_MARKET_DOMAINS,
  motorcycle: VEHICLE_MARKET_DOMAINS,
  product: ["amazon.it","ebay.it","subito.it","vinted.it","facebook.com","etsy.com","mediaworld.it","unieuro.it","eprice.it","trovaprezzi.it","idealo.it","kelkoo.it","backmarket.it","zalando.it","decathlon.it","manomano.it","aliexpress.com","temu.com","walmart.com","target.com","bestbuy.com","mercari.com","rakuten.com"],
  realestate: ["immobiliare.it","idealista.it","casa.it","subito.it","immobiliare.com","wikicasa.it","cercacasa.it","trovacasa.it","gate-away.com","idealista.com","rightmove.co.uk","zillow.com","realtor.com","remax.com"],
  job: ["indeed.it","indeed.com","infojobs.it","linkedin.com","jooble.org","monster.it","glassdoor.com","adzuna.it","careerjet.it","jobrapido.com","ziprecruiter.com"],
  hotel: ["booking.com","expedia.com","hotels.com","trivago.it","trivago.com","kayak.com","agoda.com","airbnb.com"],
  flight: ["skyscanner.it","skyscanner.com","kayak.com","google.com","expedia.com","kiwi.com","momondo.it","volagratis.com"],
  restaurant: ["tripadvisor.it","tripadvisor.com","thefork.it","google.com","paginegialle.it","yelp.com","restaurantguru.it"],
  services: ["prontopro.it","instapro.it","starofservice.com","paginegialle.it","subito.it","facebook.com","yelp.com"]
};
function marketDomainsFor(kind,country="IT"){
  const base=UNIVERSAL_MARKET_DOMAINS[kind]||GLOBAL_SHOPPING_DOMAINS;
  const local=localProfile(country)?.domains||[];
  return [...new Set([...base,...local].map(x=>String(x).split('/')[0].replace(/^www\./,'')))];
}
function searchVariants(q,intent,kind){
  const original=clean(q);
  const core=(intent.vehicleModel||intent.requiredPhrases?.[0]||intent.coreTerms?.join(' ')||original).trim();
  const loc=intent.city?` ${intent.city}`:'';
  const constraints=[
    intent.used?' usato': '',
    intent.maxMileage!=null?` meno di ${intent.maxMileage} km`:'',
    intent.maxPrice!=null?` sotto ${intent.maxPrice} euro`:'',
    intent.minYear!=null?` dal ${intent.minYear}`:'',
    intent.fuel?` ${intent.fuel}`:'',
    intent.transmission?` ${intent.transmission}`:''
  ].join('');
  const neg = kind==='car'||kind==='motorcycle' ? ' -channel -tv -televisione -documentario -streaming -serie' : '';
  const list=[
    `"${core}"${constraints}${loc} vendita annuncio${neg}`,
    `"${core}"${constraints}${loc} usato prezzo${neg}`,
    `"${core}"${constraints}${loc} buy sale price${neg}`
  ];
  if(original.toLowerCase()!==core.toLowerCase()) list.push(`"${original.replace(/\s+/g,' ').trim()}"${loc}${neg}`);
  return [...new Set(list.map(x=>x.replace(/\s+/g,' ').trim()))].slice(0,4);
}
function hardRelevant(x,intent){
  const title=clean(x.title).toLowerCase();
  const text=`${title} ${clean(x.description)} ${clean(x.url)}`.toLowerCase();
  const kind=intent.kind;
  const req=[...(intent.requiredPhrases||[]), ...(intent.vehicleModel?[intent.vehicleModel]:[])].map(clean).filter(Boolean).map(x=>x.toLowerCase());
  if(req.length && !req.some(r=>title.includes(r) || text.includes(r))) return false;
  if(kind==='car'||kind==='motorcycle'){
    if(/(discovery\s+channel|channel|canale|televisione|documentario|documentary|streaming|serie\s+tv|episodio|programma tv)/i.test(text)) return false;
    if(!/(auto|macchina|automobile|vehicle|car|moto|motorcycle|suv|km|chilometr|diesel|benzina|elettric|annuncio|vendita|usata|usato|concessionar)/i.test(text)) return false;
    if(intent.maxMileage!=null){const km=x.mileage!=null?Number(x.mileage):extractMileage(text); if(km==null||km>intent.maxMileage)return false;}
    if(intent.maxPrice!=null){const pp=x.price!=null?Number(x.price):priceOf(text,kind); if(pp==null||pp>intent.maxPrice)return false;}
    if(intent.minYear!=null){const yy=extractYear(text); if(yy!=null&&yy<intent.minYear)return false;}
  }
  if(kind==='realestate'){
    if(!/(casa|appartamento|villa|immobile|immobiliare|monolocale|bilocale|trilocale|quadrilocale|mq|m²|affitto|vendita|rent|sale|property|house|apartment)/i.test(text)) return false;
    if(intent.maxPrice!=null){const pp=x.price!=null?Number(x.price):priceOf(text,kind); if(pp==null||pp>intent.maxPrice)return false;}
  }
  if(kind==='job'){
    if(!/(lavoro|offerta|assunzione|posizione|impiego|career|job|recruit|stage|tirocinio|salary|stipendio)/i.test(text)) return false;
  }
  if(kind==='product'){
    if(/(ristorante|hotel|volo|lavoro|immobile|affitto casa)/i.test(text)) return false;
    const terms=(intent.coreTerms||[]).map(clean).filter(t=>t.length>=3);
    if(terms.length){const hits=terms.filter(t=>text.includes(t.toLowerCase())).length; if(hits<Math.max(1,Math.ceil(terms.length*.5))) return false;}
  }
  return true;
}

const GLOBAL_SHOPPING_DOMAINS = [
  "facebook.com","facebook.com/marketplace","amazon.it","amazon.com","amazon.de","amazon.fr","amazon.es","amazon.co.uk","amazon.nl","amazon.pl","amazon.co.jp",
  "ebay.it","ebay.com","ebay.de","ebay.fr","ebay.co.uk","ebay.es","vinted.it","vinted.com","subito.it","etsy.com","aliexpress.com","temu.com",
  "walmart.com","target.com","rakuten.co.jp","mercari.com","mercari.jp","shopee.com","shopee.th","shopee.sg","lazada.com","mercadolibre.com","mercadolivre.com.br",
  "allegro.pl","bol.com","kaufland.de","otto.de","cdiscount.com","fnac.com","darty.com","backmarket.it","backmarket.com","zalando.it","zalando.de",
  "decathlon.it","ikea.com","mediaworld.it","unieuro.it","eprice.it","trony.it","euronics.it","trovaprezzi.it","idealo.it","kelkoo.it","newegg.com",
  "bhphotovideo.com","bestbuy.com","homedepot.com","lowes.com","wayfair.com","farfetch.com","asos.com","stockx.com","goat.com","sephora.com","notino.it",
  "carrefour.fr","carrefour.it","lidl.it","conad.it","esselunga.it","coop.it","manomano.it","leroymerlin.it","bricoman.it","grainger.com","zoro.com"
];
const GLOBAL_SHOPPING_BATCHES=[];
for(let i=0;i<GLOBAL_SHOPPING_DOMAINS.length;i+=12) GLOBAL_SHOPPING_BATCHES.push(GLOBAL_SHOPPING_DOMAINS.slice(i,i+12));
const SEARCH_SECTIONS = {
  shopping: {label:"Shopping", icon:"🛍️", kind:"product", suffix:" acquisto prezzo comprare online", domains:GLOBAL_SHOPPING_DOMAINS},
  experiences: {label:"Esperienze", icon:"🎟️", kind:"general", suffix:" esperienza attività evento escursione tour prenotazione", domains:["getyourguide.it","getyourguide.com","viator.com","tripadvisor.it","tripadvisor.com","feverup.com","eventbrite.com","airbnb.com","klook.com","musement.com","tiqets.com","headout.com"]},
  places: {label:"Luoghi", icon:"📍", kind:"general", suffix:" luogo attività locale vicino", domains:[]},
  travel: {label:"Viaggi", icon:"✈️", kind:"general", suffix:" viaggio hotel volo offerte prenotazione", domains:["booking.com","skyscanner.it","skyscanner.com","trivago.it","trivago.com","volagratis.com","expedia.com","kayak.com","airbnb.com"]},
  services: {label:"Servizi", icon:"🛠️", kind:"general", suffix:" servizio professionista preventivo prenotazione", domains:[]},
  jobs: {label:"Lavoro", icon:"💼", kind:"job", suffix:" offerta lavoro posizione candidatura", domains:["indeed.it","indeed.com","infojobs.it","linkedin.com","monster.it","glassdoor.com","jooble.org"]},
  homes: {label:"Immobili", icon:"🏠", kind:"realestate", suffix:" vendita affitto immobile annuncio", domains:["immobiliare.it","idealista.it","casa.it","subito.it","immobiliare.com","idealista.com","rightmove.co.uk","zillow.com","realtor.com"]}
};
function sectionSpec(section){ return SEARCH_SECTIONS[clean(section).toLowerCase()] || null; }
function sectionSearchQuery(q, spec){ return `${q} ${spec?.suffix||''}`.replace(/\s+/g,' ').trim(); }
async function searchSection(q, section, lat, lon, country="IT"){
  const spec=sectionSpec(section);
  if(!spec) return {results:[],kind:"general",aiAnswer:null};
  let kind=spec.kind;
  // Preserve precise detected types inside a compatible section.
  const detected=detect(q);
  if(section==='shopping' && ['car','motorcycle','product'].includes(detected)) kind=detected;
  if(section==='travel' && ['hotel','flight'].includes(detected)) kind=detected;
  if(section==='places' && ['restaurant','hotel','pharmacy','gas'].includes(detected)) kind=detected;
  const intent=parseIntent(q,kind,lat,lon);
  if ((kind==='car'||kind==='motorcycle') && lat!=null && lon!=null) intent.near=true;
  if (lat!=null && lon!=null && !intent.city) {
    const detectedCity=await reverseGeocodeCity(lat,lon);
    if(detectedCity) intent.city=detectedCity;
  }
  intent.section=section;
  intent.country=country;
  let webResult={results:[],aiAnswer:null,providerErrors:[]};
  const domains=marketDomainsFor(kind,country);
  const variants=searchVariants(q,intent,kind);
  const localDomains=domains.slice(0,32);
  const globalDomains=domains.slice(32,80);
  const searches=[];
  for(const v of variants.slice(0,3)){
    searches.push(exactWebSearch(v,intent,localDomains));
  }
  // Always perform one broad search without site restrictions. This is essential
  // because marketplaces frequently expose the actual listing through a different
  // host/subdomain than their main domain.
  searches.push(exactWebSearch(variants[0]||q,intent,[]));
  if(globalDomains.length) searches.push(exactWebSearch(variants[1]||q,intent,globalDomains));
  const ss=await Promise.allSettled(searches);
  let found=dedupe(ss.flatMap(x=>x.status==='fulfilled'?(x.value?.results||[]):[]));
  webResult.providerErrors=ss.flatMap(x=>x.status==='fulfilled'&&x.value?.providerError?[x.value.providerError]:[]).slice(0,5);
  // Apply hard intent constraints BEFORE ranking, not after ranking.
  found=found.filter(x=>hardRelevant(x,intent));
  // If strict filtering removes everything, do a second search using the exact
  // required phrase and category vocabulary, never the raw ambiguous query alone.
  if(!found.length){
    const rescueQ=kind==='car'||kind==='motorcycle'
      ? `"${intent.vehicleModel||intent.coreTerms.join(' ')}" auto usata vendita${intent.city?' '+intent.city:''} -channel -tv -documentario`
      : `"${intent.requiredPhrases?.[0]||intent.coreTerms.join(' ')}" ${kind} ${intent.city||''}`;
    try{
      const rr=await exactWebSearch(rescueQ,intent,[]);
      found=dedupe(rr.results||[]).filter(x=>hardRelevant(x,intent));
      if(rr.providerError) webResult.providerErrors.push(rr.providerError);
    }catch{}
  }
  webResult.results=found;
  let raw=[...(webResult.results||[])];
  if(section==='places' && lat!=null && lon!=null){
    try{ raw.push(...await places(q,lat,lon,intent)); }catch{}
  }
  if(section==='travel' && detected==='flight'){
    try{ raw.push(...await flights(q)); }catch{}
  }
  let filtered=raw.filter(x=>kindEnforcement(x,intent));
  // Vehicle searches with hard constraints must never show unknown/incorrect listings.
  if ((kind==='car'||kind==='motorcycle') && intent.strictConstraints) {
    filtered=filtered.filter(x=>{
      const text=`${x.title||''} ${x.description||''}`;
      if(intent.vehicleModel && !text.toLowerCase().includes(intent.vehicleModel.toLowerCase())) return false;
      if(intent.maxMileage!=null){ const km=x.mileage!=null?Number(x.mileage):extractMileage(text); if(km==null||km>intent.maxMileage)return false; x.mileage=km; }
      if(intent.maxPrice!=null){ const pp=x.price!=null?Number(x.price):priceOf(text,kind); if(pp==null||pp>intent.maxPrice)return false; x.price=pp; }
      return true;
    });
  }
  const ranked=rank(dedupe(filtered),intent);
  const enriched=await enrichResultMetadata(ranked, section==='shopping'?8:8);
  await enrichDistances(enriched,lat,lon);
  let finalResults=rank(enriched,intent);
  if(!finalResults.length){
    try{ const rescue=await exactWebSearch(`"${q}" ${section==='shopping'?'prezzo acquisto annuncio prodotto':'Italia'}`,intent,[]); const rr=await enrichResultMetadata(rank(dedupe(rescue.results||[]),intent),section==='shopping'?4:4); await enrichDistances(rr,lat,lon); finalResults=rank(rr,intent); }catch{}
  }
  return {results:finalResults,kind,aiAnswer:webResult.aiAnswer||null,intent};
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

app.get("/api/diagnostics", async (req, res) => {
  const tk = providerKeys(process.env.TAVILY_API_KEY,"TAVILY_API_KEYS");
  const gk = providerKeys(process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY,"GEMINI_API_KEYS");
  const out = {version:VERSION, vercel:process.env.VERCEL === "1", tavilyConfigured:tk.length>0, geminiConfigured:gk.length>0, tavilyLive:null, duckDuckGoLive:null, geminiLive:null};
  if(tk.length){
    try { const d=await tavilyFetch({query:"test",search_depth:"basic",max_results:1,include_answer:false,include_raw_content:false,topic:"general"},8000,1); out.tavilyLive={ok:true,results:Array.isArray(d.results)?d.results.length:0}; }
    catch(e){ out.tavilyLive={ok:false,error:String(e?.message||e).replace(/tvly-[^\s]+/gi,"[redacted]").slice(0,220)}; }
  }
  try { const d=await fallbackWebSearch('iPhone 16 Pro',{kind:'product',coreTerms:['iPhone 16 Pro'],terms:['iPhone 16 Pro']},[]); out.webFallbackLive={ok:(d.results||[]).length>0,provider:d.provider||d.providerFallback||null,results:(d.results||[]).length,error:d.providerError||null}; } catch(e){ out.webFallbackLive={ok:false,error:String(e?.message||e).slice(0,220)}; }
  if(gk.length){
    try { const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent((process.env.GEMINI_MODEL||"gemini-3.6-flash").trim())+":generateContent?key="+encodeURIComponent(gk[0]),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:"Reply only OK"}]}]})}); const txt=await r.text(); out.geminiLive={ok:r.ok,status:r.status}; if(!r.ok) out.geminiLive.error=txt.slice(0,220).replace(/AIza[0-9A-Za-z_-]+|AQ\.[^\s\"]+/g,"[redacted]"); }
    catch(e){ out.geminiLive={ok:false,error:String(e?.message||e).slice(0,220)}; }
  }
  res.json(out);
});

app.get("/api/health", async (req, res) => res.json({
  ok: true, version: VERSION,
  geminiModels: (process.env.GEMINI_MODELS||process.env.GEMINI_MODEL||"gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash").split(",").map(clean).filter(Boolean),
  providers: {web:providerHealth().tavily.configured,places:!!process.env.GOOGLE_MAPS_API_KEY,flights:!!(process.env.AMADEUS_CLIENT_ID&&process.env.AMADEUS_CLIENT_SECRET),gemini:providerHealth().gemini.configured}, providerHealth:providerHealth()
}));

app.get("/api/search", async (req, res) => {
  const q = clean(req.query.q), lat = req.query.lat, lon = req.query.lon;
  const country = countryFromRequest(req);
  const section = clean(req.query.section).toLowerCase();
  if (!q) return res.status(400).json({error:"Inserisci cosa stai cercando."});
  const detectedKind = detect(q);
  const initialSection = section || ({product:"shopping",car:"shopping",motorcycle:"shopping",restaurant:"places",hotel:"travel",flight:"travel",job:"jobs",realestate:"homes",pharmacy:"services",gas:"services"}[detectedKind] || "shopping");
  const spec = sectionSpec(initialSection);

  // Universal mode: a general query opens on Shopping first, while the user can
  // switch instantly to Experiences, Places, Travel, Services, Jobs or Homes.
  if (spec) {
    const cacheKey = JSON.stringify([q,lat,lon,initialSection,country]);
    const cached=cacheGet(cacheKey);
    if(cached) return res.json({...cached,cached:true});
    try {
      const out=await searchSection(q,initialSection,lat,lon,country);
      const intent=out.intent || parseIntent(q,out.kind||detectedKind,lat,lon);
      intent.section=initialSection;
      intent.country=country;
      const payload={results:out.results||[],aiAnswer:out.aiAnswer||null,intent,section:initialSection,sectionLabel:spec.label,sectionIcon:spec.icon,country,availableSections:Object.entries(SEARCH_SECTIONS).map(([id,v])=>({id,label:v.label,icon:v.icon}))};
      recordPriceHistory(payload.results);
      if(payload.results.length>0) cacheSet(cacheKey,payload);
      if(!payload.results.length){ payload.searchStatus={webConfigured:providerHealth().tavily.configured, message:providerHealth().tavily.configured ? "Nessun risultato dai motori disponibili" : "Motore web non configurato", tavilyLimit:providerHealth().tavily.configured}; }
      return res.json(payload);
    } catch(e) {
      console.error("section search:",section,e);
      return res.status(502).json({error:"La ricerca non è riuscita. Riprova tra qualche secondo."});
    }
  }

  const kind = detectedKind;
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
  recordPriceHistory(results);
  const topUrls = results.slice(0,3).map(r => r.url).filter(u => u && !u.includes('google.com/maps'));
  let extractedData = [];
  if (topUrls.length && (kind==='car'||kind==='motorcycle'||kind==='product'||kind==='realestate')) {
    try {
      const extracts = await tavilyExtract(topUrls);
      for (const ext of extracts) {
        const existing = results.find(r => r.url === ext.url);
        if (existing && ext.content) {
          const ep = priceOf(ext.content, kind); if (ep != null && existing.price == null) existing.price = ep;
          const er = ratingOf(ext.content); if (er != null && existing.rating == null) existing.rating = er;
          const km = ext.content.match(/(\d{1,3}(?:[., ]?\d{3})*)\s*km/i); if (km && existing.mileage == null) existing.mileage = Number(km[1].replace(/[. ]/g,'').replace(',','.'));
          const yr = ext.content.match(/\b(20\d{2})\b/); if (yr && existing.year == null) existing.year = Number(yr[1]);
          const fl = ext.content.match(/\b(diesel|benzina|elettrica|elettrico|gpl|metano|hybrid|ibrida|ibrido)\b/i); if (fl && !existing.fuel) existing.fuel = fl[1].toLowerCase();
          existing.extractedContent = ext.content.slice(0,500);
        }
      }
    } catch {}
  }
  const payload={results:rank(results,intent),aiAnswer:webResult.aiAnswer||null,intent,section:null,availableSections:Object.entries(SEARCH_SECTIONS).map(([id,v])=>({id,label:v.label,icon:v.icon}))};
  cacheSet(cacheKey,payload);
  res.json(payload);
});

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
  const verified = [info.brand, info.model, info.variant].map(clean).filter(Boolean);
  const product = clean(info.product);
  const aiQuery = clean(info.search_query);
  const unique=[];
  for (const p of [...verified, product, aiQuery]) {
    if (!p) continue;
    if (!unique.some(x=>x.toLowerCase()===p.toLowerCase())) unique.push(p);
  }
  // Keep the most reliable identifiers first. The AI-generated query is useful
  // as an additional shopping phrase, not as a replacement for model/brand.
  return unique.join(" ").trim() || clean(fallback) || "prodotto";
}

function strictVisualRelevant(text, info) {
  const t=String(text||"").toLowerCase();
  const terms=[info.brand,info.model,info.product,info.variant].map(clean).filter(x=>x.length>=3).map(x=>x.toLowerCase());
  if (!terms.length) return true;
  const hits=terms.filter(x=>t.includes(x)).length;
  return hits >= Math.min(2, terms.length) || terms.some(x=>x.length>=6 && t.includes(x));
}

async function geminiVision(image, description="") {
  const gkeys=providerKeys(process.env.GEMINI_API_KEY||process.env.GOOGLE_GEMINI_API_KEY,"GEMINI_API_KEYS");
  if(!gkeys.length) return {info:null,error:"GEMINI_API_KEY non configurata"};
  const match=String(image||"").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if(!match) return {info:null,error:"Formato immagine non valido"};
  const models=[...new Set((process.env.GEMINI_MODELS||process.env.GEMINI_MODEL||"gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash").split(",").map(clean).filter(Boolean))];
  // PRO: output intentionally tiny. Large structured schemas can consume the output
  // budget before the JSON is complete and trigger MAX_TOKENS.
  const prompt=`FINDO PRO: identifica ESATTAMENTE l'oggetto nella foto per trovarlo in vendita. Prima leggi ogni dettaglio visibile: logo/marca, scritte, modello, sigle, numeri, EAN/UPC, variante, confezione e forma. Distingui il modello preciso dalla sola famiglia del prodotto. NON inventare e non completare sigle a memoria. Se una parte non è leggibile lasciala vuota. Rispondi SOLO con un singolo JSON valido, senza markdown e senza testo fuori dal JSON. Campi: product, brand, model, variant, barcode, search_query, confidence. Testi come stringhe; confidence 0..1. search_query massimo 8 parole e deve contenere solo gli elementi più affidabili per una ricerca di acquisto. Descrizione utente: ${clean(description)||"nessuna"}`;
  const request=async (model,maxTokens, structured=false)=>{
    const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig={temperature:0,maxOutputTokens:maxTokens};
    if(structured){ generationConfig.responseMimeType="application/json"; generationConfig.responseJsonSchema={type:"object",properties:{product:{type:"string"},brand:{type:"string"},model:{type:"string"},variant:{type:"string"},barcode:{type:"string"},search_query:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}},required:["product","brand","model","variant","barcode","search_query","confidence"],additionalProperties:false}; }
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),20000);
    try{
      let key=null; for(let n=0;n<gkeys.length;n++){const k=gkeys[(providerState.gemini.idx+n)%gkeys.length];if(keyAvailable('gemini',k)){key=k;providerState.gemini.idx=(providerState.gemini.idx+n)%gkeys.length;break;}}
      if(!key) throw new Error('Nessuna chiave Gemini temporaneamente disponibile');
      return await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},signal:controller.signal,body:JSON.stringify({contents:[{parts:[{inline_data:{mime_type:match[1],data:match[2]}},{text:prompt}]}],generationConfig})});
    } finally { clearTimeout(timer); }
  };
  let r;
  try {
    let lastErr=null;
    for(let attempt=0;attempt<6;attempt++){
      const model=models[attempt % models.length];
      try{ r=await request(model,320,true); if(r.ok || ![400,401,403,408,404,429,500,502,503,504].includes(r.status)) break; lastErr=new Error(`Gemini ${r.status}`); if([401,403,404,429,500,502,503,504].includes(r.status)){const key=gkeys[providerState.gemini.idx % gkeys.length];rotateProvider('gemini',gkeys,key,r.status===429?10000:1800);} }
      catch(e){ lastErr=e; rotateProvider('gemini',gkeys,null,1500); }
      await sleep(Math.min(5000,650*2**Math.min(attempt,3)+Math.random()*500));
    }
    if(!r) throw lastErr||new Error("Gemini non disponibile");
  }
  catch(e){ return {info:null,error:e.name==="AbortError"?"Gemini ha impiegato troppo tempo":"Connessione Gemini non riuscita"}; }
  let d=await r.json().catch(()=>null);
  let finish=d?.candidates?.[0]?.finishReason;
  // PRO fallback: if structured generation is truncated, retry with a larger plain-JSON budget.
  if(finish==="MAX_TOKENS" || !r.ok){
    try { r=await request(models[0],900,false); d=await r.json().catch(()=>null); finish=d?.candidates?.[0]?.finishReason; }
    catch(e){ return {info:null,error:e.name==="AbortError"?"Gemini ha impiegato troppo tempo":"Connessione Gemini non riuscita"}; }
  }
  if(!r.ok){
    const msg=d?.error?.message || `Gemini ${r.status}`;
    return {info:null,error:msg.slice(0,220)};
  }
  const parts=d?.candidates?.[0]?.content?.parts||[];
  const text=parts.map(x=>typeof x?.text==="string"?x.text:"").join(" ").trim();
  let info=parseJsonLoose(text);
  if(!info){ for(const x of parts){ if(x?.json&&typeof x.json==="object"){info=x.json;break;} if(x?.structuredOutput&&typeof x.structuredOutput==="object"){info=x.structuredOutput;break;} } }
  if(!info||typeof info!=="object"){
    // Last-resort recovery from a truncated JSON response.
    const pick=(k)=>{ const m=text.match(new RegExp('"'+k+'"\\s*:\\s*"([^"\\n\\r}]*)')); return m?m[1]:""; };
    const recovered={product:pick("product"),brand:pick("brand"),model:pick("model"),variant:pick("variant"),barcode:pick("barcode"),search_query:pick("search_query"),confidence:0};
    if(Object.values(recovered).some(v=>typeof v==="string"&&v.trim())) info=recovered;
  }
  if(!info||typeof info!=="object") return {info:null,raw:text,error:`Risposta Gemini non interpretabile (${finish||"JSON non disponibile"})`};
  for(const k of ["product","brand","model","variant","barcode","search_query"]) info[k]=clean(info[k]);
  info.confidence=Math.max(0,Math.min(1,Number(info.confidence)||0));
  info.category=clean(info.category); info.color=clean(info.color); info.visible_text=clean(info.visible_text);
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

async function parseHtmlSearchResults(html, engine, intent){
  const results=[];
  const push=(href,title,desc='')=>{
    try{ href=decodeURIComponent(String(href||'').replace(/&amp;/g,'&')); }catch{}
    if(href.startsWith('//')) href='https:'+href;
    if(!/^https?:\/\//i.test(href)) return;
    if(/^(https?:\/\/)?(www\.)?(google|bing|duckduckgo|search\.brave)\./i.test(href)) return;
    const cleanTitle=clean(String(title||'').replace(/<[^>]+>/g,' '));
    if(!cleanTitle || cleanTitle.length<3) return;
    const item=normalize({title:compactDescription(cleanTitle,110),description:compactDescription(clean(String(desc||'').replace(/<[^>]+>/g,' ')),260),url:href,source:hostOf(href),provider:engine,kind:intent?.kind||'product',price:priceOf(`${cleanTitle} ${desc}`,intent?.kind),rating:ratingOf(`${cleanTitle} ${desc}`)});
    results.push(item);
  };
  let m;
  // DDG HTML: capture the whole anchor regardless of attribute order.
  const anchors=/<a\b[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  while((m=anchors.exec(html)) && results.length<15){
    const block=m[0]; const hm=block.match(/href=["']([^"']+)["']/i); if(!hm) continue;
    const tail=html.slice(m.index+m[0].length,m.index+m[0].length+1800); push(hm[1],m[1],tail);
  }
  // Generic fallback for engines that change CSS classes: pick external anchors with a useful title.
  if(!results.length){
    const generic=/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while((m=generic.exec(html)) && results.length<15){
      const title=clean(String(m[2]||'').replace(/<[^>]+>/g,' '));
      if(title.length>=8 && title.length<=180) push(m[1],title,html.slice(m.index,m.index+1200));
    }
  }
  return dedupe(results).slice(0,15);
}

async function fetchHtmlSearch(url, engine, intent, timeoutMs=9000){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs);
  try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'it-IT,it;q=0.9,en;q=0.8'},signal:c.signal}); const html=await r.text(); if(!r.ok) throw new Error(`${engine} ${r.status}`); return {results:parseHtmlSearchResults(html,engine,intent)}; }
  catch(e){ return {results:[],providerError:String(e?.message||e).slice(0,220)}; }
  finally{clearTimeout(t)}
}

async function bingRssSearch(query,intent,domains=[]){
  const q=String(query||'').trim(); if(!q) return {results:[],providerError:'Query vuota'};
  const suffix=(domains||[]).slice(0,8).map(d=>`site:${String(d).replace(/^www\./,'').split('/')[0]}`).join(' ');
  const full=(q+' '+suffix).trim();
  const c=new AbortController(),t=setTimeout(()=>c.abort(),9000);
  try{
    const u=`https://www.bing.com/search?format=rss&q=${encodeURIComponent(full)}`;
    const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,application/xml,text/xml,*/*;q=0.8'},signal:c.signal});
    const xml=await r.text(); if(!r.ok) throw new Error(`Bing RSS ${r.status}`);
    const out=[]; const re=/<item>([\s\S]*?)<\/item>/gi; let m;
    while((m=re.exec(xml))&&out.length<15){
      const block=m[1]; const get=(tag)=>{const x=block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`,'i')); return x?x[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim():''};
      const title=get('title'), link=get('link'), desc=get('description');
      if(title&&/^https?:\/\//i.test(link)) out.push(normalize({title:compactDescription(title,110),description:compactDescription(desc,260),url:link,source:hostOf(link),provider:'Bing RSS',kind:intent?.kind||'product',price:priceOf(`${title} ${desc}`,intent?.kind),rating:ratingOf(`${title} ${desc}`)}));
    }
    return {results:dedupe(out),provider:'Bing RSS'};
  }catch(e){return {results:[],providerError:String(e?.message||e).slice(0,220)};}
  finally{clearTimeout(t)}
}

async function braveSearch(query,intent,domains=[]){
  const q=String(query||'').trim(); if(!q) return {results:[],providerError:'Query vuota'};
  const suffix=(domains||[]).slice(0,8).map(d=>`site:${String(d).replace(/^www\./,'').split('/')[0]}`).join(' ');
  const full=(q+' '+suffix).trim();
  const a=await fetchHtmlSearch(`https://search.brave.com/search?q=${encodeURIComponent(full)}`,'Brave Search',intent,9000);
  return a;
}

async function duckDuckGoSearch(query, intent, domains=[]){
  const q=String(query||'').trim(); if(!q) return {results:[],providerError:'Query vuota'};
  const suffix=(domains||[]).slice(0,8).map(d=>`site:${String(d).replace(/^www\./,'').split('/')[0]}`).join(' ');
  const full=(q+' '+suffix).trim();
  const a=await fetchHtmlSearch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(full)}`,'DuckDuckGo',intent,9000);
  if(a.results.length) return a;
  const b=await fetchHtmlSearch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(full)}`,'DuckDuckGo Lite',intent,9000);
  if(b.results.length) return b;
  return {results:[],providerError:[a.providerError,b.providerError].filter(Boolean).join(' | ')||'Nessun risultato DuckDuckGo'};
}

async function fallbackWebSearch(query,intent,domains=[]){
  const providers=[duckDuckGoSearch,bingRssSearch,braveSearch];
  const run=async(ds)=>{
    const settled=await Promise.allSettled(providers.map(fn=>fn(query,intent,ds)));
    const results=dedupe(settled.flatMap(x=>x.status==='fulfilled'?(x.value?.results||[]):[]));
    const errors=settled.flatMap(x=>x.status==='fulfilled'?(x.value?.providerError? [x.value.providerError]:[]):['provider error']).filter(Boolean);
    return {results,provider:results.length?'multi-fallback':null,providerError:errors.slice(0,4).join(' | ')};
  };
  let r=await run(domains);
  if(r.results?.length || !domains?.length) return r;
  const wide=await run([]);
  return wide.results?.length ? wide : {results:[],providerError:[r.providerError,wide.providerError].filter(Boolean).join(' | ')};
}

async function exactWebSearch(query, intent, domains=[]) {
  const isPrecise=String(query||'').includes('"') || domains.length>0;
  const body={query,search_depth:isPrecise?'advanced':'basic',max_results:isPrecise?8:10,include_answer:false,include_raw_content:false,topic:'general'};
  if(domains.length) body.include_domains=domains.slice(0,80);
  if(intent?.country) body.country=String(intent.country).toLowerCase();
  try{
    const d=await tavilyFetch(body,15000,2); const out=[];
    for(const x of (d.results||[])){const txt=`${x.title||''} ${x.content||''}`; out.push(normalize({title:compactDescription(x.title,110),description:compactDescription(x.content,260),url:x.url,source:hostOf(x.url),provider:'Tavily',kind:intent.kind||'product',price:priceOf(txt,intent.kind),rating:ratingOf(txt)}));}
    return {results:dedupe(out),answer:null,provider:'Tavily'};
  }catch(e){
    const tvErr=String(e?.message||'Tavily non disponibile').replace(/tvly-[^\s]+/gi,'[redacted]');
    const fb=await fallbackWebSearch(query,intent,domains);
    return fb.results?.length ? {...fb,providerFallback:'Tavily',tavilyError:tvErr} : {results:[],answer:null,providerError:tvErr+(fb.providerError?` | fallback: ${fb.providerError}`:'')};
  }
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
      if(vr.info) {
        info={...info,...vr.info};
        const vr2=await geminiVision(image,`${description||"nessuna descrizione"}. SECONDA VERIFICA INDIPENDENTE: analizza la foto come un catalogatore. Controlla logo, testo, modello, sigla, capacità/taglia/colore, confezione e forma. Non confondere prodotti della stessa famiglia.`);
        if(vr2.info){ const a=vr.info,b=vr2.info; for(const k of ["product","brand","model","variant","barcode"]){const av=clean(a[k]),bv=clean(b[k]); if(av&&bv&&av.toLowerCase()===bv.toLowerCase()) info[k]=av; else if(bv&&Number(b.confidence||0)>Number(a.confidence||0)+.08) info[k]=bv; else if(av) info[k]=av;} info.search_query=clean(a.search_query)||clean(b.search_query)||info.search_query; info.confidence=Math.max(Number(a.confidence||0),Number(b.confidence||0)); }
      } else visionError=vr.error;
    }
    const barcode=normalizeBarcodeCode(info.barcode||"");
    if(barcode){
      const p=await lookupBarcodeProduct(barcode);
      if(p){ info={...info,product:p.productName||info.product,brand:p.brand||info.brand,category:p.categories||info.category}; }
      const b=await exactWebSearch(`EAN ${barcode} ${visualSearchQuery(info,description)} prezzo Italia dove comprare`,{kind:"product",coreTerms:[barcode,...[info.product,info.brand,info.model].filter(Boolean)],terms:[barcode]},["amazon.it","ebay.it","idealo.it","trovaprezzi.it"]);
      const ranked=rank(b.results,{kind:"product",coreTerms:[barcode,...[info.product,info.brand,info.model].filter(Boolean)],terms:[barcode],cheap:true,sort:"price"});
      const enriched=await enrichResultMetadata(ranked,24);
      return res.json({query:visualSearchQuery(info,description),kind:"product",aiAnswer:`Codice ${barcode}${info.product?` · ${info.product}`:""}`,identified:info,barcode,visionError,total:enriched.length,results:enriched});
    }

    const query=visualSearchQuery(info,description);
    const searchPhrase=clean(info.search_query) || query;
    const core=[info.brand,info.model,info.product,info.variant].map(clean).filter(x=>x.length>=3);
    const strong=[info.brand,info.model,info.variant].map(clean).filter(x=>x.length>=3);
    const intent={kind:detect(query)==="general"?"product":detect(query),coreTerms:strong.length?strong:(core.length?core:[query]),terms:core.length?core:[query],cheap:false,maxPrice:null,near:false,openNow:false,sort:"best"};
    if(!["product","car","motorcycle"].includes(intent.kind)) intent.kind="product";
    const q1=strong.length ? strong.join(" ") : searchPhrase;
    const q2=searchPhrase;
    const q3=[info.product,description].map(clean).filter(Boolean).join(" ");
    const searches=[exactWebSearch(`"${q1}" buy price online`,intent,[]),exactWebSearch(`"${q2}" buy price shop`,intent,[]),exactWebSearch(`${q3} buy online price`,intent,[]),...GLOBAL_SHOPPING_BATCHES.map(dom=>exactWebSearch(`"${q1}" buy price online`,intent,dom))];
    const settled=await Promise.allSettled(searches);
    const all=dedupe(settled.flatMap(x=>x.status==='fulfilled'?(x.value?.results||[]):[]));
    // Only apply strict filtering when it actually produces matches. This prevents
    // a correct listing from being discarded because a marketplace title is abbreviated.
    const strict=all.filter(x=>strictVisualRelevant(`${x.title} ${x.description}`,{...info,model:info.model||info.search_query}));
    const candidates=strict.length ? strict : all;
    if(!candidates.length && description){
      const fb=await exactWebSearch(`${description} prezzo comprare Italia`,intent,[]);
      candidates.push(...(fb.results||[]));
    }
    const ranked=rank(candidates,intent);
    // Extra visual precision: exact model/variant/brand matches rise above generic
    // family/category listings after the normal multi-factor ranking.
    const lower=(x)=>String(x||"").toLowerCase();
    for(const r of ranked){
      const text=lower(`${r.title} ${r.description}`);
      let boost=0;
      if(info.model && text.includes(lower(info.model))) boost+=38;
      else if(info.model && info.model.length>=5) boost-=18;
      if(info.brand && text.includes(lower(info.brand))) boost+=16;
      if(info.variant && text.includes(lower(info.variant))) boost+=14;
      if(info.product && text.includes(lower(info.product))) boost+=10;
      r.score=Math.min(100,(Number(r.score)||0)+boost);
      if(boost>=24 && !r.why.includes("modello identificato")) r.why.unshift("modello identificato");
    }
    ranked.sort((a,b)=>(b.score||0)-(a.score||0));
    const enriched=await enrichResultMetadata(ranked,30);
    const answer=enriched.length
      ? `Ho identificato ${[info.brand,info.model,info.variant,info.product].filter(Boolean).join(" ") || "il prodotto"}. Ho confrontato le offerte e messo in cima quelle più corrispondenti al modello fotografato.`
      : (info.product||info.brand||info.model
        ? `Ho identificato: ${[info.brand,info.model,info.product,info.variant].filter(Boolean).join(" ")}. Non ho trovato ancora un'offerta affidabile: prova una foto più ravvicinata oppure aggiungi marca/modello.`
        : (visionError ? "Non ho identificato il prodotto con sufficiente precisione. Prova una foto più nitida e ravvicinata, oppure aggiungi marca/modello." : "Non riesco a identificare con sufficiente precisione il prodotto."));
    res.json({query,kind:intent.kind,aiAnswer:answer,identified:info,visionError,total:enriched.length,results:enriched});
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
    const queries=[[`"${code}" ${baseName} buy price online`,[]],[`EAN ${code} ${baseName} buy shop worldwide`,[]],...GLOBAL_SHOPPING_BATCHES.map(dom=>[`"${code}" ${baseName} buy price`,dom])];
    if(providerKeys(process.env.TAVILY_API_KEY,'TAVILY_API_KEYS').length){
      const settled=await Promise.all(queries.map(([q,domains])=>exactWebSearch(q,intent,domains)));
      for(const s of settled) results.push(...s.results);
    }
    let ranked=rank(dedupe(results),intent);
    for(const r of ranked){ const txt=`${r.title} ${r.description}`.toLowerCase(); if(txt.includes(code.toLowerCase())) r.score=Math.min(100,(r.score||0)+55); else if(baseName && txt.includes(baseName.toLowerCase())) r.score=Math.min(100,(r.score||0)+18); }
    ranked.sort((a,b)=>(b.score||0)-(a.score||0));
    const enriched=await enrichResultMetadata(ranked,30);
    res.json({ok:true,kind:"product",code,productName:p?.productName||null,brand:p?.brand||null,image:p?.image||null,description:p?.description||null,categories:p?.categories||null,source:p?.source||null,aiAnswer:aiAnswer|| (p?`Prodotto identificato: ${[p.brand,p.productName].filter(Boolean).join(" ")}`:`Codice ${code} identificato, ma non presente nei cataloghi FINDO.`),total:enriched.length,results:enriched.slice(0,40)});
  } catch(e){ console.error("barcode:",e); res.status(500).json({error:"Ricerca barcode non disponibile in questo momento."}); }
});

app.get("/api/config", (req, res) => res.json({
  app:"FINDO", version:VERSION,
  features:["multi-source-search","natural-language-intent","semantic-ranking","geolocation","favorites","history","pwa","mobile-wrapper","dark-mode","categories","filters","detail-view","i18n","mileage-filter","kind-enforcement","vehicle-parsing","tavily-extract","provider-auto-recovery","gemini-model-fallback","ai-answer","price-history","saved-searches","alerts","compare","voice-search","job-search","real-estate","barcode-scanner","visual-search","share"]
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
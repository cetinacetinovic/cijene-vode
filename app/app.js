(function(){
  "use strict";
  const RAW = window.WATER_DATA;
  const DATES = RAW.dates;               // ["2025-05-15", ...] sorted asc
  const CHAINS = RAW.chains;
  const PRODUCTS = RAW.products;         // [chain,name,brand,qty,unit,wtype]
  // Guard against source data errors (e.g. a wholesale case price stored as a per-bottle
  // price). Anything above this is not a plausible single-bottle water price.
  const OUTLIER_CAP = 10; // EUR
  // ...and nothing below this is a real shelf price either: some chains (Konzum
  // above all) park a dead or clearance listing at €0,10–0,20 for weeks, which
  // would otherwise read as a 90% "promotion" and drag every average down.
  const OUTLIER_FLOOR = 0.25; // EUR

  function stripDia(s){
    return (s||"").normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  }

  // ---- water-type fallback classification ----
  // A large slice of products arrive from the source data tagged "nepoznato" even
  // though they're perfectly ordinary water (e.g. "VODA CETINA 7 L") — the source
  // classifier only recognises explicit "gazirana"/flavour wording in the name, so
  // a plain bottle with neither is left unclassified. Recover these client-side:
  // detect carbonation/flavour wording ourselves, and default anything left with
  // neither cue to "negazirana" (still) — the standard assumption for bottled
  // water with no label either way — but only for names that plausibly ARE a
  // water product, so packaging/cosmetics/pet-supply items that merely contain
  // "voda" as a substring (POVODAC, AMBAL, micellar "voda" skincare…) stay
  // excluded. Patterns are matched against a diacritic-stripped, lowercased name:
  // JavaScript's \b is defined over [A-Za-z0-9_], so "Š" is not a word character
  // and a pattern like /\bšlag\b/ never fires on "ŠLAG PJENA VODA". Normalising
  // first keeps the word boundaries meaningful for Croatian text.
  // This has to run before OBS below, because the app is scoped to still/sparkling
  // water only — flavoured ("aromatizirana") and unresolved ("nepoznato") products
  // are dropped at the OBS source so they disappear from every panel at once,
  // instead of relying on each panel to separately apply the type filter.
  const FLAVOR_WORDS = /\b(limun|limet|malin|jagod|guav|kupin|marakuj|mango|brusnic|borovnic|ment|kokos|naranc|narandz|breskv|kivano|kiwano|dunj|krus|ribiz|jabuk|dumbir|bazg|vanilij|lubenic|antiox|detox|kolagen|collagen|immuno|focus|antistres|refresh|optimist|energy|happy|arom|sens|sen\.|tonic|vit)/;
  // things that merely contain the word "voda" but are not drinking water:
  // cosmetics, mouthwash, cologne, whipped cream, drain cleaner, pet supplies
  const NON_WATER_NOISE = /\b(povodac|ambal|odcep|odvod|pistolj|casa|case|micel|micer|termaln|uriage|garnier|violeta|tesori|duopack|slag|toaletn|kolonjsk|zubn|dolcela|oral b|gillette|balea|byphasse|eveline|nivea|ziaja|avene|simple|mixa|ulje|iliada|parf)/;
  const NON_WATER_PHRASES = /(voda za usta|voda\/usta|voda za ispiranje|vodaza|mic\.voda|micel\.voda)/;
  function inferWtype(pIdx){
    const wt = PRODUCTS[pIdx][5];
    if(wt !== 'nepoznato') return wt;
    const name = stripDia(PRODUCTS[pIdx][1] || '');
    if(!/\bvoda\b/.test(name)) return wt;
    if(NON_WATER_NOISE.test(name) || NON_WATER_PHRASES.test(name)) return wt;
    if(/negazir/.test(name)) return 'negazirana';
    if(/\bgazir/.test(name)) return 'gazirana';
    if(FLAVOR_WORDS.test(name)) return 'aromatizirana';
    return 'negazirana';
  }
  const PRODUCT_WTYPE = PRODUCTS.map((p,i)=> inferWtype(i));

  // The flat 10€ OUTLIER_CAP above only catches the most extreme source errors (a
  // whole-case price stored as the per-bottle price, e.g. Metro's Jamnica 1,5 l
  // 12-pack at €438,38). It does nothing for a smaller version of the same error —
  // Metro's Jana 0,5 l at €9,60 or Jana 1 l at €5,10 are equally implausible (real
  // shelf prices for those sizes run €0,75–€1,35) but sit comfortably under 10€.
  // A per-bottle price has to be roughly proportional to how much water THIS
  // SPECIFIC listing covers.
  //
  // The name alone is not reliable for that: a wholesaler like Metro carries
  // several separate listings all named e.g. "1,0L JANA VODA PET" — one per
  // bottle (quantity "1 L") and one for a wholesale case of six (quantity "6 L",
  // the TOTAL for that listing, not one more litre on top). The quantity field is
  // the more trustworthy signal of what THIS listing actually covers, but only
  // when it plausibly denotes a volume (contains "l"/"ml", or the unit column is
  // "L"/"LT") — when it's a bare count against a piece-based unit (e.g. "KOM"),
  // it isn't a volume at all and is ignored in favour of the name-parsed size.
  function roughOutlierCap(name, qty, unit){
    const n = name || '';
    let nameLiters = null;
    const m = n.match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i);
    if(m){ let val = parseFloat(m[1].replace(',','.')); if(/ml/i.test(m[2])) val/=1000; if(val>0 && val<50) nameLiters=val; }
    let totalLiters = nameLiters;
    if(qty){
      const qtyLooksVolume = /\bm?l\b/i.test(qty) || /^lt?$/i.test(unit||'');
      const mm = qtyLooksVolume ? String(qty).match(/(\d*[.,]\d+|\d+)/) : null;
      if(mm){
        let val = parseFloat(mm[1].replace(',','.'));
        if(/\bml\b/i.test(qty)) val/=1000;
        if(val>0 && val<1000 && (totalLiters===null || val>totalLiters)) totalLiters=val;
      }
    }
    if(totalLiters===null) return OUTLIER_CAP;
    return Math.min(OUTLIER_CAP, Math.max(2.5, totalLiters*3.5));
  }
  const PRODUCT_OUTLIER_CAP = PRODUCTS.map(p=> roughOutlierCap(p[1], p[3], p[4]));

  // [dateIdx,prodIdx,avg,min,max,cnt] and, from the day price-tier tracking was added
  // onward, an optional 7th element: [[price,storeCount],...] — the actual distinct
  // prices a chain sold the product at that day (not just the min/max ends), only
  // present when there was more than one. Scoped to still/sparkling water only —
  // see PRODUCT_WTYPE above.
  const OBS = RAW.obs.filter(r=> r[2]>=OUTLIER_FLOOR && r[2]<=PRODUCT_OUTLIER_CAP[r[1]]
    && (PRODUCT_WTYPE[r[1]]==='negazirana' || PRODUCT_WTYPE[r[1]]==='gazirana'));

  // The shelf price, not the arithmetic mean. When a chain sells an article at
  // several prices on the same day, obs[6] lists them as [price, storeCount] and
  // the mean lands on a value no store actually charges — Studena 1,5 l in Plodine
  // is €0,89 in 117 of 155 stores, €0,99 in 36, yet the mean reads €0,91. So take
  // the price the most stores charge (the lower one if two are equally common).
  // With no such list there was only one price that day and the mean is exact.
  const shelfCache = new Map();
  function shelfPrice(row){
    const tiers = row[6];
    if(!tiers || tiers.length < 2) return row[2];
    const key = row[0] + '|' + row[1];
    let v = shelfCache.get(key);
    if(v === undefined){
      let best = tiers[0];
      for(const t of tiers){ if(t[1] > best[1] || (t[1] === best[1] && t[0] < best[0])) best = t; }
      v = best[0];
      shelfCache.set(key, v);
    }
    return v;
  }

  // A chain sometimes carries the SAME article under two listings — Spar has both
  // "VODA STOLNA S-BUDGET 7 L" (€1,75 in 143 stores) and "STOLNA VODA S-BUDGET 7 L"
  // (€1,48 in one store). Averaging them produced €1,62, a price nobody pays. So a
  // chain's price for an article is the price the most stores actually charge:
  // every listing's store-level breakdown is pooled and the busiest price wins.
  function chainShelfPrice(rows){
    if(!rows || rows.length===0) return null;
    rows = preferPromoPacks(rows);
    const byPrice = new Map();
    rows.forEach(r=>{
      const tiers = (r.breakdown && r.breakdown.length>1) ? r.breakdown : [[r.price, r.storeCount || 1]];
      tiers.forEach(t=>{ const p=t[0], c=t[1]||1; byPrice.set(p, (byPrice.get(p)||0)+c); });
    });
    let best=null, bestN=-1;
    byPrice.forEach((n,price)=>{ if(n>bestN || (n===bestN && price<best)){ best=price; bestN=n; } });
    return best;
  }

  // Chains keep a "4+2 gratis" / "5+1" promo 6-pack on the shelf as its own SKU
  // right next to the plain 6-pack, and it is the one a shopper actually buys -
  // Metro: Cetina Dinara 6x1,5 l €4,05 vs "4+2 GRATIS" €3,16. For 4/6 packs the
  // promo pack's price wins whenever the chain has one, even if the plain SKU is
  // listed in more stores.
  const PROMO_PACK_RE = /\d\s*\+\s*\d|gratis|\bpromo\b|super\s*ponud/;
  function isPromoPack(name){ return PROMO_PACK_RE.test(stripDia(name||'').toLowerCase()); }
  function preferPromoPacks(rows){
    if(!rows.every(r=> r.volKey==='pack4' || r.volKey==='pack6')) return rows;
    const promo = rows.filter(r=> isPromoPack(r.name));
    return promo.length ? promo : rows;
  }

  const CHAIN_LABELS = {
    konzum:"Konzum", lidl:"Lidl", spar:"Spar", studenac:"Studenac", plodine:"Plodine",
    eurospin:"Eurospin", tommy:"Tommy", kaufland:"Kaufland", dm:"dm", ktc:"KTC",
    metro:"Metro", trgocentar:"Trgocentar", zabac:"Žabac", vrutak:"Vrutak", ribola:"Ribola",
    ntl:"NTL", boso:"Boso", branka:"Branka", bure:"Bure", djelo_vodice:"Đelo Vodice",
    gavranovic:"Gavranović", jadranka_trgovina:"Jadranka", roto:"Roto", stanic:"Stanić",
    stridon:"Stridon", "trgovina-krk":"Trgovina Krk", dukat:"Dukat"
  };
  function chainLabel(c){ return CHAIN_LABELS[c] || (c.charAt(0).toUpperCase()+c.slice(1)); }

  // National chains present with broadly comparable ranges in most stores, so prices
  // are genuinely apples-to-apples across them. Smaller regional chains report far
  // fewer, patchier products, which makes cross-chain comparison noisy — so the main
  // table defaults to just this set, with an option to widen to all chains.
  // Chains whose data feed has gone dead: Brodokomerc last reported on 2026-04-09,
  // so everything it carries is months old and would misrepresent the market.
  const EXCLUDED_CHAINS = new Set(['brodokomerc']);
  const CHAINS_LIVE = CHAINS.filter(c=>!EXCLUDED_CHAINS.has(c));

  const MAJOR_CHAINS = ['kaufland','spar','lidl','plodine','tommy','konzum','metro'];
  const MAJOR_CHAINS_SET = new Set(MAJOR_CHAINS.filter(c=>CHAINS.includes(c)));

  const TYPE_LABELS = { negazirana:"Negazirana", gazirana:"Gazirana", aromatizirana:"Aromatizirana", nepoznato:"Ostalo" };
  const SERIES_COLORS = ['--series-1','--series-2','--series-3','--series-4','--series-5','--series-6','--series-7','--series-8'];
  function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---- volume (pack size) categorisation ----
  // Source "quantity"/"unit" columns are inconsistent across chains (337 distinct raw
  // strings, mixed decimal separators, sometimes just "kom" with no size at all) and
  // sometimes describe the whole multi-pack rather than one bottle. The product NAME is
  // the most reliable place retailers put the actual bottle size, so try that first.
  function parseVolumeLiters(name, qty, unit){
    const m = (name||'').match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i);
    if(m){
      let val = parseFloat(m[1].replace(',','.'));
      if(/ml/i.test(m[2])) val/=1000;
      if(val>0 && val<50) return val;
    }
    // Lidl puts the whole pack spec ("4x1,5l") in the UNIT column instead of the
    // name, leaving the name bare ("Studenac Gazirana mineralna voda") — pull the
    // per-bottle size out of that pattern before falling back to qty, which for
    // these rows holds the PACK TOTAL (qty=6 for a 4x1,5l case), not one bottle.
    const um = (unit||'').match(/\d+\s*[xX*×]\s*(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i);
    if(um){
      let val = parseFloat(um[1].replace(',','.'));
      if(/ml/i.test(um[2])) val/=1000;
      if(val>0 && val<50) return val;
    }
    if(qty){
      const mm = String(qty).match(/(\d*[.,]\d+|\d+)/); // also handles bare-decimal qty like ",33" or ".5" (= 0,33 / 0,5)
      if(mm){
        let val = parseFloat(mm[1].replace(',','.'));
        if(/ml/i.test(unit||'')) val/=1000;
        if(val>0 && val<50) return val;
      }
    }
    return null;
  }
  const VOLUME_BUCKETS = [
    {key:'s033', label:'do 0,33 l', max:0.35},
    {key:'s05',  label:'0,5 l',     max:0.6},
    {key:'s075', label:'0,75 l',    max:0.85},
    {key:'s1',   label:'1 l',       max:1.15},
    {key:'s15',  label:'1,5 l',     max:1.75},
    {key:'s2',   label:'2 l',       max:3},
    // the large 5, 6 and 7 l packs are one product family bought for the same
    // reason, so they share a bucket rather than being split into three near-empty
    // ones ("5 l" / "6 l" / "7 l")
    {key:'balon', label:'Velika pakiranja (5-7 l)', max:7},
    // "galon" — standalone 15/18,9 l water-cooler dispenser bottles (e.g. Cetina,
    // Aquaviva) are a bigger, different product still — split out from the 5-7 l packs.
    {key:'galon', label:'Galon', max:Infinity},
  ];
  // pure per-bottle size bucket, ignoring whether it's sold as a multi-bottle pack —
  // used both for the size-only lookup below and for the "N× 1,5 l" pack row label.
  function sizeBucketKey(liters){
    if(liters==null) return 'unknown';
    for(const b of VOLUME_BUCKETS){ if(liters<=b.max) return b.key; }
    return 'unknown';
  }

  // ---- multi-bottle pack detection ----
  // Many "1,5 l" (etc.) rows are actually a whole multi-bottle pack — "4+2 GRATIS
  // 6x1,5L", "Jamnica 4x1,5L", "12/1" — and the recorded price is for the WHOLE
  // pack, not one bottle. The name regex above happily extracts the per-bottle
  // size from these (e.g. 1.5), which used to dump a 6-bottle-pack price into the
  // plain "1,5 l" bucket right next to genuine single-bottle prices — wildly
  // inflating that bucket's price tiles/comparisons. Detect the pack multiplier
  // from the name and route these into their own "Pakiranje" bucket instead.
  // Lidl files the pack spec in the unit column instead of the name (unit
  // "4x1,5l" against a bare name) — check both.
  function parsePackMultiplier(name, unit, qty){
    const n = (name || '') + ' ' + (unit || '');
    let m = n.match(/(\d+)\s*[xX*×]\s*\d+(?:[.,]\d+)?\s*(?:ml|l)\b/i);   // "4x1,5L", "6X1,5L", "4*1,5 l"
    if(m){ const k=parseInt(m[1],10); if(k>1) return k; }
    m = n.match(/(\d+)\s*\+\s*(\d+)/);
    if(m){ const k=parseInt(m[1],10)+parseInt(m[2],10); if(k>1) return k; }
    m = n.match(/(\d+)\s*\/\s*1\b/);
    if(m){ const k=parseInt(m[1],10); if(k>1) return k; }
    m = n.match(/(\d+)\s*-?\s*pack?\b/i);                // "4PACK", "6 PACK", "4-pack", Spar's "4pac"
    if(m){ const k=parseInt(m[1],10); if(k>1) return k; }
    if(/duopack/i.test(n)) return 2;
    // Metro's case listings carry no multiplier text anywhere — same bare name
    // as the single bottle ("1,5L CETINA DINARA GAZ. VODA"), with only the
    // quantity column revealing it's really a 6-pack (qty "9 L" = 6× 1,5 l).
    // Infer the count from how many times the per-bottle size divides into qty,
    // but only when qty plausibly denotes a volume at all (contains "l"/"ml", or
    // the unit column is "L"/"LT") — otherwise it's a piece count or something
    // else unrelated and dividing by it would be a coincidence, not a signal.
    const nameLiters = (name||'').match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i);
    const qtyLooksVolume = qty && (/\bm?l\b/i.test(qty) || /^lt?$/i.test(unit||''));
    if(nameLiters && qtyLooksVolume){
      let perBottle = parseFloat(nameLiters[1].replace(',','.'));
      if(/ml/i.test(nameLiters[2])) perBottle/=1000;
      const qm = String(qty).match(/(\d*[.,]\d+|\d+)/);
      if(perBottle>0 && qm){
        let qtyVal = parseFloat(qm[1].replace(',','.'));
        if(/\bml\b/i.test(qty)) qtyVal/=1000;
        const ratio = qtyVal/perBottle, rounded = Math.round(ratio);
        if(rounded>1 && Math.abs(ratio-rounded)<0.05) return rounded;
      }
    }
    return 1;
  }
  const PRODUCT_PACK_MULT = PRODUCTS.map(p=> parsePackMultiplier(p[1], p[4], p[3]));

  // The two multipacks people actually shop for are the 4× and 6× cases of 1,5 l
  // bottles, so they get their own sizes. Every other multipack (12×0,5 l cases,
  // 24×0,33 l wholesale trays…) stays under the general "Pakiranje".
  function volumeBucketKey(liters, packMult){
    if(packMult>1){
      if(sizeBucketKey(liters)==='s15'){
        if(packMult===4) return 'pack4';
        if(packMult===6) return 'pack6';
      }
      return 'pack';
    }
    return sizeBucketKey(liters);
  }
  const PACK_LABELS = { pack4:'4 pack', pack6:'6 pack', pack:'Pakiranje' };
  function volumeBucketLabel(key){
    if(key==='unknown') return 'Nepoznato';
    if(PACK_LABELS[key]) return PACK_LABELS[key];
    const b = VOLUME_BUCKETS.find(x=>x.key===key);
    return b ? b.label : 'Nepoznato';
  }
  // per-row "Veličina" cell: for a pack, show "6× 1,5 l" (multiplier + bottle size)
  // instead of the generic bucket label, so the table stays specific.
  function volumeCellLabel(pIdx, volKey, volLiters){
    if(PACK_LABELS[volKey]){
      const mult = PRODUCT_PACK_MULT[pIdx];
      const sizeLabel = volLiters!=null ? volumeBucketLabel(sizeBucketKey(volLiters)) : null;
      return sizeLabel ? `${mult}× ${sizeLabel}` : 'Pakiranje';
    }
    return volumeBucketLabel(volKey);
  }
  const PRODUCT_VOLUME_L = PRODUCTS.map(p=> parseVolumeLiters(p[1], p[3], p[4]));
  const PRODUCT_VOLUME_KEY = PRODUCT_VOLUME_L.map((v,i)=> volumeBucketKey(v, PRODUCT_PACK_MULT[i]));

  // ---- brand canonicalisation (raw supplier names -> one brand) ----
  // Raw brand strings are inconsistent (the same brand shows up as "Jamnica",
  // "JAMNICA PLUS D.O.O.", "JAMNICA-BAP"...). Normalise once per product so both
  // the brand matrix and the brand-compare picker below agree on one identity.
  const NOISE_WORDS = new Set(['D.O.O','D.O.O.','DOO','D.D','D.D.','J.D.O.O','J.D.O.O.','PLUS','TRADE',
    'INTERNATIONAL','ZAGREB','GRUPA','GROUP','COMPANY','CO','LTD','TVORNICA','TRGOVINA']);
  const brandCache = new Map();
  function stripDiaUpper(s){
    return (s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  }
  function canonicalBrand(raw){
    if(!raw) return '(nepoznata marka)';
    if(brandCache.has(raw)) return brandCache.get(raw);
    let s = stripDiaUpper(raw);
    // take the segment before a comma or hyphen first (handles "JAMNICA-BAP",
    // "X, ZAGREB") — but only when that leading segment is a name in its own right,
    // otherwise hyphenated private labels lose everything ("S-Budget" became "S",
    // "K-Classic" became "K")
    const cut = s.split(/[,\-]/)[0].trim();
    if(cut.length >= 3) s = cut;
    // then drop trailing corporate-noise tokens word by word
    let tokens = s.split(/\s+/).filter(Boolean);
    while(tokens.length>1 && NOISE_WORDS.has(tokens[tokens.length-1].replace(/\.$/,''))){
      tokens.pop();
    }
    let out = tokens.join(' ').trim() || s || raw.toUpperCase();
    if(!/[A-Z]/.test(out)) out = '(nepoznata marka)';   // a bare "-" is not a brand
    brandCache.set(raw, out);
    return out;
  }
  // ---- brand hygiene: merge variants, drop distributor names ----
  // Two things fragment the brand column badly enough to distort every brand-level
  // number on the page. First, the same brand arrives under several spellings and
  // sub-line names ("MG Mivela" vs "Mivela", "Jana vitamin" vs "Jana"). Second, many
  // rows carry the DISTRIBUTOR rather than the brand ("AWT", "Atlantic", "Naturalis",
  // "Podravka", plain "Coca Cola"), which hides the actual water brand — those are
  // treated as unknown so the name-based recovery below can find the real one.
  const BRAND_ALIASES = {
    'JANA AROMATIZIRANA':'JANA', 'JANA PRIRODNA VODA':'JANA', 'JANA VITAMIN':'JANA', 'JANA IZVORSKA VODA':'JANA',
    'MG MIVELA':'MIVELA', 'DONAT MG':'DONAT',
    'SAR KISELJAK':'SARAJEVSKI KISELJAK', 'SARAJEVSKI':'SARAJEVSKI KISELJAK', 'KISELJAK':'SARAJEVSKI KISELJAK',
    'ROEMERQUELLE':'ROMERQUELLE', 'SANPELLEGRINO':'SAN PELLEGRINO', 'SMART':'SMARTWATER',
    'JAMNICA SENSATION':'SENSATION', 'CEDEVITA OTG':'CEDEVITA', 'AWT JUICY':'JUICY',
    'CETINA DINARA':'CETINA', 'DINARA':'CETINA',
    'JAMINCA':'JAMNICA', 'SARA RIVA':'SARA', 'RIVA':'SARA', 'LIPICKI STUDENAC':'STUDENAC',
    'KALNICKA VODA':'KALNICKA', 'KALNICKE VODE':'KALNICKA',
    'SV ROK':'SVETI ROK', 'SV.ROK':'SVETI ROK', 'SVETI':'SVETI ROK',
    'S-BUDGET':'S BUDGET', 'K-CLASSIC':'K CLASSIC'
  };
  const DISTRIBUTOR_BRANDS = new Set(['AWT','ATLANTIC','NATURALIS','SKLADISTE 801','PODRAVKA','COCA COLA','COCA',
    'COCA COLA HBC HRVATSKA','K','S','STUDENA ILI STUDENAC','KALA ILI KALNICKA','JAMNICA PLUS','ZLATOKLAS','DIONIS',
    'IZVORI KALNIKA','KALNIK','NARDUM','FIDELIUS DISTRIBUCIJA',
    'PET TREATMENT','PET COMFORT','EDCO','LIFETIME','TOLLE']);
  const UNKNOWN_BRAND = '(nepoznata marka)';
  // No longer produced. Remaining stock still turns up in the source data, but the
  // page filters these out everywhere — tables, charts, brand matrix, promotions
  // and the brand picker — so they don't clutter a view of the live market.
  // Display-only names. The brand key stays as it is everywhere in the logic; this
  // just shows Leda together with its producer, which is how it is recognised.
  const BRAND_LABELS = { 'LEDA': 'LEDA (NARDUM)', 'K CLASSIC': 'K CLASSIC (KAUFLAND)', 'SAGUARO': 'SAGUARO (LIDL)', 'NO BRAND': 'NO BRAND (EUROSPIN)',
    'S BUDGET': 'S-BUDGET (SPAR)', 'DESPAR': 'DESPAR (SPAR)', 'SPAR QUALITATSMARKE': 'SPAR',
    'BLUES': 'BLUES (EUROSPIN)', 'GINEVRA': 'GINEVRA (EUROSPIN)', 'VODA RM': 'PLODINE' };
  function brandLabel(b){ return BRAND_LABELS[b] || b; }
  const DISCONTINUED_BRANDS = new Set(['KALA','KALNICKA']);
  // Brand/chain pairs that have been delisted: the chain no longer carries the
  // brand at all, so its last recorded prices are stale and would otherwise keep
  // showing up as that chain's current price. Keyed `BRAND|chain`.
  const DELISTED = new Set(['CETINA|konzum','LEDA|studenac']);
  // Specific brand+size articles no longer produced (unlike DISCONTINUED_BRANDS,
  // this drops just one size — Studena still makes every other bottle size, only
  // the 5 l ("balon" bucket) is gone). Keyed `BRAND|volumeKey`.
  const DISCONTINUED_ARTICLES = new Set(['STUDENA|balon']);
  function refineBrand(b){
    b = b.replace(/^BEZALKOHOLNA PICA\s+/,'').trim();      // category prefix, not part of the name
    if(BRAND_ALIASES[b]) b = BRAND_ALIASES[b];
    if(DISTRIBUTOR_BRANDS.has(b)) return UNKNOWN_BRAND;
    return b;
  }
  const PRODUCT_BRAND = PRODUCTS.map(p=> refineBrand(canonicalBrand(p[2])));

  // ---- recover missing brands from the product name ----
  // Several chains (Spar most of all) leave the supplier/brand column empty, which
  // lumped hundreds of listings under "(nepoznata marka)" — enough to sit near the
  // top of the brand and promo tables and drown out real brands. Build a vocabulary
  // from the brands that ARE filled in elsewhere, then look for those names inside
  // the unattributed product names. Longest name wins, so "Sarajevski kiseljak" is
  // not mistaken for "Sara", and matching is on word boundaries so "Kala" does not
  // match inside a longer word.
  (function recoverBrandsFromNames(){
    const counts = new Map();
    PRODUCT_BRAND.forEach(b=>{ if(b!==UNKNOWN_BRAND) counts.set(b, (counts.get(b)||0)+1); });
    const vocab = Array.from(new Set([
        ...Array.from(counts.entries())
          .filter(([b,n])=> n>=3 && b.length>=3)   // only well-attested, non-trivial names
          .map(([b])=>b),
        ...Object.keys(BRAND_ALIASES)              // alternative spellings of the same brands
      ]))
      .sort((a,b)=> b.length-a.length)
      // a digit may follow the name directly ("MIVELA1,5 l"), a letter may not
      .map(b=>({ brand:b, re:new RegExp('(^|[^A-Z0-9])'+b.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=[^A-Z]|$)') }));
    // Some chains fill the brand column with the PRODUCER rather than the brand —
    // Studenac lists Sara, Jana and Mivela all as "Jamnica" (their maker). For those
    // umbrella names the product name is the better witness, so when it leads with
    // a different known brand, that wins.
    const UMBRELLA_BRANDS = new Set(['JAMNICA']);
    function brandFromName(name){
      let best = null;
      vocab.forEach(v=>{
        const m = v.re.exec(name);
        if(!m) return;
        const pos = m.index + m[1].length;      // where the brand itself starts
        if(best===null || pos < best.pos || (pos===best.pos && v.brand.length>best.brand.length)) best = {brand:v.brand, pos};
      });
      return best ? refineBrand(best.brand) : null;
    }
    PRODUCTS.forEach((p,i)=>{
      const cur = PRODUCT_BRAND[i];
      if(cur!==UNKNOWN_BRAND && !UMBRELLA_BRANDS.has(cur)) return;
      const fromName = brandFromName(stripDiaUpper(p[1]));
      if(!fromName) return;
      if(cur===UNKNOWN_BRAND || fromName!==cur) PRODUCT_BRAND[i] = fromName;
    });
  })();

  // Cetina Dinara (their sparkling/gazirana spring, naturally carbonated) is a
  // genuinely different product from plain Cetina still water, sold at a
  // different price — but some chains file it under the plain "Cetina" brand
  // field with "Dinara" only appearing in the product name. Left alone, both
  // would share one "CETINA" row in the brand+size groupings (Focus Matrix,
  // brand matrix) and whichever pooled to the top would hide the other's real
  // price. Split it into its own brand identity by name, after every other
  // brand-resolution step above.
  // Metro abbreviates it ("1,5L CETI.DINA.VODA 4+2 GRATIS") but files "DINARA" in
  // the brand column, so check that too.
  PRODUCTS.forEach((p,i)=>{
    if(PRODUCT_BRAND[i]==='CETINA' &&
       (/dinara|\bdina\./i.test(stripDia(p[1])) || /dinara/i.test(stripDia(p[2]||'')))) PRODUCT_BRAND[i] = 'CETINA DINARA';
  });

  // ---- indices by product ----
  const obsByProduct = new Map(); // prodIdx -> [obs rows]
  OBS.forEach(row=>{
    const p = row[1];
    if(!obsByProduct.has(p)) obsByProduct.set(p, []);
    obsByProduct.get(p).push(row);
  });
  obsByProduct.forEach(list=> list.sort((a,b)=>a[0]-b[0]));

  // ---- duplicate ("shadow") listings ----
  // A chain sometimes files the same article twice: the same product re-entered
  // as a second SKU, often under noticeably different wording for the same real
  // bottle — Kaufland has "Cetina izvorska voda neg. 7l" (1 store, €1,72) beside
  // "Cetina Voda prirod.izvor.negazirana 7L" (44+ stores, €1,85); Spar has
  // "STOLNA VODA S-BUDGET 7 L" (1 store, €1,48) beside "VODA STOLNA S-BUDGET 7 L"
  // (143 stores, €1,75). Grouping by exact normalised name missed the Cetina case
  // (different words for the same bottle: "izvorska" vs "izvor.", "neg." vs
  // "negazirana") and let the 1-store fluke keep showing as "the" current price
  // once the real listing's chain stopped reporting more recently than the twin.
  // Brand + chain + size bucket is a far more reliable "same real article" signal
  // than the words in the name, so group on that instead (falling back to the
  // name only when the size itself could not be parsed). The marginal twin is
  // then dropped from the whole app: at least ten times fewer stores than the
  // dominant listing (or two stores or fewer). A genuinely small listing with no
  // bigger twin, and two sizeable listings of the same brand+size, both stay —
  // this only prunes the clear stray, never two real, comparably-stocked SKUs.
  function listingKey(name){
    let s = stripDia(name || '').toLowerCase();
    s = s.replace(/(\d),(\d)/g, '$1.$2');          // 1,5 -> 1.5
    s = s.replace(/(\d)\s*(l|ml|kom)\b/g, '$1 $2'); // 1.5l -> 1.5 l
    return s.split(/[^a-z0-9.]+/)
      .map(t=> t.replace(/^\.+|\.+$/g,'').replace(/^0+(\d)/,'$1'))
      .filter(Boolean).sort().join(' ');
  }
  const SHADOW_LISTINGS = (function(){
    const groups = new Map();   // chain|brand|volume (or chain|name-key when volume is unknown) -> [{pi, stores}]
    for(let pi=0; pi<PRODUCTS.length; pi++){
      const list = obsByProduct.get(pi);
      if(!list || list.length===0) continue;
      const last = list[list.length-1];
      const volKey = PRODUCT_VOLUME_KEY[pi];
      const sameArticle = volKey==='unknown' ? listingKey(PRODUCTS[pi][1]) : (PRODUCT_BRAND[pi] + '|' + volKey);
      // a 4+2 / 5+1 promo pack is its own SKU, never a stray twin of the plain pack
      const key = PRODUCTS[pi][0] + '|' + sameArticle + (isPromoPack(PRODUCTS[pi][1]) ? '|promo' : '');
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ pi, stores: last[5] || 0 });
    }
    const out = new Set();
    groups.forEach(list=>{
      if(list.length < 2) return;
      const top = list.reduce((a,b)=> b.stores > a.stores ? b : a);
      const cut = Math.max(2, top.stores * 0.10);
      list.forEach(x=>{ if(x !== top && x.stores < top.stores && x.stores <= cut) out.add(x.pi); });
    });
    return out;
  })();

  // ---- promotions ("akcije") ----
  // The source marks a promotion itself: `special_price` is filled only while an
  // article is on offer, and `anchor_price` carries the regular price it is cut
  // from. The export passes that through as obs[7] = number of stores running the
  // promotion and obs[8] = that regular price. This is the retailers' own flag,
  // not a guess from the price curve.
  //
  // Two chains abuse the field — KTC and Eurospin flag ~99% of their range — so a
  // chain whose flag fires on more than this share of its product-days is treated
  // as having no usable promotion data at all rather than showing as permanently
  // on sale.
  const PROMO_FLAG_MAX_SHARE = 0.40;
  function medianOf(arr){
    const s = arr.slice().sort((a,b)=>a-b), n = s.length;
    if(n===0) return 0;
    return n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2;
  }
  const CHAIN_PROMO_UNRELIABLE = new Set();
  (function gradeChainPromoFlags(){
    const tally = new Map(); // chain -> [flagged, total]
    OBS.forEach(r=>{
      const chain = PRODUCTS[r[1]][0];
      let t = tally.get(chain);
      if(!t){ t = [0,0]; tally.set(chain, t); }
      t[1]++;
      if(r[7] > 0) t[0]++;
    });
    tally.forEach(([flagged, total], chain)=>{
      if(total >= 50 && flagged/total > PROMO_FLAG_MAX_SHARE) CHAIN_PROMO_UNRELIABLE.add(chain);
    });
  })();
  // ...and the same trap exists per article: a few listings (Metro and Konzum have
  // some) carry the flag permanently, which is a standing price position rather
  // than a promotion. If an article is flagged on more than half of the weeks it
  // was seen, its flag is ignored too.
  const PROMO_UNRELIABLE_PI = new Set();
  obsByProduct.forEach((list, pi)=>{
    let flagged = 0;
    for(const r of list){ if(r[7] > 0) flagged++; }
    if(flagged > 0 && flagged / list.length > 0.5) PROMO_UNRELIABLE_PI.add(pi);
  });
  function obsOnPromo(row){
    return row[7] > 0
      && !PROMO_UNRELIABLE_PI.has(row[1])
      && !CHAIN_PROMO_UNRELIABLE.has(PRODUCTS[row[1]][0]);
  }
  // discount against the regular price, when the source gave a usable one
  function obsPromoDepth(row){
    const anchor = row[8] || 0;
    const p = shelfPrice(row);
    return (anchor > p) ? (anchor - p) / anchor : null;
  }

  const PROMO_EVENTS = [];              // {pi, chain, brand, from, to, weeks, depth}
  const PROMO_WEEKS_BY_PI = new Map();  // pi -> Set(dateIdx) of weeks spent on promo
  const PROMO_RUN_AT = new Map();       // `${pi}|${dateIdx}` -> which week of the run this is
  obsByProduct.forEach((list, pi)=>{
    let i = 0;
    while(i < list.length){
      if(!obsOnPromo(list[i])){ i++; continue; }
      let j = i, maxDepth = 0;
      if(!PROMO_WEEKS_BY_PI.has(pi)) PROMO_WEEKS_BY_PI.set(pi, new Set());
      const wset = PROMO_WEEKS_BY_PI.get(pi);
      while(j < list.length && obsOnPromo(list[j])
            && (j === i || list[j][0] - list[j-1][0] <= 1)){
        const d = obsPromoDepth(list[j]);
        if(d !== null && d > maxDepth) maxDepth = d;
        wset.add(list[j][0]);
        PROMO_RUN_AT.set(pi + '|' + list[j][0], j - i + 1);
        j++;
      }
      PROMO_EVENTS.push({ pi, chain:PRODUCTS[pi][0], brand:PRODUCT_BRAND[pi],
        from:list[i][0], to:list[j-1][0], weeks:j-i, depth:maxDepth });
      i = j;
    }
  });

  // ---- number/date formatting ----
  // 1 lanac · 2 lanca · 5 lanaca — Croatian plurals, used by the panels that count things
  function pluralHr(n, one, few, many){
    const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
    if(a===1 && b!==11) return one;
    if(a>=2 && a<=4 && !(b>=12 && b<=14)) return few;
    return many;
  }
  const fmtEUR = (v)=> '€' + v.toLocaleString('hr-HR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fmtDate = (iso)=>{
    const d = new Date(iso+'T00:00:00');
    return d.toLocaleDateString('hr-HR', {day:'2-digit', month:'short', year: 'numeric'});
  };
  const fmtDateShort = (iso)=>{
    const d = new Date(iso+'T00:00:00');
    return d.toLocaleDateString('hr-HR', {day:'2-digit', month:'short'});
  };

  // ---- state ----
  // chains/volumes: sets, same "narrow to just these" pattern as brands/types below.
  // chains defaults to the six major national chains (the old '__major__' default);
  // date: the reference range the whole page is shown "as of".
  const state = { q:"", chains: new Set(MAJOR_CHAINS_SET), volumes: new Set(), dateFrom: DATES[0], dateTo: DATES[DATES.length-1], types:new Set(["negazirana","gazirana"]), brands:new Set(), tab:"brands",
    promoMetric:"count", promoBrand:null, page:0, sortKey:"name", sortDir:1, pageSize:50,
    tierBrand:"", tierVol:"",
    promoFilterBrand:"", promoFilterVol:"",
    popularBrand:"", popularChain:"", focusMode:"all",
    growthBrand:"", growthVol:"", growthHold:3, growthMetric:"pct", growthScope:"changed",
    growthFrom: DATES[0], growthTo: DATES[DATES.length-1] };
  let CUR_DATE_FROM_IDX = 0;
  let CUR_DATE_IDX = DATES.length-1; // "to" bound

  function setsEqual(a,b){
    if(a.size!==b.size) return false;
    for(const x of a) if(!b.has(x)) return false;
    return true;
  }

  // ---- build filter UI ----
  // ---- chain (store) multi-select — pick several to compare side by side ----
  const chainChipsEl = document.getElementById('chainChips');
  const ALL_CHAINS_SORTED = CHAINS_LIVE.slice().sort((a,b)=>chainLabel(a).localeCompare(chainLabel(b),'hr'));
  function renderChainChips(){
    chainChipsEl.innerHTML = ALL_CHAINS_SORTED.map(c=>
      `<button type="button" class="chip" aria-pressed="${state.chains.has(c)?'true':'false'}" data-chain="${escapeHtml(c)}">${escapeHtml(chainLabel(c))}</button>`
    ).join('');
    chainChipsEl.querySelectorAll('.chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const c = btn.dataset.chain;
        if(state.chains.has(c)) state.chains.delete(c); else state.chains.add(c);
        state.page=0; renderChainChips(); render();
      });
    });
  }
  document.getElementById('chainPresetMajor').addEventListener('click', ()=>{
    state.chains = new Set(MAJOR_CHAINS_SET);
    state.page=0; renderChainChips(); render();
  });
  document.getElementById('chainPresetAll').addEventListener('click', ()=>{
    state.chains = new Set(CHAINS_LIVE);
    state.page=0; renderChainChips(); render();
  });
  renderChainChips();

  // ---- volume (pack size) multi-select ----
  // the size filter appears twice — once pinned at the top of the page and once in
  // the filter panel below — and both are drawn from the same state, so toggling
  // either keeps them identical
  const volumeChipTargets = ['volumeChips','volumeChipsTop']
    .map(id=>document.getElementById(id)).filter(Boolean);
  const volumeClearTop = document.getElementById('volumeClearTop');
  const VOLUME_CHIP_DEFS = VOLUME_BUCKETS.concat([
    {key:'pack4', label:'4 pack'}, {key:'pack6', label:'6 pack'},
    {key:'pack', label:'Pakiranje'}, {key:'unknown', label:'Nepoznato'}]);
  function renderVolumeChips(){
    const html = VOLUME_CHIP_DEFS.map(b=>
      `<button type="button" class="chip" aria-pressed="${state.volumes.has(b.key)?'true':'false'}" data-vol="${escapeHtml(b.key)}">${escapeHtml(b.label)}</button>`
    ).join('');
    volumeChipTargets.forEach(el=>{
      el.innerHTML = html;
      el.querySelectorAll('.chip').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const v = btn.dataset.vol;
          if(state.volumes.has(v)) state.volumes.delete(v); else state.volumes.add(v);
          state.page=0; renderVolumeChips(); render();
        });
      });
    });
    // nothing selected means "all sizes", so the reset only earns its place once
    // something is actually filtered
    if(volumeClearTop) volumeClearTop.hidden = state.volumes.size===0;
  }
  if(volumeClearTop){
    volumeClearTop.addEventListener('click', ()=>{
      state.volumes.clear(); state.page=0; renderVolumeChips(); render();
    });
  }
  renderVolumeChips();

  const dateFromSelect = document.getElementById('dateFromSelect');
  const dateToSelect = document.getElementById('dateToSelect');
  // "05 Akcije" mirrors the same od/do pickers up in its own header, so the
  // period is visible right there instead of only in "03 Filteri" above it.
  const promoDateFromSel = document.getElementById('promoDateFromSel');
  const promoDateToSel = document.getElementById('promoDateToSel');
  const dateOptionsHtml = DATES.map(d=>`<option value="${d}">${fmtDate(d)}</option>`).join('');
  dateFromSelect.innerHTML = dateOptionsHtml;
  dateToSelect.innerHTML = dateOptionsHtml;
  promoDateFromSel.innerHTML = dateOptionsHtml;
  promoDateToSel.innerHTML = dateOptionsHtml;
  dateFromSelect.value = state.dateFrom;
  dateToSelect.value = state.dateTo;
  // one place that applies a period change, whichever of the two pickers made it
  function setDateFrom(v){
    state.dateFrom = v;
    // a range can't invert — pull "do" forward with it rather than silently ignoring the pick
    if(state.dateFrom > state.dateTo) state.dateTo = state.dateFrom;
    syncDateSelects(); state.page=0; render();
  }
  function setDateTo(v){
    state.dateTo = v;
    if(state.dateTo < state.dateFrom) state.dateFrom = state.dateTo;
    syncDateSelects(); state.page=0; render();
  }
  function syncDateSelects(){
    dateFromSelect.value = state.dateFrom;
    dateToSelect.value = state.dateTo;
    promoDateFromSel.value = state.dateFrom;
    promoDateToSel.value = state.dateTo;
  }
  syncDateSelects();
  dateFromSelect.addEventListener('change', ()=> setDateFrom(dateFromSelect.value));
  dateToSelect.addEventListener('change', ()=> setDateTo(dateToSelect.value));
  promoDateFromSel.addEventListener('change', ()=> setDateFrom(promoDateFromSel.value));
  promoDateToSel.addEventListener('change', ()=> setDateTo(promoDateToSel.value));

  const typeChips = document.getElementById('typeChips');
  ['negazirana','gazirana'].forEach(t=>{
    const btn = document.createElement('button');
    btn.className='chip'; btn.type='button'; btn.textContent = TYPE_LABELS[t];
    btn.setAttribute('aria-pressed', state.types.has(t) ? 'true':'false');
    btn.addEventListener('click', ()=>{
      if(state.types.has(t)) state.types.delete(t); else state.types.add(t);
      btn.setAttribute('aria-pressed', state.types.has(t) ? 'true':'false');
      state.page = 0; render();
    });
    typeChips.appendChild(btn);
  });

  // ---- brand compare (pick specific brands, e.g. Cetina/Jana/Studena, and follow
  // them over time — this is a global filter, same as chain/volume/type above, so
  // the chart, brand matrix and product list all narrow to just the picked brands) ----
  const MAX_COMPARE_BRANDS = SERIES_COLORS.length; // one distinct chart color per brand
  const brandObsCount = new Map();
  OBS.forEach(row=>{ const b = PRODUCT_BRAND[row[1]]; brandObsCount.set(b, (brandObsCount.get(b)||0)+1); });
  const ALL_BRANDS = Array.from(new Set(PRODUCT_BRAND))
    .filter(b=> b && b!=='(nepoznata marka)' && !DISCONTINUED_BRANDS.has(b))
    .sort((a,b)=> (brandObsCount.get(b)||0)-(brandObsCount.get(a)||0) || a.localeCompare(b,'hr'));
  // curated shortlist of well-known bottled-water brands (not every raw brand string
  // in the data — those include juices, vitamin drinks, manufacturer names etc.) —
  // one-click quick-picks so people don't have to type Jana/Cetina/Studena by hand.
  // Ordered by how many tracked prices we actually have for each.
  // Kala and Kalnička are out: production has stopped, so although remaining stock
  // is still on shelves they no longer belong in a curated "popular brands" view.
  // Their history stays in the full "Proizvodi" table below.
  const POPULAR_BRAND_CANON = ['JAMNICA','JANA','CETINA','RADENSKA','STUDENA','MIVELA',
    'STUDENAC','LEDA','DONAT','ZALA','SARA','SVETI ROK','S BUDGET','K CLASSIC','SAGUARO','NO BRAND','CETINA DINARA'];
  const POPULAR_BRANDS = POPULAR_BRAND_CANON.filter(b=> ALL_BRANDS.includes(b));
  const POPULAR_BRANDS_SET = new Set(POPULAR_BRANDS);

  // ---- "Najpopularnije vode" table: a fixed, curated view — popular brands sold in
  // the biggest national chains — independent of the "Trgovine" filter above, so it
  // stays a compact reference no matter what the rest of the page is filtered to.
  // Still respects search text / type / veličina, since those narrow the product
  // itself rather than which stores or brands count as "popular".
  const IMPORTANT_CHAINS = ['konzum','kaufland','lidl','spar','plodine','studenac','ribola','tommy','metro','eurospin'];
  const IMPORTANT_CHAINS_SET = new Set(IMPORTANT_CHAINS.filter(c=>CHAINS.includes(c)));
  function isPopularProduct(pIdx){
    const p = PRODUCTS[pIdx];
    const [chain,name,brand,qty,unit] = p;
    if(!IMPORTANT_CHAINS_SET.has(chain)) return false;
    if(SHADOW_LISTINGS.has(pIdx)) return false;
    if(DISCONTINUED_BRANDS.has(PRODUCT_BRAND[pIdx])) return false;
    if(DELISTED.has(PRODUCT_BRAND[pIdx] + '|' + chain)) return false;
    if(DISCONTINUED_ARTICLES.has(PRODUCT_BRAND[pIdx] + '|' + PRODUCT_VOLUME_KEY[pIdx])) return false;
    if(!POPULAR_BRANDS_SET.has(PRODUCT_BRAND[pIdx])) return false;
    if(state.popularBrand && PRODUCT_BRAND[pIdx]!==state.popularBrand) return false;
    if(state.popularChain && chain!==state.popularChain) return false;
    if(!state.types.has(PRODUCT_WTYPE[pIdx])) return false;
    if(state.volumes.size>0 && !state.volumes.has(PRODUCT_VOLUME_KEY[pIdx])) return false;
    if(state.q){
      const hay = stripDia(name+' '+brand);
      if(!hay.includes(state.q)) return false;
    }
    return true;
  }
  function getPopularProductIdxs(){
    const out=[];
    for(let i=0;i<PRODUCTS.length;i++){ if(isPopularProduct(i)) out.push(i); }
    return out;
  }

  const brandSearchInput = document.getElementById('brandSearch');
  const brandSuggestionsEl = document.getElementById('brandSuggestions');
  const brandChipsEl = document.getElementById('brandChips');
  const popularBrandChipsEl = document.getElementById('popularBrandChips');

  function renderPopularBrandChips(){
    const full = state.brands.size >= MAX_COMPARE_BRANDS;
    popularBrandChipsEl.innerHTML = POPULAR_BRANDS.map(b=>{
      const active = state.brands.has(b);
      const disabled = (!active && full) ? 'disabled' : '';
      return `<button type="button" class="chip" aria-pressed="${active?'true':'false'}" ${disabled} data-brand="${escapeHtml(b)}">${escapeHtml(brandLabel(b))}</button>`;
    }).join('');
    popularBrandChipsEl.querySelectorAll('.chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const b = btn.dataset.brand;
        if(state.brands.has(b)) removeBrand(b); else addBrand(b);
      });
    });
  }

  function renderBrandChips(){
    brandChipsEl.innerHTML = Array.from(state.brands).map(b=>
      `<span class="chip" aria-pressed="true" style="cursor:default;" data-brand="${escapeHtml(b)}">${escapeHtml(brandLabel(b))}<span class="chip-remove" role="button" tabindex="0" aria-label="Ukloni ${escapeHtml(b)}">✕</span></span>`
    ).join('');
    brandChipsEl.querySelectorAll('.chip-remove').forEach(el=>{
      el.addEventListener('click', (e)=>{
        e.stopPropagation();
        removeBrand(e.currentTarget.closest('.chip').dataset.brand);
      });
    });
  }

  function updateBrandSearchState(){
    const full = state.brands.size >= MAX_COMPARE_BRANDS;
    brandSearchInput.disabled = full;
    brandSearchInput.placeholder = full
      ? `Dosegnut je maksimum od ${MAX_COMPARE_BRANDS} marki — ukloni jednu za dodavanje nove`
      : 'Usporedi marke — dodaj npr. Cetina, Jana, Studena…';
  }

  function addBrand(b){
    if(!b || state.brands.has(b) || state.brands.size >= MAX_COMPARE_BRANDS) return;
    const wasEmpty = state.brands.size===0;
    state.brands.add(b);
    brandSearchInput.value = '';
    state.page = 0;
    // jump straight to the brand-comparison chart the first time a brand is picked —
    // that's the view this control is for
    if(wasEmpty && state.tab!=='brands') switchTab('brands');
    renderBrandChips();
    renderPopularBrandChips();
    updateBrandSearchState();
    render();
    // the input never actually blurs on a suggestion click (mousedown below
    // prevents that), so refresh the list in place rather than relying on a
    // focus event that won't refire — lets the user add several brands in a row
    brandSearchInput.focus();
    showBrandSuggestions();
  }
  function removeBrand(b){
    state.brands.delete(b);
    state.page = 0;
    renderBrandChips();
    renderPopularBrandChips();
    updateBrandSearchState();
    render();
  }

  function showBrandSuggestions(){
    if(state.brands.size >= MAX_COMPARE_BRANDS){ brandSuggestionsEl.hidden = true; return; }
    const q = stripDia(brandSearchInput.value.trim());
    const pool = ALL_BRANDS.filter(b=> !state.brands.has(b) && (q==='' || stripDia(b).includes(q)));
    const list = pool.slice(0, 8);
    if(list.length===0){
      brandSuggestionsEl.innerHTML = `<div class="sugg-empty">Nema marki koje odgovaraju upitu.</div>`;
    } else {
      brandSuggestionsEl.innerHTML = list.map(b=>
        `<div class="sugg-item" data-brand="${escapeHtml(b)}"><span>${escapeHtml(brandLabel(b))}</span><span class="sugg-count">${(brandObsCount.get(b)||0).toLocaleString('hr-HR')} cijena</span></div>`
      ).join('');
      brandSuggestionsEl.querySelectorAll('.sugg-item').forEach(el=>{
        // mousedown (not click) fires before the input's blur hides the list
        el.addEventListener('mousedown', (e)=>{ e.preventDefault(); addBrand(el.dataset.brand); });
      });
    }
    brandSuggestionsEl.hidden = false;
  }

  brandSearchInput.addEventListener('input', showBrandSuggestions);
  brandSearchInput.addEventListener('focus', showBrandSuggestions);
  brandSearchInput.addEventListener('blur', ()=>{ setTimeout(()=>{ brandSuggestionsEl.hidden = true; }, 150); });
  brandSearchInput.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const first = brandSuggestionsEl.querySelector('.sugg-item');
      if(first) addBrand(first.dataset.brand);
    } else if(e.key==='Escape'){
      brandSuggestionsEl.hidden = true;
    }
  });
  renderBrandChips();
  renderPopularBrandChips();
  updateBrandSearchState();

  let qTimer=null;
  document.getElementById('q').addEventListener('input', (e)=>{
    clearTimeout(qTimer);
    const v = e.target.value;
    qTimer = setTimeout(()=>{ state.q = stripDia(v.trim()); state.page=0; render(); }, 120);
  });

  function switchTab(tab){
    state.tab = tab;
    document.querySelectorAll('#chartTabs .tab-btn').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===tab?'true':'false'));
    document.getElementById('chartBrandsWrap').style.display = state.tab==='brands' ? '' : 'none';
    document.getElementById('chartChainsWrap').style.display = state.tab==='chains' ? '' : 'none';
    document.getElementById('chartTitle').textContent = state.tab==='brands' ? 'Usporedba po markama' : 'Usporedba po dućanima';
  }
  document.getElementById('chartTabs').addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn'); if(!btn) return;
    switchTab(btn.dataset.tab);
    render();
  });

  document.querySelectorAll('#tbl thead th[data-sort]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const k = th.dataset.sort;
      if(state.sortKey===k) state.sortDir *= -1; else { state.sortKey=k; state.sortDir = (k==='name'||k==='chain'||k==='type'||k==='volume') ? 1 : -1; }
      state.page=0; render();
    });
  });
  document.getElementById('prevPage').addEventListener('click', ()=>{ if(state.page>0){ state.page--; render(); }});
  document.getElementById('nextPage').addEventListener('click', ()=>{ state.page++; render(); });

  // ---- filtering ----
  function productMatches(pIdx){
    const p = PRODUCTS[pIdx];
    const [chain,name,brand,qty,unit] = p;
    if(EXCLUDED_CHAINS.has(chain)) return false;
    if(SHADOW_LISTINGS.has(pIdx)) return false;          // duplicate listing of the same article
    if(DISCONTINUED_BRANDS.has(PRODUCT_BRAND[pIdx])) return false;
    if(DELISTED.has(PRODUCT_BRAND[pIdx] + '|' + chain)) return false;
    if(DISCONTINUED_ARTICLES.has(PRODUCT_BRAND[pIdx] + '|' + PRODUCT_VOLUME_KEY[pIdx])) return false;
    if(!state.chains.has(chain)) return false;
    if(!state.types.has(PRODUCT_WTYPE[pIdx])) return false;
    if(state.volumes.size>0 && !state.volumes.has(PRODUCT_VOLUME_KEY[pIdx])) return false;
    if(state.brands.size>0 && !state.brands.has(PRODUCT_BRAND[pIdx])) return false;
    if(state.q){
      const hay = stripDia(name+' '+brand);
      if(!hay.includes(state.q)) return false;
    }
    return true;
  }

  function getMatchingProductIdxs(){
    const out=[];
    for(let i=0;i<PRODUCTS.length;i++){ if(productMatches(i)) out.push(i); }
    return out;
  }

  function getMatchingIdxsAnyChain(){
    // same filters as productMatches minus the chain restriction — for panels
    // that compare chains with each other and so must see all of them
    const saved = state.chains; state.chains = new Set(CHAINS_LIVE);
    const out = getMatchingProductIdxs();
    state.chains = saved;
    return out;
  }

  // ================= PRICE TIERS PER CHAIN =================
  // From 2026-09-10 the pipeline stores every distinct price a chain sold a
  // product at on a day, with the number of stores on each — obs[6] as
  // [[price, stores], ...] when there is more than one. This panel turns that
  // into a per-chain picture: how many articles have several tiers, how many
  // tiers is typical, the most, and how the stores split between the tiers.
  const TIER_COLORS = ['var(--line)','color-mix(in srgb, var(--accent) 30%, transparent)','color-mix(in srgb, var(--accent) 52%, transparent)','color-mix(in srgb, var(--accent) 74%, transparent)','var(--accent)'];
  const TIER_LABELS = ['1 razina','2 razine','3 razine','4 razine','5+ razina'];
  const TIERS_INTRO_OVERVIEW = 'Neki lanci nemaju jednu cijenu nego više <em>razina</em> ovisno o poslovnici — Tommy, na primjer, isti artikl istog dana prodaje po tri ili četiri različite cijene. Ovdje se za svaki lanac vidi koliko artikala ima više razina, koliko ih razina obično ima, najviše koliko, te koliko poslovnica spada u koju razinu. Odaberi marku (i veličinu) gore za točne razine cijena po lancima. Prikaz ne ovisi o filteru trgovina; gleda datum „Do" u filterima ispod.';
  const TIERS_INTRO_DETAIL = 'Točne razine cijena za odabrani artikl: svaka cijena po kojoj lanac taj dan prodaje taj artikl i koliko poslovnica prodaje po toj cijeni. <span class="focus-legend-cheap">Najniža razina</span> u lancu je istaknuta, trakica ispod cijene pokazuje udio poslovnica. Prikaz ne ovisi o filteru trgovina; gleda datum „Do" u filterima ispod.';

  // The panel has its own two pickers (marka + veličina) so an article can be
  // looked up here without disturbing the filters below; it still honours the
  // type filter and the search box, which define what counts as water at all.
  function tierPanelIdxs(){
    const out=[];
    for(let i=0;i<PRODUCTS.length;i++){
      const [chain,name,brand] = PRODUCTS[i];
      if(EXCLUDED_CHAINS.has(chain)) continue;
      if(SHADOW_LISTINGS.has(i)) continue;
      if(DISCONTINUED_BRANDS.has(PRODUCT_BRAND[i])) continue;
      if(DELISTED.has(PRODUCT_BRAND[i] + '|' + chain)) continue;
      if(DISCONTINUED_ARTICLES.has(PRODUCT_BRAND[i] + '|' + PRODUCT_VOLUME_KEY[i])) continue;
      if(!state.types.has(PRODUCT_WTYPE[i])) continue;
      if(state.q && !stripDia(name+' '+brand).includes(state.q)) continue;
      out.push(i);
    }
    return out;
  }
  // latest observation on or before "Do", skipping articles whose chain has
  // stopped reporting them (chains skip days, so compare with the chain's own
  // last report rather than with the selected date)
  function latestFreshObs(pi, lastSeen){
    const list = obsByProduct.get(pi); if(!list || list.length===0) return null;
    let last=null; for(let k=list.length-1;k>=0;k--){ if(list[k][0]<=CUR_DATE_IDX){ last=list[k]; break; } }
    if(!last) return null;
    const chainLast = lastSeen.get(PRODUCTS[pi][0]);
    if(chainLast !== undefined && chainLast - last[0] > STALE_AFTER) return null;
    return last;
  }
  // every distinct price the chain sold this article at that day, cheapest first
  function tierLevels(row){
    const bd = row[6];
    if(bd && bd.length>1) return bd.map(t=>({price:t[0], stores:t[1]})).sort((a,b)=>a.price-b.price);
    return [{price: shelfPrice(row), stores: row[5]}];
  }

  function renderTiersControls(idxs, lastSeen){
    const bSel = document.getElementById('tierBrandSel');
    const vSel = document.getElementById('tierVolSel');
    const reset = document.getElementById('tierReset');
    const brandCount = new Map(), volCount = new Map();
    idxs.forEach(pi=>{
      if(!latestFreshObs(pi, lastSeen)) return;
      const b = PRODUCT_BRAND[pi];
      brandCount.set(b, (brandCount.get(b)||0)+1);
      if(!state.tierBrand || state.tierBrand===b){
        const v = PRODUCT_VOLUME_KEY[pi];
        volCount.set(v, (volCount.get(v)||0)+1);
      }
    });
    if(state.tierBrand && !brandCount.has(state.tierBrand)) state.tierBrand = '';
    if(state.tierVol && !volCount.has(state.tierVol)) state.tierVol = '';
    const brands = Array.from(brandCount.keys()).sort((a,b)=>{
      const pa = POPULAR_BRAND_CANON.indexOf(a), pb = POPULAR_BRAND_CANON.indexOf(b);
      if(pa>=0 || pb>=0){ if(pa<0) return 1; if(pb<0) return -1; return pa-pb; }
      return brandLabel(a).localeCompare(brandLabel(b),'hr');
    });
    bSel.innerHTML = '<option value="">Sve marke — pregled lanaca</option>' + brands.map(b=>
      `<option value="${escapeHtml(b)}"${b===state.tierBrand?' selected':''}>${escapeHtml(brandLabel(b))}</option>`).join('');
    const vols = Array.from(volCount.keys()).sort((a,b)=>{
      const oa = VOLUME_ORDER.has(a)?VOLUME_ORDER.get(a):99, ob = VOLUME_ORDER.has(b)?VOLUME_ORDER.get(b):99;
      return oa-ob;
    });
    vSel.innerHTML = '<option value="">Sve veličine</option>' + vols.map(v=>
      `<option value="${escapeHtml(v)}"${v===state.tierVol?' selected':''}>${escapeHtml(volumeBucketLabel(v))} (${volCount.get(v)})</option>`).join('');
    reset.hidden = !(state.tierBrand || state.tierVol);
  }

  // ---- picked article: the exact price levels, chain by chain ----
  function renderTierDetail(idxs, lastSeen, wrap, note, legend){
    const rows = [];
    idxs.forEach(pi=>{
      if(state.tierBrand && PRODUCT_BRAND[pi]!==state.tierBrand) return;
      if(state.tierVol && PRODUCT_VOLUME_KEY[pi]!==state.tierVol) return;
      const last = latestFreshObs(pi, lastSeen); if(!last) return;
      const levels = tierLevels(last);
      const stores = levels.reduce((a,l)=>a+l.stores,0) || last[5];
      rows.push({ pi, chain:PRODUCTS[pi][0], name:PRODUCTS[pi][1], volKey:PRODUCT_VOLUME_KEY[pi],
        levels, stores, dateIdx:last[0], onPromo:obsOnPromo(last), anchor:last[8]||0,
        lo:levels[0].price, hi:levels[levels.length-1].price });
    });
    if(rows.length===0){
      wrap.innerHTML = '<div class="empty">Nema aktivnih artikala za taj odabir na odabrani datum.</div>';
      note.textContent = ''; legend.innerHTML = ''; return;
    }
    const chainRank = c=>{ const i = IMPORTANT_CHAINS.indexOf(c); return i<0 ? 99 : i; };
    const volRank = v=> VOLUME_ORDER.has(v) ? VOLUME_ORDER.get(v) : 99;
    rows.sort((a,b)=> chainRank(a.chain)-chainRank(b.chain) || chainLabel(a.chain).localeCompare(chainLabel(b.chain),'hr')
      || volRank(a.volKey)-volRank(b.volKey) || a.lo-b.lo || a.name.localeCompare(b.name,'hr'));

    const chains = new Set(rows.map(r=>r.chain));
    const multi = rows.filter(r=>r.levels.length>1).length;
    const cheapest = rows.reduce((m,r)=> r.lo<m.lo ? r : m, rows[0]);
    const pickLabel = [state.tierBrand ? brandLabel(state.tierBrand) : 'Sve marke',
                       state.tierVol ? volumeBucketLabel(state.tierVol) : 'sve veličine'].join(' · ');
    note.textContent = `${pickLabel} · ${rows.length} ${rows.length===1?'artikl':'artikala'} u ${chains.size} ${chains.size===1?'lancu':'lanaca'} · stanje ${fmtDate(DATES[CUR_DATE_IDX])}`;

    let html = '<table class="matrix"><thead>'
      + '<tr class="grouprow"><th class="brand-head"></th><th colspan="3">što se prodaje</th><th class="colsep" colspan="2">po kojim cijenama</th></tr>'
      + '<tr class="colrow"><th class="brand-head">Lanac</th><th>Artikl</th><th>Poslovnica</th><th>Br. razina</th><th class="colsep">Razine cijena (cijena · broj poslovnica)</th><th>Raspon</th></tr></thead><tbody>';
    let prevChain = null;
    rows.forEach(r=>{
      const lvlHtml = r.levels.map((l,i)=>{
        const share = r.stores ? l.stores/r.stores : 0;
        return `<span class="lvl${i===0 && r.levels.length>1 ? ' lvl-cheap':''}">
          <b>${fmtEUR(l.price)}</b><small>${l.stores} ${l.stores===1?'poslovnica':'posl.'} · ${Math.round(share*100)}%</small>
          <span class="lvl-share" style="width:${Math.max(6, Math.round(share*54))}px"></span></span>`;
      }).join('');
      const spread = r.lo>0 && r.hi>r.lo ? `+${Math.round((r.hi-r.lo)/r.lo*100)}%<br><small style="color:var(--ink-muted)">${fmtEUR(r.hi-r.lo)}</small>` : '–';
      const promoTag = r.onPromo ? `<small style="color:var(--promo-ink)">na akciji${r.anchor>r.lo?` · redovno ${fmtEUR(r.anchor)}`:''}</small>` : '';
      const dateTag = r.dateIdx!==CUR_DATE_IDX ? `<small>zadnja objava ${fmtDateShort(DATES[r.dateIdx])}</small>` : '';
      const chainCell = r.chain===prevChain ? '' : chainLabel(r.chain);
      prevChain = r.chain;
      html += `<tr><td class="brand-cell">${chainCell}</td>
        <td><div class="tier-detail-name">${escapeHtml(r.name)}<small>${escapeHtml(volumeCellLabel(r.pi, r.volKey, PRODUCT_VOLUME_L[r.pi]))}</small>${promoTag}${dateTag}</div></td>
        <td class="num">${r.stores}</td>
        <td class="num tier-mode">${r.levels.length}</td>
        <td class="colsep"><div class="lvl-list">${lvlHtml}</div></td>
        <td class="num">${spread}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    legend.innerHTML = `<span>Najjeftiniji artikl u odabiru: <b>${chainLabel(cheapest.chain)} ${fmtEUR(cheapest.lo)}</b> · ${multi} od ${rows.length} artikala ima više od jedne razine.</span>`
      + `<span style="margin-left:auto;">"Poslovnica" = ukupan broj poslovnica koje taj dan prodaju artikl; "Raspon" = koliko je najskuplja razina skuplja od najjeftinije.</span>`;
  }

  function renderTiersPanel(){
    const wrap = document.getElementById('tiersWrap');
    const note = document.getElementById('tiersNote');
    const legend = document.getElementById('tiersLegend');
    const intro = document.getElementById('tiersIntro');
    const idxs = tierPanelIdxs();
    const lastSeen = chainLastSeen();
    renderTiersControls(idxs, lastSeen);
    const detail = !!(state.tierBrand || state.tierVol);
    intro.innerHTML = detail ? TIERS_INTRO_DETAIL : TIERS_INTRO_OVERVIEW;
    if(detail) return renderTierDetail(idxs, lastSeen, wrap, note, legend);

    // per chain, the latest observation of each product on or before "Do"
    const perChain = new Map(); // chain -> {n, tierCounts:{}, splits:Map(patternKey->count), spreads:[]}
    let anyBreakdownDate = -1;
    idxs.forEach(pi=>{
      const last = latestFreshObs(pi, lastSeen); if(!last) return;
      const chain = PRODUCTS[pi][0];
      if(!perChain.has(chain)) perChain.set(chain, {n:0, tierCounts:{}, splits:new Map(), spreads:[]});
      const o = perChain.get(chain);
      const bd = last[6];
      const tiers = (bd && bd.length>1) ? bd.length : 1;
      o.n++; o.tierCounts[tiers] = (o.tierCounts[tiers]||0)+1;
      if(tiers>1){
        anyBreakdownDate = Math.max(anyBreakdownDate, last[0]);
        const key = bd.map(x=>x[1]).join('·');
        o.splits.set(key, (o.splits.get(key)||0)+1);
        const lo = bd[0][0], hi = bd[bd.length-1][0];
        if(lo>0) o.spreads.push((hi-lo)/lo*100);
      }
    });
    if(anyBreakdownDate < 0){
      wrap.innerHTML = '<div class="empty">Za odabrani datum nijedan lanac nije prijavio više od jedne cijene po artiklu.</div>';
      note.textContent=''; legend.innerHTML=''; return;
    }
    const rows = Array.from(perChain.entries()).map(([chain,o])=>{
      const multi = o.n - (o.tierCounts[1]||0);
      let mode=1, modeN=-1, maxT=1;
      Object.entries(o.tierCounts).forEach(([t,c])=>{ t=+t; if(t>maxT) maxT=t; if(t>1 && c>modeN){ modeN=c; mode=t; } });
      let bestSplit=null, bestN=0; o.splits.forEach((c,k)=>{ if(c>bestN){ bestN=c; bestSplit=k; } });
      return { chain, n:o.n, multi, share: multi/o.n, mode: multi>0?mode:1, maxT, split:bestSplit, splitN:bestN,
               spread: o.spreads.length ? medianOf(o.spreads) : null, tierCounts:o.tierCounts };
    }).sort((a,b)=> b.share-a.share || b.maxT-a.maxT || a.chain.localeCompare(b.chain));

    note.textContent = `${rows.length} lanaca · stanje ${fmtDate(DATES[Math.min(CUR_DATE_IDX, DATES.length-1)])}`;
    let html = '<table class="matrix"><thead><tr><th class="brand-head">Lanac</th><th>Artikala</th><th>S više razina</th><th>Najčešće</th><th>Najviše</th><th>Raspodjela artikala po broju razina</th><th>Tipičan raspon</th><th>Poslovnica po razini</th></tr></thead><tbody>';
    rows.forEach(r=>{
      const segs = [1,2,3,4,5].map((t,i)=>{
        const c = t<5 ? (r.tierCounts[t]||0) : Object.entries(r.tierCounts).filter(([k])=>+k>=5).reduce((a,[,v])=>a+v,0);
        if(!c) return '';
        return `<div class="tier-seg" style="width:${(c/r.n*100).toFixed(1)}%; background:${TIER_COLORS[i]};" title="${TIER_LABELS[i]}: ${c} ${c===1?'artikl':'artikala'}"></div>`;
      }).join('');
      const splitHtml = r.split
        ? `<span class="tier-split">${escapeHtml(r.split.split('·').join(' · '))} <small>(${r.splitN} art.)</small></span>`
        : '<span class="tier-split"><small>jedna cijena u svim poslovnicama</small></span>';
      html += `<tr><td class="brand-cell">${chainLabel(r.chain)}</td>
        <td class="num">${r.n}</td>
        <td class="num">${r.multi>0 ? Math.round(r.share*100)+'%' : '–'}</td>
        <td class="num tier-mode">${r.multi>0 ? r.mode : 1}</td>
        <td class="num">${r.maxT}</td>
        <td><div class="tier-bar">${segs}</div></td>
        <td class="num">${r.spread!==null ? Math.round(r.spread)+'%' : '–'}</td>
        <td>${splitHtml}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    legend.innerHTML = TIER_LABELS.map((l,i)=>`<span class="promo-legend-swatch" style="background:${TIER_COLORS[i]};"></span><span style="margin-right:8px;">${l}</span>`).join('')
      + `<span style="margin-left:auto;">"Poslovnica po razini" = najčešći raspored poslovnica od najjeftinije do najskuplje razine; "Tipičan raspon" = medijan razlike najskuplje i najjeftinije razine.</span>`;
  }

  // ================= HERO =================
  // dateIdx -> {sum,count} for a set of product indices, restricted to the active
  // date range — shared by the hero's delta/range cards and by the per-selection
  // price tiles below (much cheaper than scanning all of OBS per subset: walks only
  // each product's own observations via obsByProduct).
  function buildByDate(idxList, fromIdx = CUR_DATE_FROM_IDX){
    const byDate = new Map();
    idxList.forEach(pi=>{
      const rows = obsByProduct.get(pi);
      if(!rows) return;
      for(const row of rows){
        if(row[0] < fromIdx || row[0] > CUR_DATE_IDX) continue;
        const d = row[0];
        if(!byDate.has(d)) byDate.set(d,{sum:0,count:0});
        const o = byDate.get(d); o.sum+=shelfPrice(row); o.count++;
      }
    });
    return byDate;
  }
  // the latest (closest to "do") available price for a subset — used per tile
  function latestForSubset(idxList){
    const byDate = buildByDate(idxList, 0);
    const idxs = Array.from(byDate.keys()).sort((a,b)=>a-b);
    if(idxs.length===0) return null;
    const d = idxs[idxs.length-1];
    const o = byDate.get(d);
    return { price:o.sum/o.count, dateIdx:d, count:o.count };
  }

  // Chains occasionally skip a day in the source archive. Their prices are still
  // shown (the freshness rule compares each chain with its own last report), but
  // the day's average is computed without them, so say which ones are missing
  // rather than letting it look like the data was removed.
  function missingChainsNote(dateIdx){
    if(dateIdx < 0) return '';
    const seen = new Set();
    for(const r of OBS){ if(r[0]===dateIdx) seen.add(PRODUCTS[r[1]][0]); }
    const expected = CHAINS_LIVE.filter(c=> state.chains.has(c));
    const missing = expected.filter(c=> !seen.has(c));
    if(missing.length===0 || missing.length===expected.length) return '';
    const names = missing.map(chainLabel);
    const shown = names.length>3 ? names.slice(0,3).join(', ')+' i još '+(names.length-3) : names.join(', ');
    return `<br><span title="${escapeHtml('Ti lanci nisu objavili cijene tog dana, pa nisu uključeni u prosjek. Njihove zadnje cijene i dalje se prikazuju u tablicama.')}" style="text-decoration:underline dotted; text-underline-offset:2px; cursor:help;">${escapeHtml(shown)} nije objavio cijene tog dana</span>`;
  }

  function renderHero(matchIdxs){
    const hero = document.getElementById('hero');
    // The top of the page is a snapshot "as of" one day, so it ignores "od" -
    // otherwise narrowing the period elsewhere (e.g. in Akcije) would silently
    // empty the 90-day comparison here.
    const byDate = buildByDate(matchIdxs, 0);
    const activeDateIdxs = Array.from(byDate.keys()).sort((a,b)=>a-b);
    if(activeDateIdxs.length===0){
      hero.innerHTML = '<div class="hero-main"><div class="hero-label">Cijena vode</div><div class="hero-value" style="font-size:22px;color:var(--ink-muted)">Nema podataka za odabrani filtar</div></div>';
      return;
    }
    const latestIdx = activeDateIdxs[activeDateIdxs.length-1];
    const latestAvg = byDate.get(latestIdx).sum / byDate.get(latestIdx).count;
    const latestDate = DATES[latestIdx];

    function deltaFrom(targetIso){
      const cand = activeDateIdxs.filter(i=>DATES[i] <= targetIso);
      if(cand.length===0) return null;
      const idx = cand[cand.length-1];
      const avg = byDate.get(idx).sum / byDate.get(idx).count;
      return {avg, date: DATES[idx]};
    }
    const d90 = new Date(latestDate+'T00:00:00'); d90.setDate(d90.getDate()-90);
    const d90iso = d90.toISOString().slice(0,10);
    const from90 = deltaFrom(d90iso);

    function deltaCard(label, base){
      if(!base) return `<div class="delta-card"><span class="hero-label">${label}</span><span class="delta-context">nema dovoljno podataka</span></div>`;
      const diff = latestAvg - base.avg;
      const pct = base.avg>0 ? (diff/base.avg*100) : 0;
      const cls = Math.abs(pct)<0.5 ? 'delta-flat' : (pct>0 ? 'delta-up':'delta-down');
      const arrow = Math.abs(pct)<0.5 ? '≈' : (pct>0?'▲':'▼');
      return `<div class="delta-card">
        <span class="hero-label">${label}</span>
        <div class="delta-row"><span class="delta-pill ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span></div>
        <span class="delta-context">${fmtEUR(base.avg)} · ${fmtDateShort(base.date)}</span>
      </div>`;
    }

    // One day, not a range: everything up here shows prices as of a single date.
    // Period pickers (od–do) live with the sections that actually use a period.
    const newestIso = DATES[DATES.length-1];
    const dayOpts = DATES.slice().reverse().map(d=>`<option value="${d}"${d===state.dateTo?' selected':''}>${fmtDate(d)}</option>`).join('');
    const dayCard = `<div class="delta-card">
      <span class="hero-label">Stanje na dan</span>
      <div class="hero-range"><select id="heroDate" aria-label="Stanje na dan">${dayOpts}</select></div>
      <span class="delta-context">${state.dateTo===newestIso
        ? 'najnoviji dostupni podaci'
        : `<button type="button" class="preset-chip" id="heroDateNewest">Na najnoviji (${fmtDateShort(newestIso)})</button>`}</span>
    </div>`;

    hero.innerHTML = `
      ${renderPriceCard(matchIdxs, latestAvg, latestDate, byDate.get(latestIdx).count)}
      ${deltaCard('U odnosu na prije 90 dana', from90)}
      ${dayCard}
    `;
    // the hero is rebuilt on every render, so these are always fresh elements —
    // binding here cannot accumulate handlers
    const hDay = document.getElementById('heroDate');
    const hNewest = document.getElementById('heroDateNewest');
    if(hDay) hDay.addEventListener('change', ()=> setDateTo(hDay.value));
    if(hNewest) hNewest.addEventListener('click', ()=> setDateTo(newestIso));
  }

  // Left hero card: a single "cijena na datum" number by default, or — the moment
  // the visitor narrows brands, veličine or trgovine to specific picks rather than
  // the defaults — one small tile per combination they picked, so several prices
  // sit side by side instead of blurring into one blended average.
  const MAX_PRICE_TILES = 12;
  function renderPriceCard(matchIdxs, fallbackAvg, fallbackDate, fallbackCount){
    const brandsExplicit = state.brands.size>0;
    const volumesExplicit = state.volumes.size>0;
    const chainsExplicit = !setsEqual(state.chains, MAJOR_CHAINS_SET);

    if(!brandsExplicit && !volumesExplicit && !chainsExplicit){
      const brandCard = renderHeroBrandsCard(fallbackDate);
      if(brandCard) return brandCard;
      const heroLabel = state.dateTo===DATES[DATES.length-1] ? 'Cijena vode danas' : 'Cijena vode na odabrani datum';
      return `<div class="hero-main">
        <span class="hero-label">${heroLabel}</span>
        <div class="hero-value">${fmtEUR(fallbackAvg)}<small>/ kom</small></div>
        <div class="hero-sub">${fmtDate(fallbackDate)} · ${fallbackCount.toLocaleString('hr-HR')} cijena u uzorku${missingChainsNote(DATES.indexOf(fallbackDate))}</div>
      </div>`;
    }

    const brandVals = brandsExplicit ? Array.from(state.brands) : [null];
    const volumeVals = volumesExplicit ? Array.from(state.volumes) : [null];
    const chainVals = chainsExplicit ? Array.from(state.chains) : [null];

    let tiles = [];
    for(const b of brandVals){
      for(const v of volumeVals){
        for(const c of chainVals){
          const subset = matchIdxs.filter(pi=>
            (b===null || PRODUCT_BRAND[pi]===b) &&
            (v===null || PRODUCT_VOLUME_KEY[pi]===v) &&
            (c===null || PRODUCTS[pi][0]===c)
          );
          const r = latestForSubset(subset);
          if(r) tiles.push({ b, v, c, ...r });
        }
      }
    }
    if(tiles.length===0){
      return `<div class="hero-main"><div class="hero-label">Cijena po odabiru</div><div class="hero-value" style="font-size:22px;color:var(--ink-muted)">Nema podataka za odabranu kombinaciju</div></div>`;
    }
    tiles.sort((a,b)=> b.count - a.count);
    const omitted = tiles.length - MAX_PRICE_TILES;
    tiles = tiles.slice(0, MAX_PRICE_TILES);

    const groupLabel = state.dateTo===DATES[DATES.length-1] ? 'Zadnja cijena po odabiru' : `Cijena na ${fmtDateShort(state.dateTo)} po odabiru`;
    const tilesHtml = tiles.map(t=>{
      const parts = [t.b, t.v!=null?volumeBucketLabel(t.v):null, t.c!=null?chainLabel(t.c):null].filter(Boolean);
      const name = parts.join(' · ') || 'Odabrano';
      return `<div class="price-tile">
        <div class="price-tile-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="price-tile-value">${fmtEUR(t.price)}</div>
        <div class="price-tile-sub">${fmtDateShort(DATES[t.dateIdx])} · ${t.count.toLocaleString('hr-HR')} cij.</div>
      </div>`;
    }).join('');
    const omittedNote = omitted>0 ? `<div class="price-tiles-omitted">+${omitted} kombinacija nije prikazano — suzi odabir za jasniji prikaz.</div>` : '';
    return `<div class="hero-main hero-tiles">
      <span class="hero-label">${groupLabel}</span>
      <div class="price-tile-grid">${tilesHtml}</div>
      ${omittedNote}
    </div>`;
  }

  function buildLinePath(points, x, y){
    if(points.length===0) return '';
    return points.map((p,i)=> (i===0?'M':'L') + x(p[0]).toFixed(2) + ' ' + y(p[1]).toFixed(2)).join(' ');
  }

  // ================= BRANDS CHART =================
  function renderBrandsChart(matchIdxs){
    const svg = document.getElementById('chartBrands');
    const tt = document.getElementById('ttBrands');
    const legend = document.getElementById('legendBrands');
    const note = document.getElementById('chartNote');
    svg.innerHTML=''; legend.innerHTML='';
    if(state.tab!=='brands') return;

    // group products by canonical brand among matches (same identity the brand
    // matrix and the brand-compare picker use, so a picked "Jamnica" isn't split
    // back into "Jamnica" / "JAMNICA PLUS D.O.O." series)
    const brandProducts = new Map(); // brand -> [prodIdx]
    matchIdxs.forEach(pi=>{
      const brand = PRODUCT_BRAND[pi];
      if(!brandProducts.has(brand)) brandProducts.set(brand, []);
      brandProducts.get(brand).push(pi);
    });
    // when the user explicitly picked brands to compare, show all of them (up to
    // the color-slot cap); otherwise auto-rank by data volume and keep it to 6
    const cap = state.brands.size>0 ? MAX_COMPARE_BRANDS : 6;
    const ranked = Array.from(brandProducts.entries()).map(([brand,idxs])=>{
      let cnt=0; idxs.forEach(i=> cnt += (obsByProduct.get(i)||[]).length );
      return {brand, idxs, cnt};
    }).sort((a,b)=>b.cnt-a.cnt).slice(0,cap);

    if(ranked.length===0){ note.textContent='Nema podataka za odabrani filtar.'; return; }
    note.textContent = state.brands.size>0
      ? `Usporedba marki: ${Array.from(state.brands).join(', ')}`
      : `Top ${ranked.length} marki po broju zabilježenih cijena u odabranom filtru`;

    const series = ranked.map((r,i)=>{
      const idxSet = new Set(r.idxs);
      const byDate = new Map();
      OBS.forEach(row=>{
        if(row[0] < CUR_DATE_FROM_IDX || row[0] > CUR_DATE_IDX) return;
        if(!idxSet.has(row[1])) return;
        const d=row[0];
        if(!byDate.has(d)) byDate.set(d,{sum:0,count:0});
        const o=byDate.get(d); o.sum+=shelfPrice(row); o.count++;
      });
      const pts = Array.from(byDate.keys()).sort((a,b)=>a-b).map(d=>[d, byDate.get(d).sum/byDate.get(d).count]);
      return {brand:r.brand, pts, color: cssVar(SERIES_COLORS[i%SERIES_COLORS.length])};
    }).filter(s=>s.pts.length>1);

    if(series.length===0){ note.textContent='Nema dovoljno podataka po markama za odabrani filtar.'; return; }

    const W=1000,H=320, padL=54, padR=90, padT=16, padB=30;
    let allVals=[]; series.forEach(s=>s.pts.forEach(p=>allVals.push(p[1])));
    const minV=Math.min(...allVals), maxV=Math.max(...allVals);
    const spanV=(maxV-minV)||1;
    const yMin=minV-spanV*0.1, yMax=maxV+spanV*0.1;
    const xSpan = Math.max(CUR_DATE_IDX - CUR_DATE_FROM_IDX, 1);
    const x=(di)=> padL + ((di-CUR_DATE_FROM_IDX)/xSpan) * (W-padL-padR);
    const y=(v)=> padT + (1-(v-yMin)/(yMax-yMin)) * (H-padT-padB);
    const ns='http://www.w3.org/2000/svg';
    function el(tag,attrs){ const e=document.createElementNS(ns,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); return e; }

    const gcount=4;
    for(let i=0;i<=gcount;i++){
      const v=yMin+(yMax-yMin)*i/gcount; const gy=y(v);
      svg.appendChild(el('line',{x1:padL,x2:W-padR,y1:gy,y2:gy,class:'gridline'}));
      const t=el('text',{x:8,y:gy+4,class:'axis-label'}); t.textContent=fmtEUR(v); svg.appendChild(t);
    }
    const anyPts = series[0].pts;
    [0, anyPts.length-1].forEach((pi,k)=>{
      const di = anyPts[pi][0];
      const t=el('text',{x:x(di),y:H-8,class:'axis-label','text-anchor': k===0?'start':'end'});
      t.textContent=fmtDateShort(DATES[di]); svg.appendChild(t);
    });
    svg.appendChild(el('line',{x1:padL,x2:W-padR,y1:H-padB,y2:H-padB,class:'baseline'}));

    // de-collide end labels: lines that finish close together in y would otherwise
    // print on top of one another
    const endYs = series.map(s=> y(s.pts[s.pts.length-1][1]));
    const order = endYs.map((v,i)=>i).sort((a,b)=>endYs[a]-endYs[b]);
    const MIN_GAP = 14;
    for(let k=1;k<order.length;k++){
      if(endYs[order[k]] - endYs[order[k-1]] < MIN_GAP){
        endYs[order[k]] = endYs[order[k-1]] + MIN_GAP;
      }
    }

    series.forEach((s,i)=>{
      svg.appendChild(el('path',{d:buildLinePath(s.pts,x,y), class:'series-line', stroke:s.color}));
      const last = s.pts[s.pts.length-1];
      svg.appendChild(el('circle',{cx:x(last[0]),cy:y(last[1]),r:3, fill:s.color}));
      const lbl = el('text',{x:x(last[0])+7,y:endYs[i]+4,class:'end-label',fill:s.color});
      const bl = brandLabel(s.brand);
      lbl.textContent = bl.length>14? bl.slice(0,13)+'…' : bl;
      svg.appendChild(lbl);
    });

    series.forEach(s=>{
      const item=document.createElement('div'); item.className='legend-item';
      item.innerHTML = `<span class="legend-swatch" style="background:${s.color}"></span>${escapeHtml(brandLabel(s.brand))}`;
      legend.appendChild(item);
    });

    // hover
    const hoverLine = el('line',{class:'crosshair-line', y1:padT, y2:H-padB, x1:-100,x2:-100});
    svg.appendChild(hoverLine);
    const dots = series.map(s=>{ const d= el('circle',{class:'hover-dot', r:4, fill:s.color, cx:-100,cy:-100}); svg.appendChild(d); return d; });
    const overlay = el('rect',{x:padL,y:padT,width:W-padL-padR,height:H-padT-padB, fill:'transparent'});
    overlay.style.cursor='crosshair';
    svg.appendChild(overlay);

    function onMove(evt){
      const rect = svg.getBoundingClientRect();
      const mx = (evt.clientX-rect.left)/rect.width*W;
      let closest=0, bestD=Infinity;
      anyPts.forEach((p,i)=>{ const dx=Math.abs(x(p[0])-mx); if(dx<bestD){bestD=dx; closest=i;} });
      const di = anyPts[closest][0];
      hoverLine.setAttribute('x1',x(di)); hoverLine.setAttribute('x2',x(di));
      let rows='';
      series.forEach((s,i)=>{
        const pt = s.pts.find(p=>p[0]===di) || s.pts.reduce((a,b)=>Math.abs(b[0]-di)<Math.abs(a[0]-di)?b:a);
        dots[i].setAttribute('cx', x(pt[0])); dots[i].setAttribute('cy', y(pt[1]));
        rows += `<div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span><span>${s.brand}: ${fmtEUR(pt[1])}</span></div>`;
      });
      const rectWrap = document.getElementById('chartBrandsWrap').getBoundingClientRect();
      const px = rect.left - rectWrap.left + (x(di)/W)*rect.width;
      const py = rect.top - rectWrap.top;
      tt.innerHTML = `<div class="tt-date">${fmtDate(DATES[di])}</div>${rows}`;
      tt.style.left = Math.min(px+12, rect.width-190)+'px';
      tt.style.top = Math.max(py+10,0)+'px';
      tt.classList.add('show');
    }
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseleave', ()=>{ tt.classList.remove('show'); hoverLine.setAttribute('x1',-100); hoverLine.setAttribute('x2',-100); dots.forEach(d=>d.setAttribute('cx',-100)); });
  }

  // ================= CHAINS CHART =================
  function renderChainsChart(matchIdxs){
    const svg = document.getElementById('chartChains');
    const tt = document.getElementById('ttChains');
    const legend = document.getElementById('legendChains');
    const note = document.getElementById('chartNote');
    svg.innerHTML=''; legend.innerHTML='';
    if(state.tab!=='chains') return;

    // group products by chain among matches; cap to the color-slot count and
    // auto-rank by data volume (the chain filter above can select far more chains
    // than are readable as separate lines at once, e.g. "Svi lanci" = 28)
    const chainProducts = new Map(); // chain -> [prodIdx]
    matchIdxs.forEach(pi=>{
      const chain = PRODUCTS[pi][0];
      if(!chainProducts.has(chain)) chainProducts.set(chain, []);
      chainProducts.get(chain).push(pi);
    });
    const cap = SERIES_COLORS.length;
    const ranked = Array.from(chainProducts.entries()).map(([chain,idxs])=>{
      let cnt=0; idxs.forEach(i=> cnt += (obsByProduct.get(i)||[]).length );
      return {chain, idxs, cnt};
    }).sort((a,b)=>b.cnt-a.cnt).slice(0,cap);

    if(ranked.length===0){ note.textContent='Nema podataka za odabrani filtar.'; return; }
    const omittedCount = chainProducts.size - ranked.length;
    note.textContent = omittedCount>0
      ? `Top ${ranked.length} lanaca po broju zabilježenih cijena (od ${chainProducts.size} odabranih u filtru) — suzi odabir trgovina za prikaz svih`
      : `Usporedba lanaca: ${ranked.map(r=>chainLabel(r.chain)).join(', ')}`;

    const series = ranked.map((r,i)=>{
      const idxSet = new Set(r.idxs);
      const byDate = new Map();
      OBS.forEach(row=>{
        if(row[0] < CUR_DATE_FROM_IDX || row[0] > CUR_DATE_IDX) return;
        if(!idxSet.has(row[1])) return;
        const d=row[0];
        if(!byDate.has(d)) byDate.set(d,{sum:0,count:0});
        const o=byDate.get(d); o.sum+=shelfPrice(row); o.count++;
      });
      const pts = Array.from(byDate.keys()).sort((a,b)=>a-b).map(d=>[d, byDate.get(d).sum/byDate.get(d).count]);
      return {chain:r.chain, label: chainLabel(r.chain), pts, color: cssVar(SERIES_COLORS[i%SERIES_COLORS.length])};
    }).filter(s=>s.pts.length>1);

    if(series.length===0){ note.textContent='Nema dovoljno podataka po dućanima za odabrani filtar.'; return; }

    const W=1000,H=320, padL=54, padR=90, padT=16, padB=30;
    let allVals=[]; series.forEach(s=>s.pts.forEach(p=>allVals.push(p[1])));
    const minV=Math.min(...allVals), maxV=Math.max(...allVals);
    const spanV=(maxV-minV)||1;
    const yMin=minV-spanV*0.1, yMax=maxV+spanV*0.1;
    const xSpan = Math.max(CUR_DATE_IDX - CUR_DATE_FROM_IDX, 1);
    const x=(di)=> padL + ((di-CUR_DATE_FROM_IDX)/xSpan) * (W-padL-padR);
    const y=(v)=> padT + (1-(v-yMin)/(yMax-yMin)) * (H-padT-padB);
    const ns='http://www.w3.org/2000/svg';
    function el(tag,attrs){ const e=document.createElementNS(ns,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); return e; }

    const gcount=4;
    for(let i=0;i<=gcount;i++){
      const v=yMin+(yMax-yMin)*i/gcount; const gy=y(v);
      svg.appendChild(el('line',{x1:padL,x2:W-padR,y1:gy,y2:gy,class:'gridline'}));
      const t=el('text',{x:8,y:gy+4,class:'axis-label'}); t.textContent=fmtEUR(v); svg.appendChild(t);
    }
    const anyPts = series[0].pts;
    [0, anyPts.length-1].forEach((pi,k)=>{
      const di = anyPts[pi][0];
      const t=el('text',{x:x(di),y:H-8,class:'axis-label','text-anchor': k===0?'start':'end'});
      t.textContent=fmtDateShort(DATES[di]); svg.appendChild(t);
    });
    svg.appendChild(el('line',{x1:padL,x2:W-padR,y1:H-padB,y2:H-padB,class:'baseline'}));

    // de-collide end labels: lines that finish close together in y would otherwise
    // print on top of one another
    const endYs = series.map(s=> y(s.pts[s.pts.length-1][1]));
    const order = endYs.map((v,i)=>i).sort((a,b)=>endYs[a]-endYs[b]);
    const MIN_GAP = 14;
    for(let k=1;k<order.length;k++){
      if(endYs[order[k]] - endYs[order[k-1]] < MIN_GAP){
        endYs[order[k]] = endYs[order[k-1]] + MIN_GAP;
      }
    }

    series.forEach((s,i)=>{
      svg.appendChild(el('path',{d:buildLinePath(s.pts,x,y), class:'series-line', stroke:s.color}));
      const last = s.pts[s.pts.length-1];
      svg.appendChild(el('circle',{cx:x(last[0]),cy:y(last[1]),r:3, fill:s.color}));
      const lbl = el('text',{x:x(last[0])+7,y:endYs[i]+4,class:'end-label',fill:s.color});
      lbl.textContent = s.label.length>14? s.label.slice(0,13)+'…' : s.label;
      svg.appendChild(lbl);
    });

    series.forEach(s=>{
      const item=document.createElement('div'); item.className='legend-item';
      item.innerHTML = `<span class="legend-swatch" style="background:${s.color}"></span>${s.label}`;
      legend.appendChild(item);
    });

    // hover
    const hoverLine = el('line',{class:'crosshair-line', y1:padT, y2:H-padB, x1:-100,x2:-100});
    svg.appendChild(hoverLine);
    const dots = series.map(s=>{ const d= el('circle',{class:'hover-dot', r:4, fill:s.color, cx:-100,cy:-100}); svg.appendChild(d); return d; });
    const overlay = el('rect',{x:padL,y:padT,width:W-padL-padR,height:H-padT-padB, fill:'transparent'});
    overlay.style.cursor='crosshair';
    svg.appendChild(overlay);

    function onMove(evt){
      const rect = svg.getBoundingClientRect();
      const mx = (evt.clientX-rect.left)/rect.width*W;
      let closest=0, bestD=Infinity;
      anyPts.forEach((p,i)=>{ const dx=Math.abs(x(p[0])-mx); if(dx<bestD){bestD=dx; closest=i;} });
      const di = anyPts[closest][0];
      hoverLine.setAttribute('x1',x(di)); hoverLine.setAttribute('x2',x(di));
      let rows='';
      series.forEach((s,i)=>{
        const pt = s.pts.find(p=>p[0]===di) || s.pts.reduce((a,b)=>Math.abs(b[0]-di)<Math.abs(a[0]-di)?b:a);
        dots[i].setAttribute('cx', x(pt[0])); dots[i].setAttribute('cy', y(pt[1]));
        rows += `<div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span><span>${s.label}: ${fmtEUR(pt[1])}</span></div>`;
      });
      const rectWrap = document.getElementById('chartChainsWrap').getBoundingClientRect();
      const px = rect.left - rectWrap.left + (x(di)/W)*rect.width;
      const py = rect.top - rectWrap.top;
      tt.innerHTML = `<div class="tt-date">${fmtDate(DATES[di])}</div>${rows}`;
      tt.style.left = Math.min(px+12, rect.width-190)+'px';
      tt.style.top = Math.max(py+10,0)+'px';
      tt.classList.add('show');
    }
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseleave', ()=>{ tt.classList.remove('show'); hoverLine.setAttribute('x1',-100); hoverLine.setAttribute('x2',-100); dots.forEach(d=>d.setAttribute('cx',-100)); });
  }

  // ================= TABLE =================
  function sparklineSVG(pts, color){
    if(pts.length<2) return '';
    const W=90,H=28,pad=3;
    const vals = pts.map(p=>p[1]);
    const minV=Math.min(...vals), maxV=Math.max(...vals); const span=(maxV-minV)||1;
    const x = (i)=> pad + i/(pts.length-1) * (W-2*pad);
    const y = (v)=> pad + (1-(v-minV)/span) * (H-2*pad);
    const d = pts.map((p,i)=> (i===0?'M':'L')+x(i).toFixed(1)+' '+y(p[1]).toFixed(1)).join(' ');
    const last = pts[pts.length-1];
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(pts.length-1).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="2" fill="${color}"/>
    </svg>`;
  }

  // Chains stop reporting an article when they stop selling it, but its last
  // recorded price would otherwise keep showing as that chain's current price —
  // Cetina in Konzum sat at a four-month-old €0,50, Sveti Rok in Studenac at a
  // price from June 2025. So an article counts as listed only while the chain is
  // still reporting it. The comparison is against THAT chain's own latest
  // reporting date, because chains skip weeks (Kaufland has blank weeks), and
  // against the selected end date, so browsing an earlier period still works.
  const STALE_AFTER = 2;          // weekly snapshots of slack
  let CHAIN_LAST_IDX = new Map(), CHAIN_LAST_FOR = -1;
  function chainLastSeen(){
    if(CHAIN_LAST_FOR === CUR_DATE_IDX) return CHAIN_LAST_IDX;
    const m = new Map();
    for(const r of OBS){
      if(r[0] > CUR_DATE_IDX) continue;
      const chain = PRODUCTS[r[1]][0];
      const cur = m.get(chain);
      if(cur === undefined || r[0] > cur) m.set(chain, r[0]);
    }
    CHAIN_LAST_IDX = m; CHAIN_LAST_FOR = CUR_DATE_IDX;
    return m;
  }

  function buildRows(matchIdxs){
    const rows=[];
    const lastSeen = chainLastSeen();
    matchIdxs.forEach(pi=>{
      const fullList = obsByProduct.get(pi);
      if(!fullList || fullList.length===0) return;
      const list = fullList.filter(r=> r[0] >= CUR_DATE_FROM_IDX && r[0] <= CUR_DATE_IDX);
      if(list.length===0) return;
      const last = list[list.length-1];
      const chainLast = lastSeen.get(PRODUCTS[pi][0]);
      if(chainLast !== undefined && chainLast - last[0] > STALE_AFTER) return;   // no longer listed
      const [chain,name,rawBrand,qty,unit] = PRODUCTS[pi];
      // fall back to the brand recovered from the name when the source left the
      // supplier column empty, so those rows aren't shown with a blank brand
      const brand = rawBrand || (PRODUCT_BRAND[pi]!==UNKNOWN_BRAND ? PRODUCT_BRAND[pi] : '');
      const wtype = PRODUCT_WTYPE[pi];
      const latestIso = DATES[last[0]];
      const d90 = new Date(latestIso+'T00:00:00'); d90.setDate(d90.getDate()-90);
      const d90iso = d90.toISOString().slice(0,10);
      const cand = list.filter(r=> DATES[r[0]] <= d90iso);
      const base = cand.length ? cand[cand.length-1] : null;
      const lastP = shelfPrice(last), baseP = base ? shelfPrice(base) : null;
      const change = baseP ? (lastP-baseP)/baseP*100 : null;
      const volKey = PRODUCT_VOLUME_KEY[pi], volLiters = PRODUCT_VOLUME_L[pi];
      const breakdown = last[6] || null; // [[price,storeCount],...] when the chain sold this at >1 price that day
      const onPromo = obsOnPromo(last);
      rows.push({ pi, chain, name, brand, qty, unit, wtype, volKey, volLiters, price:lastP, change, breakdown,
        onPromo,
        promoDepth:  onPromo ? obsPromoDepth(last) : null,
        promoStores: onPromo ? last[7] : 0,
        promoRun:    onPromo ? (PROMO_RUN_AT.get(pi+'|'+last[0]) || 1) : 0,
        storeCount:  last[5],
        pts: list.map(r=>[r[0],shelfPrice(r)]) });
    });
    return rows;
  }

  function sortRows(rows){
    const k = state.sortKey, dir = state.sortDir;
    const val = (r)=>{
      switch(k){
        case 'name': return r.name;
        case 'chain': return chainLabel(r.chain);
        case 'type': return TYPE_LABELS[r.wtype];
        case 'volume': return r.volLiters===null ? -1 : r.volLiters;
        case 'price': return r.price;
        case 'change': return r.change===null ? -Infinity : r.change;
        default: return r.name;
      }
    };
    rows.sort((a,b)=>{
      const va=val(a), vb=val(b);
      if(typeof va === 'string') return va.localeCompare(vb,'hr') * dir;
      return (va-vb) * dir;
    });
  }

  function renderTable(matchIdxs){
    let rows = buildRows(matchIdxs);
    sortRows(rows);
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total/state.pageSize));
    if(state.page >= totalPages) state.page = totalPages-1;
    if(state.page < 0) state.page = 0;
    const pageRows = rows.slice(state.page*state.pageSize, (state.page+1)*state.pageSize);

    const tbody = document.getElementById('tbody');
    document.getElementById('emptyMsg').style.display = total===0 ? '' : 'none';
    document.getElementById('tableCount').textContent = `${total.toLocaleString('hr-HR')} proizvoda`;
    document.getElementById('thPrice').textContent = state.dateTo === DATES[DATES.length-1] ? 'Zadnja cijena' : `Cijena (${fmtDateShort(state.dateTo)})`;

    tbody.innerHTML = pageRows.map(productRowHtml).join('');

    document.getElementById('pageInfo').textContent = total===0 ? '' : `Stranica ${state.page+1} / ${totalPages}`;
    document.getElementById('prevPage').disabled = state.page<=0;
    document.getElementById('nextPage').disabled = state.page>=totalPages-1;
  }

  // "Akcija −22% · 3. tj." beside a price the retailer currently flags as on offer
  function promoTag(r){
    if(!r.onPromo) return '';
    const pct = r.promoDepth !== null ? ' −' + Math.round(r.promoDepth*100) + '%' : '';
    const dur = r.promoRun > 1 ? ` <span class="promo-dur">${r.promoRun}. tj.</span>` : '';
    const bits = ['Označeno kao akcija u izvornim podacima'];
    if(r.promoDepth !== null) bits.push(`redovna cijena ${fmtEUR(r.price/(1-r.promoDepth))}`);
    if(r.promoStores && r.storeCount) bits.push(`u ${r.promoStores} od ${r.storeCount} poslovnica`);
    bits.push(r.promoRun > 1 ? `traje ${r.promoRun}. tjedan zaredom` : 'prvi tjedan');
    return `<div class="promo-tag" title="${escapeHtml(bits.join(' · '))}">Akcija${pct}${dur}</div>`;
  }

  // shared <tr> markup for both the full "Proizvodi" table and the "Najpopularnije
  // vode" table below — same columns, same formatting.
  function productRowHtml(r){
    const changeCls = r.change===null ? 'delta-flat' : (r.change>0.5?'delta-up':(r.change<-0.5?'delta-down':'delta-flat'));
    const changeTxt = r.change===null ? '—' : (r.change>0?'▲ ':(r.change<0?'▼ ':'≈ ')) + Math.abs(r.change).toFixed(1)+'%';
    const sparkColor = getComputedStyle(document.documentElement).getPropertyValue('--series-3').trim() || '#1baf7a';
    return `<tr>
      <td><div class="pname">${escapeHtml(r.name)}</div><div class="pmeta">${escapeHtml(r.brand||'')}${r.qty?(' · '+escapeHtml(r.qty)):''}</div></td>
      <td>${chainLabel(r.chain)}</td>
      <td><span class="type-badge">${TYPE_LABELS[r.wtype]}</span></td>
      <td>${volumeCellLabel(r.pi, r.volKey, r.volLiters)}</td>
      <td class="num"><span class="${r.onPromo?'promo-price':''}">${fmtEUR(r.price)}</span>${breakdownLabel(r.breakdown)}${promoTag(r)}</td>
      <td class="num"><span class="delta-pill ${changeCls}" style="padding:2px 8px;">${changeTxt}</span></td>
      <td>${sparklineSVG(r.pts, sparkColor)}</td>
    </tr>`;
  }

  // ---- focus matrix: the same article (brand + size) across the key chains ----
  // The everyday question — "where is Jana 1,5 l cheapest, and how far apart are
  // the chains?" — answered in one row per article. Fixed to the popular brands
  // and the seven key chains, like the popular-products table below it.
  const FOCUS_CHAINS = IMPORTANT_CHAINS.filter(c=>CHAINS.includes(c));
  const VOLUME_ORDER = new Map(VOLUME_CHIP_DEFS.map((d,i)=>[d.key,i]));
  // ---- headline price for the brands people ask about first ----
  // One tile per brand, showing the price you would actually pay: the median
  // shelf price of that brand's article across the key chains. A brand spans many
  // sizes, so a single number only means something for one size — 1,5 l is the
  // reference unless a size is picked in the filter above.
  const HERO_BRANDS = ['JANA','CETINA','STUDENA','SARA'];
  // Rendered as the first hero card (top left). Returns null when none of the
  // four brands has a price in the chosen size, so the hero can fall back to the
  // plain "cijena vode" number instead of showing four empty tiles.
  function renderHeroBrandsCard(fallbackDate){
    const refVols = state.volumes.size>0 ? Array.from(state.volumes) : ['s15'];
    const refLabel = refVols.map(volumeBucketLabel).join(' + ');

    const rows = buildRows(getPopularProductIdxs());
    const perBrand = new Map();
    rows.forEach(r=>{
      if(!refVols.includes(r.volKey)) return;
      const brand = PRODUCT_BRAND[r.pi];
      if(!HERO_BRANDS.includes(brand)) return;
      if(!perBrand.has(brand)) perBrand.set(brand, new Map());
      const byChain = perBrand.get(brand);
      if(!byChain.has(r.chain)) byChain.set(r.chain, []);
      byChain.get(r.chain).push(r);
    });
    if(perBrand.size===0) return null;

    const tiles = HERO_BRANDS.map(brand=>{
      const byChain = perBrand.get(brand);
      if(!byChain || byChain.size===0){
        return `<div class="brand-tile"><div class="brand-tile-name">${escapeHtml(brandLabel(brand))}</div>
          <div class="brand-tile-empty">nema u odabranoj veličini</div></div>`;
      }
      // one price per chain first, so a chain with many articles doesn't dominate
      const perChainPrice = [];
      byChain.forEach((list, chain)=> perChainPrice.push({chain, price: chainShelfPrice(list),
        onPromo: list.some(x=>x.onPromo)}));
      perChainPrice.sort((a,b)=>a.price-b.price);
      const mid = medianOf(perChainPrice.map(x=>x.price));
      const cheapest = perChainPrice[0];
      const promo = perChainPrice.filter(x=>x.onPromo).length;
      return `<div class="brand-tile">
        <div class="brand-tile-name">${escapeHtml(brandLabel(brand))}</div>
        <div class="brand-tile-value">${fmtEUR(mid)}<small>${escapeHtml(refLabel)}</small></div>
        <div class="brand-tile-sub">najjeftinije <b>${chainLabel(cheapest.chain)} ${fmtEUR(cheapest.price)}</b> · ${perChainPrice.length} ${perChainPrice.length===1?'lanac':'lanaca'}${promo?` · ${promo} na akciji`:''}</div>
      </div>`;
    }).join('');

    const d = fallbackDate || DATES[CUR_DATE_IDX];
    return `<div class="hero-main hero-brands">
      <span class="hero-label">Najpopularniji brendovi · tipična cijena · ${escapeHtml(refLabel)}</span>
      <div class="brand-strip">${tiles}</div>
      <div class="hero-sub">${fmtDate(d)}${missingChainsNote(DATES.indexOf(d))}</div>
    </div>`;
  }

  // ---- "Robne marke" view of table 01 ----
  // Each chain's own labels. Every one lives in exactly one chain, so a row per
  // brand would be a single filled cell; instead a row is a size and each chain
  // column shows its cheapest own-label water of that size, head to head.
  const PRIVATE_LABEL_CHAINS = ['kaufland','lidl','spar','eurospin','plodine'].filter(c=>CHAINS.includes(c));
  const PRIVATE_LABELS = {
    kaufland: ['K CLASSIC'],
    lidl:     ['SAGUARO'],
    spar:     ['S BUDGET','DESPAR','SPAR QUALITATSMARKE','SPAR'],
    eurospin: ['NO BRAND','BLUES','GINEVRA'],
    plodine:  ['VODA RM'],
  };
  const PRIVATE_LABEL_SHORT = { 'K CLASSIC':'K-Classic', 'SAGUARO':'Saguaro', 'S BUDGET':'S-Budget', 'DESPAR':'Despar',
    'SPAR QUALITATSMARKE':'Spar', 'SPAR':'Spar', 'NO BRAND':'No Brand', 'BLUES':'Blues', 'GINEVRA':'Ginevra', 'VODA RM':'Plodine' };
  function isPrivateLabel(pi){
    const [chain, name] = PRODUCTS[pi];
    const labels = PRIVATE_LABELS[chain];
    if(!labels) return false;
    // distilled water is sold under these labels too, but it is not drinking water
    // and would pass for the chain's cheapest big bottle
    if(/destil/i.test(stripDia(name))) return false;
    if(labels.includes(PRODUCT_BRAND[pi])) return true;
    // Plodine files its own water under a supplier code; the name carries the label
    return chain==='plodine' && /\bplodine\b/i.test(stripDia(name));
  }
  function getPrivateLabelIdxs(){
    const out = [];
    for(let pi=0; pi<PRODUCTS.length; pi++){
      if(!isPrivateLabel(pi) || SHADOW_LISTINGS.has(pi)) continue;
      if(!state.types.has(PRODUCT_WTYPE[pi])) continue;
      if(state.volumes.size>0 && !state.volumes.has(PRODUCT_VOLUME_KEY[pi])) continue;
      if(state.q && !stripDia(PRODUCTS[pi][1]+' '+PRODUCTS[pi][2]).includes(state.q)) continue;
      out.push(pi);
    }
    return out;
  }
  function renderPrivateLabelMatrix(wrap, note){
    const byVol = new Map();   // volKey -> Map(chain -> [rows])
    buildRows(getPrivateLabelIdxs()).forEach(r=>{
      if(r.volKey==='unknown' || r.volKey==='pack') return;
      if(!byVol.has(r.volKey)) byVol.set(r.volKey, new Map());
      const m = byVol.get(r.volKey);
      if(!m.has(r.chain)) m.set(r.chain, []);
      m.get(r.chain).push(r);
    });
    const vols = Array.from(byVol.keys()).sort((a,b)=> VOLUME_ORDER.get(a)-VOLUME_ORDER.get(b));
    if(vols.length===0){
      wrap.innerHTML = '<div class="empty">Nema robnih marki za odabrani filtar.</div>';
      note.textContent = '';
      return;
    }
    note.textContent = `Robne marke · ${vols.length} veličina × ${PRIVATE_LABEL_CHAINS.length} lanaca`;

    let html = '<table class="matrix focus-table"><thead>';
    html += `<tr class="grouprow"><th class="brand-head"></th><th colspan="${PRIVATE_LABEL_CHAINS.length}">najjeftinija robna marka lanca</th></tr>`;
    html += '<tr class="colrow"><th class="brand-head">Veličina</th>';
    PRIVATE_LABEL_CHAINS.forEach(c=> html += `<th>${chainLabel(c)}</th>`);
    html += '</tr></thead><tbody>';
    vols.forEach(v=>{
      const m = byVol.get(v);
      // per chain: each own-label article at the price most of its stores charge,
      // then the cheapest of them
      const picks = PRIVATE_LABEL_CHAINS.map(c=>{
        const rows = m.get(c);
        if(!rows) return null;
        const priced = rows.map(r=>({ r, p: chainShelfPrice([r]) })).sort((a,b)=> a.p-b.p);
        return { best: priced[0], all: priced };
      });
      const present = picks.filter(Boolean).map(x=>x.best.p);
      const minV = Math.min(...present);
      html += `<tr><td class="brand-cell">${escapeHtml(volumeBucketLabel(v))}</td>`;
      picks.forEach((pk,i)=>{
        if(!pk){ html += '<td class="num empty-cell">–</td>'; return; }
        const r = pk.best.r;
        const cheap = present.length>1 && Math.abs(pk.best.p-minV)<1e-9;
        const brandShort = PRIVATE_LABEL_SHORT[PRODUCT_BRAND[r.pi]] || (PRIVATE_LABEL_CHAINS[i]==='plodine' ? 'Plodine' : brandLabel(PRODUCT_BRAND[r.pi]));
        let title = `${chainLabel(PRIVATE_LABEL_CHAINS[i])} · ` + pk.all.map(x=>`${x.r.name}: ${fmtEUR(x.p)} (${x.r.storeCount} posl.)`).join('\n');
        if(r.onPromo) title += ` · NA AKCIJI${r.promoDepth!==null?' (−'+Math.round(r.promoDepth*100)+'%)':''}`;
        const cls = 'num' + (cheap?' focus-cheap':'') + (r.onPromo?' focus-promo':'');
        html += `<td class="${cls}" title="${escapeHtml(title)}">${fmtEUR(pk.best.p)}<span class="pl-brand">${escapeHtml(brandShort)}</span></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function renderFocusMatrix(){
    const wrap = document.getElementById('focusMatrixWrap');
    const note = document.getElementById('focusNote');
    const isPrivate = state.focusMode==='private';
    document.getElementById('focusTitle').textContent = isPrivate ? 'Robne marke u najjačim dućanima' : 'Najpopularnije marke u najjačim dućanima';
    document.getElementById('focusPurpose').textContent = isPrivate
      ? 'Vlastite marke lanaca jedna do druge: jedan redak = veličina, u ćeliji najjeftinija robna marka tog lanca.'
      : 'Tko je koliko skup: jedan redak = marka + veličina, jedan stupac = lanac, u ćeliji zadnja cijena.';
    if(isPrivate) return renderPrivateLabelMatrix(wrap, note);
    const rows = buildRows(getPopularProductIdxs());
    const groups = new Map(); // `${brand}||${volKey}` -> {brand, volKey, chains: Map(chain -> {sum,count,names})}
    rows.forEach(r=>{
      // 4 pack and 6 pack are a single, well-defined article (four or six 1,5 l
      // bottles), so they compare across chains like any bottle size. The general
      // "Pakiranje" bucket does not — it mixes 12×0,5 l with 24×0,33 l trays.
      if(r.volKey==='unknown' || r.volKey==='pack') return;
      const brand = PRODUCT_BRAND[r.pi];
      const key = brand+'||'+r.volKey;
      if(!groups.has(key)) groups.set(key, {brand, volKey:r.volKey, chains:new Map()});
      const g = groups.get(key);
      if(!g.chains.has(r.chain)) g.chains.set(r.chain, {prices:[],rows:[],count:0,names:[],promo:0,depth:null});
      const c = g.chains.get(r.chain); c.prices.push(r.price); c.rows.push(r); c.count++; c.names.push(r.name);
      if(r.onPromo){ c.promo++; if(r.promoDepth !== null) c.depth = Math.max(c.depth ?? 0, r.promoDepth); }
    });
    // Every article of a curated brand gets a row, including ones only one chain
    // carries — a private label (S Budget, K Classic) can never be in two chains,
    // and "only Lidl stocks this" is itself worth seeing. Such rows simply have no
    // range to report.
    const list = Array.from(groups.values());
    const brandRank = new Map(POPULAR_BRANDS.map((b,i)=>[b,i]));
    list.sort((a,b)=> (brandRank.get(a.brand)-brandRank.get(b.brand)) || (VOLUME_ORDER.get(a.volKey)-VOLUME_ORDER.get(b.volKey)));

    if(list.length===0){
      wrap.innerHTML = '<div class="empty">Nema podataka za odabrano razdoblje i filtar.</div>';
      note.textContent = '';
      return;
    }
    note.textContent = `${list.length} artikala × ${FOCUS_CHAINS.length} lanaca`;

    let html = '<table class="matrix focus-table"><thead>';
    html += `<tr class="grouprow"><th class="brand-head"></th><th colspan="${FOCUS_CHAINS.length}">cijena po lancu</th></tr>`;
    html += '<tr class="colrow"><th class="brand-head">Artikl</th>';
    FOCUS_CHAINS.forEach(c=> html += `<th>${chainLabel(c)}</th>`);
    html += '</tr></thead><tbody>';
    list.forEach(g=>{
      // the price most of the chain's stores actually charge, so a one-store duplicate
      // listing can't drag the cell to a price nobody pays
      const vals = FOCUS_CHAINS.map(c=>{ const o=g.chains.get(c); return o ? chainShelfPrice(o.rows) : null; });
      const present = vals.filter(v=>v!==null);
      const minV = Math.min(...present);
      html += `<tr><td class="brand-cell">${escapeHtml(brandLabel(g.brand))} <span class="focus-vol">· ${volumeBucketLabel(g.volKey)}</span></td>`;
      FOCUS_CHAINS.forEach((c,i)=>{
        const v = vals[i];
        if(v===null){ html += '<td class="num empty-cell">–</td>'; return; }
        const o = g.chains.get(c);
        const cheap = present.length>1 && Math.abs(v-minV)<1e-9;
        let title = `${chainLabel(c)} · ${o.count} ${o.count===1?'artikl':'artikla'}: ${o.names.slice(0,4).join(' · ')}${o.names.length>4?' …':''}`;
        if(o.count>1){
          const alt = o.rows.map(x=>`${x.name}: ${fmtEUR(x.price)} (${x.storeCount} posl.)`).join('\n');
          const rule = preferPromoPacks(o.rows).length < o.rows.length
            ? 'prikazana je cijena akcijskog pakiranja (4+2 / 5+1)'
            : 'cijena koju naplaćuje najviše poslovnica';
          title = `${chainLabel(c)} · ${rule}\n${alt}`;
        }
        if(o.promo) title += ` · NA AKCIJI${o.depth!==null?' (−'+Math.round(o.depth*100)+'%)':''}`;
        const cls = 'num' + (cheap?' focus-cheap':'') + (o.promo?' focus-promo':'');
        html += `<td class="${cls}" title="${escapeHtml(title)}">${fmtEUR(v)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  // ================= LONG-TERM PRICE GROWTH =================
  // The question this answers is "je li ovaj artikl stvarno poskupio", not "je li
  // ovaj tjedan jeftiniji". Two things keep a promotion from being mistaken for a
  // price move: promo weeks are replaced by the regular (anchor) price the retailer
  // files alongside the discount, and a new price is only accepted as a price LEVEL
  // once it holds for the chosen number of weekly snapshots. What is compared is the
  // first stable level in the range with the last one.
  const GROWTH_TOL = 0.02;        // ±2% counts as the same price level
  const GROWTH_MIN_POINTS = 6;    // weekly snapshots needed before a trend is claimed
  const GROWTH_MIN_SPAN = 10;     // ... spread over at least this many weeks

  function regularPrice(row){
    if(obsOnPromo(row)) return row[8] > 0 ? row[8] : null;   // on promo: use the filed regular price
    return shelfPrice(row);
  }
  // this panel carries its own period (picked in its header), so it can look at a
  // long window while the rest of the page sits on a single date
  let GROWTH_FROM_IDX = 0, GROWTH_TO_IDX = 0;
  function regularSeries(pi){
    const list = obsByProduct.get(pi); if(!list) return [];
    const cap = PRODUCT_OUTLIER_CAP[pi];
    const pts = [];
    for(const r of list){
      if(r[0] < GROWTH_FROM_IDX || r[0] > GROWTH_TO_IDX) continue;
      const p = regularPrice(r);
      if(p === null || p < OUTLIER_FLOOR || p > cap) continue;
      pts.push([r[0], p]);
    }
    return pts;
  }
  // split a price series into stable levels; a value that differs from the current
  // level but doesn't hold long enough is discarded as noise rather than starting one
  function priceLevels(pts, minHold){
    if(pts.length===0) return [];
    const levels = [{ startIdx: pts[0][0], endIdx: pts[0][0], vals:[pts[0][1]], price: pts[0][1] }];
    for(let i=1;i<pts.length;i++){
      const v = pts[i][1];
      const cur = levels[levels.length-1];
      if(Math.abs(v-cur.price)/cur.price <= GROWTH_TOL){
        cur.vals.push(v); cur.price = medianOf(cur.vals); cur.endIdx = pts[i][0];
        continue;
      }
      let hold = 1;
      while(i+hold < pts.length && Math.abs(pts[i+hold][1]-v)/v <= GROWTH_TOL) hold++;
      // accept when it holds long enough, or when it runs to the end of the series
      // (that one is simply the price in force right now)
      if(hold >= minHold || i+hold >= pts.length){
        levels.push({ startIdx: pts[i][0], endIdx: pts[i][0], vals:[v], price:v });
      }
      // otherwise: a blip — ignored entirely, it never enters a level
    }
    // The opening level gets the same test as every other one. Without this, a
    // promotion in the very first week of the range becomes the baseline and the
    // article looks like it exploded in price — and for the first three weeks of
    // the archive (svibanj 2025.) the source had no promo flag at all, so that is
    // exactly what happened to e.g. Radenska 1,5 l in Tommy (€0,57 → €0,99).
    while(levels.length > 1 && levels[0].vals.length < minHold) levels.shift();
    return levels;
  }
  function growthStats(pi, minHold){
    const pts = regularSeries(pi);
    if(pts.length < GROWTH_MIN_POINTS) return null;
    const span = pts[pts.length-1][0] - pts[0][0];
    if(span < GROWTH_MIN_SPAN) return null;
    const levels = priceLevels(pts, minHold);
    const base = levels[0].price, now = levels[levels.length-1].price;
    if(!(base > 0)) return null;
    const pct = (now-base)/base*100;
    const annual = (Math.pow(now/base, 52/Math.max(span,1)) - 1) * 100;
    const changes = levels.slice(1).map((l,i)=>({ dateIdx:l.startIdx, from:levels[i].price, to:l.price,
      pct:(l.price-levels[i].price)/levels[i].price*100 }));
    const lastRow = (obsByProduct.get(pi)||[]).filter(r=> r[0]>=GROWTH_FROM_IDX && r[0]<=GROWTH_TO_IDX).pop();
    return { pi, pts, base, now, pct, annual, abs: now-base, span, stores: lastRow ? lastRow[5] : 0,
             steps: changes, ups: changes.filter(c=>c.pct>0).length, downs: changes.filter(c=>c.pct<0).length,
             last: changes.length ? changes[changes.length-1] : null };
  }

  function renderGrowthPeriod(){
    const fSel = document.getElementById('growthFromSel');
    const tSel = document.getElementById('growthToSel');
    if(!fSel.options.length){
      const opts = DATES.map(d=>`<option value="${d}">${fmtDate(d)}</option>`).join('');
      fSel.innerHTML = opts; tSel.innerHTML = opts;
    }
    fSel.value = state.growthFrom; tSel.value = state.growthTo;
    const weeks = GROWTH_TO_IDX - GROWTH_FROM_IDX;
    const atEnd = GROWTH_TO_IDX === DATES.length-1;
    document.querySelectorAll('[data-growth-preset]').forEach(btn=>{
      const v = btn.dataset.growthPreset;
      const on = atEnd && (v==='all' ? GROWTH_FROM_IDX===0 : weeks === +v && GROWTH_FROM_IDX>0);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function setGrowthPeriod(from, to){
    state.growthFrom = from; state.growthTo = to;
    if(state.growthFrom > state.growthTo) state.growthFrom = state.growthTo;
    renderGrowthPanel();
  }

  function renderGrowthControls(idxs){
    const bSel = document.getElementById('growthBrandSel');
    const vSel = document.getElementById('growthVolSel');
    const brandCount = new Map(), volCount = new Map();
    idxs.forEach(pi=>{
      const b = PRODUCT_BRAND[pi];
      brandCount.set(b, (brandCount.get(b)||0)+1);
      if(!state.growthBrand || state.growthBrand===b){
        const v = PRODUCT_VOLUME_KEY[pi];
        if(v!=='unknown' && v!=='pack') volCount.set(v, (volCount.get(v)||0)+1);
      }
    });
    if(state.growthBrand && !brandCount.has(state.growthBrand)) state.growthBrand='';
    if(state.growthVol && !volCount.has(state.growthVol)) state.growthVol='';
    const brands = POPULAR_BRANDS.filter(b=>brandCount.has(b));
    bSel.innerHTML = '<option value="">Sve popularne marke</option>' + brands.map(b=>
      `<option value="${escapeHtml(b)}"${b===state.growthBrand?' selected':''}>${escapeHtml(brandLabel(b))}</option>`).join('');
    const vols = Array.from(volCount.keys()).sort((a,b)=>
      (VOLUME_ORDER.has(a)?VOLUME_ORDER.get(a):99) - (VOLUME_ORDER.has(b)?VOLUME_ORDER.get(b):99));
    vSel.innerHTML = '<option value="">Sve veličine</option>' + vols.map(v=>
      `<option value="${escapeHtml(v)}"${v===state.growthVol?' selected':''}>${escapeHtml(volumeBucketLabel(v))}</option>`).join('');
    document.getElementById('growthHoldSel').value = String(state.growthHold);
    document.getElementById('growthMetricSel').value = state.growthMetric;
    document.getElementById('growthScopeSel').value = state.growthScope;
  }

  const GROWTH_METRIC_LABEL = { pct:'promjena', annual:'godišnja stopa', abs:'promjena u €' };
  function growthValue(st){
    return state.growthMetric==='annual' ? st.annual : state.growthMetric==='abs' ? st.abs : st.pct;
  }
  function fmtGrowth(v){
    if(state.growthMetric==='abs') return (v>0?'+':v<0?'−':'') + fmtEUR(Math.abs(v));
    return (v>0?'+':v<0?'−':'') + Math.abs(v).toFixed(1).replace('.',',') + '%';
  }
  // strength of the cell tint, 0–1; ±15% (or ±0,15 €) is full colour
  function growthWeight(v){
    const cap = state.growthMetric==='abs' ? 0.15 : 15;
    return Math.min(1, Math.abs(v)/cap);
  }

  function renderGrowthPanel(){
    const wrap = document.getElementById('growthWrap');
    const note = document.getElementById('growthNote');
    const legend = document.getElementById('growthLegend');
    const lead = document.getElementById('growthLead');
    const minHold = state.growthHold;
    const fi = DATES.indexOf(state.growthFrom), ti = DATES.indexOf(state.growthTo);
    GROWTH_FROM_IDX = fi>=0 ? fi : 0;
    GROWTH_TO_IDX = ti>=0 ? ti : DATES.length-1;
    renderGrowthPeriod();

    // candidate articles: the curated brands in the key chains, independent of the
    // chain chips but honouring the type filter and the search box
    const idxs = [];
    for(let i=0;i<PRODUCTS.length;i++){
      const [chain,name,brand] = PRODUCTS[i];
      if(!IMPORTANT_CHAINS_SET.has(chain)) continue;
      if(SHADOW_LISTINGS.has(i)) continue;
      if(DISCONTINUED_BRANDS.has(PRODUCT_BRAND[i]) || DELISTED.has(PRODUCT_BRAND[i]+'|'+chain)) continue;
      if(DISCONTINUED_ARTICLES.has(PRODUCT_BRAND[i]+'|'+PRODUCT_VOLUME_KEY[i])) continue;
      if(!POPULAR_BRANDS_SET.has(PRODUCT_BRAND[i])) continue;
      if(!state.types.has(PRODUCT_WTYPE[i])) continue;
      if(state.q && !stripDia(name+' '+brand).includes(state.q)) continue;
      idxs.push(i);
    }
    renderGrowthControls(idxs);

    const groups = new Map();   // `${brand}||${volKey}` -> {brand, volKey, chains:Map(chain->[stats])}
    idxs.forEach(pi=>{
      const brand = PRODUCT_BRAND[pi], volKey = PRODUCT_VOLUME_KEY[pi];
      if(volKey==='unknown' || volKey==='pack') return;
      if(state.growthBrand && brand!==state.growthBrand) return;
      if(state.growthVol && volKey!==state.growthVol) return;
      const st = growthStats(pi, minHold);
      if(!st) return;
      const key = brand+'||'+volKey;
      if(!groups.has(key)) groups.set(key, {brand, volKey, chains:new Map()});
      const g = groups.get(key);
      const chain = PRODUCTS[pi][0];
      if(!g.chains.has(chain)) g.chains.set(chain, []);
      g.chains.get(chain).push(st);
    });

    const rows = Array.from(groups.values()).map(g=>{
      const cells = FOCUS_CHAINS.map(c=>{
        const list = g.chains.get(c);
        if(!list || list.length===0) return null;
        const pick = list.slice().sort((a,b)=> b.stores-a.stores || b.pts.length-a.pts.length)[0];  // the listing most stores carry
        return { chain:c, st:pick };
      });
      const present = cells.filter(Boolean);
      const med = medianOf(present.map(x=>growthValue(x.st)));
      const base = medianOf(present.map(x=>x.st.base));
      const now = medianOf(present.map(x=>x.st.now));
      // one median series across the chains, for the sparkline
      const byDate = new Map();
      present.forEach(x=> x.st.pts.forEach(([d,v])=>{ if(!byDate.has(d)) byDate.set(d,[]); byDate.get(d).push(v); }));
      const pts = Array.from(byDate.entries()).sort((a,b)=>a[0]-b[0]).map(([d,vals])=>[d, medianOf(vals)]);
      const steps = present.reduce((a,x)=>a+x.st.steps.length, 0);
      const lastIdx = present.reduce((a,x)=> x.st.last ? Math.max(a, x.st.last.dateIdx) : a, -1);
      return { ...g, cells, present, med, base, now, pts, steps, lastIdx };
    }).filter(r=> r.present.length>0);

    if(rows.length===0){
      wrap.innerHTML = '<div class="empty">Za odabir nema artikala s dovoljno dugim nizom cijena (traži se barem 6 tjednih snimaka kroz 10+ tjedana).</div>';
      note.textContent=''; legend.innerHTML=''; lead.innerHTML=''; return;
    }
    rows.sort((a,b)=> b.med-a.med);
    // most articles simply hold their price for months — by default the table shows
    // the ones that actually moved, so the picture isn't buried under flat rows
    const moved = (r)=> r.present.some(x=> Math.abs(x.st.pct) >= 1);
    const hidden = rows.filter(r=>!moved(r)).length;
    const shown = state.growthScope==='all' ? rows : rows.filter(moved);

    const spanWeeks = GROWTH_TO_IDX - GROWTH_FROM_IDX;
    note.textContent = `${shown.length} ${pluralHr(shown.length,'artikl','artikla','artikala')} × ${FOCUS_CHAINS.length} lanaca · ${fmtDate(DATES[GROWTH_FROM_IDX])} – ${fmtDate(DATES[GROWTH_TO_IDX])} (${spanWeeks} ${pluralHr(spanWeeks,'tjedan','tjedna','tjedana')})`
      + (state.growthScope==='all' || hidden===0 ? '' : ` · ${hidden} bez promjene skriveno`);

    // ---- headline: how the selection moved overall, and the extremes ----
    const allVals = rows.flatMap(r=> r.present.map(x=>growthValue(x.st)));
    const overall = allVals.reduce((a,v)=>a+v,0)/allVals.length;   // prosjek kroz sve kombinacije
    const overallMed = medianOf(allVals);
    const movedShare = allVals.filter(v=>Math.abs(v) > (state.growthMetric==='abs'?0.01:1)).length / allVals.length;
    const risers = rows.filter(r=>r.med>0.5).length, fallers = rows.filter(r=>r.med<-0.5).length;
    const top = rows[0], bottom = rows[rows.length-1];
    const cheapestChain = (r)=>{
      const best = r.present.slice().sort((a,b)=> growthValue(b.st)-growthValue(a.st))[0];
      return best ? `${chainLabel(best.chain)} ${fmtGrowth(growthValue(best.st))}` : '';
    };
    lead.innerHTML = `
      <div class="grow-stat">
        <div class="grow-stat-label">Tipičan pomak u odabiru</div>
        <div class="grow-stat-value ${overall>0?'grow-up':overall<0?'grow-down':''}">${fmtGrowth(overall)}</div>
        <div class="grow-stat-sub">prosjek kroz ${allVals.length} kombinacija artikl × lanac · medijan ${fmtGrowth(overallMed)} · ${Math.round(movedShare*100)}% ih se uopće mijenjalo</div>
      </div>
      <div class="grow-stat">
        <div class="grow-stat-label">Poskupjelo / pojeftinilo</div>
        <div class="grow-stat-value">${risers} <small style="font-family:'IBM Plex Sans',sans-serif;font-size:13px;color:var(--ink-muted)">/ ${fallers}</small></div>
        <div class="grow-stat-sub">od ${rows.length} artikala u odabiru</div>
      </div>
      <div class="grow-stat">
        <div class="grow-stat-label">Najviše poskupjelo</div>
        <div class="grow-stat-value grow-up" style="font-size:19px">${escapeHtml(brandLabel(top.brand))} · ${escapeHtml(volumeBucketLabel(top.volKey))}</div>
        <div class="grow-stat-sub">${fmtGrowth(top.med)} · ${fmtEUR(top.base)} → ${fmtEUR(top.now)} · najviše ${escapeHtml(cheapestChain(top))}</div>
      </div>
      <div class="grow-stat">
        <div class="grow-stat-label">Najviše pojeftinilo</div>
        ${fallers>0
          ? `<div class="grow-stat-value grow-down" style="font-size:19px">${escapeHtml(brandLabel(bottom.brand))} · ${escapeHtml(volumeBucketLabel(bottom.volKey))}</div>
             <div class="grow-stat-sub">${fmtGrowth(bottom.med)} · ${fmtEUR(bottom.base)} → ${fmtEUR(bottom.now)}</div>`
          : `<div class="grow-stat-value" style="font-size:19px;color:var(--ink-muted)">nijedan artikl</div>
             <div class="grow-stat-sub">${rows.length-risers} ${pluralHr(rows.length-risers,'artikl je','artikla su','artikala je')} ostalo na istoj cijeni</div>`}
      </div>`;

    // ---- the matrix ----
    let html = '<table class="matrix grow-table"><thead>';
    html += `<tr class="grouprow"><th class="brand-head"></th><th colspan="${FOCUS_CHAINS.length}">promjena po lancu</th><th class="colsep" colspan="3">sažetak</th></tr>`;
    html += '<tr class="colrow"><th class="brand-head">Artikl</th>';
    FOCUS_CHAINS.forEach(c=> html += `<th>${chainLabel(c)}</th>`);
    html += '<th class="colsep">Ukupno</th><th>Prije → sada</th><th>Kretanje</th></tr></thead><tbody>';
    const sparkNeutral = getComputedStyle(document.documentElement).getPropertyValue('--ink-muted').trim() || '#8a8f98';
    if(shown.length===0){
      wrap.innerHTML = '<div class="empty">Nijednom artiklu u odabiru cijena se nije trajno promijenila u ovom razdoblju.</div>';
      legend.innerHTML=''; return;
    }
    shown.forEach(r=>{
      html += `<tr><td class="brand-cell">${escapeHtml(brandLabel(r.brand))} <span class="focus-vol">· ${escapeHtml(volumeBucketLabel(r.volKey))}</span></td>`;
      r.cells.forEach((cell,i)=>{
        if(!cell){ html += '<td class="num empty-cell">–</td>'; return; }
        const st = cell.st, v = growthValue(st);
        const w = growthWeight(v);
        const flat = Math.abs(st.pct) < 1;
        const hue = v>0 ? 'var(--promo)' : 'var(--accent)';
        const bg = flat ? '' : `background:color-mix(in srgb, ${hue} ${(w*26+6).toFixed(0)}%, transparent);`;
        const fg = flat ? '' : `color:${v>0?'var(--promo-ink)':'var(--accent-ink)'};`;
        const stepTxt = st.steps.length
          ? st.steps.slice(-3).map(c=>`${fmtDateShort(DATES[c.dateIdx])}: ${fmtEUR(c.from)} → ${fmtEUR(c.to)}`).join('\n')
          : 'nije bilo trajne promjene cijene';
        const title = `${chainLabel(cell.chain)} · ${PRODUCTS[st.pi][1]}\n${fmtEUR(st.base)} → ${fmtEUR(st.now)} (${fmtGrowth(st.pct)})\ngodišnje ${fmtGrowth(st.annual)} · ${st.steps.length} ${pluralHr(st.steps.length,'trajna promjena','trajne promjene','trajnih promjena')} kroz ${st.span} ${pluralHr(st.span,'tjedan','tjedna','tjedana')}\n${stepTxt}`;
        html += `<td class="grow-cell${flat?' grow-flat':''}" style="${bg}${fg}" title="${escapeHtml(title)}">${flat ? (state.growthMetric==='abs' ? '≈0 €' : '≈0%') : fmtGrowth(v)}</td>`;
      });
      const medCls = r.med>0.5 ? 'grow-up' : r.med<-0.5 ? 'grow-down' : '';
      html += `<td class="grow-sum colsep ${medCls}" style="font-weight:600">${fmtGrowth(r.med)}<small>${r.present.length} ${pluralHr(r.present.length,'lanac','lanca','lanaca')}</small></td>`;
      const priceTitle = `${r.steps} ${pluralHr(r.steps,'trajna promjena','trajne promjene','trajnih promjena')} kroz ${r.present.length} ${pluralHr(r.present.length,'lanac','lanca','lanaca')}`
        + (r.lastIdx>=0 ? ` · zadnja ${fmtDate(DATES[r.lastIdx])}` : '');
      html += `<td class="grow-sum" title="${escapeHtml(priceTitle)}">${fmtEUR(r.base)}→${fmtEUR(r.now)}</td>`;
      html += `<td>${sparklineSVG(r.pts, r.med>0.5 ? (getComputedStyle(document.documentElement).getPropertyValue('--promo').trim()||sparkNeutral) : r.med<-0.5 ? (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||sparkNeutral) : sparkNeutral)}</td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    legend.innerHTML = `<span>Prikazano: <b>${GROWTH_METRIC_LABEL[state.growthMetric]}</b> · nova cijena se priznaje nakon ${minHold} ${minHold===2?'tjedna':'tjedana'} · akcije isključene.</span>`
      + `<span style="margin-left:auto;">Prijeđi mišem preko ćelije lanca za datume i iznose svake trajne promjene, a preko stupca „Cijena" za broj promjena i datum zadnje. Artikli s premalo tjedana u razdoblju se ne prikazuju.</span>`;
  }

  // Static sort (brand, then product name) — this table has no interactive sort
  // headers, it's meant to be a fixed, quick-scan reference.
  function renderPopularTable(){
    const bSel = document.getElementById('popularBrandSel');
    const cSel = document.getElementById('popularChainSel');
    if(!bSel.dataset.filled){
      bSel.innerHTML = '<option value="">Sve marke</option>' + POPULAR_BRANDS.map(b=>
        `<option value="${escapeHtml(b)}">${escapeHtml(brandLabel(b))}</option>`).join('');
      cSel.innerHTML = '<option value="">Svi lanci</option>' + IMPORTANT_CHAINS.filter(c=>CHAINS.includes(c)).map(c=>
        `<option value="${escapeHtml(c)}">${escapeHtml(chainLabel(c))}</option>`).join('');
      bSel.dataset.filled = '1';
      bSel.addEventListener('change', ()=>{ state.popularBrand = bSel.value; renderPopularTable(); });
      cSel.addEventListener('change', ()=>{ state.popularChain = cSel.value; renderPopularTable(); });
    }
    bSel.value = state.popularBrand;
    cSel.value = state.popularChain;

    const idxs = getPopularProductIdxs();
    let rows = buildRows(idxs);
    rows.sort((a,b)=> (a.brand||'').localeCompare(b.brand||'','hr') || a.name.localeCompare(b.name,'hr'));

    const tbody = document.getElementById('tbodyPopular');
    document.getElementById('emptyMsgPopular').style.display = rows.length===0 ? '' : 'none';
    document.getElementById('popularCount').textContent = `${rows.length.toLocaleString('hr-HR')} proizvoda`;
    document.getElementById('thPricePopular').textContent = state.dateTo === DATES[DATES.length-1] ? 'Zadnja cijena' : `Cijena (${fmtDateShort(state.dateTo)})`;
    tbody.innerHTML = rows.map(productRowHtml).join('');
  }

  function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // A chain doesn't always sell a product at one uniform price on a given day — e.g.
  // Tommy commonly has several distinct price tiers across its stores at once, not
  // just a min and a max with everything smoothly in between. When we have that
  // breakdown for the row's date, show it as a small "N razina" label whose native
  // tooltip lists each price and how many stores reported it.
  function breakdownLabel(bd){
    if(!bd || bd.length<2) return '';
    let top = bd[0];
    for(const t of bd){ if(t[1] > top[1] || (t[1] === top[1] && t[0] < top[0])) top = t; }
    const title = bd.map(([p,c])=>
      `${fmtEUR(p)} · ${c} poslovnica${p===top[0] ? '  ← prikazana cijena' : ''}`).join('\n');
    return `<div class="pmeta" title="${escapeHtml(title)}" style="text-align:right; text-decoration:underline dotted; text-underline-offset:2px; cursor:help;">${bd.length} razine cijena</div>`;
  }

  // ================= BRAND x CHAIN MATRIX =================
  function renderBrandMatrix(matchIdxs){
    const wrap = document.getElementById('matrixWrap');
    const note = document.getElementById('matrixNote');
    const lastSeen = chainLastSeen();

    // brand -> chain -> {sum,count} using each product's latest price
    const cell = new Map(); // key `${brand}||${chain}` -> {sum,count}
    const brandChains = new Map(); // brand -> Set(chain)
    const chainsUsed = new Set();
    matchIdxs.forEach(pi=>{
      const fullList = obsByProduct.get(pi);
      if(!fullList || fullList.length===0) return;
      const list = fullList.filter(r=> r[0] >= CUR_DATE_FROM_IDX && r[0] <= CUR_DATE_IDX);
      if(list.length===0) return;
      const chain = PRODUCTS[pi][0];
      const cb = PRODUCT_BRAND[pi];   // cleaned + recovered brand, same identity as everywhere else
      const last = list[list.length-1];
      const chainLast = lastSeen.get(chain);
      if(chainLast !== undefined && chainLast - last[0] > STALE_AFTER) return;   // no longer listed
      const key = cb+'||'+chain;
      if(!cell.has(key)) cell.set(key, {sum:0,count:0});
      const o = cell.get(key); o.sum += shelfPrice(last); o.count++;
      if(!brandChains.has(cb)) brandChains.set(cb, new Set());
      brandChains.get(cb).add(chain);
      chainsUsed.add(chain);
    });

    const chainCols = CHAINS.filter(c=>chainsUsed.has(c));
    const brands = Array.from(brandChains.keys()).sort((a,b)=>{
      const diff = brandChains.get(b).size - brandChains.get(a).size;
      return diff!==0 ? diff : a.localeCompare(b,'hr');
    });

    if(brands.length===0 || chainCols.length===0){
      wrap.innerHTML = '<div class="empty">Nema podataka za odabrani filtar.</div>';
      note.textContent = '';
      return;
    }
    note.textContent = `${brands.length} marki × ${chainCols.length} lanaca`;

    let html = '<table class="matrix"><thead><tr><th class="brand-head">Marka</th>';
    chainCols.forEach(c=> html += `<th title="${chainLabel(c)}">${chainLabel(c)}</th>`);
    html += '</tr></thead><tbody>';
    brands.forEach(b=>{
      html += `<tr><td class="brand-cell">${escapeHtml(brandLabel(b))}</td>`;
      chainCols.forEach(c=>{
        const o = cell.get(b+'||'+c);
        if(o){ html += `<td class="num">${fmtEUR(o.sum/o.count)}</td>`; }
        else { html += `<td class="num empty-cell">–</td>`; }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  // ================= PROMO ("AKCIJE") =================
  // Aggregate the pre-computed promo events down to brand × chain, restricted to
  // the current filters and the selected period.
  function computePromoAgg(matchIdxs, rowKeyFn){
    rowKeyFn = rowKeyFn || (pi=>PRODUCT_BRAND[pi]);
    const matchSet = new Set(matchIdxs);
    const cells = new Map();        // `${rowKey}||${chain}` -> {count, depths[], promoWeeks, obsWeeks}
    const rowTotals = new Map();    // rowKey -> promo count
    const chainsUsed = new Set();
    const rowsWithData = new Set();

    matchIdxs.forEach(pi=>{
      const list = obsByProduct.get(pi);
      if(!list || list.length===0) return;
      let obsWeeks = 0;
      for(const r of list){ if(r[0]>=CUR_DATE_FROM_IDX && r[0]<=CUR_DATE_IDX) obsWeeks++; }
      if(obsWeeks===0) return;
      const rowKey = rowKeyFn(pi), chain = PRODUCTS[pi][0];
      const key = rowKey+'||'+chain;
      if(!cells.has(key)) cells.set(key, {count:0, depths:[], durations:[], promoWeeks:0, obsWeeks:0});
      const cell = cells.get(key);
      cell.obsWeeks += obsWeeks;
      chainsUsed.add(chain);
      rowsWithData.add(rowKey);
      const weeks = PROMO_WEEKS_BY_PI.get(pi);
      if(weeks) weeks.forEach(w=>{ if(w>=CUR_DATE_FROM_IDX && w<=CUR_DATE_IDX) cell.promoWeeks++; });
    });

    PROMO_EVENTS.forEach(e=>{
      if(!matchSet.has(e.pi)) return;
      if(e.to < CUR_DATE_FROM_IDX || e.from > CUR_DATE_IDX) return;   // outside the period
      const rowKey = rowKeyFn(e.pi);
      const cell = cells.get(rowKey+'||'+e.chain);
      if(!cell) return;
      cell.count++; cell.durations.push(e.weeks);
      if(e.depth > 0) cell.depths.push(e.depth);
      rowTotals.set(rowKey, (rowTotals.get(rowKey)||0)+1);
    });

    return {cells, rowTotals, chainsUsed, rowsWithData};
  }

  function promoMetricValue(cell, metric){
    if(!cell) return null;
    if(metric==='count')     return cell.count>0 ? cell.count : null;
    if(metric==='depth')     return cell.depths.length ? medianOf(cell.depths)*100 : null;
    return null;
  }
  function promoMetricText(v, metric){
    if(v===null) return '–';
    if(metric==='count') return String(v);
    return Math.round(v)+'%';
  }
  // tint a cell proportionally to its value, so the matrix reads as a heatmap
  function promoTint(v, maxV){
    if(v===null || !(maxV>0)) return '';
    const f = Math.max(0.06, Math.min(1, v/maxV));
    return `background:color-mix(in srgb, var(--accent) ${(f*42).toFixed(0)}%, transparent);`;
  }

  // Own brand+size pickers, same self-contained pattern as the tiers/growth
  // panels — independent of the "Trgovine"/brand-compare filters above, so this
  // section keeps working across all chains no matter what's picked up there.
  function promoMatrixIdxs(){
    return tierPanelIdxs().filter(i=>
      (!state.promoFilterBrand || PRODUCT_BRAND[i]===state.promoFilterBrand) &&
      (!state.promoFilterVol || PRODUCT_VOLUME_KEY[i]===state.promoFilterVol));
  }
  function renderPromoFilterControls(baseIdxs){
    const bSel = document.getElementById('promoFilterBrandSel');
    const vSel = document.getElementById('promoFilterVolSel');
    const brandCount = new Map(), volCount = new Map();
    baseIdxs.forEach(pi=>{
      const b = PRODUCT_BRAND[pi];
      brandCount.set(b, (brandCount.get(b)||0)+1);
      if(!state.promoFilterBrand || state.promoFilterBrand===b){
        const v = PRODUCT_VOLUME_KEY[pi];
        volCount.set(v, (volCount.get(v)||0)+1);
      }
    });
    if(state.promoFilterBrand && !brandCount.has(state.promoFilterBrand)) state.promoFilterBrand = '';
    if(state.promoFilterVol && !volCount.has(state.promoFilterVol)) state.promoFilterVol = '';
    const brands = Array.from(brandCount.keys()).sort((a,b)=>{
      const pa = POPULAR_BRAND_CANON.indexOf(a), pb = POPULAR_BRAND_CANON.indexOf(b);
      if(pa>=0 || pb>=0){ if(pa<0) return 1; if(pb<0) return -1; return pa-pb; }
      return brandLabel(a).localeCompare(brandLabel(b),'hr');
    });
    bSel.innerHTML = '<option value="">Sve marke</option>' + brands.map(b=>
      `<option value="${escapeHtml(b)}"${b===state.promoFilterBrand?' selected':''}>${escapeHtml(brandLabel(b))} (${brandCount.get(b)})</option>`).join('');
    const vols = Array.from(volCount.keys()).sort((a,b)=>{
      const oa = VOLUME_ORDER.has(a)?VOLUME_ORDER.get(a):99, ob = VOLUME_ORDER.has(b)?VOLUME_ORDER.get(b):99;
      return oa-ob;
    });
    vSel.innerHTML = '<option value="">Sve veličine</option>' + vols.map(v=>
      `<option value="${escapeHtml(v)}"${v===state.promoFilterVol?' selected':''}>${escapeHtml(volumeBucketLabel(v))} (${volCount.get(v)})</option>`).join('');
  }

  function renderPromoMatrix(matchIdxs){
    const wrap = document.getElementById('promoMatrixWrap');
    const note = document.getElementById('promoNote');
    renderPromoFilterControls(tierPanelIdxs());
    // A single brand picked with "sve veličine" left open would otherwise
    // collapse every size into one summed row - break it down by size instead,
    // since that's exactly the case where "which size is on promo" is the
    // interesting question, not "which brand".
    const groupBySize = !!state.promoFilterBrand && !state.promoFilterVol;
    const rowKeyFn = groupBySize ? (pi=>PRODUCT_VOLUME_KEY[pi]) : (pi=>PRODUCT_BRAND[pi]);
    const rowLabel = groupBySize ? (k=>volumeBucketLabel(k)) : (k=>brandLabel(k));
    const rowTitle = groupBySize ? (k=>`${brandLabel(state.promoFilterBrand)} · ${volumeBucketLabel(k)}`) : (k=>brandLabel(k));
    const rowHeadLabel = groupBySize ? 'Veličina' : 'Marka';
    const rowNoun = groupBySize ? 'veličina' : 'marki';
    const agg = computePromoAgg(matchIdxs, rowKeyFn);
    const metric = state.promoMetric;

    const chainCols = CHAINS.filter(c=>agg.chainsUsed.has(c));
    // only rows that actually ran a promo in the period — a table of mostly
    // dashes would bury the signal
    const rows = Array.from(agg.rowTotals.keys())
      .sort((a,b)=> groupBySize
        ? (VOLUME_ORDER.has(a)?VOLUME_ORDER.get(a):99) - (VOLUME_ORDER.has(b)?VOLUME_ORDER.get(b):99)
        : (agg.rowTotals.get(b)-agg.rowTotals.get(a)) || a.localeCompare(b,'hr'));

    if(rows.length===0 || chainCols.length===0){
      wrap.innerHTML = '<div class="empty">Nema zabilježenih akcija za odabrani filtar i razdoblje.</div>';
      note.textContent = '';
      renderPromoBrandSelect(groupBySize ? [state.promoFilterBrand] : []);
      renderPromoCalendar(matchIdxs);
      return;
    }

    let maxV = 0;
    rows.forEach(r=> chainCols.forEach(c=>{
      const v = promoMetricValue(agg.cells.get(r+'||'+c), metric);
      if(v!==null && v>maxV) maxV = v;
    }));

    let html = `<table class="matrix"><thead><tr><th class="brand-head">${rowHeadLabel}</th>`;
    chainCols.forEach(c=> html += `<th>${chainLabel(c)}</th>`);
    html += '<th>Ukupno</th></tr></thead><tbody>';
    rows.forEach(r=>{
      html += `<tr><td class="brand-cell">${escapeHtml(rowLabel(r))}</td>`;
      chainCols.forEach(c=>{
        const cell = agg.cells.get(r+'||'+c);
        const v = promoMetricValue(cell, metric);
        const cls = v===null ? 'promo-cell promo-empty' : 'promo-cell';
        const title = cell && cell.count>0
          ? `${rowTitle(r)} · ${chainLabel(c)}: ${cell.count} akcija`
            + (cell.depths.length ? `, medijan popusta ${Math.round(medianOf(cell.depths)*100)}%` : '')
            + `, medijan trajanja ${medianOf(cell.durations)} tj., ${cell.promoWeeks} od ${cell.obsWeeks} artikl-tjedana na akciji`
          : `${rowTitle(r)} · ${chainLabel(c)}: nema zabilježenih akcija`;
        html += `<td class="${cls}" style="${promoTint(v,maxV)}" title="${escapeHtml(title)}">${promoMetricText(v,metric)}</td>`;
      });
      html += `<td class="num">${agg.rowTotals.get(r)}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    const totalEvents = Array.from(agg.rowTotals.values()).reduce((a,b)=>a+b,0);
    const noPromo = agg.rowsWithData.size - rows.length;
    note.textContent = `${totalEvents.toLocaleString('hr-HR')} akcija · ${rows.length} ${rowNoun} × ${chainCols.length} lanaca`
      + (noPromo>0 ? ` · još ${noPromo} ${noPromo===1?(groupBySize?'veličina nije bila':'marka nije bila'):(groupBySize?'veličina nije bilo':'marki nije bilo')} ni na jednoj akciji u ovom razdoblju` : '');

    renderPromoBrandSelect(groupBySize ? [state.promoFilterBrand] : rows);
    renderPromoCalendar(matchIdxs);
  }

  function renderPromoBrandSelect(brands){
    const sel = document.getElementById('promoBrandSelect');
    if(brands.length===0){ sel.innerHTML=''; state.promoBrand=null; return; }
    // keep the user's pick when it's still available; otherwise fall back to an
    // explicitly compared brand, else the busiest one
    if(!state.promoBrand || !brands.includes(state.promoBrand)){
      const picked = Array.from(state.brands).find(b=> brands.includes(b));
      state.promoBrand = picked || brands[0];
    }
    sel.innerHTML = brands.map(b=>`<option value="${escapeHtml(b)}">${escapeHtml(brandLabel(b))}</option>`).join('');
    sel.value = state.promoBrand;
  }

  function renderPromoCalendar(matchIdxs){
    const wrap = document.getElementById('promoCalWrap');
    const legend = document.getElementById('promoLegend');
    const brand = state.promoBrand;
    if(!brand){ wrap.innerHTML=''; legend.innerHTML=''; return; }

    const matchSet = new Set(matchIdxs);
    // chain -> weekIdx -> deepest discount that week
    const byChain = new Map();
    PROMO_EVENTS.forEach(e=>{
      if(e.brand!==brand || !matchSet.has(e.pi)) return;
      if(e.to < CUR_DATE_FROM_IDX || e.from > CUR_DATE_IDX) return;
      if(!byChain.has(e.chain)) byChain.set(e.chain, new Map());
      const weeks = byChain.get(e.chain);
      for(let w=Math.max(e.from,CUR_DATE_FROM_IDX); w<=Math.min(e.to,CUR_DATE_IDX); w++){
        weeks.set(w, Math.max(weeks.get(w)||0, e.depth));
      }
    });

    const chainRows = CHAINS.filter(c=>byChain.has(c));
    if(chainRows.length===0){
      wrap.innerHTML = '<div class="empty">Nema zabilježenih akcija za odabranu marku u ovom razdoblju.</div>';
      legend.innerHTML='';
      return;
    }

    let maxDepth = 0;
    byChain.forEach(weeks=> weeks.forEach(d=>{ if(d>maxDepth) maxDepth=d; }));

    let html = '<table class="promo-cal"><thead><tr><th class="cal-chain"></th>';
    for(let w=CUR_DATE_FROM_IDX; w<=CUR_DATE_IDX; w++){
      // a sparse month marker every ~6 weeks keeps the axis readable
      const showLabel = (w-CUR_DATE_FROM_IDX) % 6 === 0;
      html += `<th>${showLabel ? fmtDateShort(DATES[w]) : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    chainRows.forEach(c=>{
      const weeks = byChain.get(c);
      html += `<tr><th class="cal-chain">${chainLabel(c)}</th>`;
      for(let w=CUR_DATE_FROM_IDX; w<=CUR_DATE_IDX; w++){
        const d = weeks.get(w);
        if(d===undefined){
          html += `<td class="cal-cell" title="${escapeHtml(chainLabel(c)+' · '+fmtDate(DATES[w])+': nema akcije')}"></td>`;
        } else {
          const f = maxDepth>0 ? Math.max(0.25, d/maxDepth) : 1;
          const title = `${chainLabel(c)} · ${fmtDate(DATES[w])}: akcija, popust ${Math.round(d*100)}%`;
          html += `<td class="cal-cell" style="background:color-mix(in srgb, var(--accent) ${(f*85).toFixed(0)}%, transparent);" title="${escapeHtml(title)}"></td>`;
        }
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    const steps = [0.25,0.45,0.65,0.85].map(f=>
      `<span class="promo-legend-swatch" style="background:color-mix(in srgb, var(--accent) ${(f*85).toFixed(0)}%, transparent);"></span>`
    ).join('');
    legend.innerHTML = `<span>Bez akcije</span><span class="promo-legend-swatch" style="background:var(--line);"></span>`
      + `<span style="margin-left:6px;">Popust:</span><span class="promo-legend-scale">${steps}</span>`
      + `<span>plići → dublji (do ${Math.round(maxDepth*100)}%)</span>`;
  }

  document.getElementById('focusModeTabs').addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn'); if(!btn) return;
    state.focusMode = btn.dataset.mode;
    document.querySelectorAll('#focusModeTabs .tab-btn').forEach(b=>
      b.setAttribute('aria-selected', b.dataset.mode===state.focusMode?'true':'false'));
    renderFocusMatrix();
  });
  document.getElementById('promoMetricTabs').addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn'); if(!btn) return;
    state.promoMetric = btn.dataset.metric;
    document.querySelectorAll('#promoMetricTabs .tab-btn').forEach(b=>
      b.setAttribute('aria-selected', b.dataset.metric===state.promoMetric?'true':'false'));
    render();
  });
  document.getElementById('growthBrandSel').addEventListener('change', (e)=>{ state.growthBrand = e.target.value; renderGrowthPanel(); });
  document.getElementById('growthVolSel').addEventListener('change', (e)=>{ state.growthVol = e.target.value; renderGrowthPanel(); });
  document.getElementById('growthHoldSel').addEventListener('change', (e)=>{ state.growthHold = +e.target.value; renderGrowthPanel(); });
  document.getElementById('growthMetricSel').addEventListener('change', (e)=>{ state.growthMetric = e.target.value; renderGrowthPanel(); });
  document.getElementById('growthScopeSel').addEventListener('change', (e)=>{ state.growthScope = e.target.value; renderGrowthPanel(); });
  document.getElementById('growthFromSel').addEventListener('change', (e)=> setGrowthPeriod(e.target.value, state.growthTo));
  document.getElementById('growthToSel').addEventListener('change', (e)=> setGrowthPeriod(state.growthFrom, e.target.value));
  document.querySelectorAll('[data-growth-preset]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const v = btn.dataset.growthPreset;
      const last = DATES.length-1;
      const fromIdx = v==='all' ? 0 : Math.max(0, last - (+v));
      setGrowthPeriod(DATES[fromIdx], DATES[last]);
    });
  });
  document.getElementById('tierBrandSel').addEventListener('change', (e)=>{ state.tierBrand = e.target.value; renderTiersPanel(); });
  document.getElementById('tierVolSel').addEventListener('change', (e)=>{ state.tierVol = e.target.value; renderTiersPanel(); });
  document.getElementById('tierReset').addEventListener('click', ()=>{ state.tierBrand=''; state.tierVol=''; renderTiersPanel(); });
  document.getElementById('promoFilterBrandSel').addEventListener('change', (e)=>{ state.promoFilterBrand = e.target.value; renderPromoMatrix(promoMatrixIdxs()); });
  document.getElementById('promoFilterVolSel').addEventListener('change', (e)=>{ state.promoFilterVol = e.target.value; renderPromoMatrix(promoMatrixIdxs()); });
  document.getElementById('promoBrandSelect').addEventListener('change', (e)=>{
    state.promoBrand = e.target.value;
    renderPromoCalendar(getMatchingProductIdxs());
  });

  // ================= QUICK LOOKUP (brand + chain) =================
  // ================= MAIN RENDER =================
  function render(){
    const fromIdx = DATES.indexOf(state.dateFrom);
    const toIdx = DATES.indexOf(state.dateTo);
    CUR_DATE_FROM_IDX = fromIdx>=0 ? fromIdx : 0;
    CUR_DATE_IDX = toIdx>=0 ? toIdx : DATES.length-1;
    const matchIdxs = getMatchingProductIdxs();
    renderHero(matchIdxs);
    renderBrandsChart(matchIdxs);
    renderChainsChart(matchIdxs);
    renderPromoMatrix(promoMatrixIdxs());
    renderBrandMatrix(matchIdxs);
    renderFocusMatrix();
    renderTiersPanel();
    renderPopularTable();
    renderTable(matchIdxs);
    renderGrowthPanel();
  }

  document.getElementById('footRange').textContent = fmtDate(DATES[0]) + ' — ' + fmtDate(DATES[DATES.length-1]) + ' (' + DATES.length + ' tjednih arhiva)';
  document.getElementById('footUpdated').textContent = fmtDate(DATES[DATES.length-1]);
  document.getElementById('footShadow').textContent =
    `Izostavljeno je ${SHADOW_LISTINGS.size} ${pluralHr(SHADOW_LISTINGS.size,'dvostruki zapis','dvostruka zapisa','dvostrukih zapisa')}: isti lanac vodi isti artikl pod dva naziva, a jedan od njih pokriva desetak puta manje poslovnica (npr. Spar, S-Budget 7 l: €1,48 u jednoj poslovnici uz €1,75 u 143). Uvijek se uzima zapis koji pokriva više poslovnica.`;

  render();
  window.addEventListener('resize', ()=>{ render(); });

  // section nav: highlight whichever panel is currently in view
  (function sectionNav(){
    const links = Array.from(document.querySelectorAll('.secnav a'));
    const secs = links.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);
    if(secs.length===0) return;
    const mark = ()=>{
      const y = window.scrollY + 140;
      let cur = secs[0];
      for(const el of secs){ if(el.offsetTop <= y) cur = el; }
      links.forEach(a=> a.setAttribute('aria-current', a.getAttribute('href')==='#'+cur.id ? 'true':'false'));
    };
    window.addEventListener('scroll', mark, {passive:true});
    mark();
  })();
})();

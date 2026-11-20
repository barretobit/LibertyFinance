/* ===== Zuri Vault: tangible assets =====
 *
 * Cars, watches, art and houses have no public daily price feed, so their
 * prices are simulated around a rough real price per item. The simulation is deterministic: the same item on the same date
 * has the same price for every player, so games stay comparable.
 *
 * Two numbers drive each item:
 *   - trend: yearly change of the price you pay for that item on the market
 *     (a new car of that model, that watch reference, that kind of artwork).
 *   - depreciation: yearly change of a unit you own, on top of the market
 *     price (a new car loses value the day it is yours; a watch or a painting
 *     does not). Negative values lose value.
 * On top of the trend, a smooth wiggle of +/- `wiggle` moves the price day to day.
 * Cars also carry their kind (electric and classic cars cost differently to
 * run), houses their city (purchase costs and property tax depend on it).
 * Precious metals are real market prices, counted in grams.
 */

const GameTangibles = (() => {
  // Prices are the list price on this date; the trend runs from here.
  const ANCHOR_DATE = '2026-01-01';
  const WIGGLE_KNOT_DAYS = 14;

  const CATEGORIES = { car: 'CARS', watch: 'WATCHES', art: 'ART', house: 'HOUSES' };
  // Randata's precious metal futures, quoted in USD per troy ounce.
  const PRECIOUS_METALS = { 'GC=F': 'GOLD', 'SI=F': 'SILVER', 'PL=F': 'PLATINUM', 'PA=F': 'PALLADIUM' };
  const GRAMS_PER_TROY_OUNCE = 31.1034768;

  // One catalog row: [id, name, price in CHF, trend, depreciation, wiggle].
  // shortcut: prices are rough Swiss market prices for late 2026 (new price for current cars, typical resale price for
  // classics, sought-after watches and art), refresh them by hand when they drift too far.
  // `extra` adds the same fields to every row of the group (a car's kind, a house's city).
  const group = (assetClass, label, rows, extra) => rows.map(([id, name, priceChf, trend, depreciation, wiggle]) => Object.assign(
    { id: id, class: assetClass, group: label, name: name, priceChf: priceChf, trend: trend, depreciation: depreciation, wiggle: wiggle }, extra));

  const ITEMS = [].concat(
    group('car', 'CARS: COMPACT', [
      ['car-vw-golf', 'Volkswagen Golf 1.5 eTSI', 33000, 0.01, -0.15, 0.01],
      ['car-toyota-yaris', 'Toyota Yaris Hybrid', 25000, 0.01, -0.13, 0.01],
      ['car-skoda-fabia', 'Skoda Fabia', 22000, 0.01, -0.15, 0.01],
      ['car-peugeot-208', 'Peugeot 208', 24000, 0.01, -0.17, 0.01],
      ['car-mini-cooper-s', 'Mini Cooper S', 36000, 0.01, -0.14, 0.01],
    ], { kind: 'compact' }),
    group('car', 'CARS: SUV', [
      ['car-skoda-kodiaq', 'Skoda Kodiaq', 48000, 0.01, -0.13, 0.01],
      ['car-vw-tiguan', 'Volkswagen Tiguan', 45000, 0.01, -0.13, 0.01],
      ['car-toyota-rav4', 'Toyota RAV4 Hybrid', 47000, 0.01, -0.10, 0.01],
      ['car-bmw-x5', 'BMW X5 xDrive40i', 95000, 0.02, -0.15, 0.02],
      ['car-volvo-xc90', 'Volvo XC90', 85000, 0.01, -0.16, 0.02],
    ], { kind: 'suv' }),
    group('car', 'CARS: ELECTRIC', [
      ['car-tesla-model-3', 'Tesla Model 3', 42000, -0.03, -0.18, 0.03],
      ['car-tesla-model-y', 'Tesla Model Y', 47000, -0.03, -0.18, 0.03],
      ['car-bmw-i4', 'BMW i4 eDrive40', 68000, -0.01, -0.18, 0.02],
      ['car-polestar-2', 'Polestar 2', 52000, -0.02, -0.20, 0.02],
      ['car-porsche-taycan', 'Porsche Taycan 4S', 125000, -0.01, -0.20, 0.02],
    ], { kind: 'electric' }),
    group('car', 'CARS: SPORTS', [
      ['car-porsche-911', 'Porsche 911 Carrera', 135000, 0.02, -0.05, 0.02],
      ['car-bmw-m4', 'BMW M4 Competition', 105000, 0.02, -0.10, 0.02],
      ['car-amg-gt', 'Mercedes-AMG GT 63', 175000, 0.02, -0.12, 0.02],
      ['car-porsche-cayman', 'Porsche 718 Cayman GTS', 105000, 0.02, -0.06, 0.02],
      ['car-toyota-supra', 'Toyota GR Supra', 70000, 0.01, -0.09, 0.02],
    ], { kind: 'sports' }),
    group('car', 'CARS: SUPERCARS', [
      ['car-ferrari-296', 'Ferrari 296 GTB', 300000, 0.02, -0.05, 0.03],
      ['car-lamborghini-temerario', 'Lamborghini Temerario', 330000, 0.02, -0.06, 0.03],
      ['car-mclaren-750s', 'McLaren 750S', 330000, 0.01, -0.09, 0.03],
      ['car-porsche-gt3-rs', 'Porsche 911 GT3 RS', 330000, 0.03, 0, 0.05],
      ['car-ferrari-sf90', 'Ferrari SF90 Stradale', 470000, 0.02, -0.05, 0.03],
    ], { kind: 'supercar' }),
    group('car', 'CARS: CLASSICS', [
      ['car-porsche-964', 'Porsche 911 Carrera 2 (964, 1990)', 110000, 0.04, 0, 0.06],
      ['car-mercedes-pagoda', 'Mercedes-Benz 280 SL Pagoda (1969)', 120000, 0.03, 0, 0.05],
      ['car-jaguar-e-type', 'Jaguar E-Type Series 1 (1963)', 180000, 0.04, 0, 0.06],
      ['car-vw-beetle', 'Volkswagen Beetle (1965)', 18000, 0.02, 0, 0.05],
      ['car-ferrari-308', 'Ferrari 308 GTS (1979)', 95000, 0.04, 0, 0.06],
    ], { kind: 'classic' }),
    group('watch', 'WATCHES', [
      ['watch-rolex-submariner', 'Rolex Submariner Date 126610LN', 13000, 0.04, 0, 0.04],
      ['watch-rolex-daytona', 'Rolex Cosmograph Daytona 126500LN', 28000, 0.03, 0, 0.07],
      ['watch-rolex-gmt-pepsi', 'Rolex GMT-Master II "Pepsi" 126710BLRO', 21000, 0.03, 0, 0.05],
      ['watch-rolex-datejust', 'Rolex Datejust 41 126334', 11500, 0.03, 0, 0.03],
      ['watch-rolex-day-date', 'Rolex Day-Date 40 Yellow Gold 228238', 39000, 0.03, 0, 0.04],
      ['watch-patek-nautilus', 'Patek Philippe Nautilus 5711/1A', 110000, 0.02, 0, 0.10],
      ['watch-patek-aquanaut', 'Patek Philippe Aquanaut 5167A', 60000, 0.02, 0, 0.08],
      ['watch-patek-calatrava', 'Patek Philippe Calatrava 6119G', 33000, 0.02, -0.04, 0.03],
      ['watch-ap-royal-oak', 'Audemars Piguet Royal Oak 15510ST', 60000, 0.02, 0, 0.08],
      ['watch-ap-offshore', 'Audemars Piguet Royal Oak Offshore 26420', 38000, 0.01, -0.03, 0.05],
      ['watch-vc-overseas', 'Vacheron Constantin Overseas 4500V', 32000, 0.02, 0, 0.05],
      ['watch-lange-1', 'A. Lange & Söhne Lange 1', 45000, 0.03, 0, 0.04],
      ['watch-richard-mille', 'Richard Mille RM 011', 250000, 0.04, 0, 0.10],
      ['watch-omega-speedmaster', 'Omega Speedmaster Moonwatch Professional', 7500, 0.02, -0.03, 0.02],
      ['watch-omega-seamaster', 'Omega Seamaster Diver 300M', 5800, 0.02, -0.05, 0.02],
      ['watch-cartier-santos', 'Cartier Santos de Cartier Large', 7800, 0.02, -0.03, 0.02],
      ['watch-tag-carrera', 'TAG Heuer Carrera Chronograph', 6500, 0.01, -0.08, 0.02],
      ['watch-iwc-portugieser', 'IWC Portugieser Chronograph', 8300, 0.01, -0.06, 0.02],
      ['watch-jlc-reverso', 'Jaeger-LeCoultre Reverso Tribute', 9500, 0.02, -0.04, 0.02],
      ['watch-breitling-navitimer', 'Breitling Navitimer B01 Chronograph 43', 9000, 0.01, -0.07, 0.02],
    ]),
    group('art', 'ART', [
      ['art-banksy-balloon', 'Banksy, Girl with Balloon (signed screenprint)', 400000, 0.02, 0, 0.20],
      ['art-warhol-soup', 'Andy Warhol, Campbell\'s Soup I (screenprint, 1968)', 55000, 0.03, 0, 0.10],
      ['art-kusama-pumpkin', 'Yayoi Kusama, Pumpkin (signed screenprint)', 70000, 0.03, 0, 0.15],
      ['art-haring-pop-shop', 'Keith Haring, Pop Shop I (screenprint, 1987)', 15000, 0.03, 0, 0.12],
      ['art-hockney-ipad', 'David Hockney, iPad drawing (signed inkjet print)', 25000, 0.03, 0, 0.12],
      ['art-picasso-madoura', 'Pablo Picasso, Madoura ceramic plate', 15000, 0.03, 0, 0.08],
      ['art-miro-lithograph', 'Joan Miró, lithograph', 8000, 0.02, 0, 0.08],
      ['art-murakami-flowers', 'Takashi Murakami, Flowers (signed offset print)', 3000, 0.01, 0, 0.15],
      ['art-kaws-companion', 'KAWS, Companion (vinyl figure)', 1500, 0.02, 0, 0.20],
      ['art-hodler-landscape', 'Ferdinand Hodler, Alpine landscape study (oil)', 850000, 0.03, 0, 0.08],
    ]),
    // Four homes per city, from a small flat to a top villa. Street and district only: a house number on a real
    // street could point at a real person's home. The older ids keep their original homes, so saved games still work.
    group('house', 'HOUSES: ZÜRICH', [
      ['house-zurich-wiedikon', '2.5 room flat, Birmensdorferstrasse, Zürich Wiedikon', 1050000, 0.035, 0, 0.02],
      ['house-zurich-hottingen', '4.5 room flat, Hofstrasse, Zürich Hottingen', 2100000, 0.035, 0, 0.02],
      ['house-zurich-fluntern', 'Villa, Zürichbergstrasse, Zürich Fluntern', 4800000, 0.035, 0, 0.02],
      ['house-zurich-wollishofen', 'Lakeside estate, Seestrasse, Zürich Wollishofen', 14500000, 0.03, 0, 0.03],
    ], { location: 'zurich' }),
    group('house', 'HOUSES: GENEVA', [
      ['house-geneva-paquis', '2 room flat, Rue de Berne, Geneva Pâquis', 780000, 0.025, 0, 0.02],
      ['house-geneva-eaux-vives', '4 room flat, Rue des Eaux-Vives, Geneva Eaux-Vives', 1650000, 0.025, 0, 0.02],
      ['house-geneva-champel', 'Townhouse, Route de Florissant, Geneva Champel', 3200000, 0.025, 0, 0.02],
      ['house-geneva-cologny', 'Lakeside villa, Quai de Cologny, Cologny', 18000000, 0.025, 0, 0.03],
    ], { location: 'geneva' }),
    group('house', 'HOUSES: LAUSANNE', [
      ['house-lausanne-prelaz', '2.5 room flat, Avenue de Morges, Lausanne Prélaz', 640000, 0.025, 0, 0.02],
      ['house-lausanne-chailly', '4.5 room flat, Avenue de Chailly, Lausanne Chailly', 1350000, 0.025, 0, 0.02],
      ['house-lausanne-ouchy', 'Family house, Chemin de Bellerive, Lausanne-Ouchy', 2300000, 0.025, 0, 0.02],
      ['house-lausanne-elysee', "Villa with lake view, Avenue de l'Elysée, Lausanne", 7500000, 0.025, 0, 0.03],
    ], { location: 'lausanne' }),
    group('house', 'HOUSES: BERN', [
      ['house-bern-bumpliz', '2.5 room flat, Bümplizstrasse, Bern Bümpliz', 520000, 0.02, 0, 0.02],
      ['house-bern-holligen', 'Row house, Weissensteinstrasse, Bern Holligen', 940000, 0.02, 0, 0.02],
      ['house-bern-kirchenfeld', 'Family house, Thunstrasse, Bern Kirchenfeld', 2200000, 0.02, 0, 0.02],
      ['house-bern-elfenau', 'Patrician villa, Elfenauweg, Bern Elfenau', 6500000, 0.02, 0, 0.03],
    ], { location: 'bern' }),
    group('house', 'HOUSES: BASEL', [
      ['house-basel-klybeck', '2.5 room flat, Klybeckstrasse, Basel Klybeck', 490000, 0.02, 0, 0.02],
      ['house-basel-kleinbasel', 'Row house, Hammerstrasse, Basel Kleinbasel', 880000, 0.02, 0, 0.02],
      ['house-basel-bruderholz', 'Family house, Bruderholzallee, Basel Bruderholz', 2100000, 0.02, 0, 0.02],
      ['house-basel-gellert', 'Villa, Gellertstrasse, Basel Gellert', 6000000, 0.02, 0, 0.03],
    ], { location: 'basel' })
  );
  const ITEM_BY_ID = {};
  ITEMS.forEach((item) => { ITEM_BY_ID[item.id] = item; });

  // Deterministic number in [-1, 1) for a text (FNV-1a hash).
  function hashSigned(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967296) * 2 - 1;
  }

  // Smooth value in [-1, 1]: random points every few days, eased in between.
  function wiggleAt(id, dayNumber) {
    const knot = Math.floor(dayNumber / WIGGLE_KNOT_DAYS);
    const progress = (dayNumber - knot * WIGGLE_KNOT_DAYS) / WIGGLE_KNOT_DAYS;
    const from = hashSigned(id + ':' + knot);
    const to = hashSigned(id + ':' + (knot + 1));
    return from + (to - from) * (1 - Math.cos(Math.PI * progress)) / 2;
  }

  function quote(id, date) {
    const item = ITEM_BY_ID[id];
    if (!item) return null;
    const dayNumber = Math.round(Date.parse(date + 'T00:00:00Z') / 86400000);
    const years = (dayNumber - Date.parse(ANCHOR_DATE + 'T00:00:00Z') / 86400000) / 365.25;
    const priceChf = item.priceChf * Math.pow(1 + item.trend, years) * (1 + item.wiggle * wiggleAt(id, dayNumber));
    return { priceChf: priceChf, date: date };
  }

  // The catalog row for a car, watch, artwork or house, or null.
  function item(id) {
    return ITEM_BY_ID[id] || null;
  }

  return { CATEGORIES, PRECIOUS_METALS, GRAMS_PER_TROY_OUNCE, ITEMS, quote, item, isTangible: (id) => !!ITEM_BY_ID[id] };
})();

if (typeof module !== 'undefined') module.exports = GameTangibles;

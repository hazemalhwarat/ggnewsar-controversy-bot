// ===================================================================
// GGNewsAR Controversy Bot — نسخة GitHub فقط (بدون أي خدمة ذكاء اصطناعي خارجية)
// يرصد قضايا وجدل الرياضات الإلكترونية (لاعبون، فرق، دول) بعيداً عن نتائج المباريات
// التصنيف: قواعد وكلمات مفتاحية محلية بالكامل، بدون أي API خارجي
// التخزين: ملف data/seen.json داخل نفس الريبو
// ===================================================================

import fs from 'node:fs';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEEN_FILE = 'data/seen.json';
const DEDUPE_LOOKBACK_DAYS = 14;
const MAX_NEW_PER_RUN = 40;
// أي مقال أقدم من هذا العدد من الساعات (حسب تاريخ نشره الفعلي في المصدر) يُتجاهل
// ولا يُنشر إطلاقاً، حتى لو كان "جديداً" بمعنى أن البوت لم يره من قبل.
const MAX_ARTICLE_AGE_HOURS = 24;

if (!DISCORD_WEBHOOK_URL) {
  console.error('متغير البيئة المطلوب مفقود: DISCORD_WEBHOOK_URL');
  process.exit(1);
}

// ------------------- المصادر -------------------
const sources = [
  { name: 'Dexerto Esports', url: 'https://www.dexerto.com/esports/feed/' },
  { name: 'Dot Esports', url: 'https://dotesports.com/feed' },
  { name: 'Esports Insider', url: 'https://esportsinsider.com/feed' },
  { name: 'Esports.net', url: 'https://esports.net/news/feed/' },
  { name: 'Esports News UK', url: 'https://esports-news.co.uk/feed/' },
  { name: 'The Loadout Esports', url: 'https://www.theloadout.com/feed' },
  { name: 'Sportskeeda Esports', url: 'https://www.sportskeeda.com/esports/feed' },
  { name: 'Inven Global', url: 'https://www.invenglobal.com/rss' },
  { name: 'Upcomer', url: 'https://upcomer.com/feed' },
  { name: 'ESIC (Esports Integrity Commission)', url: 'https://esic.gg/feed/' },
  { name: 'Charlie INTEL (Call of Duty)', url: 'https://charlieintel.com/feed/' },
  // أضف مصادرك هنا: { name: 'اسم المصدر', url: 'https://example.com/feed' },
];

// ------------------- محلل RSS خفيف -------------------
function extractBlocks(xml, tag) {
  const blocks = [];
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let idx = xml.indexOf(openTag);
  while (idx !== -1) {
    const closeIdx = xml.indexOf(closeTag, idx);
    if (closeIdx === -1) break;
    blocks.push(xml.slice(idx + openTag.length, closeIdx));
    idx = xml.indexOf(openTag, closeIdx + closeTag.length);
  }
  return blocks;
}

function extractField(block, tag) {
  const openIdx = block.indexOf(`<${tag}`);
  if (openIdx === -1) return '';
  const gtIdx = block.indexOf('>', openIdx);
  if (gtIdx === -1) return '';
  const closeTag = `</${tag}>`;
  const closeIdx = block.indexOf(closeTag, gtIdx);
  if (closeIdx === -1) return '';
  return unwrapCdata(block.slice(gtIdx + 1, closeIdx).trim());
}

function unwrapCdata(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    return trimmed.slice(9, -3).trim();
  }
  return trimmed;
}

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTITY_MAP = {
  '&amp;': '&', '&quot;': '"', '&#8216;': '\u2018', '&#8217;': '\u2019',
  '&#8220;': '\u201c', '&#8221;': '\u201d', '&#8230;': '\u2026',
  '&#8211;': '\u2013', '&#8212;': '\u2014', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
};

function decodeEntities(text) {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    if (result.includes(entity)) result = result.split(entity).join(char);
  }
  return result;
}

function parseRss(xmlText) {
  const itemBlocks = extractBlocks(xmlText, 'item');
  return itemBlocks.map((block) => {
    const rawTitle = extractField(block, 'title');
    const rawLink = extractField(block, 'link') || extractField(block, 'guid');
    const rawDescription = extractField(block, 'description');
    return {
      title: decodeEntities(stripHtml(rawTitle)).slice(0, 300),
      link: rawLink.trim(),
      pubDate: extractField(block, 'pubDate'),
      description: decodeEntities(stripHtml(rawDescription)).slice(0, 500),
    };
  });
}

// ------------------- التخزين (ملف JSON محلي بالريبو) -------------------
function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSeen(seenMap) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seenMap, null, 2), 'utf-8');
}

function pruneOld(seenMap) {
  const cutoff = Date.now() - DEDUPE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(seenMap)) {
    if (ts < cutoff) delete seenMap[id];
  }
}

// يتحقق أن المقال نُشر فعلياً خلال آخر MAX_ARTICLE_AGE_HOURS ساعة، بالاعتماد على
// تاريخ النشر الحقيقي القادم من المصدر (وليس وقت اكتشاف البوت له).
function isRecentEnough(article) {
  if (!article.pubDate) return true; // نادراً ما يخلو المصدر من تاريخ نشر، نتركه يمر احترازياً
  const published = new Date(article.pubDate);
  if (Number.isNaN(published.getTime())) return true;
  const ageMs = Date.now() - published.getTime();
  return ageMs <= MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000;
}

// ------------------- التصنيف عبر كلمات مفتاحية محلية (بدون أي API خارجي) -------------------

// كلمات تدل على أن الخبر يقتصر على نتيجة مباراة أو بطولة (نستبعدها إلا إذا رافقها
// شيء من قائمة القبول أدناه، مثل قضية أو تصريح مثير للجدل داخل نفس الخبر)
const EXCLUDE_KEYWORDS = [
  'defeat', 'defeats', 'defeated', 'beats', 'beat', 'wins the series', 'win the series',
  'grand final', 'grand finals', 'advance to', 'advances to', 'qualify for', 'qualifies for',
  'clinch', 'clinches', 'upset win', 'comeback win', 'match recap', 'highlights',
  'best plays', 'mvp of the', 'series score', 'final score', 'takes down', 'sweep', 'swept',
  'bracket reset', 'lower bracket', 'upper bracket', 'playoffs bracket', 'standings update',
  'group stage results', 'round of 16', 'quarterfinal', 'semifinal result', 'tournament preview',
  'power ranking', 'tier list', 'meta report', 'patch notes', 'roster ranking',
];

// كلمات تدل بقوة على أن الخبر ضمن نطاق البوت (قضايا، جدل، لاعبون، فرق، قوانين، صناعة)
const INCLUDE_KEYWORDS = [
  'ban', 'bans', 'banned', 'suspend', 'suspends', 'suspended', 'suspension',
  'investigation', 'investigating', 'investigated', 'scandal', 'fine', 'fined',
  'penalty', 'penalties', 'lawsuit', 'sues', 'sued', 'court', 'legal action',
  'visa', 'government', 'regulation', 'match-fixing', 'match fixing', 'matchfixing',
  'betting scandal', 'doping', 'cheat', 'cheating', 'cheater', 'anti-cheat', 'vac ban', 'esic',
  'harassment', 'abuse', 'allegation', 'allegations', 'retire', 'retirement', 'retires',
  'resign', 'resigns', 'steps down', 'disband', 'disbanded', 'bankrupt', 'financial trouble',
  'dispute', 'contract dispute', 'interview', 'apology', 'apologizes', 'statement',
  'backlash', 'criticism', 'boycott', 'protest', 'sponsorship deal', 'acquisition',
  'acquires', 'investment', 'funding round', 'shuts down', 'shutting down', 'lays off',
  'layoffs', 'controversy', 'controversial', 'discrimination', 'racism', 'racist',
  'sexism', 'sexist', 'homophobia', 'homophobic', 'death threat', 'threats',
  'diagnosed', 'health issue', 'mental health', 'passed away', 'tribute', 'homelessness',
  'jordan', 'jordanian',
];

const GAME_KEYWORDS = [
  { name: 'CS2', patterns: ['counter-strike', 'cs2', 'csgo'] },
  { name: 'Dota 2', patterns: ['dota 2', 'dota2'] },
  { name: 'League of Legends', patterns: ['league of legends'] },
  { name: 'Valorant', patterns: ['valorant'] },
  { name: 'Call of Duty', patterns: ['call of duty'] },
  { name: 'PUBG Mobile', patterns: ['pubg mobile', 'pubgm'] },
  { name: 'MLBB', patterns: ['mobile legends', 'mlbb'] },
  { name: 'Overwatch', patterns: ['overwatch'] },
  { name: 'Rainbow Six Siege', patterns: ['rainbow six', 'r6 siege'] },
  { name: 'Apex Legends', patterns: ['apex legends'] },
  { name: 'Fortnite', patterns: ['fortnite'] },
  { name: 'Rocket League', patterns: ['rocket league'] },
  { name: 'EA SPORTS FC', patterns: ['ea sports fc', 'fifa'] },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// يبني تعبيراً نمطياً يطابق الكلمة/العبارة كوحدة كاملة فقط (حدود كلمة حقيقية)،
// لتفادي مشاكل مثل مطابقة "layoffs" داخل كلمة "playoffs" الفرعية.
function wordRegex(phrase) {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i');
}

function findKeyword(haystack, keywords) {
  return keywords.find((kw) => wordRegex(kw).test(haystack));
}

function detectGame(text) {
  const lower = text.toLowerCase();
  for (const game of GAME_KEYWORDS) {
    if (game.patterns.some((p) => lower.includes(p))) return game.name;
  }
  return 'Multi-title';
}

function classifyArticle(article) {
  const haystack = `${article.title} ${article.description}`.toLowerCase();

  const matchedInclude = findKeyword(haystack, INCLUDE_KEYWORDS);
  const matchedExclude = findKeyword(haystack, EXCLUDE_KEYWORDS);

  if (matchedInclude) {
    return {
      include: true,
      game: detectGame(haystack),
      jordanRelated: wordRegex('jordan').test(haystack),
      reason: `تطابق كلمة: "${matchedInclude}"`,
    };
  }

  if (matchedExclude) {
    return {
      include: false,
      reason: `استُبعد لاحتوائه على: "${matchedExclude}"`,
    };
  }

  return {
    include: false,
    reason: 'لا توجد كلمة مفتاحية واضحة (قبول أو استبعاد)',
  };
}

// ------------------- النشر عبر Discord Webhook -------------------
function truncate(text, max) { return text && text.length > max ? `${text.slice(0, max - 1)}…` : text; }

function buildEmbed(article, classification) {
  const embed = {
    title: truncate(article.title, 256),
    color: 0x5865f2,
    fields: [
      { name: 'Game/Title', value: classification.game || 'Multi-title', inline: true },
      { name: 'الأردن', value: classification.jordanRelated ? 'نعم' : 'لا', inline: true },
    ],
    footer: { text: `المصدر: ${article.sourceName}` },
  };
  if (article.link) embed.url = article.link;
  if (article.description) embed.description = truncate(article.description, 500);
  if (classification.reason) {
    embed.fields.push({ name: 'سبب التطابق', value: truncate(classification.reason, 300) });
  }
  if (article.pubDate) {
    const date = new Date(article.pubDate);
    if (!Number.isNaN(date.getTime())) embed.timestamp = date.toISOString();
  }
  return embed;
}

async function postToDiscord(article, classification) {
  try {
    const embed = buildEmbed(article, classification);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error(`فشل إرسال Discord Webhook (${response.status}): ${errText.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`خطأ أثناء إرسال المقال "${article.title}": ${err.message}`);
    return false;
  }
}

// ------------------- التشغيل الرئيسي -------------------
async function fetchAllArticles() {
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const response = await fetch(source.url, { headers: { 'User-Agent': 'GGNewsARControversyBot/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      return parseRss(xml).map((item) => ({ ...item, sourceName: source.name }));
    })
  );

  const articles = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      console.warn(`تعذّر جلب المصدر "${sources[i].name}": ${result.reason?.message || result.reason}`);
    }
  });
  return articles;
}

async function main() {
  const seenMap = loadSeen();
  const isFirstRun = Object.keys(seenMap).length === 0;

  const articles = await fetchAllArticles();
  const notSeen = articles.filter((a) => a.link && !Object.prototype.hasOwnProperty.call(seenMap, a.link));

  console.log(`مقالات مجلوبة: ${articles.length}، غير مسجلة سابقاً: ${notSeen.length}`);

  if (isFirstRun) {
    notSeen.forEach((a) => { seenMap[a.link] = Date.now(); });
    saveSeen(seenMap);
    console.log(`دورة التهيئة الأولى: تم تسجيل ${notSeen.length} مقال كمقروء بدون نشر (لتفادي إغراق القناة بمحتوى قديم).`);
    return;
  }

  // نفصل المقالات القديمة (أقدم من MAX_ARTICLE_AGE_HOURS) ونسجلها كمقروءة دون
  // نشرها، والمقالات الحديثة فقط تمر للتصنيف والنشر.
  let expiredOld = 0;
  const freshArticles = [];
  for (const article of notSeen) {
    if (isRecentEnough(article)) {
      freshArticles.push(article);
    } else {
      seenMap[article.link] = Date.now();
      expiredOld += 1;
    }
  }

  console.log(`جديدة خلال آخر ${MAX_ARTICLE_AGE_HOURS} ساعة: ${freshArticles.length}، أقدم من ذلك وتم تجاهلها: ${expiredOld}`);

  const toProcess = freshArticles.slice(0, MAX_NEW_PER_RUN);
  let included = 0, excluded = 0;

  for (const article of toProcess) {
    const classification = classifyArticle(article);
    if (classification.include) {
      const posted = await postToDiscord(article, classification);
      if (posted) included += 1;
    } else {
      excluded += 1;
    }
    seenMap[article.link] = Date.now();
  }

  pruneOld(seenMap);
  saveSeen(seenMap);

  console.log(`انتهت الدورة: نُشر ${included}، استُبعد ${excluded}.`);
}

main().catch((err) => {
  console.error('خطأ غير متوقع:', err);
  process.exit(1);
});

// ===================================================================
// GGNewsAR Players Bot — نسخة GitHub فقط (بدون أي خدمة ذكاء اصطناعي خارجية)
// مختص برصد "أخبار لاعبي الرياضات الإلكترونية" في كل الألعاب التنافسية:
//   - تصريحات اللاعبين
//   - المقابلات واللقاءات مع أي جهة
//   - ما تنقله المواقع والمنصات عن حسابات اللاعبين في مواقع التواصل
//   - انتقالات وعقود واعتزال وعودة اللاعبين
//   - أخبار اللاعبين الشخصية (إصابة، صحة، تكريم... إلخ)
// يستبعد ضجيج المواعيد والنتائج والأدلة (schedule / results / guides / patch notes)
// عندما لا تحمل أي إشارة تخص لاعباً.
//
// التصنيف: قواعد وكلمات مفتاحية محلية بالكامل، بدون أي API خارجي.
// التخزين: ملف data/seen.json داخل نفس الريبو.
// ===================================================================

import fs from 'node:fs';

// ينظف الرابط من مسافات/علامات اقتباس قد تُلصق بالخطأ عند حفظ السيكريت
function sanitizeWebhookUrl(raw) {
  if (!raw) return '';
  let cleaned = raw.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

const DISCORD_WEBHOOK_URL = sanitizeWebhookUrl(process.env.DISCORD_WEBHOOK_URL);
const WEBHOOK_SHAPE_REGEX = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/\S+$/;
const SEEN_FILE = 'data/seen.json';
const DEDUPE_LOOKBACK_DAYS = 14;
const MAX_NEW_PER_RUN = 100;
// أي مقال أقدم من هذا العدد من الساعات (حسب تاريخ نشره الفعلي في المصدر) يُتجاهل.
const MAX_ARTICLE_AGE_HOURS = 24;
// اجعلها true إذا أردت البوت أن يرسل "كل شيء" حتى المقالات التي لا تحمل أي إشارة
// واضحة تخص لاعباً (سيزيد ذلك الضجيج بشكل كبير: سكنات، أدلة، تحديثات... إلخ).
const INCLUDE_WHEN_NO_SIGNAL = false;

// ------------------- تقرير الملخص (يظهر أعلى صفحة التشغيلة في GitHub Actions) -------------------
function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `${markdown}\n`);
  } catch {
    // تجاهل أي خطأ بكتابة الملخص، لا يجب أن يوقف تشغيل البوت
  }
}

function failFast(userMessage, summaryMessage) {
  console.error(`::error::${userMessage}`);
  appendSummary(`## ❌ فشل تشغيل البوت\n\n${summaryMessage}\n`);
  process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) {
  failFast(
    'متغير البيئة المطلوب مفقود: DISCORD_WEBHOOK_URL',
    'السيكريت `DISCORD_WEBHOOK_URL` غير موجود إطلاقاً بإعدادات الريبو (Settings ← Secrets and variables ← Actions).'
  );
}

if (!WEBHOOK_SHAPE_REGEX.test(DISCORD_WEBHOOK_URL)) {
  failFast(
    'رابط DISCORD_WEBHOOK_URL له شكل غير صحيح',
    'الرابط المحفوظ بالسيكريت `DISCORD_WEBHOOK_URL` لا يطابق شكل رابط ويبهوك ديسكورد الصحيح ' +
      '(`https://discord.com/api/webhooks/<id>/<token>`). تحقق من نسخه كاملاً بدون مسافات أو أسطر إضافية.'
  );
}

// فحص صحة الويبهوك فعلياً قبل البدء (طلب GET بسيط، بدون إرسال أي رسالة)
async function verifyWebhookIsAlive() {
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, { method: 'GET' });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      failFast(
        `رابط الويبهوك مرفوض من Discord (HTTP ${response.status})`,
        `Discord رفض رابط الويبهوك المحفوظ بالسيكريت (HTTP ${response.status}). ` +
          'على الأغلب الويبهوك انحذف أو دُوِّر من إعدادات القناة، ولازم تحدّث السيكريت `DISCORD_WEBHOOK_URL` برابط جديد.\n\n' +
          `رد Discord: \`${bodyText.slice(0, 300)}\``
      );
    }
  } catch (err) {
    failFast(
      `تعذّر الاتصال برابط الويبهوك: ${err.message}`,
      `فشل الاتصال بالكامل برابط الويبهوك (خطأ شبكة): \`${err.message}\``
    );
  }
}

// ------------------- المصادر -------------------
// أساسية = مثبتة وتعمل. تجريبية = قد تتوقف أحياناً، والبوت يتجاوز أي مصدر يفشل
// تلقائياً (Promise.allSettled) فلا يؤثر سقوط مصدر على البقية.
const sources = [
  // — مصادر عامة أساسية —
  { name: 'Dexerto Esports', url: 'https://www.dexerto.com/esports/feed/' },
  { name: 'Dot Esports', url: 'https://dotesports.com/feed' },
  { name: 'Esports Insider', url: 'https://esportsinsider.com/feed' },
  { name: 'Esports.net', url: 'https://esports.net/news/feed/' },
  { name: 'Esports News UK', url: 'https://esports-news.co.uk/feed/' },
  { name: 'The Loadout', url: 'https://www.theloadout.com/feed' },
  { name: 'Sportskeeda Esports', url: 'https://www.sportskeeda.com/esports/feed' },
  { name: 'Inven Global', url: 'https://www.invenglobal.com/rss' },
  { name: 'Upcomer', url: 'https://upcomer.com/feed' },
  { name: 'Jaxon', url: 'https://jaxon.gg/feed/' },
  { name: 'ESTNN', url: 'https://estnn.com/feed/' },

  // — تغذيات Dexerto لكل لعبة (كثيفة تصريحات ومقابلات اللاعبين) —
  { name: 'Dexerto CS2', url: 'https://www.dexerto.com/counter-strike-2/feed/' },
  { name: 'Dexerto Valorant', url: 'https://www.dexerto.com/valorant/feed/' },
  { name: 'Dexerto League of Legends', url: 'https://www.dexerto.com/league-of-legends/feed/' },
  { name: 'Dexerto Call of Duty', url: 'https://www.dexerto.com/call-of-duty/feed/' },
  { name: 'Dexerto Apex Legends', url: 'https://www.dexerto.com/apex-legends/feed/' },
  { name: 'Dexerto Rainbow Six', url: 'https://www.dexerto.com/rainbow-six/feed/' },
  { name: 'Dexerto Fortnite', url: 'https://www.dexerto.com/fortnite/feed/' },
  { name: 'Dexerto Dota 2', url: 'https://www.dexerto.com/dota2/feed/' },
  { name: 'Dexerto Overwatch', url: 'https://www.dexerto.com/overwatch/feed/' },
  { name: 'Dexerto Rocket League', url: 'https://www.dexerto.com/rocket-league/feed/' },

  // — مصادر متخصصة —
  { name: 'HLTV (CS2)', url: 'https://www.hltv.org/rss/news' },
  { name: 'Charlie INTEL (Call of Duty)', url: 'https://charlieintel.com/feed/' },
  { name: 'ESIC (Esports Integrity)', url: 'https://esic.gg/feed/' },

  // أضف مصادرك هنا: { name: 'اسم المصدر', url: 'https://example.com/feed' },
];

// ------------------- محلل RSS/Atom خفيف -------------------
function extractBlocks(xml, tag) {
  const blocks = [];
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i');
  const closeTag = `</${tag}>`;
  let rest = xml;
  let offset = 0;
  while (true) {
    const m = openRe.exec(rest.slice(offset));
    if (!m) break;
    const start = offset + m.index + m[0].length;
    const closeIdx = rest.indexOf(closeTag, start);
    if (closeIdx === -1) break;
    blocks.push(rest.slice(start, closeIdx));
    offset = closeIdx + closeTag.length;
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

// روابط Atom تأتي كسمة href داخل وسم <link .../>
function extractAtomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/gi)];
  if (links.length === 0) return '';
  const alternate = links.find((l) => /rel="alternate"/i.test(l[0]));
  return (alternate || links[0])[1].trim();
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
  '&#39;': '\u2019', '&apos;': '\u2019',
};

function decodeEntities(text) {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    if (result.includes(entity)) result = result.split(entity).join(char);
  }
  return result;
}

function parseFeed(xmlText) {
  // RSS 2.0
  let blocks = extractBlocks(xmlText, 'item').map((block) => ({
    title: extractField(block, 'title'),
    link: extractField(block, 'link') || extractField(block, 'guid'),
    pubDate: extractField(block, 'pubDate') || extractField(block, 'dc:date'),
    description: extractField(block, 'description') || extractField(block, 'content:encoded'),
  }));

  // Atom (احتياطياً إذا لم يكن هناك <item>)
  if (blocks.length === 0) {
    blocks = extractBlocks(xmlText, 'entry').map((block) => ({
      title: extractField(block, 'title'),
      link: extractAtomLink(block),
      pubDate: extractField(block, 'published') || extractField(block, 'updated'),
      description: extractField(block, 'summary') || extractField(block, 'content'),
    }));
  }

  return blocks.map((b) => ({
    title: decodeEntities(stripHtml(b.title)).slice(0, 300),
    link: (b.link || '').trim(),
    pubDate: b.pubDate,
    description: decodeEntities(stripHtml(b.description)).slice(0, 500),
  }));
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

function isRecentEnough(article) {
  if (!article.pubDate) return true;
  const published = new Date(article.pubDate);
  if (Number.isNaN(published.getTime())) return true;
  const ageMs = Date.now() - published.getTime();
  return ageMs <= MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000;
}

// ------------------- التصنيف عبر كلمات مفتاحية محلية (بدون أي API خارجي) -------------------

// إشارات كلام/تصريح اللاعب (الأقوى دلالة على أن شخصاً يتحدث أو يُقتبس)
const SPEECH_KEYWORDS = [
  'says', 'said', 'tells', 'told', 'reveals', 'revealed', 'explains', 'explained',
  'admits', 'admitted', 'claims', 'claimed', 'confirms', 'confirmed', 'denies', 'denied',
  'announces', 'announced', 'insists', 'argues', 'addresses', 'opens up', 'breaks silence',
  'speaks out', 'speaks on', 'weighs in', 'comments', 'discusses', 'reflects on', 'teases',
  'hints', 'warns', 'promises', 'apologizes', 'apologises', 'calls out', 'hits back',
  'claps back', 'fires back', 'responds', 'reacts', 'slams', 'praises', 'defends',
  'criticizes', 'criticises', 'blasts', 'threatens', 'jokes', 'shares', 'statement',
  'interview', 'q&a', 'sits down', 'one-on-one', 'exclusive', 'on why', 'on how',
  'on what', 'on whether', 'on his', 'on her', 'on their',
];

// إشارات مواقع التواصل والبث (نقل كلام اللاعب عن حساباته)
// ملاحظة: تجنّبنا كلمة "stream" وحدها لأنها تلتقط جداول المشاهدة (stream schedule)
const SOCIAL_KEYWORDS = [
  'tweets', 'tweeted', 'tweet', 'posts', 'posted', 'instagram', 'twitter', 'on x',
  'tiktok', 'on stream', 'live on stream', 'twitch', 'youtube video', 'cryptic',
  'deletes', 'clip', 'goes off', 'goes viral', 'streamer',
];

// إشارات انتقالات/عقود/مسيرة اللاعب
const CAREER_KEYWORDS = [
  'sign', 'signing', 'signings', 'signs', 'signed', 'signs with', 'joins', 'joined', 'departs', 'departure',
  'parts ways', 'benched', 'benches', 'dropped from', 'cut from', 'released by',
  'transfer', 'roster move', 'moves to', 'returns to', 'return to', 'debut', 'debuts',
  'retires', 'retire', 'retirement', 'steps down', 'stepped down', 'trial', 'tryout',
  'replaces', 'replaced', 'loan', 'loaned', 'promoted', 'demoted', 'comeback',
];

// إشارات شخصية/صحية للاعب
const LIFE_KEYWORDS = [
  'injury', 'injured', 'health', 'hospital', 'diagnosed', 'recovers', 'recovery',
  'passes away', 'passed away', 'dies', 'death', 'tribute', 'married', 'engaged',
  'arrested', 'detained', 'banned', 'suspended', 'fined', 'visa', 'mental health',
  'harassment', 'allegation', 'allegations', 'scandal', 'controversy', 'apology',
];

// مصطلحات مراكز/تشكيلة تدل على أن الخبر يدور حول لاعب محدد
const ROLE_KEYWORDS = [
  'igl', 'in-game leader', 'awper', 'rifler', 'duelist', 'initiator', 'sentinel',
  'controller', 'entry fragger', 'mid laner', 'top laner', 'bot laner', 'jungler',
  'adc', 'roster', 'lineup', 'stand-in', 'substitute', 'starter', 'rookie', 'veteran',
];

// إشارة ضعيفة: تُقبل فقط إن لم يكن الخبر لوجستياً بحتاً
const WEAK_KEYWORDS = ['player', 'players', 'pro player', 'esports player'];

// الإشارات القوية: أي منها يعني قبول الخبر مباشرةً
const PLAYER_SIGNAL_KEYWORDS = [
  ...SPEECH_KEYWORDS, ...SOCIAL_KEYWORDS, ...CAREER_KEYWORDS, ...LIFE_KEYWORDS, ...ROLE_KEYWORDS,
];

// إشارات لوجستية بحتة (نستبعدها فقط عندما لا توجد أي إشارة تخص لاعباً)
const LOGISTICS_EXCLUDE = [
  'how to watch', 'where to watch', 'stream schedule', 'streams schedule', 'schedule',
  'results', 'standings', 'bracket', 'brackets', 'group stage', 'playoff schedule',
  'patch notes', 'patch', 'update notes', 'hotfix', 'tier list', 'power ranking',
  'power rankings', 'meta report', 'best settings', 'best sensitivity', 'best loadout',
  'best builds', 'best agents', 'best weapons', 'tips and tricks', 'giveaway', 'skins',
  'skin bundle', 'battle pass', 'redeem codes', 'free rewards', 'predictions',
  'betting odds', 'odds', 'where to buy', 'release date', 'trailer', 'teaser',
  'how to get', 'how to unlock', 'all rewards', 'gift codes',
];

const GAME_KEYWORDS = [
  { name: 'CS2', patterns: ['counter-strike', 'cs2', 'csgo'] },
  { name: 'Valorant', patterns: ['valorant'] },
  { name: 'League of Legends', patterns: ['league of legends', 'lol esports'] },
  { name: 'Dota 2', patterns: ['dota 2', 'dota2'] },
  { name: 'Call of Duty', patterns: ['call of duty', 'cdl', 'black ops'] },
  { name: 'Rainbow Six Siege', patterns: ['rainbow six', 'r6 siege', 'siege'] },
  { name: 'Apex Legends', patterns: ['apex legends'] },
  { name: 'Fortnite', patterns: ['fortnite'] },
  { name: 'Overwatch', patterns: ['overwatch'] },
  { name: 'Rocket League', patterns: ['rocket league'] },
  { name: 'PUBG Mobile', patterns: ['pubg mobile', 'pubgm'] },
  { name: 'PUBG', patterns: ['pubg', 'pubg: battlegrounds'] },
  { name: 'MLBB', patterns: ['mobile legends', 'mlbb'] },
  { name: 'Marvel Rivals', patterns: ['marvel rivals'] },
  { name: 'Super Smash Bros', patterns: ['smash bros', 'melee', 'ultimate'] },
  { name: 'StarCraft II', patterns: ['starcraft'] },
  { name: 'Teamfight Tactics', patterns: ['teamfight tactics', 'tft'] },
  { name: 'Wild Rift', patterns: ['wild rift'] },
  { name: 'Free Fire', patterns: ['free fire'] },
  { name: 'Honor of Kings', patterns: ['honor of kings'] },
  { name: 'EA SPORTS FC', patterns: ['ea sports fc', 'fifa', 'fc pro'] },
  { name: 'FGC', patterns: ['street fighter', 'tekken', 'fatal fury', 'guilty gear', 'mortal kombat'] },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// يطابق العبارة كوحدة كاملة (حدود كلمة) لتفادي مشاكل مثل "layoffs" داخل "playoffs".
function wordRegex(phrase) {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i');
}

function findKeyword(haystack, keywords) {
  return keywords.find((kw) => wordRegex(kw).test(haystack));
}

// نمط عنوان المقابلة/التصريح الشائع: "PlayerName on <موضوع>" أو "on his/why/how..."
const INTERVIEW_PATTERNS = [
  /\bon (his|her|their|why|how|what|whether|being|the future|his future|joining|leaving|fixing|playing|facing|losing|winning|returning|signing|moving|beating)\b/i,
  /\b\w+ on \w+ing\b/i, // مثل: "m0nesy on fixing" / "faker on winning"
];

function hasInterviewPattern(haystack) {
  return INTERVIEW_PATTERNS.some((re) => re.test(haystack));
}

function detectGame(text) {
  const lower = text.toLowerCase();
  for (const game of GAME_KEYWORDS) {
    if (game.patterns.some((p) => wordRegex(p).test(lower))) return game.name;
  }
  return 'Multi-title';
}

// يحدد نوع الخبر لعرضه في البطاقة
function detectKind(haystack) {
  if (findKeyword(haystack, ['interview', 'q&a', 'sits down', 'one-on-one', 'exclusive'])) {
    return 'مقابلة';
  }
  if (findKeyword(haystack, SOCIAL_KEYWORDS)) return 'تواصل اجتماعي';
  if (findKeyword(haystack, ['responds', 'reacts', 'hits back', 'claps back', 'fires back', 'slams', 'calls out', 'defends', 'praises', 'blasts'])) {
    return 'رد/تفاعل';
  }
  if (findKeyword(haystack, [...CAREER_KEYWORDS, ...ROLE_KEYWORDS])) return 'انتقال/مسيرة';
  if (findKeyword(haystack, LIFE_KEYWORDS)) return 'خبر شخصي';
  if (findKeyword(haystack, SPEECH_KEYWORDS)) return 'تصريح';
  if (hasInterviewPattern(haystack)) return 'تصريح';
  return 'خبر لاعب';
}

function classifyArticle(article) {
  const haystack = `${article.title} ${article.description}`.toLowerCase();
  const jordanRelated = wordRegex('jordan').test(haystack) || wordRegex('jordanian').test(haystack);

  const build = (reason) => ({
    include: true,
    kind: jordanRelated ? `أردني · ${detectKind(haystack)}` : detectKind(haystack),
    game: detectGame(haystack),
    jordanRelated,
    reason,
  });

  // 1) إشارة قوية تخص لاعباً → قبول مباشر
  const strong = findKeyword(haystack, PLAYER_SIGNAL_KEYWORDS);
  if (strong) return build(`إشارة لاعب: "${strong}"`);
  if (hasInterviewPattern(haystack)) return build('نمط مقابلة/تصريح');

  // 2) أي خبر أردني → قبول دائم (قاعدة الزاوية الأردنية)
  if (jordanRelated) return build('خبر مرتبط بالأردن');

  // 3) خبر لوجستي بحت بلا أي إشارة لاعب → استبعاد
  const logistics = findKeyword(haystack, LOGISTICS_EXCLUDE);
  if (logistics) return { include: false, reason: `لوجستي/غير مرتبط بلاعب: "${logistics}"` };

  // 4) إشارة ضعيفة (كلمة "player") مع غياب اللوجستيات → قبول
  const weak = findKeyword(haystack, WEAK_KEYWORDS);
  if (weak) return build(`إشارة عامة: "${weak}"`);

  // 5) لا شيء واضح
  if (INCLUDE_WHEN_NO_SIGNAL) return build('وضع "أرسل كل شيء" مُفعّل');
  return { include: false, reason: 'لا توجد إشارة واضحة تخص لاعباً' };
}

// ------------------- النشر عبر Discord Webhook -------------------
function truncate(text, max) { return text && text.length > max ? `${text.slice(0, max - 1)}…` : text; }

function buildEmbed(article, classification) {
  const embed = {
    title: truncate(article.title, 256),
    color: 0x5865f2,
    fields: [
      { name: 'النوع', value: classification.kind || 'خبر لاعب', inline: true },
      { name: 'Game/Title', value: classification.game || 'Multi-title', inline: true },
      { name: 'الأردن', value: classification.jordanRelated ? 'نعم' : 'لا', inline: true },
    ],
    footer: { text: `GGNewsAR — رصد لاعبي الإيسبورتس | ${article.sourceName}` },
  };
  if (article.link) embed.url = article.link;
  if

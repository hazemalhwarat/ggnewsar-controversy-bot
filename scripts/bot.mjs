// ===================================================================
// GGNewsAR Controversy Bot — نسخة GitHub Actions (مجانية بالكامل)
// يرصد قضايا وجدل الرياضات الإلكترونية (لاعبون، فرق، دول) بعيداً عن نتائج المباريات
// التصنيف عبر GitHub Models (مدمج داخل GitHub Actions، لا يحتاج أي حساب خارجي)
// التخزين: ملف data/seen.json داخل نفس الريبو
// ===================================================================

import fs from 'node:fs';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AI_MODEL = 'openai/gpt-4o-mini';
const SEEN_FILE = 'data/seen.json';
const DEDUPE_LOOKBACK_DAYS = 14;
// حد متحفظ لعدد التصنيفات بكل تشغيلة، لأن GitHub Models له سقف طلبات يومي محدود
// (حوالي 50 طلب/يوم لهذا النموذج). أي مقال يتجاوز الحد لا يُسجَّل كمقروء، فيُعاد
// تصنيفه تلقائياً بالتشغيلة القادمة بدل أن يُفقد.
const MAX_NEW_PER_RUN = 10;

if (!DISCORD_WEBHOOK_URL || !GITHUB_TOKEN) {
  console.error('أحد متغيرات البيئة المطلوبة مفقود: DISCORD_WEBHOOK_URL, GITHUB_TOKEN');
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

// ------------------- التصنيف عبر GitHub Models -------------------
const SYSTEM_PROMPT = `أنت مساعد تصنيف لبوت رصد أخبار رياضات إلكترونية (إسبورتس) خاص بمنصة GGNewsAR.
مهمتك الوحيدة: تقرأ عنوان وملخص مقال إخباري بالإنجليزية، وتقرر هل هذا المقال ضمن نطاق البوت أم لا، ثم تصنّفه.

نطاق البوت (استبعد كل ما لا يخصه):
البوت مخصص فقط لما يخص القضايا واللاعبين والفرق والدول والجدل في عالم الإسبورتس. البوت لا يريد إطلاقاً أخبار نتائج المباريات والبطولات.

استبعد المقال (include=false) إذا كان يقتصر على أحد هذه الأنواع بلا أي زاوية أخرى:
- نتيجة مباراة أو سلسلة مباريات (من فاز ومن خسر والنتيجة)
- تتويج ببطولة أو مركز في الترتيب (standings)
- تحليل تكتيكي أو ميتا اللعبة (أبطال، أسلحة، خرائط، بناء عناصر) دون أي بعد شخصي أو جدلي
- توقعات نتائج مباريات قادمة
- إحصاءات أداء داخل بطولة (KDA، معدل فوز، إلخ) دون قصة أو جدل حولها
- ملاحظات تحديثات وباتشات تقنية للعبة نفسها لا علاقة لها بلاعب أو فريق أو قضية

اشمل المقال (include=true) إذا كان عن أي من هذه (حتى لو ذُكرت داخله نتيجة مباراة كسياق فرعي):
- قضايا وجدل: فضائح، عقوبات، حظر (بما فيها حظر الغش وanti-cheat وESIC)، تحقيقات، تلاعب بالنتائج (match-fixing)، مراهنات، اتهامات تحرش أو إساءة
- قوانين وتشريعات: قرارات حكومية أو رسمية تخص الألعاب أو الإسبورتس في أي دولة، تأشيرات سفر لمنتخبات، قضايا قانونية أو حقوق رقمية
- شؤون الفرق والمنظمات: مشاكل مالية، إفلاس، حل فريق، نزاع ملكية، خلافات داخلية، صفقات رعاية وأعمال
- اللاعبون والشخصيات: قصص شخصية، مقابلات، اعتزال، تصريحات، خلافات عقود، قصص حياتية
- المشهد المحلي والعربي: أي شيء يخص دولة ولاعبيها أو فرقها أو اتحادها الرياضي للألعاب الإلكترونية
- ثقافة الألعاب والنقاش المجتمعي: قضايا جدلية مطروحة للنقاش في المجتمع (حتى لو لم يكن هناك "طرف مذنب")
- صناعة وأعمال: استثمارات، إغلاق شركات، تغييرات في البطولات كصناعة، تقارير مشاهدات وسوق

عند الشك بين نتيجة مباراة بحتة وقضية حقيقية، افضّل الاستبعاد فقط إذا كانت المباراة/النتيجة هي محور الخبر الوحيد بلا أي بعد إنساني أو جدلي أو مؤسسي.

أعد الإجابة بصيغة JSON فقط بدون أي نص أو شرح أو علامات markdown قبله أو بعده، بالضبط بهذا الشكل:
{
  "include": true أو false,
  "category": "قيمة واحدة من: Competitive, Transfers & Rosters, Teams & Orgs, Business & Industry, Law & Regulation, Gaming Culture, Community & Local Scene, Tech & Platforms, Player & Personalities",
  "game_title": "اسم اللعبة بالإنجليزية كما في Liquipedia، أو Multi-title أو Industry (no single title) إن لم تخص لعبة واحدة",
  "story_type": "قيمة واحدة من: Match result, Tournament win, Standings update, Tournament Stats, Roster move, Official announcement, Business & sponsorship, Schedule & qualification, Stats & viewership, Investigation, Controversy & discipline, Platform integrity & anti-cheat, Record, Feature & analysis, Community & local scene",
  "arab_scene_relevance": "High أو Medium أو Low",
  "sensitivity": "High أو Medium أو Low",
  "jordan_related": true أو false,
  "headline_ar": "صياغة عربية مختصرة من عندك لجوهر الخبر (وليست ترجمة حرفية)، لا تتجاوز 12 كلمة",
  "reason_ar": "سبب القرار في جملة عربية قصيرة جداً"
}`;

function buildUserMessage(article) {
  return [
    `المصدر: ${article.sourceName}`,
    `العنوان: ${article.title}`,
    article.description ? `الملخص: ${article.description}` : null,
    article.pubDate ? `تاريخ النشر: ${article.pubDate}` : null,
  ].filter(Boolean).join('\n');
}

function safeParseJson(text) {
  let cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('لا يوجد JSON صالح في الرد');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function classifyArticle(article) {
  try {
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(article) },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub Models API ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('لا يوجد نص في رد النموذج');

    const parsed = safeParseJson(text);
    if (typeof parsed.include !== 'boolean') throw new Error('حقل include مفقود أو غير صالح');
    return parsed;
  } catch (err) {
    console.warn(`فشل تصنيف المقال "${article.title}": ${err.message}`);
    return {
      include: false, category: null, game_title: null, story_type: null,
      arab_scene_relevance: null, sensitivity: null, jordan_related: false,
      headline_ar: null, reason_ar: 'فشل التصنيف الآلي، تم التجاوز احترازياً',
      classification_failed: true,
    };
  }
}

// ------------------- النشر عبر Discord Webhook -------------------
const SENSITIVITY_COLOR = { High: 0xe53935, Medium: 0xfb8c00, Low: 0x546e7a };
function colorFor(sensitivity) { return SENSITIVITY_COLOR[sensitivity] || 0x5865f2; }
function truncate(text, max) { return text && text.length > max ? `${text.slice(0, max - 1)}…` : text; }

function buildEmbed(article, classification) {
  const embed = {
    title: truncate(classification.headline_ar || article.title, 256),
    color: colorFor(classification.sensitivity),
    fields: [
      { name: 'Category', value: String(classification.category || 'غير محدد'), inline: true },
      { name: 'Game/Title', value: String(classification.game_title || 'غير محدد'), inline: true },
      { name: 'Story type', value: String(classification.story_type || 'غير محدد'), inline: true },
      { name: 'Arab-scene relevance', value: String(classification.arab_scene_relevance || 'غير محدد'), inline: true },
      { name: 'Sensitivity', value: String(classification.sensitivity || 'غير محدد'), inline: true },
      { name: 'الأردن', value: classification.jordan_related ? 'نعم' : 'لا', inline: true },
      { name: 'العنوان الأصلي', value: truncate(article.title, 1024) },
    ],
    footer: { text: `المصدر: ${article.sourceName}` },
  };
  if (article.link) embed.url = article.link;
  if (classification.reason_ar) embed.fields.push({ name: 'ملاحظة التصنيف', value: truncate(classification.reason_ar, 300) });
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
  const freshArticles = articles.filter((a) => a.link && !Object.prototype.hasOwnProperty.call(seenMap, a.link));

  console.log(`مقالات مجلوبة: ${articles.length}، جديدة: ${freshArticles.length}`);

  if (isFirstRun) {
    freshArticles.forEach((a) => { seenMap[a.link] = Date.now(); });
    saveSeen(seenMap);
    console.log(`دورة التهيئة الأولى: تم تسجيل ${freshArticles.length} مقال كمقروء بدون نشر (لتفادي إغراق القناة بمحتوى قديم).`);
    return;
  }

  const toProcess = freshArticles.slice(0, MAX_NEW_PER_RUN);
  let included = 0, excluded = 0, failed = 0;

  for (const article of toProcess) {
    const classification = await classifyArticle(article);
    if (classification.classification_failed) {
      failed += 1;
    } else {
      if (classification.include) {
        const posted = await postToDiscord(article, classification);
        if (posted) included += 1;
      } else {
        excluded += 1;
      }
      seenMap[article.link] = Date.now();
    }
  }

  pruneOld(seenMap);
  saveSeen(seenMap);

  console.log(`انتهت الدورة: نُشر ${included}، استُبعد ${excluded}، فشل تصنيف ${failed}.`);
}

main().catch((err) => {
  console.error('خطأ غير متوقع:', err);
  process.exit(1);
});

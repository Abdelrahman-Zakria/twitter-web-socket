require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 1. Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore(app);

// 2. Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const cp1252_map = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
};

function isMojibake(text) {
  if (!text) return false;
  const count = (text.match(/Ø|Ù|Ã|Â/g) || []).length;
  return count >= 2;
}

function decodeAndCleanText(text) {
  if (!text) return '';
  let s = text;

  if (isMojibake(s)) {
    const bytes = [];
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = s[i];
      if (c === '\u00D9' && i + 1 < n && s[i + 1] === '\uFFFD') {
        bytes.push(0xD9, 0x81);
        i++;
        continue;
      }
      if (c === '\u00D9' && (i + 1 >= n || s[i + 1] === '\u00D9' || s[i + 1] === ' ' || s[i + 1] === '.' || s[i + 1] === ':')) {
        bytes.push(0xD9, 0x81);
        continue;
      }
      if (c === '\u00D8' && i + 1 < n && s[i + 1] === '\uFFFD') {
        bytes.push(0xD8, 0x81);
        i++;
        continue;
      }
      if (cp1252_map[c] !== undefined) {
        bytes.push(cp1252_map[c]);
      } else {
        const code = c.charCodeAt(0);
        if (code < 256) {
          bytes.push(code);
        } else {
          const buf = Buffer.from(c, 'utf8');
          for (const b of buf) bytes.push(b);
        }
      }
    }

    try {
      let decoded = Buffer.from(bytes).toString('utf8');
      decoded = decoded.replace(/\ufffd/g, '');
      decoded = decoded
        .replace(/يفعتقد/g, 'يُعتقد')
        .replace(/قفتل/g, 'قُتل')
        .replace(/بفعد/g, 'بعد')
        .replace(/غدف/g, 'غدًا');
      s = decoded;
    } catch (err) {
      console.warn('⚠️ Decoding error, using original:', err.message);
    }
  }

  return s.trim();
}

function isArabicOrEnglish(text) {
  if (!text || text.trim().length === 0) return false;
  const arabicLetters = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const englishLetters = (text.match(/[a-zA-Z]/g) || []).length;
  return (arabicLetters + englishLetters) > 0;
}

function classifyFastWithKeywords(text) {
  const t = text.toLowerCase();
  if (t.includes('عاجل')) return 'عاجل';
  if (/دوري|مباراة|كأس|نادي|لاعب|منتخب|رياضي|أهداف|كرة|الهلال|النصر|الاتحاد|الأهلي/.test(t)) return 'رياضة';
  if (/اقتصاد|أسهم|تداول|تضخم|ريال|دولار|نفط|برميل|بنك|مصرف|أرباح|ميزانية|استثمار/.test(t)) return 'اقتصاد';
  if (/وزير|وزارة الخارجية|مجلس الوزراء|قمة|دبلوماسي|حرب|جيش|عسكري|دفاع|هدنة|اتفاقية|ترامب|بايدن|طهران|إيران/.test(t)) return 'سياسة';
  if (/تقنية|ذكاء اصطناعي|تطبيق|هاتف|إنترنت|أبل|سامسونج|تحديث|أندرويد|ios/.test(t)) return 'تكنولوجيا';
  if (/وظيفة|وظائف|شاغرة|توظيف|رواتب|تدريب/.test(t)) return 'وظائف';
  if (/طقس|أمطار|صحة|تعليم|مدرسة|جامعة|طرق|مرور|حوادث/.test(t)) return 'مجتمع';
  return null;
}

async function classifyTweetWithAI(tweetText) {
  const quick = classifyFastWithKeywords(tweetText);
  if (quick) return quick;

  const prompt = `Classify the following Arabic news tweet into one of these exact categories: [سياسة, اقتصاد, مجتمع, تكنولوجيا, رياضة, عاجل]. Return ONLY the category name in Arabic without any extra text or punctuation:\n\n"${tweetText}"`;

  try {
    const aiPromise = aiModel.generateContent(prompt).then(async r => {
      const res = await r.response;
      return res.text().trim();
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI timeout')), 3500)
    );

    const category = await Promise.race([aiPromise, timeoutPromise]);
    const validCategories = ['سياسة', 'اقتصاد', 'مجتمع', 'تكنولوجيا', 'رياضة', 'عاجل'];
    return validCategories.includes(category) ? category : 'عام';
  } catch (error) {
    return 'عام';
  }
}

async function backfillUser(username, targetCollection) {
  console.log(`\n🔄 Backfilling tweets for @${username} into [${targetCollection}]...`);
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${username}`;
    const res = await fetch(url, {
      headers: { 'x-api-key': process.env.TWITTER_API_KEY }
    });
    
    if (!res.ok) {
      console.error(`❌ HTTP Error ${res.status} for @${username}`);
      return 0;
    }

    const data = await res.json();
    const tweets = data.data?.tweets || data.tweets || [];
    console.log(`  Fetched ${tweets.length} recent tweets from API.`);

    let savedCount = 0;
    for (const tweet of tweets) {
      const tweetId = String(tweet?.id || tweet?.tweet_id || '');
      if (!tweetId) continue;

      const docRef = db.collection(targetCollection).doc(tweetId);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        continue;
      }

      const rawText = tweet?.text || '';
      const text = decodeAndCleanText(rawText);
      if (!text || !isArabicOrEnglish(text)) continue;

      const createdAt = tweet?.createdAt || tweet?.created_at || new Date().toISOString();
      const mediaList = Array.isArray(tweet?.extendedEntities?.media || tweet?.media)
        ? (tweet?.extendedEntities?.media || tweet?.media)
        : [];

      let aiCategory = 'عام';
      if (targetCollection === 'news') {
        aiCategory = await classifyTweetWithAI(text);
      } else if (targetCollection === 'jobs') {
        aiCategory = 'وظائف';
      } else if (targetCollection === 'spl') {
        aiCategory = 'رياضة';
      } else if (targetCollection === 'technology') {
        aiCategory = 'تكنولوجيا';
      }

      await docRef.set({
        tweetId,
        text,
        createdAt,
        author: username.toLowerCase(),
        category: aiCategory,
        media: mediaList,
        retweetCount: tweet?.retweetCount || 0,
        likeCount: tweet?.likeCount || 0,
        replyCount: tweet?.replyCount || 0,
        timestamp: FieldValue.serverTimestamp()
      });

      savedCount++;
      console.log(`  ✅ Saved [${targetCollection}] (${aiCategory}): ${text.substring(0, 50)}...`);
    }

    console.log(`✨ Completed @${username}: ${savedCount} new tweets saved.`);
    return savedCount;
  } catch (err) {
    console.error(`❌ Error backfilling @${username}:`, err.message);
    return 0;
  }
}

async function run() {
  console.log('🚀 Starting backfill of missed tweets across all accounts...');
  const accounts = [
    { username: 'SaudiNews50', collection: 'news' },
    { username: 'ajlnews', collection: 'news' },
    { username: 'newsjobs50', collection: 'jobs' },
    { username: 'spl', collection: 'spl' },
    { username: 'utechcom', collection: 'technology' }
  ];

  let totalSaved = 0;
  for (const acc of accounts) {
    const count = await backfillUser(acc.username, acc.collection);
    totalSaved += count;
  }

  console.log(`\n🎉 Backfill complete! Total ${totalSaved} missed tweets recovered and saved to Firestore.`);
  process.exit(0);
}

run();

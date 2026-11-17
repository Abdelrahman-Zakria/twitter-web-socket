require('dotenv').config();
const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Prevent silent process death
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// 1. Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore(app);
const messaging = getMessaging(app);

// 2. Initialize Gemini AI (using recommended fast model)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

/**
 * Windows-1252 byte mapping for 0x80-0x9F characters
 */
const cp1252_map = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
};

/**
 * Detects whether text contains UTF-8 mojibake (e.g. decoded as Windows-1252 / Latin-1)
 */
function isMojibake(text) {
  if (!text) return false;
  const count = (text.match(/Ø|Ù|Ã|Â/g) || []).length;
  return count >= 2;
}

/**
 * Decodes and cleans mojibake text back into proper Arabic / English
 */
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

/**
 * Validates that text contains Arabic or English content
 */
function isArabicOrEnglish(text) {
  if (!text || text.trim().length === 0) return false;
  const arabicLetters = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const englishLetters = (text.match(/[a-zA-Z]/g) || []).length;
  return (arabicLetters + englishLetters) > 0;
}

/**
 * Fast keyword classification to avoid slow AI roundtrips when obvious
 */
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

/**
 * Classifies tweet text using Gemini AI with strict timeout
 */
async function classifyTweetWithAI(tweetText) {
  const quick = classifyFastWithKeywords(tweetText);
  if (quick) return quick;

  const prompt = `Classify the following Arabic news tweet into one of these exact categories: [سياسة, اقتصاد, مجتمع, تكنولوجيا, رياضة, عاجل]. Return ONLY the category name in Arabic without any extra text or punctuation:\n\n"${tweetText}"`;

  try {
    const aiPromise = aiModel.generateContent(prompt).then(async r => {
      const response = await r.response;
      return response.text().trim();
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

/**
 * Common tweet processing logic
 */
async function processSingleTweet(tweet, isLive = true) {
  const rawAuthor = tweet?.author || {};
  const rawUsername = rawAuthor.userName || rawAuthor.username || tweet?.username || '';
  const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : '';

  const rawText = tweet?.text || '';
  const text = decodeAndCleanText(rawText);

  if (!text || !isArabicOrEnglish(text)) {
    return false;
  }
  const tweetId = String(tweet?.id || tweet?.tweet_id || '');
  const createdAt = tweet?.createdAt || tweet?.created_at || new Date().toISOString();
  const mediaList = Array.isArray(tweet?.extendedEntities?.media || tweet?.media) 
    ? (tweet?.extendedEntities?.media || tweet?.media) 
    : [];

  if (!tweetId) return false;

  // Routing Logic
  let targetCollection = '';
  let notificationTopic = '';

  if (['saudinews50', 'ajlnews', 'makanspace'].includes(username)) {
    targetCollection = 'news';
    notificationTopic = 'news_topic';
  } else if (username === 'newsjobs50') {
    targetCollection = 'jobs';
    notificationTopic = 'jobs_topic';
  } else if (username === 'spl') {
    targetCollection = 'spl';
    notificationTopic = 'spl_topic';
  } else if (username === 'utechcom') {
    targetCollection = 'technology';
    notificationTopic = 'technology_topic';
  } else {
    return false;
  }

  // Deduplication Check
  const docRef = db.collection(targetCollection).doc(tweetId);
  const docSnap = await docRef.get();
  if (docSnap.exists) {
    return false;
  }

  // AI Classification
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

  // Save to Firestore
  await docRef.set({
    tweetId,
    text,
    createdAt,
    author: username,
    category: aiCategory,
    media: mediaList,
    retweetCount: tweet?.retweetCount || 0,
    likeCount: tweet?.likeCount || 0,
    replyCount: tweet?.replyCount || 0,
    timestamp: FieldValue.serverTimestamp()
  });

  console.log(`💾 Saved [${targetCollection}] (${aiCategory}): @${username} - ${text.substring(0, 45)}...`);

  // Send Deep-Linking Notification only for live incoming tweets
  if (isLive) {
    try {
      const response = await messaging.send({
        topic: notificationTopic,
        notification: {
          title: `[${aiCategory}] خبر جديد 🚨`,
          body: text.substring(0, 150).trim() + '...'
        },
        data: {
          tweetId: tweetId,
          collection: targetCollection, 
          type: 'news_update',
          click_action: 'FLUTTER_NOTIFICATION_CLICK' 
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'fcm_foreground_channel',
            sound: 'default'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              contentAvailable: true
            }
          }
        }
      });
      console.log(`🚀 FCM SUCCESS: Sent to [${notificationTopic}]. ID: ${response}`);
    } catch (fcmError) {
      console.error(`🔴 FCM ERROR for [${notificationTopic}]:`, fcmError.message);
    }
  }

  return true;
}

/**
 * Background auto-backfill on startup and after reconnection
 */
async function backfillRecentTweets() {
  console.log('🔄 Checking for any missed tweets during downtime...');
  const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
  const accounts = ['SaudiNews50', 'ajlnews', 'newsjobs50', 'spl', 'utechcom'];

  for (const account of accounts) {
    try {
      const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${account}`;
      const res = await fetch(url, {
        headers: { 'x-api-key': process.env.TWITTER_API_KEY }
      });
      if (!res.ok) continue;

      const data = await res.json();
      const tweets = data.data?.tweets || data.tweets || [];
      for (const tweet of tweets) {
        await processSingleTweet(tweet, false);
      }
    } catch (e) {
      console.warn(`⚠️ Backfill error for @${account}:`, e.message);
    }
  }
  console.log('✅ Backfill check complete.');
}

/**
 * Twitter WebSocket Stream logic with Heartbeat & Dead Socket Detection
 */
let reconnectDelay = 3000;
let isBackfillRunning = false;

function connectWebSocket() {
  const apiKey = process.env.TWITTER_API_KEY;
  const wsUrl = "wss://ws.twitterapi.io/twitter/tweet/websocket";
  
  console.log('🔌 Connecting to Twitter WebSocket stream...');
  
  const ws = new WebSocket(wsUrl, {
    headers: { "x-api-key": apiKey }
  });

  let heartbeatInterval = null;
  let isAlive = false;

  ws.on('open', () => {
    console.log('🟢 SUCCESS: Connected to live Twitter stream!');
    reconnectDelay = 3000; // Reset backoff on success
    isAlive = true;

    // Heartbeat every 25 seconds to keep connection alive and detect half-open sockets
    heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        console.warn('⚠️ No heartbeat response in 25s. Dead socket detected, terminating...');
        clearInterval(heartbeatInterval);
        return ws.terminate(); // Triggers 'close' event and forces reconnection
      }
      isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        ws.terminate();
      }
    }, 25000);

    // Run backfill in background once connected
    if (!isBackfillRunning) {
      isBackfillRunning = true;
      backfillRecentTweets().finally(() => {
        isBackfillRunning = false;
      });
    }
  });

  ws.on('pong', () => {
    isAlive = true;
  });

  ws.on('message', async (data) => {
    isAlive = true; // Any message proves socket is active
    try {
      const result_json = JSON.parse(data.toString());
      if (result_json.event_type !== "tweet") return;

      const tweets = result_json.tweets || [];
      console.log(`📥 Processing ${tweets.length} tweet(s)...`);

      for (const tweet of tweets) {
        await processSingleTweet(tweet, true);
      }
    } catch (err) {
      console.error('❌ WebSocket Message Error:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.warn(`⚠️ WebSocket Disconnected (code: ${code}, reason: ${reason}). Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // Exponential backoff up to 30s
  });

  ws.on('error', (error) => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.error('🔴 WebSocket critical error:', error.message);
    ws.terminate();
  });
}

connectWebSocket();

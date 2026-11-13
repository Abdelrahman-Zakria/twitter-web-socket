require('dotenv').config();
const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 1. Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore(app);
const messaging = getMessaging(app);

// 2. Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

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
      // \u00D9\uFFFD or isolated \u00D9 represents UTF-8 0xD9 0x81 ('ف')
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
  // Must have at least some Arabic or English alphabetic content
  return (arabicLetters + englishLetters) > 0;
}

/**
 * Classifies tweet text using Gemini AI
 */
async function classifyTweetWithAI(tweetText) {
  const prompt = `Classify the following Arabic news tweet into one of these exact categories: [سياسة, اقتصاد, مجتمع, تكنولوجيا, رياضة, عاجل]. Return ONLY the category name in Arabic without any extra text or punctuation:\n\n"${tweetText}"`;

  try {
    const result = await aiModel.generateContent(prompt);
    const response = await result.response;
    const category = response.text().trim();
    
    const validCategories = ['سياسة', 'اقتصاد', 'مجتمع', 'تكنولوجيا', 'رياضة', 'عاجل'];
    return validCategories.includes(category) ? category : 'عام';
  } catch (error) {
    console.error('⚠️ AI Classification Error:', error.message);
    return 'عام';
  }
}

/**
 * Twitter WebSocket Stream logic
 */
function connectWebSocket() {
  const apiKey = process.env.TWITTER_API_KEY;
  const wsUrl = "wss://ws.twitterapi.io/twitter/tweet/websocket";
  
  console.log('🔌 Connecting to Twitter WebSocket stream...');
  
  const ws = new WebSocket(wsUrl, {
    headers: { "x-api-key": apiKey }
  });

  ws.on('open', () => {
    console.log('🟢 SUCCESS: Connected to live Twitter stream!');
  });

  ws.on('message', async (data) => {
    try {
      const result_json = JSON.parse(data.toString());
      
      if (result_json.event_type !== "tweet") return;

      const tweets = result_json.tweets || [];
      console.log(`📥 Processing ${tweets.length} tweet(s)...`);

      for (const tweet of tweets) {
        const rawAuthor = tweet?.author || {};
        const rawUsername = rawAuthor.userName || rawAuthor.username || tweet?.username || '';
        const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : '';
        
        const rawText = tweet?.text || '';
        const text = decodeAndCleanText(rawText);

        if (!text || !isArabicOrEnglish(text)) {
          console.warn(`⚠️ Skipped tweet ${tweet?.id || tweet?.tweet_id}: Text is empty or neither Arabic nor English`);
          continue;
        }
        const tweetId = String(tweet?.id || tweet?.tweet_id || '');
        const createdAt = tweet?.createdAt || tweet?.created_at || new Date().toISOString();
        const mediaList = Array.isArray(tweet?.extendedEntities?.media || tweet?.media) ? (tweet?.extendedEntities?.media || tweet?.media) : [];

        if (!tweetId) continue;

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
          continue; 
        }

        // Deduplication Check
        const docRef = db.collection(targetCollection).doc(tweetId);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
          console.log(`🛡️ Duplicate skipped: ${tweetId}`);
          continue;
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

        // 3. Save to Firestore
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

        console.log(`💾 Saved [${targetCollection}]: @${username}`);

        // 4. Send Deep-Linking Notification (Optimized for App Opening)
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
                // clickAction REMOVED
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
    } catch (err) {
      console.error('❌ WebSocket Message Error:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`⚠️ WebSocket Disconnected. Reconnecting in 5s...`);
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('🔴 WebSocket critical error:', error.message);
    ws.terminate();
  });
}

connectWebSocket();
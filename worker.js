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
const aiModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

/**
 * Classifies tweet text using Gemini 1.5 Flash
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
        
        const text = tweet?.text || '';
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
              type: 'news_update'
              // click_action REMOVED
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
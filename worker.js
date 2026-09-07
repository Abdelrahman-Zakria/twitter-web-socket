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

// 2. Initialize Gemini AI (using the latest SDK)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

/**
 * Classifies tweet text using Gemini 1.5 Flash
 */
async function classifyTweetWithAI(tweetText) {
  const prompt = `Classify the following Arabic news tweet into one of these exact categories: [سياسة, اقتصاد, مجتمع, تكنولوجيا, رياضة, عاجل]. Return ONLY the category name in Arabic without any extra text or punctuation:\n\n"${tweetText}"`;

  try {
    const result = await aiModel.generateContent(prompt);
    const response = await result.response;
    const category = response.text().trim();
    
    // Validate that AI returned one of the expected categories
    const validCategories = ['سياسة', 'اقتصاد', 'مجتمع', 'تكنولوجيا', 'رياضة', 'عاجل'];
    return validCategories.includes(category) ? category : 'عام';
  } catch (error) {
    console.error('⚠️ AI Classification Error:', error.message);
    return 'عام';
  }
}

/**
 * Establishes and maintains the Twitter WebSocket stream
 */
function connectWebSocket() {
  const apiKey = process.env.TWITTER_API_KEY;
  const wsUrl = "wss://ws.twitterapi.io/twitter/tweet/websocket";
  
  console.log('🔌 Connecting to Twitter WebSocket stream...');
  
  const ws = new WebSocket(wsUrl, {
    headers: { "x-api-key": apiKey }
  });

  ws.on('open', () => {
    console.log('🟢 SUCCESS: Connected to Twitter WebSocket Stream live!');
  });

  ws.on('message', async (data) => {
    try {
      const result_json = JSON.parse(data.toString());
      
      if (result_json.event_type === "connected") return;
      if (result_json.event_type === "ping") return;

      if (result_json.event_type === "tweet") {
        const tweets = result_json.tweets || [];
        console.log(`📥 Received ${tweets.length} tweet(s).`);

        for (const tweet of tweets) {
          // Extract basic info
          const rawAuthor = tweet?.author || {};
          const rawUsername = rawAuthor.userName || rawAuthor.username || tweet?.username || '';
          const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : '';
          
          const text = tweet?.text || '';
          const tweetId = String(tweet?.id || tweet?.tweet_id || '');
          const createdAt = tweet?.createdAt || tweet?.created_at || new Date().toISOString();
          
          const rawMedia = tweet?.extendedEntities?.media || tweet?.extended_entities?.media || tweet?.media || [];
          const mediaList = Array.isArray(rawMedia) ? rawMedia : [rawMedia].filter(Boolean);

          if (!tweetId) continue;

          // Route to correct collection and notification topic
          let targetCollection = '';
          let notificationTopic = '';

          if (username === 'saudinews50' || username === 'ajlnews' || username === 'makanspace') {
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
          if (docSnap.exists) continue;

          // Logic-based classification
          let aiCategory = 'عام';
          if (username === 'saudinews50' || username === 'ajlnews' || username === 'makanspace') {
            aiCategory = await classifyTweetWithAI(text);
          } else if (username === 'newsjobs50') {
            aiCategory = 'وظائف';
          } else if (username === 'spl') {
            aiCategory = 'رياضة';
          } else if (username === 'utechcom') {
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
            retweetCount: tweet?.retweetCount || tweet?.retweet_count || 0,
            likeCount: tweet?.likeCount || tweet?.like_count || 0,
            replyCount: tweet?.replyCount || tweet?.reply_count || 0,
            timestamp: FieldValue.serverTimestamp()
          });

          console.log(`💾 Saved to [${targetCollection}]: @${username}`);

          // 4. Send Professional Notification
          try {
            const response = await messaging.send({
              topic: notificationTopic,
              notification: {
                title: `[${aiCategory}] خبر جديد 🚨`,
                body: text.substring(0, 150).trim() + '...'
              },
              data: {
                tweetId: tweetId,
                type: 'news_update',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
              },
              android: {
                priority: 'high',
                notification: {
                  channelId: 'fcm_foreground_channel',
                  sound: 'default',
                  clickAction: 'FLUTTER_NOTIFICATION_CLICK'
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
            console.error(`🔴 FCM FAILED for [${notificationTopic}]:`, fcmError.message);
          }
        }
      }
    } catch (err) {
      console.error('❌ Processing Error:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`⚠️ Connection Lost. Reconnecting in 5s...`);
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('🔴 WebSocket Error:', error.message);
    ws.terminate();
  });
}

connectWebSocket();
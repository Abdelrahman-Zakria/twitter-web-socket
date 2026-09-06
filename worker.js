require('dotenv').config();
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Initialize Firebase from Environment Variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore(app);
const messaging = getMessaging(app);

async function classifyTweetWithAI(tweetText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return 'عام';

  const prompt = `Classify the following Arabic news tweet into one of these exact categories: [سياسة, اقتصاد, مجتمع, تكنولوجيا, رياضة, عاجل]. Return ONLY the category name in Arabic without any extra text or punctuation:\n\n"${tweetText}"`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!response.ok) return 'عام';
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'عام';
  } catch (error) {
    console.error('AI Error:', error.message);
    return 'عام';
  }
}

function connectWebSocket() {
  const apiKey = process.env.TWITTER_API_KEY;
  const wsUrl = "wss://ws.twitterapi.io/twitter/tweet/websocket";
  
  console.log('🔌 Connecting to Twitter WebSocket stream...');
  
  // Pass the x-api-key header as required by TwitterAPI.io
  const ws = new WebSocket(wsUrl, {
    headers: {
      "x-api-key": apiKey
    }
  });

  ws.on('open', () => {
    console.log('🟢 SUCCESS: Connected to Twitter WebSocket Stream live!');
  });

  ws.on('message', async (data) => {
    try {
      const result_json = JSON.parse(data.toString());
      const event_type = result_json.event_type;

      if (event_type === "connected") {
        console.log("🟢 Connection handshake successful!");
        return;
      }

      if (event_type === "ping") {
        console.log("🏓 Ping received from server.");
        return;
      }

      if (event_type === "tweet") {
        const tweets = result_json.tweets || [];
        console.log(`📥 Received tweet event with ${tweets.length} tweet(s).`);

        for (const tweet of tweets) {
          const rawAuthor = tweet?.author || {};
          const rawUsername = rawAuthor.userName || rawAuthor.username || tweet?.username || '';
          const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : '';
          
          const text = tweet?.text || '';
          const tweetId = String(tweet?.id || tweet?.tweet_id || '');
          const createdAt = tweet?.createdAt || tweet?.created_at || new Date().toISOString();
          
          const rawMedia = tweet?.extendedEntities?.media || tweet?.extended_entities?.media || tweet?.media || [];
          const mediaList = Array.isArray(rawMedia) ? rawMedia : [rawMedia].filter(Boolean);

          if (!tweetId) continue;

          let targetCollection = '';
          let notificationTopic = '';

          if (username === 'saudinews50') {
            targetCollection = 'news';
            notificationTopic = 'news_topic';
          } else if (username === 'btalah') {
            targetCollection = 'jobs';
            notificationTopic = 'jobs_topic';
          } else if (username === 'spl') {
            targetCollection = 'spl';
            notificationTopic = 'spl_topic';
          } else if (username === 'utechcom') {
            targetCollection = 'technology';
            notificationTopic = 'technology_topic';
          } else {
            console.log(`ℹ️ Ignored tweet from unmonitored username: @${username}`);
            continue;
          }

          const docRef = db.collection(targetCollection).doc(tweetId);
          const docSnap = await docRef.get();

          if (docSnap.exists) {
            console.log(`🛡️ Duplicate Prevented: Tweet [${tweetId}] already in Firestore.`);
            continue;
          }

          let aiCategory = 'عام';
          if (username === 'saudinews50') {
            aiCategory = await classifyTweetWithAI(text);
          } else if (username === 'btalah') {
            aiCategory = 'وظائف';
          } else if (username === 'spl') {
            aiCategory = 'رياضة';
          } else if (username === 'utechcom') {
            aiCategory = 'تكنولوجيا';
          }

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

          console.log(`🟢 SAVED [${targetCollection}]: Tweet ID [${tweetId}] from @${username}`);

          try {
            await messaging.send({
              topic: notificationTopic,
              notification: {
                title: `[${aiCategory}] خبر أو تحديث جديد 🚨`,
                body: text.substring(0, 100) + '...'
              }
            });
            console.log(`🚀 FCM Sent for topic: ${notificationTopic}`);
          } catch (fcmError) {
            console.error('FCM Error:', fcmError.message);
          }
        }
      }
    } catch (err) {
      console.error('Error processing incoming WebSocket message:', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`⚠️ WebSocket disconnected (Code: ${code}, Reason: ${reason.toString()}). Reconnecting in 5 seconds...`);
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('🔴 WebSocket error:', error.message);
    ws.terminate();
  });
}

connectWebSocket();
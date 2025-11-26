const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const sharp = require('sharp');
const app = express();

// ====================================
// 1. LINE 設定
// ====================================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const GAS_URL = process.env.GAS_URL;
const client = new Client(config);

// ====================================
// 2. 資料庫與狀態
// ====================================
let submissions = new Map();
let userState = {};
let lastImageUpload = {};

// ====================================
// 🆕 V24: 測試模式計數器
// ====================================
let testMode = process.env.TEST_MODE === 'true' || false;
let submissionsOpen = true;
let guestCounter = 0;

// ====================================
// 3. 安全機制設定
// ====================================
const MAX_MEMORY_PHOTOS = 60;
const USER_STATE_TIMEOUT = 5 * 60 * 1000;
const INACTIVITY_CLEAR_TIME = 6 * 60 * 60 * 1000; // 🆕 V24: 6 小時

const IMAGE_CONFIG = {
  maxSize: 1920,
  quality: 70,
};

const MAX_NICKNAME_LENGTH = 9;

// ====================================
// 4. 活動追蹤 & 自動清空機制
// ====================================
let lastActivityTime = Date.now();
let inactivityTimer = null;

function updateActivity() {
  lastActivityTime = Date.now();
  resetInactivityTimer();
}

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => clearAllData(), INACTIVITY_CLEAR_TIME);
}

function clearAllData() {
  const photoCount = submissions.size;
  submissions.clear();
  userState = {};
  lastImageUpload = {};
  guestCounter = 0;
  console.log(`🧹 [自動清空] 6小時無活動，已清除 ${photoCount} 張照片`);
}

resetInactivityTimer();

// ====================================
// 5. userState 逾時清理
// ====================================
setInterval(() => {
  const now = Date.now();
  for (const [uId, state] of Object.entries(userState)) {
    if (now - state.timestamp > USER_STATE_TIMEOUT) {
      delete userState[uId];
    }
  }
  for (const [uId, timestamp] of Object.entries(lastImageUpload)) {
    if (now - timestamp > 60 * 1000) {
      delete lastImageUpload[uId];
    }
  }
}, 60 * 1000);

// ====================================
// 6. 圖片壓縮函式
// ====================================
async function compressImage(buffer) {
  try {
    const compressed = await sharp(buffer)
      .resize(IMAGE_CONFIG.maxSize, IMAGE_CONFIG.maxSize, { 
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality: IMAGE_CONFIG.quality, mozjpeg: true })
      .toBuffer();
    return compressed;
  } catch (error) {
    console.error('⚠️ [壓縮失敗]', error.message);
    return buffer;
  }
}

function generateSubmissionKey(userId) {
  if (testMode) {
    return `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  }
  return userId;
}

function truncateNickname(name) {
  return name.length > MAX_NICKNAME_LENGTH ? name.substring(0, MAX_NICKNAME_LENGTH) : name;
}

// ====================================
// 7. API 端點
// ====================================
app.use(cors());

app.get('/api/status', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    photos: submissions.size,
    pendingUploads: Object.keys(userState).length,
    testMode, submissionsOpen, guestCounter,
    lastActivity: new Date(lastActivityTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    nextAutoClear: new Date(lastActivityTime + INACTIVITY_CLEAR_TIME).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    memory: {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(1)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`
    }
  });
});

app.post('/api/test-mode', (req, res) => {
  testMode = !testMode;
  if (testMode) guestCounter = 0;
  console.log(`🧪 [測試模式] ${testMode ? '已開啟' : '已關閉'}`);
  res.json({ 
    success: true, testMode, 
    message: testMode ? '🧪 測試模式已開啟 - 可批量上傳，自動編號暱稱' : '✅ 測試模式已關閉 - 恢復正常模式'
  });
});

app.get('/api/test-mode', (req, res) => {
  res.json({ testMode, description: testMode ? '批量上傳，自動編號暱稱' : '同一帳號僅保留最新一張' });
});

app.get('/api/submission-status', (req, res) => {
  res.json({ submissionsOpen, description: submissionsOpen ? '目前開放報名' : '報名已暫停' });
});

app.post('/api/submission-status', (req, res) => {
  submissionsOpen = !submissionsOpen;
  console.log(`📝 [報名狀態] ${submissionsOpen ? '已開放' : '已暫停'}`);
  res.json({ success: true, submissionsOpen, message: submissionsOpen ? '✅ 報名已開放' : '⏸️ 報名已暫停' });
});

// ====================================
// 8. Webhook 入口
// ====================================
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error('❌ [Webhook Error]', err); res.status(500).end(); });
});

// ====================================
// 9. 主要事件處理
// ====================================
async function handleEvent(event) {
  const userId = event.source.userId;
  let isHandledByPhotoBot = false;

  // A. 文字訊息處理
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // 用戶正在輸入暱稱 (非測試模式)
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
      let name = truncateNickname(text);
      const data = userState[userId];
      updateActivity();

      const submissionKey = generateSubmissionKey(userId);
      const isOverwrite = !testMode && submissions.has(userId);
      
      if (submissions.size >= MAX_MEMORY_PHOTOS) {
        const oldestKey = submissions.keys().next().value;
        submissions.delete(oldestKey);
      }

      submissions.set(submissionKey, {
        id: Date.now(),
        odialog: submissionKey,
        userId: userId,
        url: data.tempUrl,
        cat: data.cat,
        uploader: name,
        avatar: '',
        status: 'pending',
        isWinner: false,
        timestamp: Date.now()
      });

      delete userState[userId];
      isHandledByPhotoBot = true;
      console.log(`✅ [報名成功] ${name} (${data.cat}) - 目前共 ${submissions.size} 張`);

      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: isOverwrite ? `收到！${name}，您的作品已更新 ✨` : `報名成功！感謝 ${name} 的參與 🏆` 
      });
    }

    // 用戶點選選單報名
    if (text.includes('#我要報名')) {
      if (!submissionsOpen) {
        isHandledByPhotoBot = true;
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '⏸️ 婚禮神攝手投稿已截止\n\n感謝您的參與！如有美照歡迎私底下傳給我們 🙏' 
        });
      }
      
      let cat = '';
      if (text.includes('新郎')) cat = 'groom';
      else if (text.includes('新娘')) cat = 'bride';
      else if (text.includes('創意')) cat = 'creative';

      if (cat) {
        updateActivity();
        userState[userId] = { step: 'WAITING_PHOTO', cat, timestamp: Date.now() };
        isHandledByPhotoBot = true;
        return Promise.resolve(null);
      }
    }
  }

  // B. 圖片訊息處理
  if (event.type === 'message' && event.message.type === 'image') {
    if (!submissionsOpen) {
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '⏸️ 婚禮神攝手投稿已截止\n\n感謝您的參與！如有美照歡迎私底下傳給我們 🙏' 
      });
    }

    // 🆕 V24: 測試模式 - 完全跳過限制，自動編號
    if (testMode) {
      isHandledByPhotoBot = true;
      let cat = 'creative';
      if (userState[userId] && userState[userId].step === 'WAITING_PHOTO') {
        cat = userState[userId].cat;
        delete userState[userId];
      }

      try {
        updateActivity();
        const stream = await client.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const compressedBuffer = await compressImage(Buffer.concat(chunks));
        const base64Img = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

        guestCounter++;
        const autoName = `賓客${guestCounter}`;
        const submissionKey = generateSubmissionKey(userId);

        if (submissions.size >= MAX_MEMORY_PHOTOS) {
          submissions.delete(submissions.keys().next().value);
        }

        submissions.set(submissionKey, {
          id: Date.now(), odialog: submissionKey, userId,
          url: base64Img, cat, uploader: autoName,
          avatar: '', status: 'pending', isWinner: false, timestamp: Date.now()
        });

        console.log(`🧪 [測試] ${autoName} (${cat}) - 共 ${submissions.size} 張`);
        const catName = cat === 'groom' ? '最帥新郎賞' : cat === 'bride' ? '最美新娘賞' : '最佳創意賞';
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: `🧪 測試模式收到！\n\n自動編號：${autoName}\n類別：${catName}\n\n可繼續上傳 📸` 
        });
      } catch (error) {
        console.error('❌ [圖片處理失敗]', error);
        return client.replyMessage(event.replyToken, { type: 'text', text: '😅 處理失敗，請重試！' });
      }
    }

    // 非測試模式
    if (!userState[userId] || userState[userId].step !== 'WAITING_PHOTO') {
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '請先點選上方選單，選擇報名項目喔！🎯\n\n選好後再上傳您的美照 📸' 
      });
    }

    isHandledByPhotoBot = true;
    try {
      updateActivity();
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const compressedBuffer = await compressImage(Buffer.concat(chunks));
      const base64Img = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = base64Img;
      userState[userId].timestamp = Date.now();

      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: `📸 收到照片了！\n\n請輸入您的「暱稱」(最多${MAX_NICKNAME_LENGTH}個字) 來完成報名\n例如：表弟阿豪 👇` 
      });
    } catch (error) {
      console.error('❌ [圖片處理失敗]', error);
      delete userState[userId];
      return client.replyMessage(event.replyToken, { type: 'text', text: '😅 處理失敗，請重試！' });
    }
  }

  // C. 轉接給 GAS
  if (!isHandledByPhotoBot && GAS_URL) {
    try {
      if (event.type === 'message' && event.message.type === 'text' && event.message.text.includes('#我要報名')) {
        return Promise.resolve(null);
      }
      await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-line-signature': 'forwarded-by-render' },
        body: JSON.stringify({ destination: event.destination, events: [event] })
      });
    } catch (error) { console.error('❌ [轉發失敗]', error); }
  }

  return Promise.resolve(null);
}

// ====================================
// 10. 其他 API
// ====================================
app.get('/api/photos', (req, res) => res.json(Array.from(submissions.values())));

app.post('/api/clear', (req, res) => {
  const count = submissions.size;
  submissions.clear();
  userState = {};
  lastImageUpload = {};
  guestCounter = 0;
  res.json({ success: true, message: `已清空 ${count} 張照片` });
});

app.post('/api/extend', (req, res) => {
  updateActivity();
  res.json({ success: true, message: '已延長 6 小時' });
});

// ====================================
// 11. 啟動
// ====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('========================================');
  console.log(`🚀 婚禮神攝手後端 V24 - Port ${port}`);
  console.log(`⏰ 自動清空: 6 小時無活動`);
  console.log(`📝 暱稱上限: ${MAX_NICKNAME_LENGTH} 字`);
  console.log('========================================');
});
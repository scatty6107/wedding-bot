const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const cloudinary = require('cloudinary').v2; // 引入 Cloudinary
const streamifier = require('streamifier');    // 引入 Stream 轉換工具
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
// Cloudinary 設定
// ====================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ====================================
// 2. 資料庫與狀態
// ====================================
let submissions = new Map();
let userState = {};
let lastImageUpload = {};
let userLastCategory = {};

let testMode = process.env.TEST_MODE === 'true' || false;
let submissionsOpen = true;
let guestCounter = 0;

// 🔥 新增：全域鎖定狀態 (預設為 false)
let winnersLocked = false;

// ====================================
// 3. 安全機制設定
// ====================================
const MAX_MEMORY_PHOTOS = 300; 
const USER_STATE_TIMEOUT = 5 * 60 * 1000;
const MAX_NICKNAME_LENGTH = 9;

// ====================================
// 4. 活動追蹤
// ====================================
let lastActivityTime = Date.now();

function updateActivity() {
  lastActivityTime = Date.now();
}

function clearAllData() {
  const photoCount = submissions.size;
  submissions.clear();
  userState = {};
  lastImageUpload = {};
  userLastCategory = {};
  guestCounter = 0;
  winnersLocked = false; // 🔥 重置時也要解鎖
  console.log(`🧹 [手動清空] 已清除 ${photoCount} 張照片`);
}

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
}, 60 * 1000);

// ====================================
// 6. 圖片處理函式
// ====================================
async function uploadToCloudinary(messageId, userId) {
    return new Promise(async (resolve, reject) => {
        try {
            const stream = await client.getMessageContent(messageId);
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: "wedding_2025", 
                    public_id: `${userId}_${Date.now()}`,
                    resource_type: "image",
                },
                (error, result) => {
                    if (error) return reject(error);
                    resolve(result.secure_url); 
                }
            );
            stream.pipe(uploadStream);
        } catch (error) {
            reject(error);
        }
    });
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
    maxPhotos: MAX_MEMORY_PHOTOS,
    pendingUploads: Object.keys(userState).length,
    testMode, submissionsOpen, guestCounter, winnersLocked, // 🔥 回傳鎖定狀態
    lastActivity: new Date(lastActivityTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    nextAutoClear: "已停用 (無限期保留)", 
    memory: {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`
    }
  });
});

// 🔥 新增：設定鎖定狀態 API
app.post('/api/winners/lock', express.json(), (req, res) => {
    const { locked } = req.body;
    if (locked !== undefined) {
        winnersLocked = locked;
        console.log(`🔒 [得獎名單] ${locked ? '已鎖定' : '已解鎖'}`);
    }
    res.json({ success: true, winnersLocked });
});

app.post('/api/test-mode', (req, res) => {
  testMode = !testMode;
  if (testMode) {
    guestCounter = 0;
    userLastCategory = {};
  }
  console.log(`🧪 [測試模式] ${testMode ? '已開啟' : '已關閉'}`);
  res.json({ success: true, testMode, message: testMode ? '🧪 測試模式已開啟' : '✅ 測試模式已關閉' });
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

app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

app.post('/api/photos/:id/status', express.json(), (req, res) => {
  const { id } = req.params;
  const { status, isWinner } = req.body;
   
  const photo = submissions.get(id);
  if (!photo) {
    return res.status(404).json({ success: false, message: '照片不存在' });
  }
   
  if (status !== undefined) {
    photo.status = status;
  }
  if (isWinner !== undefined) {
    if (isWinner) {
      for (const [key, p] of submissions) {
        if (p.cat === photo.cat && p.isWinner) {
          p.isWinner = false;
          submissions.set(key, p);
        }
      }
    }
    photo.isWinner = isWinner;
  }
   
  submissions.set(id, photo);
  console.log(`📝 [狀態更新] ${id.substring(0, 10)}... → ${status || ''} ${isWinner ? '👑' : ''}`);
   
  res.json({ success: true, photo });
});

app.post('/api/photos/batch-update', express.json(), (req, res) => {
  const { updates } = req.body;
   
  if (!Array.isArray(updates)) {
    return res.status(400).json({ success: false, message: '無效的更新格式' });
  }
   
  let updated = 0;
  for (const { id, status, isWinner } of updates) {
    const photo = submissions.get(id);
    if (photo) {
      if (status !== undefined) photo.status = status;
      if (isWinner !== undefined) photo.isWinner = isWinner;
      submissions.set(id, photo);
      updated++;
    }
  }
   
  console.log(`📝 [批次更新] ${updated} 張照片`);
  res.json({ success: true, updated });
});

app.post('/api/clear', (req, res) => {
  const count = submissions.size;
  submissions.clear();
  userState = {};
  lastImageUpload = {};
  userLastCategory = {};
  guestCounter = 0;
  winnersLocked = false; // 🔥 重置時解鎖
  res.json({ success: true, message: `已清空 ${count} 張照片` });
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
        text: `報名成功！感謝 ${name} 的參與 🏆\n(您可以繼續上傳更多照片喔！)` 
      });
    }

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
        userLastCategory[userId] = cat;
        isHandledByPhotoBot = true;
        console.log(`📝 [選擇類別] ${cat} ${testMode ? '[測試模式]' : ''}`);
        return Promise.resolve(null);
      }
    }
  }

  // 影片拒絕
  if (event.type === 'message' && event.message.type === 'video') {
    isHandledByPhotoBot = true;
    console.log(`🎬 [影片拒絕] 用戶 ${userId.substring(0, 10)}... 上傳影片`);
    return client.replyMessage(event.replyToken, { 
      type: 'text', 
      text: '📷 抱歉，目前只接受照片投稿喔！\n\n請上傳您的精彩照片 📸' 
    });
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

    // 正式模式：入圍保護 (這裡也檢查 winnersLocked 變數)
    if (!testMode) {
        const existing = submissions.get(userId);
        if (existing && (existing.status === 'approved' || existing.isWinner)) {
            // 如果名單已鎖定，或是該照片已入圍，都不可修改
            isHandledByPhotoBot = true;
            console.log(`🛡️ [入圍保護] ${existing.uploader} 試圖覆蓋入圍照片，已攔截`);
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `🏆 恭喜您！\n\n您的照片已經【入圍決選名單】囉！\n為了確保評選公平，入圍後無法再修改照片。\n\n請期待稍後的頒獎典禮 🎉` 
            });
        }
    }

    // 測試模式
    if (testMode) {
      isHandledByPhotoBot = true;
      
      let cat = 'creative';
      if (userState[userId] && userState[userId].step === 'WAITING_PHOTO') {
        cat = userState[userId].cat;
      } else if (userLastCategory[userId]) {
        cat = userLastCategory[userId];
      }

      try {
        updateActivity();
        
        const imageUrl = await uploadToCloudinary(event.message.id, userId);

        guestCounter++;
        const autoName = `賓客${guestCounter}`;
        const submissionKey = generateSubmissionKey(userId);

        if (submissions.size >= MAX_MEMORY_PHOTOS) {
          submissions.delete(submissions.keys().next().value);
        }

        submissions.set(submissionKey, {
          id: Date.now(), odialog: submissionKey, userId,
          url: imageUrl, 
          cat, uploader: autoName,
          avatar: '', status: 'pending', isWinner: false, timestamp: Date.now()
        });

        console.log(`🧪 [測試] ${autoName} (${cat}) - 上傳成功`);
        const catName = cat === 'groom' ? '最帥新郎賞' : cat === 'bride' ? '最美新娘賞' : '最佳創意賞';
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: `🧪 測試模式收到！\n\n自動編號：${autoName}\n類別：${catName}\n\n繼續上傳會投稿同一類別\n切換類別請點選上方選單 📸` 
        });
      } catch (error) {
        console.error('❌ [圖片處理失敗]', error);
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '😅 網路不穩定，請稍後再試一次！\n\n如持續失敗，請稍等幾秒後重新上傳 📶' 
        });
      }
    }

    // 正式模式
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
      
      const imageUrl = await uploadToCloudinary(event.message.id, userId);

      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = imageUrl;
      userState[userId].timestamp = Date.now();

      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: `📸 收到照片了！\n\n請輸入您的「暱稱」(最多${MAX_NICKNAME_LENGTH}個字) 來完成報名\n例如：表弟阿豪 👇` 
      });
    } catch (error) {
      console.error('❌ [圖片處理失敗]', error);
      delete userState[userId];
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '😅 網路不穩定，請稍後再試一次！\n\n如持續失敗，請稍等幾秒後重新上傳 📶' 
      });
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
// 11. 啟動
// ====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('========================================');
  console.log(`🚀 婚禮神攝手後端 V26.8 (SyncLock) - Port ${port}`);
  console.log(`📦 最大照片數: ${MAX_MEMORY_PHOTOS} 張`);
  console.log(`☁️ 圖片儲存: Cloudinary`);
  console.log(`⏰ 自動清空: 已停用`);
  console.log('========================================');
});
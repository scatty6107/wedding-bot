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
// 🆕 測試模式 & 報名狀態開關
// ====================================
let testMode = process.env.TEST_MODE === 'true' || false;
let submissionsOpen = true;  // 🆕 V23: 報名開關

// ====================================
// 3. 安全機制設定
// ====================================
const MAX_MEMORY_PHOTOS = 60;
const USER_STATE_TIMEOUT = 5 * 60 * 1000;
const INACTIVITY_CLEAR_TIME = 2 * 60 * 60 * 1000;
const BATCH_UPLOAD_THRESHOLD = 3 * 1000;

const IMAGE_CONFIG = {
  maxSize: 1920,
  quality: 70,
};

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
  const stateCount = Object.keys(userState).length;
  const uploadCount = Object.keys(lastImageUpload).length;
  
  submissions.clear();
  userState = {};
  lastImageUpload = {};
  
  console.log(`🧹 [自動清空] 2小時無活動，已清除 ${photoCount} 張照片、${stateCount} 個暫存狀態、${uploadCount} 個上傳記錄`);
  console.log(`🧹 [自動清空] 時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
}

resetInactivityTimer();

// ====================================
// 5. userState 逾時清理 (每分鐘檢查)
// ====================================
setInterval(() => {
  const now = Date.now();
  let cleanedStateCount = 0;
  let cleanedUploadCount = 0;
  
  for (const [uId, state] of Object.entries(userState)) {
    if (now - state.timestamp > USER_STATE_TIMEOUT) {
      delete userState[uId];
      cleanedStateCount++;
    }
  }
  
  for (const [uId, timestamp] of Object.entries(lastImageUpload)) {
    if (now - timestamp > 60 * 1000) {
      delete lastImageUpload[uId];
      cleanedUploadCount++;
    }
  }
  
  if (cleanedStateCount > 0 || cleanedUploadCount > 0) {
    console.log(`🗑️ [定時清理] userState: ${cleanedStateCount} 個, lastImageUpload: ${cleanedUploadCount} 個`);
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
      .jpeg({ 
        quality: IMAGE_CONFIG.quality,
        mozjpeg: true
      })
      .toBuffer();
    
    const originalKB = (buffer.length / 1024).toFixed(1);
    const compressedKB = (compressed.length / 1024).toFixed(1);
    console.log(`📸 [壓縮] ${originalKB}KB → ${compressedKB}KB (節省 ${((1 - compressed.length / buffer.length) * 100).toFixed(0)}%)`);
    
    return compressed;
  } catch (error) {
    console.error('⚠️ [壓縮失敗]', error.message);
    return buffer;
  }
}

// ====================================
// 生成提交 Key
// ====================================
function generateSubmissionKey(userId) {
  if (testMode) {
    return `${userId}_${Date.now()}`;
  } else {
    return userId;
  }
}

// ====================================
// 7. API 端點
// ====================================
app.use(cors());

// 狀態 API
app.get('/api/status', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    photos: submissions.size,
    pendingUploads: Object.keys(userState).length,
    testMode: testMode,
    submissionsOpen: submissionsOpen,  // 🆕 V23
    lastActivity: new Date(lastActivityTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    nextAutoClear: new Date(lastActivityTime + INACTIVITY_CLEAR_TIME).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    memory: {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(1)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`
    }
  });
});

// 測試模式 API
app.post('/api/test-mode', (req, res) => {
  testMode = !testMode;
  console.log(`🧪 [測試模式] ${testMode ? '已開啟' : '已關閉'}`);
  res.json({ 
    success: true,
    testMode: testMode, 
    message: testMode ? '🧪 測試模式已開啟 - 同一帳號可上傳多張照片' : '✅ 測試模式已關閉 - 恢復正常模式',
    timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  });
});

app.get('/api/test-mode', (req, res) => {
  res.json({ 
    testMode: testMode,
    description: testMode ? '同一帳號可上傳多張照片' : '同一帳號僅保留最新一張'
  });
});

// 🆕 V23: 報名狀態 API
app.get('/api/submission-status', (req, res) => {
  res.json({ 
    submissionsOpen: submissionsOpen,
    description: submissionsOpen ? '目前開放報名' : '報名已暫停'
  });
});

app.post('/api/submission-status', (req, res) => {
  submissionsOpen = !submissionsOpen;
  console.log(`📝 [報名狀態] ${submissionsOpen ? '已開放' : '已暫停'}`);
  res.json({ 
    success: true,
    submissionsOpen: submissionsOpen, 
    message: submissionsOpen ? '✅ 報名已開放 - LINE 官方帳號可接收新照片' : '⏸️ 報名已暫停 - LINE 官方帳號暫停接收新照片',
    timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  });
});

// ====================================
// 8. Webhook 入口
// ====================================
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { 
      console.error('❌ [Webhook Error]', err); 
      res.status(500).end(); 
    });
});

// ====================================
// 9. 主要事件處理
// ====================================
async function handleEvent(event) {
  const userId = event.source.userId;
  let isHandledByPhotoBot = false;

  // ==========================================
  //  A. 文字訊息處理
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // [情境 1] 用戶正在輸入暱稱
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
      const name = text;
      const data = userState[userId];

      updateActivity();

      const submissionKey = generateSubmissionKey(userId);
      
      const isOverwrite = !testMode && submissions.has(userId);
      if (submissions.size >= MAX_MEMORY_PHOTOS) {
        const oldestKey = submissions.keys().next().value;
        submissions.delete(oldestKey);
        console.log(`⚠️ [記憶體保護] 已自動移除最舊資料 (${oldestKey.substring(0, 10)}...)`);
      }

      let replyText;
      if (testMode) {
        const userPhotoCount = Array.from(submissions.keys()).filter(k => k.startsWith(userId)).length + 1;
        replyText = `🧪 [測試模式] 收到！${name}，這是您的第 ${userPhotoCount} 張照片 ✨`;
      } else {
        replyText = isOverwrite 
          ? `收到！${name}，您的作品已更新 (舊照片已覆蓋) ✨` 
          : `報名成功！感謝 ${name} 的參與 🏆`;
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

      console.log(`✅ [報名成功] ${name} (${data.cat}) - Key: ${submissionKey.substring(0, 20)}... - 目前共 ${submissions.size} 張照片 ${testMode ? '[測試模式]' : ''}`);

      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    // [情境 2] 用戶點選選單報名
    if (text.includes('#我要報名')) {
      // 🆕 V23: 檢查報名是否開放
      if (!submissionsOpen) {
        isHandledByPhotoBot = true;
        console.log(`⏸️ [報名暫停] 用戶 ${userId.substring(0, 10)}... 嘗試報名但已暫停`);
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '⏸️ 報名已暫停\n\n感謝您的參與！目前活動報名已暫時關閉，請稍後再試或聯繫現場工作人員 🙏' 
        });
      }
      
      let cat = '';
      if (text.includes('新郎')) cat = 'groom';
      else if (text.includes('新娘')) cat = 'bride';
      else if (text.includes('創意')) cat = 'creative';

      if (cat) {
        updateActivity();
        
        userState[userId] = { 
          step: 'WAITING_PHOTO', 
          cat: cat,
          timestamp: Date.now()
        };
        isHandledByPhotoBot = true;
        console.log(`📝 [開始報名] 用戶選擇: ${cat} ${testMode ? '[測試模式]' : ''}`);
        return Promise.resolve(null);
      }
    }
  }

  // ==========================================
  //  B. 圖片訊息處理
  // ==========================================
  if (event.type === 'message' && event.message.type === 'image') {
    const now = Date.now();

    // 🆕 V23: 檢查報名是否開放
    if (!submissionsOpen) {
      console.log(`⏸️ [報名暫停] 用戶 ${userId.substring(0, 10)}... 上傳照片但報名已暫停`);
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '⏸️ 報名已暫停\n\n感謝您的參與！目前活動報名已暫時關閉，請稍後再試或聯繫現場工作人員 🙏' 
      });
    }

    // 批次上傳檢測 - 測試模式下跳過
    if (!testMode && lastImageUpload[userId] && (now - lastImageUpload[userId]) < BATCH_UPLOAD_THRESHOLD) {
      console.log(`⚠️ [批次上傳] 用戶 ${userId.substring(0, 10)}... 短時間內上傳多張`);
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '⚠️ 一次只能上傳一張照片喔！\n\n請重新點選選單，選擇報名項目後，再上傳「一張」照片 📸' 
      });
    }

    lastImageUpload[userId] = now;

    // 檢查是否有選擇報名項目
    if (!userState[userId] || userState[userId].step !== 'WAITING_PHOTO') {
      console.log(`📢 [未報名] 用戶 ${userId.substring(0, 10)}... 直接上傳照片但未選擇報名項目`);
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '請先點選下方選單，選擇報名項目喔！🎯\n\n選好後再上傳您的美照 📸' 
      });
    }

    isHandledByPhotoBot = true;

    try {
      updateActivity();

      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) { 
        chunks.push(chunk); 
      }
      const originalBuffer = Buffer.concat(chunks);

      const compressedBuffer = await compressImage(originalBuffer);
      const base64Img = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = base64Img;
      userState[userId].timestamp = Date.now();

      const modeHint = testMode ? '\n\n🧪 測試模式：此照片不會覆蓋之前的上傳' : '';

      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: `📸 收到照片了！\n\n請輸入您的「暱稱」或「名字」來完成報名 (例如：表弟阿豪) 👇${modeHint}` 
      });

    } catch (error) {
      console.error('❌ [圖片處理失敗]', error);
      delete userState[userId];
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '😅 圖片處理失敗，請重新上傳一次！' 
      });
    }
  }

  // ==========================================
  //  C. 轉接給 Excel 查桌次
  // ==========================================
  if (!isHandledByPhotoBot && GAS_URL) {
    try {
      if (event.type === 'message' && event.message.type === 'text' && event.message.text.includes('#我要報名')) {
        return Promise.resolve(null);
      }

      const forwardBody = {
        destination: event.destination,
        events: [event]
      };

      await fetch(GAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': 'forwarded-by-render'
        },
        body: JSON.stringify(forwardBody)
      });

      return Promise.resolve(null);
    } catch (error) {
      console.error('❌ [轉發失敗]', error);
    }
  }

  return Promise.resolve(null);
}

// ====================================
// 10. 其他 API 端點
// ====================================

// 取得所有照片
app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

// 手動清空
app.post('/api/clear', (req, res) => {
  const photoCount = submissions.size;
  clearAllData();
  res.json({ 
    success: true, 
    message: `已清空 ${photoCount} 張照片`,
    timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  });
});

// 延長時間
app.post('/api/extend', (req, res) => {
  updateActivity();
  res.json({ 
    success: true, 
    message: '已延長 2 小時',
    nextAutoClear: new Date(lastActivityTime + INACTIVITY_CLEAR_TIME).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  });
});

// ====================================
// 11. 啟動伺服器
// ====================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('========================================');
  console.log(`🚀 婚禮神攝手後端 V23 啟動 - Port ${port}`);
  console.log(`📦 最大照片數: ${MAX_MEMORY_PHOTOS} 張`);
  console.log(`🖼️ 圖片壓縮: ${IMAGE_CONFIG.maxSize}px / ${IMAGE_CONFIG.quality}%`);
  console.log(`⏰ 自動清空: ${INACTIVITY_CLEAR_TIME / 1000 / 60} 分鐘無活動`);
  console.log(`🧪 測試模式: ${testMode ? '開啟' : '關閉'}`);
  console.log(`📝 報名狀態: ${submissionsOpen ? '開放' : '暫停'}`);
  console.log('========================================');
});
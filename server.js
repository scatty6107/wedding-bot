const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const sharp = require('sharp'); // 圖片壓縮
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
let submissions = new Map();  // 正式照片
let userState = {};           // 暫存狀態
let lastImageUpload = {};     // 記錄用戶最後上傳圖片的時間 (防批次上傳)

// ====================================
// 🆕 測試模式開關
// ====================================
let testMode = process.env.TEST_MODE === 'true' || false;

// ====================================
// 3. 安全機制設定
// ====================================
const MAX_MEMORY_PHOTOS = 60;           // 最多存 60 張壓縮後照片
const USER_STATE_TIMEOUT = 5 * 60 * 1000;  // userState 5 分鐘逾時
const INACTIVITY_CLEAR_TIME = 2 * 60 * 60 * 1000; // 2 小時無活動清空
const BATCH_UPLOAD_THRESHOLD = 3 * 1000;  // 3 秒內視為批次上傳

// 圖片壓縮設定
const IMAGE_CONFIG = {
  maxSize: 1920,      // 最長邊 1920px (Full HD)
  quality: 70,        // JPEG 品質 (1-100)
};

// ====================================
// 4. 活動追蹤 & 自動清空機制
// ====================================
let lastActivityTime = Date.now();
let inactivityTimer = null;

// 更新最後活動時間
function updateActivity() {
  lastActivityTime = Date.now();
  resetInactivityTimer();
}

// 重設不活動計時器
function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    clearAllData();
  }, INACTIVITY_CLEAR_TIME);
}

// 清空所有資料
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

// 啟動時初始化計時器
resetInactivityTimer();

// ====================================
// 5. userState 逾時清理 (每分鐘檢查)
// ====================================
setInterval(() => {
  const now = Date.now();
  let cleanedStateCount = 0;
  let cleanedUploadCount = 0;
  
  // 清理逾時的 userState
  for (const [uId, state] of Object.entries(userState)) {
    if (now - state.timestamp > USER_STATE_TIMEOUT) {
      delete userState[uId];
      cleanedStateCount++;
    }
  }
  
  // 清理過期的 lastImageUpload 記錄 (超過 1 分鐘的)
  for (const [uId, timestamp] of Object.entries(lastImageUpload)) {
    if (now - timestamp > 60 * 1000) {
      delete lastImageUpload[uId];
      cleanedUploadCount++;
    }
  }
  
  if (cleanedStateCount > 0 || cleanedUploadCount > 0) {
    console.log(`🗑️ [定時清理] userState: ${cleanedStateCount} 個, lastImageUpload: ${cleanedUploadCount} 個`);
  }
}, 60 * 1000); // 每分鐘執行

// ====================================
// 6. 圖片壓縮函式
// ====================================
async function compressImage(buffer) {
  try {
    const compressed = await sharp(buffer)
      .resize(IMAGE_CONFIG.maxSize, IMAGE_CONFIG.maxSize, { 
        withoutEnlargement: true,  // 小圖不放大
        fit: 'inside'              // 等比例縮放，最長邊不超過 maxSize
      })
      .jpeg({ 
        quality: IMAGE_CONFIG.quality,
        mozjpeg: true  // 更好的壓縮
      })
      .toBuffer();
    
    const originalKB = (buffer.length / 1024).toFixed(1);
    const compressedKB = (compressed.length / 1024).toFixed(1);
    console.log(`📸 [壓縮] ${originalKB}KB → ${compressedKB}KB (節省 ${((1 - compressed.length / buffer.length) * 100).toFixed(0)}%)`);
    
    return compressed;
  } catch (error) {
    console.error('⚠️ [壓縮失敗]', error.message);
    // 壓縮失敗時回傳原圖（但這可能有風險）
    return buffer;
  }
}

// ====================================
// 🆕 生成提交 Key (測試模式 vs 正式模式)
// ====================================
function generateSubmissionKey(userId) {
  if (testMode) {
    // 測試模式：userId + 時間戳，允許同一用戶多張照片
    return `${userId}_${Date.now()}`;
  } else {
    // 正式模式：只用 userId，同一用戶只能有一張
    return userId;
  }
}

// ====================================
// 7. 記憶體狀態 API (除錯用)
// ====================================
app.use(cors());

app.get('/api/status', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    photos: submissions.size,
    pendingUploads: Object.keys(userState).length,
    testMode: testMode,  // 🆕 回傳測試模式狀態
    lastActivity: new Date(lastActivityTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    nextAutoClear: new Date(lastActivityTime + INACTIVITY_CLEAR_TIME).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    memory: {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(1)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`
    }
  });
});

// ====================================
// 🆕 測試模式切換 API
// ====================================
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

// 🆕 取得測試模式狀態
app.get('/api/test-mode', (req, res) => {
  res.json({ 
    testMode: testMode,
    description: testMode ? '同一帳號可上傳多張照片' : '同一帳號僅保留最新一張'
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

    // [情境 1] 用戶正在輸入暱稱 (流程最後一步)
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
      const name = text;
      const data = userState[userId];

      // 更新活動時間
      updateActivity();

      // 🆕 使用新的 key 生成邏輯
      const submissionKey = generateSubmissionKey(userId);
      
      // --- 記憶體防爆檢查 ---
      const isOverwrite = !testMode && submissions.has(userId);
      if (submissions.size >= MAX_MEMORY_PHOTOS) {
        const oldestKey = submissions.keys().next().value;
        submissions.delete(oldestKey);
        console.log(`⚠️ [記憶體保護] 已自動移除最舊資料 (${oldestKey.substring(0, 10)}...)`);
      }

      // 🆕 根據測試模式調整回覆訊息
      let replyText;
      if (testMode) {
        const userPhotoCount = Array.from(submissions.keys()).filter(k => k.startsWith(userId)).length + 1;
        replyText = `🧪 [測試模式] 收到！${name}，這是您的第 ${userPhotoCount} 張照片 ✨`;
      } else {
        replyText = isOverwrite 
          ? `收到！${name}，您的作品已更新 (舊照片已覆蓋) ✨` 
          : `報名成功！感謝 ${name} 的參與 🏆`;
      }

      // 寫入正式名單
      submissions.set(submissionKey, {
        id: Date.now(),
        odialog: submissionKey,  // 🆕 儲存實際的 key (用於前端識別)
        userId: userId,           // 🆕 保留原始 userId
        url: data.tempUrl,
        cat: data.cat,
        uploader: name,
        avatar: '',
        status: 'pending',
        isWinner: false,
        timestamp: Date.now()
      });

      // 清除狀態
      delete userState[userId];
      isHandledByPhotoBot = true;

      console.log(`✅ [報名成功] ${name} (${data.cat}) - Key: ${submissionKey.substring(0, 20)}... - 目前共 ${submissions.size} 張照片 ${testMode ? '[測試模式]' : ''}`);

      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    // [情境 2] 用戶點選選單報名 (無聲模式)
    if (text.includes('#我要報名')) {
      let cat = '';
      if (text.includes('新郎')) cat = 'groom';
      else if (text.includes('新娘')) cat = 'bride';
      else if (text.includes('創意')) cat = 'creative';

      if (cat) {
        // 更新活動時間
        updateActivity();
        
        userState[userId] = { 
          step: 'WAITING_PHOTO', 
          cat: cat,
          timestamp: Date.now()  // 加入時間戳記供逾時清理
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

    // 🆕 [檢查 1] 批次上傳檢測 - 測試模式下跳過此檢查
    if (!testMode && lastImageUpload[userId] && (now - lastImageUpload[userId]) < BATCH_UPLOAD_THRESHOLD) {
      console.log(`⚠️ [批次上傳] 用戶 ${userId.substring(0, 10)}... 短時間內上傳多張`);
      isHandledByPhotoBot = true;
      // 不存入記憶體，直接回覆警告
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '⚠️ 一次只能上傳一張照片喔！\n\n請重新點選選單，選擇報名項目後，再上傳「一張」照片 📸' 
      });
    }

    // 更新最後上傳時間
    lastImageUpload[userId] = now;

    // [檢查 2] 是否有選擇報名項目 (WAITING_PHOTO 狀態)
    if (!userState[userId] || userState[userId].step !== 'WAITING_PHOTO') {
      console.log(`📢 [未報名] 用戶 ${userId.substring(0, 10)}... 直接上傳照片但未選擇報名項目`);
      isHandledByPhotoBot = true;
      // 不存入記憶體，提醒先選擇報名項目
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '請先點選下方選單，選擇報名項目喔！🎯\n\n選好後再上傳您的美照 📸' 
      });
    }

    // [正常流程] 狀態為 WAITING_PHOTO，開始處理圖片
    isHandledByPhotoBot = true;

    try {
      // 更新活動時間
      updateActivity();

      // 取得照片
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) { 
        chunks.push(chunk); 
      }
      const originalBuffer = Buffer.concat(chunks);

      // 🔥 關鍵：壓縮圖片
      const compressedBuffer = await compressImage(originalBuffer);
      const base64Img = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

      // 更新狀態：暫存照片，改為等待暱稱
      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = base64Img;
      userState[userId].timestamp = Date.now(); // 更新時間戳記

      // 🆕 測試模式下的提示訊息
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
  //  C. 轉接給 Excel 查桌次 (若上面都沒處理)
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
// 10. API 端點
// ====================================

// 取得所有照片
app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

// 手動清空 (緊急用)
app.post('/api/clear', (req, res) => {
  const photoCount = submissions.size;
  clearAllData();
  res.json({ 
    success: true, 
    message: `已清空 ${photoCount} 張照片`,
    timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  });
});

// 手動延長時間 (重設 2 小時計時器)
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
  console.log(`🚀 婚禮神攝手後端啟動 - Port ${port}`);
  console.log(`📦 最大照片數: ${MAX_MEMORY_PHOTOS} 張`);
  console.log(`🖼️ 圖片壓縮: ${IMAGE_CONFIG.maxSize}px (最長邊) / ${IMAGE_CONFIG.quality}%`);
  console.log(`⏰ 自動清空: ${INACTIVITY_CLEAR_TIME / 1000 / 60} 分鐘無活動`);
  console.log(`🗑️ userState 逾時: ${USER_STATE_TIMEOUT / 1000 / 60} 分鐘`);
  console.log(`🧪 測試模式: ${testMode ? '開啟' : '關閉'}`);
  console.log('========================================');
});
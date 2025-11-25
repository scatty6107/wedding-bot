const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const app = express();

// 1. LINE 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 2. 取得 Excel/GAS 網址 (從環境變數)
const GAS_URL = process.env.GAS_URL; 

const client = new Client(config);

// 3. 資料庫與狀態
let submissions = new Map(); // 存正式照片
let userState = {};          // 存暫存狀態 (等待照片/等待暱稱)

// 【關鍵功能】記憶體保護機制：最多存 60 張，超過刪最舊
const MAX_MEMORY_PHOTOS = 60;

app.use(cors());

// Webhook 入口
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

async function handleEvent(event) {
  const userId = event.source.userId;
  let isHandledByPhotoBot = false; // 標記：照片機器人是否處理了？

  // ==========================================
  //  A. 文字訊息處理
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // [情境 1] 用戶正在輸入暱稱 (流程最後一步)
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
        const name = text;
        const data = userState[userId];
        
        // --- 記憶體防爆檢查 ---
        const isOverwrite = submissions.has(userId);
        if (!isOverwrite && submissions.size >= MAX_MEMORY_PHOTOS) {
            const oldestKey = submissions.keys().next().value;
            submissions.delete(oldestKey);
            console.log(`⚠️ 記憶體保護啟動：已自動移除舊資料 (${oldestKey})`);
        }
        // --------------------

        const replyText = isOverwrite ? `收到！${name}，您的作品已更新 (舊照片已覆蓋) ✨` : `報名成功！感謝 ${name} 的參與 🏆`;

        // 寫入正式名單
        submissions.set(userId, {
            id: Date.now(),
            userId: userId,
            url: data.tempUrl,
            cat: data.cat,
            uploader: name, // 使用賓客輸入的名字
            avatar: '', 
            status: 'pending',
            isWinner: false,
            timestamp: Date.now()
        });

        // 清除狀態
        delete userState[userId];
        isHandledByPhotoBot = true;

        return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    // [情境 2] 用戶點選選單報名 (無聲模式)
    if (text.includes('#我要報名')) {
       let cat = '';
       if (text.includes('新郎')) cat = 'groom';
       else if (text.includes('新娘')) cat = 'bride';
       else if (text.includes('創意')) cat = 'creative';
       
       if(cat) {
           userState[userId] = { step: 'WAITING_PHOTO', cat: cat };
           isHandledByPhotoBot = true;
           // 不回覆訊息，讓賓客直接傳圖
           return Promise.resolve(null); 
       }
    }
  }

  // ==========================================
  //  B. 圖片訊息處理 (等待傳圖階段)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'image') {
      // 只有當狀態是 WAITING_PHOTO 才攔截圖片
      if (userState[userId] && userState[userId].step === 'WAITING_PHOTO') {
          isHandledByPhotoBot = true;

          // 取得照片
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];
          for await (const chunk of stream) { chunks.push(chunk); }
          const buffer = Buffer.concat(chunks);
          const base64Img = `data:image/jpeg;base64,${buffer.toString('base64')}`;

          // 更新狀態：暫存照片，改為等待暱稱
          userState[userId].step = 'WAITING_NAME';
          userState[userId].tempUrl = base64Img;

          return client.replyMessage(event.replyToken, { type: 'text', text: '📸 收到照片了！\n\n請輸入您的「暱稱」或「名字」來完成報名 (例如：表弟阿豪) 👇' });
      }
  }

  // ==========================================
  //  C. 轉接給 Excel 查桌次 (若上面都沒處理)
  // ==========================================
  if (!isHandledByPhotoBot && GAS_URL) {
    try {
      // 排除掉「我要報名」但沒選到分類的情況，避免誤傳
      if (event.type === 'message' && event.message.type === 'text' && event.message.text.includes('#我要報名')) {
          return Promise.resolve(null);
      }

      const forwardBody = {
        destination: event.destination,
        events: [event]
      };
      // 轉發給 Google Script
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
      console.error('轉發失敗:', error);
    }
  }

  return Promise.resolve(null);
}

// API
app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const app = express();

// 1. 設定 LINE Channel 資訊
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 取得原本 Excel/GAS 的網址 (從環境變數)
const GAS_URL = process.env.GAS_URL; 

const client = new Client(config);

// 記憶體暫存資料庫
let submissions = new Map();

// 簡易狀態追蹤
const userState = {};

app.use(cors());

// 2. LINE Webhook 入口
app.post('/webhook', middleware(config), (req, res) => {
  // Promise.all 會等待所有事件處理完畢
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 3. 處理事件 (核心邏輯修改版)
async function handleEvent(event) {
  const userId = event.source.userId;
  let isHandledByPhotoBot = false; // 標記：照片機器人是否有處理這則訊息？

  // --- A. 照片機器人邏輯開始 ---
  
  // A-1. 處理文字訊息 (報名意圖)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    let reply = '';
    
    if (text.includes('新郎')) {
      userState[userId] = 'groom';
      reply = '收到！請傳送「最帥新郎」的參賽照片📸';
      isHandledByPhotoBot = true;
    } else if (text.includes('新娘')) {
      userState[userId] = 'bride';
      reply = '收到！請傳送「最美新娘」的參賽照片📸';
      isHandledByPhotoBot = true;
    } else if (text.includes('創意')) {
      userState[userId] = 'creative';
      reply = '收到！請傳送「最佳創意」的參賽照片📸';
      isHandledByPhotoBot = true;
    } 
    // 注意：如果是查桌次的名字，這裡 isHandledByPhotoBot 會是 false
    
    if (isHandledByPhotoBot) {
      return client.replyMessage(event.replyToken, { type: 'text', text: reply });
    }
  }

  // A-2. 處理圖片訊息 (參賽作品)
  if (event.type === 'message' && event.message.type === 'image') {
    // 只有當使用者已經選過分類，我們才攔截圖片
    if (userState[userId]) {
      isHandledByPhotoBot = true;
      const category = userState[userId];

      // 取得照片內容
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) { chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      
      const base64Img = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      const isOverwrite = submissions.has(userId);
      
      submissions.set(userId, {
          id: Date.now(),
          userId: userId,
          url: base64Img, 
          cat: category,
          uploader: 'Guest', 
          status: 'pending',
          timestamp: Date.now()
      });

      const replyText = isOverwrite ? '收到您上傳的新作品 (舊照片已覆蓋) ✨' : '報名成功！祝您中大獎 🏆';
      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }
  }
  // --- A. 照片機器人邏輯結束 ---


  // --- B. 轉接給 Excel 機器人 (如果上面沒處理，就轉傳) ---
  if (!isHandledByPhotoBot && GAS_URL) {
    try {
      // 我們要把這個 event 包裝成 LINE 原始的格式傳給 Excel 腳本
      // Google Apps Script 通常預期收到 { events: [...] }
      const forwardBody = {
        destination: event.destination, // 雖然 GAS 可能不用，但補上比較完整
        events: [event]
      };

      // 使用 fetch 轉傳 (不等待回應，避免拖慢速度)
      await fetch(GAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 模擬 LINE 的簽章，雖然 GAS 通常不驗證這個，但以防萬一
          'x-line-signature': 'forwarded-by-render' 
        },
        body: JSON.stringify(forwardBody)
      });
      
      console.log('已轉發訊息給 Excel 機器人');
      return Promise.resolve(null); // 我們這邊不回話，讓 Excel 機器人回
    } catch (error) {
      console.error('轉發失敗:', error);
    }
  }

  return Promise.resolve(null);
}

// 4. 前端 API
app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
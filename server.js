const express = require('express');
// const multer = require('multer'); // 這行我幫你註解掉了，避免報錯
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const app = express();

// 1. 設定 LINE Channel 資訊 (這些會從 Render 的設定讀取)
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new Client(config);

// 記憶體暫存資料庫 (注意：Render 免費版休眠會清空)
let submissions = new Map();

app.use(cors());

// 2. LINE Webhook 入口
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 3. 處理事件
async function handleEvent(event) {
  const userId = event.source.userId;

  // 處理文字訊息 (報名意圖)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    let reply = '';
    
    if (text.includes('新郎')) {
      userState[userId] = 'groom';
      reply = '收到！請傳送「最帥新郎」的參賽照片📸';
    } else if (text.includes('新娘')) {
      userState[userId] = 'bride';
      reply = '收到！請傳送「最美新娘」的參賽照片📸';
    } else if (text.includes('創意')) {
      userState[userId] = 'creative';
      reply = '收到！請傳送「最佳創意」的參賽照片📸';
    } else {
      return Promise.resolve(null);
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: reply });
  }

  // 處理圖片訊息 (參賽作品)
  if (event.type === 'message' && event.message.type === 'image') {
    const category = userState[userId];
    if (!category) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '請先輸入「#我要報名...」選擇獎項喔！' });
    }

    // 取得照片內容
    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    
    // 轉為 Base64 供前端顯示
    const base64Img = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    
    // 檢查是否覆蓋
    const isOverwrite = submissions.has(userId);
    
    // 儲存資料
    submissions.set(userId, {
        id: Date.now(),
        userId: userId,
        url: base64Img, 
        cat: category,
        uploader: 'Guest', 
        status: 'pending',
        timestamp: Date.now()
    });

    // 回覆訊息
    const replyText = isOverwrite ? '收到您上傳的新作品 (舊照片已覆蓋) ✨' : '報名成功！祝您中大獎 🏆';
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }
}

// 簡易狀態追蹤
const userState = {};

// 4. 前端 API (讓網頁抓取照片)
app.get('/api/photos', (req, res) => {
  const list = Array.from(submissions.values());
  res.json(list);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
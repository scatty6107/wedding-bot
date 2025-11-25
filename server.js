const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const cors = require('cors');
const app = express();

// LINE 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// 記憶體資料庫
let submissions = new Map();
// 用戶狀態暫存 { userId: { step: 'WAITING_PHOTO'|'WAITING_NAME', cat: 'groom', tempUrl: '...' } }
let userState = {};

app.use(cors());

app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

async function handleEvent(event) {
  const userId = event.source.userId;

  // 1. 文字訊息處理
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // [階段3] 檢查是否在等待暱稱 (流程最後一步)
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
        const name = text; // 用戶輸入的文字即為暱稱
        const data = userState[userId];
        
        // 判斷是否為覆蓋 (Overwrite Check)
        const isOverwrite = submissions.has(userId);
        const replyText = isOverwrite ? '收到！已更新您的參賽作品 (舊照片已覆蓋) ✨' : '報名成功！祝您中大獎 🏆';

        // 寫入正式名單
        submissions.set(userId, {
            id: Date.now(),
            userId: userId,
            url: data.tempUrl,
            cat: data.cat,
            uploader: name, // 使用輸入的暱稱
            avatar: '', // LINE API 需額外權限抓頭像，此處留空或用預設
            status: 'pending',
            isWinner: false,
            timestamp: Date.now()
        });

        // 清除狀態
        delete userState[userId];

        // 回覆成功
        return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    // [階段1] 檢查是否為報名指令 (靜默模式：不回覆，只記狀態)
    if (text.includes('#我要報名')) {
       let cat = '';
       if (text.includes('新郎')) cat = 'groom';
       else if (text.includes('新娘')) cat = 'bride';
       else if (text.includes('創意')) cat = 'creative';
       
       if(cat) {
           // 設定狀態：等待照片
           userState[userId] = { step: 'WAITING_PHOTO', cat: cat };
           // 這裡【不回覆】任何訊息，依照您的需求
           return Promise.resolve(null); 
       }
    }
  }

  // 2. 圖片訊息處理 (階段2)
  if (event.type === 'message' && event.message.type === 'image') {
      // 檢查是否有先選分類
      if (!userState[userId] || userState[userId].step !== 'WAITING_PHOTO') {
          return client.replyMessage(event.replyToken, { type: 'text', text: '請先點選選單選擇報名項目喔！' });
      }

      // 取得照片二進制流
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) { chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      const base64Img = `data:image/jpeg;base64,${buffer.toString('base64')}`;

      // 更新狀態：暫存照片，改為等待暱稱
      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = base64Img;

      // 回覆引導輸入暱稱
      return client.replyMessage(event.replyToken, { type: 'text', text: '收到照片了！請輸入您的「暱稱」來完成報名。' });
  }
}

// API: 供前端戰情室抓取資料
app.get('/api/photos', (req, res) => {
  // 只回傳已完成 (有暱稱) 的資料
  const list = Array.from(submissions.values());
  res.json(list);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
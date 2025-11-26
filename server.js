// ====================================
// 9. 主要事件處理 (已修正：Cloudinary + 原本文案)
// ====================================
async function handleEvent(event) {
  const userId = event.source.userId;
  let isHandledByPhotoBot = false;

  // A. 文字訊息處理 (這部分維持原樣，不需更動)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // ... (原本的文字處理邏輯：輸入暱稱、#我要報名 等等，請直接保留原本的程式碼) ...
    // 為了節省篇幅，這邊省略文字處理的重複代碼，請保留你原本 server.js 的這區塊
    
    // 這裡只需要注意一點：原本在 "WAITING_NAME" 成功後的 submissions.set
    // 現在不需要再存 url: data.tempUrl 了，因為 data.tempUrl 已經是 Cloudinary 的網址
    // 邏輯是通用的，所以原本的文字處理代碼幾乎不用改。
    
    // (請將原本 server.js 的 "文字訊息處理" 完整保留)
    if (userState[userId] && userState[userId].step === 'WAITING_NAME') {
      let name = truncateNickname(text);
      const data = userState[userId];
      updateActivity();

      const submissionKey = generateSubmissionKey(userId);
      // ... (原本的記憶體保護邏輯) ...

      submissions.set(submissionKey, {
        id: Date.now(),
        odialog: submissionKey,
        userId: userId,
        url: data.tempUrl, // 這裡的 tempUrl 已經是 Cloudinary 網址了
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
        text: !testMode && submissions.has(userId) ? 
              `收到！${name}，您的作品已更新 ✨` : 
              `報名成功！感謝 ${name} 的參與 🏆` 
      });
    }
    
    // ... (原本的 #我要報名 處理邏輯) ...
    if (text.includes('#我要報名')) {
        // ... (保留原本代碼) ...
        if (!submissionsOpen) { /* ... */ }
        
        let cat = '';
        if (text.includes('新郎')) cat = 'groom';
        else if (text.includes('新娘')) cat = 'bride';
        else if (text.includes('創意')) cat = 'creative';

        if (cat) {
            updateActivity();
            userState[userId] = { step: 'WAITING_PHOTO', cat, timestamp: Date.now() };
            userLastCategory[userId] = cat;
            isHandledByPhotoBot = true;
            // ... (保留原本代碼) ...
            return Promise.resolve(null);
        }
    }
  }

  // 影片拒絕 (維持原樣)
  if (event.type === 'message' && event.message.type === 'video') {
    isHandledByPhotoBot = true;
    return client.replyMessage(event.replyToken, { 
      type: 'text', 
      text: '📷 抱歉，目前只接受照片投稿喔！\n\n請上傳您的精彩照片 📸' 
    });
  }

  // ==========================================
  // B. 圖片訊息處理 (🔥 重點修改區域)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'image') {
    if (!submissionsOpen) {
      isHandledByPhotoBot = true;
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '⏸️ 婚禮神攝手投稿已截止\n\n感謝您的參與！如有美照歡迎私底下傳給我們 🙏' 
      });
    }

    // --- 測試模式 ---
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
        
        // 🔥 修改：上傳到 Cloudinary
        const imageUrl = await uploadToCloudinary(event.message.id, userId);

        guestCounter++;
        const autoName = `賓客${guestCounter}`;
        const submissionKey = generateSubmissionKey(userId);

        if (submissions.size >= MAX_MEMORY_PHOTOS) {
          submissions.delete(submissions.keys().next().value);
        }

        submissions.set(submissionKey, {
          id: Date.now(), odialog: submissionKey, userId,
          url: imageUrl, // 存入雲端網址
          cat, uploader: autoName,
          avatar: '', status: 'pending', isWinner: false, timestamp: Date.now()
        });

        console.log(`🧪 [測試] ${autoName} (${cat}) - 上傳成功 (Cloudinary)`);
        
        const catName = cat === 'groom' ? '最帥新郎賞' : cat === 'bride' ? '最美新娘賞' : '最佳創意賞';
        
        // ✅ 恢復原本文案
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: `🧪 測試模式收到！\n\n自動編號：${autoName}\n類別：${catName}\n\n繼續上傳會投稿同一類別\n切換類別請點選上方選單 📸` 
        });

      } catch (error) {
        console.error('❌ [圖片上傳失敗]', error);
        // ✅ 恢復原本文案
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '😅 網路不穩定，請稍後再試一次！\n\n如持續失敗，請稍等幾秒後重新上傳 📶' 
        });
      }
    }

    // --- 正式模式 ---
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
      
      // 🔥 修改：上傳到 Cloudinary
      const imageUrl = await uploadToCloudinary(event.message.id, userId);

      userState[userId].step = 'WAITING_NAME';
      userState[userId].tempUrl = imageUrl; // 暫存雲端網址
      userState[userId].timestamp = Date.now();

      // ✅ 恢復原本詳細文案
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: `📸 收到照片了！\n\n請輸入您的「暱稱」(最多${MAX_NICKNAME_LENGTH}個字) 來完成報名\n例如：表弟阿豪 👇` 
      });

    } catch (error) {
      console.error('❌ [圖片上傳失敗]', error);
      delete userState[userId];
      // ✅ 恢復原本親切文案
      return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '😅 網路不穩定，請稍後再試一次！\n\n如持續失敗，請稍等幾秒後重新上傳 📶' 
      });
    }
  }

  // C. 轉接給 GAS (維持原樣)
  if (!isHandledByPhotoBot && GAS_URL) {
     // ... (保留原本代碼) ...
     try {
       /* ... fetch GAS ... */
     } catch (error) { console.error('❌ [轉發失敗]', error); }
  }

  return Promise.resolve(null);
}
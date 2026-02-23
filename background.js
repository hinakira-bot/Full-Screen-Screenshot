/**
 * Background Service Worker
 *
 * popup.js からキャプチャ指示を受けて:
 *   1. content.js に記事検出を依頼
 *   2. スクロールしながら captureVisibleTab で分割撮影
 *   3. OffscreenDocument で画像を結合
 *   4. PNG or PDF として保存
 */

// OffscreenDocument が必要かチェック
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    // 既存のoffscreenドキュメントを確認
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["CANVAS"],
        justification: "画像結合とPDF生成のためにCanvas APIを使用",
      });
    }
    offscreenReady = true;
  } catch (e) {
    // 既に存在する場合のエラーは無視
    offscreenReady = true;
  }
}

/**
 * タブにメッセージを送信するヘルパー
 */
function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * ポップアップに進捗を通知
 */
function notifyProgress(text, percent) {
  chrome.runtime.sendMessage({
    type: "capture-progress",
    text,
    percent,
  }).catch(() => {
    // ポップアップが閉じている場合は無視
  });
}

/**
 * 指定ミリ秒だけ待機
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 現在表示されている画面をキャプチャ（リトライ付き）
 * Chrome の captureVisibleTab は 1秒あたり2回までの制限がある
 */
async function captureScreen(retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(
          null,
          { format: "png", quality: 100 },
          (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(result);
            }
          }
        );
      });
      return dataUrl;
    } catch (err) {
      const msg = err.message || "";
      const isRateLimit =
        msg.includes("MAX_CAPTURE") ||
        msg.includes("quota") ||
        msg.includes("Too many");
      if (attempt < retries - 1 && isRateLimit) {
        // レート制限 → 長めに待ってリトライ
        console.log(
          `captureVisibleTab rate limited, retry ${attempt + 1}/${retries} ...`
        );
        await sleep(1500);
      } else {
        throw err;
      }
    }
  }
}

/**
 * メインのキャプチャ処理
 */
async function captureArticle(tabId, format) {
  notifyProgress("記事を検出中...", 15);

  // 1. 記事を検出
  const articleInfo = await sendToTab(tabId, { type: "detect-article" });

  if (articleInfo.error) {
    throw new Error(articleInfo.error);
  }

  notifyProgress("記事を検出しました", 20);

  const {
    top: articleTop,
    left: articleLeft,
    width: articleWidth,
    height: articleHeight,
    viewportWidth,
    viewportHeight,
    devicePixelRatio,
  } = articleInfo;

  // 2. ノイズ要素を非表示に
  const noiseResult = await sendToTab(tabId, { type: "hide-noise" });

  // 3. 元のスクロール位置を保存
  const origScroll = await sendToTab(tabId, { type: "get-scroll-info" });
  const originalScrollY = origScroll.scrollY;

  // 4. スクロールしながらキャプチャ
  const screenshots = [];
  const captureRegions = [];

  const articleBottom = articleTop + articleHeight;
  let currentY = articleTop;
  const totalScrollSteps = Math.ceil(articleHeight / viewportHeight);
  let step = 0;

  notifyProgress("キャプチャ中...", 30);

  while (currentY < articleBottom) {
    step++;
    const progress = 30 + Math.floor((step / totalScrollSteps) * 50);
    notifyProgress(
      `キャプチャ中... (${step}/${totalScrollSteps})`,
      Math.min(progress, 80)
    );

    // スクロール
    await sendToTab(tabId, { type: "scroll-to", y: currentY });

    // ★ レート制限を確実に回避するため 1.2秒待つ
    await sleep(1200);

    // キャプチャ（リトライ付き）
    const dataUrl = await captureScreen();
    screenshots.push(dataUrl);

    // この撮影でキャプチャすべき領域を計算
    const scrollInfo = await sendToTab(tabId, { type: "get-scroll-info" });
    const actualScrollY = scrollInfo.scrollY;

    const cropTop = Math.max(0, articleTop - actualScrollY);
    const cropBottom = Math.min(
      viewportHeight,
      articleBottom - actualScrollY
    );

    captureRegions.push({
      sx: Math.floor(articleLeft * devicePixelRatio),
      sy: Math.floor(cropTop * devicePixelRatio),
      sw: Math.ceil(articleWidth * devicePixelRatio),
      sh: Math.ceil((cropBottom - cropTop) * devicePixelRatio),
      dy: Math.floor(
        (actualScrollY + cropTop - articleTop) * devicePixelRatio
      ),
    });

    currentY += viewportHeight;
  }

  // 5. ノイズ要素を復元
  await sendToTab(tabId, {
    type: "restore-noise",
    backup: noiseResult.backup,
  });

  // 6. スクロール位置を復元
  await sendToTab(tabId, { type: "scroll-to", y: originalScrollY });

  notifyProgress("画像を処理中...", 85);

  // 7. Offscreen で画像結合
  await ensureOffscreen();

  const finalWidth = Math.ceil(articleWidth * devicePixelRatio);
  const finalHeight = Math.ceil(articleHeight * devicePixelRatio);

  const result = await chrome.runtime.sendMessage({
    type: "combine-images",
    screenshots,
    regions: captureRegions,
    finalWidth,
    finalHeight,
    format,
    devicePixelRatio,
  });

  if (result.error) {
    throw new Error(result.error);
  }

  notifyProgress("保存中...", 95);

  // 8. ダウンロード
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const filename =
    format === "pdf"
      ? `article-${timestamp}.pdf`
      : `article-${timestamp}.png`;

  await chrome.downloads.download({
    url: result.dataUrl,
    filename,
    saveAs: true,
  });

  return { success: true };
}

// popup.js からのメッセージを処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // popup からのメッセージのみ処理（popup は sender.tab を持たない）
  if (message.type === "start-capture" && !sender.tab) {
    captureArticle(message.tabId, message.format)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }
});

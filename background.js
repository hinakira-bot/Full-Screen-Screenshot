/**
 * Background Service Worker
 *
 * popup.js からキャプチャ指示を受けて:
 *   1. content.js + html2canvas で記事を直接キャプチャ
 *   2. PNG → そのまま保存 / PDF → offscreen で変換して保存
 *
 * captureVisibleTab は使わない（レート制限を完全に回避）
 */

// OffscreenDocument が必要かチェック
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["CANVAS"],
        justification: "PDF生成のためにCanvas APIを使用",
      });
    }
    offscreenReady = true;
  } catch (e) {
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
  }).catch(() => {});
}

/**
 * メインのキャプチャ処理
 */
async function captureArticle(tabId, format) {
  notifyProgress("記事を検出中...", 15);

  // 1. content script を注入
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "lib/article-detector.js",
      "lib/html2canvas.min.js",
      "content.js",
    ],
  });

  notifyProgress("キャプチャ中...", 40);

  // スクリプト注入後、少し待ってからメッセージを送信
  await new Promise((r) => setTimeout(r, 300));

  // 2. content.js に記事キャプチャを依頼（html2canvasで直接レンダリング）
  const result = await sendToTab(tabId, {
    type: "capture-article",
    format,
  });

  if (!result) {
    throw new Error("コンテンツスクリプトからの応答がありません。ページを再読み込みしてお試しください。");
  }

  if (result.error) {
    throw new Error(result.error);
  }

  notifyProgress("処理中...", 70);

  let finalDataUrl = result.dataUrl;

  // 3. PDF の場合は offscreen で変換
  if (result.needsPdf) {
    await ensureOffscreen();

    notifyProgress("PDF生成中...", 80);

    const pdfResult = await chrome.runtime.sendMessage({
      type: "convert-to-pdf",
      imageDataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      devicePixelRatio: 1, // html2canvas が既にスケーリング済み
    });

    if (pdfResult.error) {
      throw new Error(pdfResult.error);
    }

    finalDataUrl = pdfResult.dataUrl;
  }

  notifyProgress("保存中...", 95);

  // 4. ダウンロード
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const filename =
    format === "pdf"
      ? `article-${timestamp}.pdf`
      : `article-${timestamp}.png`;

  await chrome.downloads.download({
    url: finalDataUrl,
    filename,
    saveAs: true,
  });

  return { success: true };
}

// popup.js からのメッセージを処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "start-capture" && !sender.tab) {
    captureArticle(message.tabId, message.format)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Background Service Worker
 *
 * popup.js からキャプチャ指示を受けて:
 *   1. content.js に必要なライブラリを注入
 *   2. content.js 内で html2canvas + jsPDF を使って記事をキャプチャ
 *   3. 生成された dataURL をダウンロード
 *
 * すべてのレンダリング処理は content.js 内で完結する。
 */

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

  // 1. content script を注入（article-detector + html2canvas + jsPDF + content.js）
  const scripts = [
    "lib/article-detector.js",
    "lib/html2canvas.min.js",
    "content.js",
  ];

  // PDF の場合は jsPDF も注入
  if (format === "pdf") {
    scripts.splice(2, 0, "lib/jspdf.umd.min.js");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: scripts,
  });

  notifyProgress("キャプチャ中...", 40);

  // スクリプト注入後、少し待ってからメッセージを送信
  await new Promise((r) => setTimeout(r, 300));

  // 2. content.js に記事キャプチャを依頼
  const result = await sendToTab(tabId, {
    type: "capture-article",
    format,
  });

  if (!result) {
    throw new Error(
      "コンテンツスクリプトからの応答がありません。ページを再読み込みしてお試しください。"
    );
  }

  if (result.error) {
    throw new Error(result.error);
  }

  notifyProgress("保存中...", 90);

  // 3. ダウンロード
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
  if (message.type === "start-capture" && !sender.tab) {
    captureArticle(message.tabId, message.format)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

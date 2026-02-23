/**
 * Content Script - 記事検出とキャプチャ
 *
 * html2canvas を使って記事要素を直接キャンバスにレンダリング。
 * captureVisibleTab のレート制限を完全に回避。
 */
(() => {
  "use strict";

  // 二重実行防止
  if (window.__articleCaptureInjected) return;
  window.__articleCaptureInjected = true;

  /**
   * 記事要素を検出し、html2canvas でキャプチャして dataURL を返す
   */
  async function captureArticle(format) {
    const detector = window.__ArticleDetector;
    if (!detector) {
      return { error: "ArticleDetector が読み込まれていません" };
    }

    const article = detector.detectArticle();
    if (!article) {
      return { error: "記事要素が見つかりませんでした" };
    }

    // ノイズ要素を一時的に非表示
    const noisyElements = detector.findNoisyChildren(article);
    const hiddenBackup = [];
    for (const el of noisyElements) {
      hiddenBackup.push({ el, display: el.style.display });
      el.style.display = "none";
    }

    try {
      // html2canvas で記事要素をキャプチャ
      const canvas = await html2canvas(article, {
        useCORS: true,
        allowTaint: true,
        scale: window.devicePixelRatio || 1,
        logging: false,
        backgroundColor: "#ffffff",
        // スクロール位置を自動で処理してくれる
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: document.documentElement.scrollHeight,
      });

      const imageDataUrl = canvas.toDataURL("image/png");

      if (format === "pdf") {
        // PDF生成はoffscreenに委任するため、画像データを返す
        return {
          success: true,
          dataUrl: imageDataUrl,
          width: canvas.width,
          height: canvas.height,
          needsPdf: true,
        };
      } else {
        return {
          success: true,
          dataUrl: imageDataUrl,
          width: canvas.width,
          height: canvas.height,
          needsPdf: false,
        };
      }
    } catch (err) {
      return { error: "キャプチャに失敗: " + err.message };
    } finally {
      // ノイズ要素を復元
      for (const { el, display } of hiddenBackup) {
        el.style.display = display;
      }
    }
  }

  // background.js からのメッセージを処理
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "capture-article") {
      captureArticle(message.format)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async response
    }
  });
})();

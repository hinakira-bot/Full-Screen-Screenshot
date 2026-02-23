/**
 * Content Script - 記事検出・位置計測・スクロール制御
 */
(() => {
  "use strict";

  /**
   * 記事要素を検出し、位置・サイズ情報を返す
   */
  function detectAndMeasure() {
    const detector = window.__ArticleDetector;
    if (!detector) {
      return { error: "ArticleDetector が読み込まれていません" };
    }

    const article = detector.detectArticle();
    if (!article) {
      return { error: "記事要素が見つかりませんでした" };
    }

    // ノイズ要素を非表示
    const noisyElements = detector.findNoisyChildren(article);
    for (const el of noisyElements) {
      el.style.setProperty("display", "none", "important");
    }

    const rect = article.getBoundingClientRect();
    const scrollTop = window.scrollY;

    return {
      top: Math.max(0, rect.top + scrollTop - 8),
      left: Math.max(0, rect.left - 8),
      width: Math.ceil(rect.width + 16),
      height: Math.ceil(rect.height + 16),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollY: scrollTop,
    };
  }

  /**
   * 指定位置までスクロール
   */
  function scrollTo(y) {
    window.scrollTo({ top: y, behavior: "instant" });
  }

  // リスナー再登録
  if (window.__articleCaptureListener) {
    chrome.runtime.onMessage.removeListener(window.__articleCaptureListener);
  }

  window.__articleCaptureListener = (message, sender, sendResponse) => {
    if (message.type === "detect-article") {
      sendResponse(detectAndMeasure());
      return true;
    }
    if (message.type === "scroll-to") {
      scrollTo(message.y);
      // スクロール完了を少し待つ
      setTimeout(() => {
        sendResponse({ scrollY: window.scrollY });
      }, 150);
      return true;
    }
    if (message.type === "get-scroll") {
      sendResponse({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
      });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__articleCaptureListener);
})();

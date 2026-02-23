/**
 * Content Script - 記事検出とキャプチャ制御
 *
 * background.js からの指示を受けて:
 *   1. ArticleDetector で記事要素を特定
 *   2. 記事要素の位置・サイズ情報を返す
 *   3. スクロールキャプチャ時のスクロール制御を行う
 */
(() => {
  "use strict";

  // 二重実行防止
  if (window.__articleCaptureInjected) return;
  window.__articleCaptureInjected = true;

  /**
   * 記事要素を検出し、その情報を返す
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

    // ノイズ要素を一時的に非表示にする
    const noisyElements = detector.findNoisyChildren(article);
    const hiddenElements = [];

    for (const el of noisyElements) {
      const original = el.style.display;
      hiddenElements.push({ el, original });
      el.style.display = "none";
    }

    // 記事要素の位置・サイズを取得
    const rect = article.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;

    // padding を少し追加
    const padding = 16;

    const info = {
      // ページ上の絶対座標
      top: Math.max(0, rect.top + scrollTop - padding),
      left: Math.max(0, rect.left + scrollLeft - padding),
      width: Math.ceil(rect.width + padding * 2),
      height: Math.ceil(rect.height + padding * 2),
      // ビューポート情報
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      // ページ全体
      pageHeight:
        Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        ),
      devicePixelRatio: window.devicePixelRatio || 1,
      // 非表示にした要素の数
      hiddenCount: hiddenElements.length,
    };

    // 非表示を元に戻す（background.jsが段階的にスクロールキャプチャするまで維持）
    // → 実際にはキャプチャ中に再度非表示にする
    for (const { el, original } of hiddenElements) {
      el.style.display = original;
    }

    return info;
  }

  /**
   * キャプチャ前にノイズ要素を非表示にする
   */
  function hideNoise() {
    const detector = window.__ArticleDetector;
    if (!detector) return [];

    const article = detector.detectArticle();
    if (!article) return [];

    const noisyElements = detector.findNoisyChildren(article);
    const backup = [];

    for (const el of noisyElements) {
      backup.push({ selector: getUniqueSelector(el), display: el.style.display });
      el.style.display = "none";
    }

    return backup;
  }

  /**
   * ノイズ要素の表示を復元する
   */
  function restoreNoise(backup) {
    for (const item of backup) {
      try {
        const el = document.querySelector(item.selector);
        if (el) {
          el.style.display = item.display;
        }
      } catch (e) {
        // セレクタが無効な場合は無視
      }
    }
  }

  /**
   * 指定位置までスクロール
   */
  function scrollToPosition(y) {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    // スクロール完了を待つ
    return new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * 要素のユニークなCSSセレクタを生成
   */
  function getUniqueSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);

    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = "#" + CSS.escape(current.id);
        parts.unshift(selector);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  // background.js からのメッセージを処理
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "detect-article") {
      const info = detectAndMeasure();
      sendResponse(info);
      return true;
    }

    if (message.type === "hide-noise") {
      const backup = hideNoise();
      sendResponse({ backup });
      return true;
    }

    if (message.type === "restore-noise") {
      restoreNoise(message.backup || []);
      sendResponse({ done: true });
      return true;
    }

    if (message.type === "scroll-to") {
      scrollToPosition(message.y).then(() => {
        sendResponse({ done: true, scrollY: window.scrollY });
      });
      return true; // async response
    }

    if (message.type === "get-scroll-info") {
      sendResponse({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      });
      return true;
    }
  });
})();

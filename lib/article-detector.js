/**
 * Article Detector - 記事コンテンツの自動検出モジュール
 *
 * ヒューリスティックなスコアリングで記事の本文領域を特定する。
 * Mozilla Readability のアプローチを参考に、以下の手法を組み合わせる:
 *   1. セマンティックHTML要素の検出 (<article>, <main>, role="main")
 *   2. テキスト密度分析 (テキスト量 / HTML量 の比率)
 *   3. クラス名・ID名のスコアリング (positive/negative patterns)
 *   4. ブロック要素の構造分析
 */
(() => {
  "use strict";

  // Positive indicators (記事っぽいクラス名・ID)
  const POSITIVE_PATTERN =
    /article|body|content|entry|main|page|post|text|blog|story|hentry|prose/i;

  // Negative indicators (サイドバー・フッター・ナビ等)
  const NEGATIVE_PATTERN =
    /banner|breadcrumb|combx|comment|community|cover|disqus|extra|footer|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|promo|share|shopping|widget|nav|meta|tag/i;

  // 除外すべきタグ
  const REMOVE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "NAV",
    "FOOTER",
    "HEADER",
    "ASIDE",
  ]);

  /**
   * 要素内のテキスト長を取得（直接の子テキストノード）
   */
  function getDirectTextLength(el) {
    let len = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        len += node.textContent.trim().length;
      }
    }
    return len;
  }

  /**
   * 要素内の全テキスト長を取得
   */
  function getTotalTextLength(el) {
    return (el.textContent || "").trim().length;
  }

  /**
   * 要素内のリンクテキスト密度を計算
   */
  function getLinkDensity(el) {
    const textLen = getTotalTextLength(el);
    if (textLen === 0) return 1;
    let linkLen = 0;
    const links = el.querySelectorAll("a");
    for (const link of links) {
      linkLen += getTotalTextLength(link);
    }
    return linkLen / textLen;
  }

  /**
   * 要素のスコアを計算
   */
  function scoreElement(el) {
    let score = 0;
    const tag = el.tagName;
    const className = el.className || "";
    const id = el.id || "";
    const classAndId = className + " " + id;

    // タグベースのスコア
    if (tag === "ARTICLE") score += 30;
    if (tag === "MAIN") score += 25;
    if (tag === "SECTION") score += 5;
    if (tag === "DIV") score += 1;

    // role属性
    const role = el.getAttribute("role") || "";
    if (role === "main") score += 25;
    if (role === "article") score += 20;

    // itemprop属性
    const itemprop = el.getAttribute("itemprop") || "";
    if (itemprop === "articleBody" || itemprop === "text") score += 30;

    // クラス名・IDのパターンマッチ
    if (POSITIVE_PATTERN.test(classAndId)) score += 20;
    if (NEGATIVE_PATTERN.test(classAndId)) score -= 30;

    // テキスト密度
    const textLen = getTotalTextLength(el);
    score += Math.min(textLen / 100, 30); // テキストが多いほど加点（最大30）

    // <p>タグの数
    const pCount = el.querySelectorAll("p").length;
    score += Math.min(pCount * 3, 30); // <p>が多いほど加点（最大30）

    // <img>タグの数（記事には画像も含まれる）
    const imgCount = el.querySelectorAll("img").length;
    score += Math.min(imgCount * 2, 10);

    // リンク密度が高いとペナルティ（ナビバーなど）
    const linkDensity = getLinkDensity(el);
    if (linkDensity > 0.5) score -= 30;
    if (linkDensity > 0.3) score -= 15;

    // 要素が小さすぎる場合はペナルティ
    if (textLen < 50) score -= 20;

    return score;
  }

  /**
   * 記事要素を検出する
   */
  function detectArticle() {
    // Step 1: セマンティック要素を直接探す
    const semanticSelectors = [
      '[itemprop="articleBody"]',
      '[role="article"] [itemprop="text"]',
      "article .post-content",
      "article .entry-content",
      "article .article-body",
      "article .article-content",
      ".post-content",
      ".entry-content",
      ".article-body",
      ".article-content",
      "article",
      "main",
      '[role="main"]',
    ];

    // まずセマンティックセレクタで探す（高信頼度）
    for (const selector of semanticSelectors) {
      const el = document.querySelector(selector);
      if (el && getTotalTextLength(el) > 200) {
        return el;
      }
    }

    // Step 2: ヒューリスティックスコアリング
    const candidates = document.querySelectorAll(
      "div, section, article, main"
    );
    let bestElement = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      // 除外すべき祖先を持つ要素はスキップ
      if (el.closest("nav, footer, header, aside")) continue;

      // 非表示要素はスキップ
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const score = scoreElement(el);

      if (score > bestScore) {
        bestScore = score;
        bestElement = el;
      }
    }

    // スコアが低すぎる場合は body をフォールバック
    if (bestScore < 10) {
      return document.body;
    }

    return bestElement;
  }

  /**
   * 検出した記事要素の不要な子要素を特定
   * （実際には削除せず、キャプチャ時に非表示にする要素リストを返す）
   */
  function findNoisyChildren(articleEl) {
    const noisy = [];
    const children = articleEl.querySelectorAll("*");

    for (const child of children) {
      const tag = child.tagName;
      if (REMOVE_TAGS.has(tag)) {
        noisy.push(child);
        continue;
      }

      const classAndId = (child.className || "") + " " + (child.id || "");
      if (
        NEGATIVE_PATTERN.test(classAndId) &&
        !POSITIVE_PATTERN.test(classAndId)
      ) {
        // リンク密度が高い or テキストが少ない → ノイズ
        if (getLinkDensity(child) > 0.5 || getTotalTextLength(child) < 30) {
          noisy.push(child);
        }
      }
    }

    return noisy;
  }

  // グローバルに公開
  window.__ArticleDetector = {
    detectArticle,
    findNoisyChildren,
    scoreElement,
  };
})();

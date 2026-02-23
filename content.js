/**
 * Content Script - 記事検出・キャプチャ・PDF生成
 *
 * html2canvas で記事要素を直接キャンバスにレンダリングし、
 * PNG または PDF（jsPDF）として dataURL を生成する。
 * すべてコンテンツスクリプト内で完結（メッセージサイズ制限を回避）。
 */
(() => {
  "use strict";

  /**
   * Canvas から PDF の dataURL を生成
   */
  function canvasToPdfDataUrl(canvas) {
    // UMDビルド: window.jspdf.jsPDF がコンストラクタ
    const jsPDF = window.jspdf.jsPDF;

    const dpr = window.devicePixelRatio || 1;
    const displayWidth = canvas.width / dpr;
    const displayHeight = canvas.height / dpr;

    // A4サイズ
    const a4Width = 210; // mm
    const a4Height = 297; // mm
    const margin = 10; // mm
    const contentWidth = a4Width - margin * 2;

    // アスペクト比を維持してスケーリング
    const scaledHeight = (displayHeight / displayWidth) * contentWidth;

    // ページあたりの有効高さ
    const pageContentHeight = a4Height - margin * 2;

    // 必要なページ数
    const totalPages = Math.ceil(scaledHeight / pageContentHeight);

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
    });

    const imgDataUrl = canvas.toDataURL("image/png");

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) {
        pdf.addPage();
      }

      const yOffset = -(page * pageContentHeight) + margin;

      pdf.saveGraphicsState();
      pdf.rect(margin, margin, contentWidth, pageContentHeight, "clip");
      pdf.addImage(
        imgDataUrl,
        "PNG",
        margin,
        yOffset,
        contentWidth,
        scaledHeight
      );
      pdf.restoreGraphicsState();
    }

    return pdf.output("datauristring");
  }

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
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: document.documentElement.scrollHeight,
      });

      let dataUrl;

      if (format === "pdf") {
        // jsPDF が読み込まれているか確認
        if (!window.jspdf) {
          return { error: "jsPDF が読み込まれていません" };
        }
        dataUrl = canvasToPdfDataUrl(canvas);
      } else {
        dataUrl = canvas.toDataURL("image/png");
      }

      return {
        success: true,
        dataUrl,
      };
    } catch (err) {
      return { error: "キャプチャに失敗: " + err.message };
    } finally {
      // ノイズ要素を復元
      for (const { el, display } of hiddenBackup) {
        el.style.display = display;
      }
    }
  }

  // 前回のリスナーを削除して再登録できるようにする
  if (window.__articleCaptureListener) {
    chrome.runtime.onMessage.removeListener(window.__articleCaptureListener);
  }

  // メッセージリスナーを登録
  window.__articleCaptureListener = (message, sender, sendResponse) => {
    if (message.type === "capture-article") {
      captureArticle(message.format)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async response
    }
  };

  chrome.runtime.onMessage.addListener(window.__articleCaptureListener);
})();

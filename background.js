/**
 * Background Service Worker
 *
 * ハイブリッド方式:
 *   1. content.js で記事の位置を検出
 *   2. captureVisibleTab でスクロールキャプチャ（レート制限対策済み）
 *   3. offscreen の Canvas で記事部分を切り出し・結合
 *   4. PNG / PDF で保存
 */

/**
 * タブにメッセージを送信
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
 * ポップアップに進捗通知
 */
function notifyProgress(text, percent) {
  chrome.runtime.sendMessage({
    type: "capture-progress",
    text,
    percent,
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * captureVisibleTab（リトライ付き）
 */
async function captureScreen(retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(null, {
        format: "png",
        quality: 100,
      });
    } catch (err) {
      if (attempt < retries - 1) {
        // レート制限 → 待ってリトライ
        await sleep(2000);
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
  notifyProgress("記事を検出中...", 10);

  // 1. content script を注入
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/article-detector.js", "content.js"],
  });

  await sleep(300);

  // 2. 記事位置を検出
  const info = await sendToTab(tabId, { type: "detect-article" });
  if (!info || info.error) {
    throw new Error(info?.error || "記事の検出に失敗しました");
  }

  notifyProgress("記事を検出しました", 20);

  const {
    top: articleTop,
    left: articleLeft,
    width: articleWidth,
    height: articleHeight,
    viewportHeight,
    devicePixelRatio: dpr,
  } = info;

  const articleBottom = articleTop + articleHeight;
  const originalScrollY = info.scrollY;

  // 3. スクロールしながらキャプチャ
  const captures = []; // { dataUrl, cropTop, cropBottom }
  let currentY = articleTop;
  const totalSteps = Math.ceil(articleHeight / viewportHeight);
  let step = 0;

  while (currentY < articleBottom) {
    step++;
    notifyProgress(
      `キャプチャ中... (${step}/${totalSteps})`,
      20 + Math.floor((step / totalSteps) * 50)
    );

    // スクロール
    const scrollResult = await sendToTab(tabId, {
      type: "scroll-to",
      y: currentY,
    });
    const actualScrollY = scrollResult.scrollY;

    // ★ レート制限対策: 各キャプチャ間に十分待つ
    await sleep(1500);

    // キャプチャ
    const dataUrl = await captureScreen();

    // ビューポート内での記事の範囲を計算
    const cropTop = Math.max(0, articleTop - actualScrollY);
    const cropBottom = Math.min(viewportHeight, articleBottom - actualScrollY);

    if (cropBottom > cropTop) {
      captures.push({
        dataUrl,
        // Canvas座標（dpr適用済み）
        sx: Math.floor(articleLeft * dpr),
        sy: Math.floor(cropTop * dpr),
        sw: Math.ceil(articleWidth * dpr),
        sh: Math.ceil((cropBottom - cropTop) * dpr),
        // 結合先Y座標
        dy: Math.floor((actualScrollY + cropTop - articleTop) * dpr),
      });
    }

    currentY += viewportHeight;
  }

  // 4. スクロール位置を復元
  await sendToTab(tabId, { type: "scroll-to", y: originalScrollY });

  notifyProgress("画像を処理中...", 75);

  // 5. Canvasで結合 → PNG / PDF 生成
  //    content script 内で行う（Canvasはページ内で使える）
  if (format === "pdf") {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["lib/jspdf.umd.min.js"],
    });
    await sleep(200);
  }

  const finalWidth = Math.ceil(articleWidth * dpr);
  const finalHeight = Math.ceil(articleHeight * dpr);

  // content script に結合処理を依頼（関数を直接実行）
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: combineAndExport,
    args: [captures, finalWidth, finalHeight, format, dpr],
  });

  if (result.result?.error) {
    throw new Error(result.result.error);
  }

  notifyProgress("保存中...", 95);

  // 6. ダウンロード
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const ext = format === "pdf" ? "pdf" : "png";
  const filename = `article-${timestamp}.${ext}`;

  await chrome.downloads.download({
    url: result.result.dataUrl,
    filename,
    saveAs: true,
  });

  return { success: true };
}

/**
 * ページ内で実行される結合・エクスポート関数
 * （chrome.scripting.executeScript の func として渡す）
 */
async function combineAndExport(captures, finalWidth, finalHeight, format, dpr) {
  try {
    // ★ DPRを考慮せず、CSS座標ベースでCanvasを作成
    //    captureVisibleTab はDPR倍のサイズで撮影されるので、
    //    ソースからの切り出しはDPR座標、結合先はCSS座標で描画する
    const cssWidth = Math.ceil(finalWidth / dpr);
    const cssHeight = Math.ceil(finalHeight / dpr);

    // Canvas サイズ制限チェック（Chrome: ~16384px）
    const MAX_DIM = 16384;
    let outW = finalWidth;
    let outH = finalHeight;

    if (outW > MAX_DIM || outH > MAX_DIM || outW * outH > 268435456) {
      // 大きすぎる場合はCSS解像度にフォールバック
      outW = cssWidth;
      outH = cssHeight;
    }

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return { error: "Canvas の作成に失敗しました（メモリ不足の可能性）" };
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);

    // 出力Canvasと元のDPRサイズとの比率
    const outScale = outW / finalWidth;

    // 各キャプチャを読み込んで描画
    for (const cap of captures) {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = cap.dataUrl;
      });

      // ソース座標（DPRピクセル） → 出力座標
      ctx.drawImage(
        img,
        cap.sx, cap.sy, cap.sw, cap.sh, // ソース切り出し
        0,
        Math.round(cap.dy * outScale),
        Math.ceil(cap.sw * outScale),
        Math.ceil(cap.sh * outScale)
      );
    }

    let dataUrl;

    if (format === "pdf") {
      const jsPDF = window.jspdf.jsPDF;

      const a4W = 210, a4H = 297, margin = 10;
      const contentW = a4W - margin * 2;
      const scaledH = (outH / outW) * contentW;
      const pageH = a4H - margin * 2;
      const totalPages = Math.ceil(scaledH / pageH);

      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) pdf.addPage();

        const srcYStart = Math.floor((page * pageH / scaledH) * outH);
        const srcYEnd = Math.min(
          Math.floor(((page + 1) * pageH / scaledH) * outH),
          outH
        );
        const srcH = srcYEnd - srcYStart;

        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = outW;
        pageCanvas.height = srcH;
        const pCtx = pageCanvas.getContext("2d");
        pCtx.drawImage(canvas, 0, srcYStart, outW, srcH, 0, 0, outW, srcH);

        const pageImg = pageCanvas.toDataURL("image/jpeg", 0.92);
        const imgH = (srcH / outH) * scaledH;
        pdf.addImage(pageImg, "JPEG", margin, margin, contentW, imgH);
      }

      const pdfBlob = pdf.output("blob");
      dataUrl = URL.createObjectURL(pdfBlob);
    } else {
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png")
      );
      if (!blob) {
        return { error: "画像の生成に失敗しました" };
      }
      dataUrl = URL.createObjectURL(blob);
    }

    return { dataUrl };
  } catch (err) {
    return { error: err.message };
  }
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

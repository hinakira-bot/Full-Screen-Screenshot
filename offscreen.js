/**
 * Offscreen Document - 画像結合とPDF生成
 *
 * Canvas API を使ってスクリーンショットを結合し、
 * PNG画像またはPDF（jsPDF）として出力する。
 */

/**
 * data URL から Image オブジェクトを作成
 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * スクリーンショットを結合して最終画像を生成
 */
async function combineImages(data) {
  const { screenshots, regions, finalWidth, finalHeight, format, devicePixelRatio } = data;

  const canvas = document.getElementById("canvas");
  canvas.width = finalWidth;
  canvas.height = finalHeight;
  const ctx = canvas.getContext("2d");

  // 白背景
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, finalWidth, finalHeight);

  // 各スクリーンショットから記事部分を切り出して結合
  for (let i = 0; i < screenshots.length; i++) {
    const img = await loadImage(screenshots[i]);
    const region = regions[i];

    if (region.sh <= 0) continue;

    try {
      ctx.drawImage(
        img,
        region.sx,  // ソースX
        region.sy,  // ソースY
        region.sw,  // ソース幅
        region.sh,  // ソース高さ
        0,          // 出力先X
        region.dy,  // 出力先Y
        region.sw,  // 出力先幅
        region.sh   // 出力先高さ
      );
    } catch (e) {
      console.error("drawImage error at step " + i, e);
    }
  }

  // 形式に応じて出力
  if (format === "pdf") {
    return generatePDF(canvas, devicePixelRatio);
  } else {
    return canvas.toDataURL("image/png");
  }
}

/**
 * Canvas内容をPDFに変換
 */
function generatePDF(canvas, devicePixelRatio) {
  const { jspdf } = window.jspdf;

  // 実際の表示サイズに戻す（devicePixelRatio で割る）
  const displayWidth = canvas.width / devicePixelRatio;
  const displayHeight = canvas.height / devicePixelRatio;

  // A4に収まるようにスケーリング
  const a4Width = 210; // mm
  const a4Height = 297; // mm
  const margin = 10; // mm

  const contentWidth = a4Width - margin * 2;
  const scale = contentWidth / (displayWidth * 0.264583); // px to mm (1px ≈ 0.264583mm at 96dpi)

  // 画像の高さ（mm単位）
  const imgHeightMM = displayHeight * 0.264583;
  const scaledHeight = imgHeightMM * (contentWidth / (displayWidth * 0.264583));

  // ページあたりの有効高さ
  const pageContentHeight = a4Height - margin * 2;

  // 必要なページ数
  const totalPages = Math.ceil(scaledHeight / pageContentHeight);

  const pdf = new jspdf({
    orientation: scaledHeight > contentWidth ? "portrait" : "portrait",
    unit: "mm",
    format: "a4",
  });

  const imgDataUrl = canvas.toDataURL("image/png");

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) {
      pdf.addPage();
    }

    // 各ページに画像の対応部分を配置
    // jsPDFは画像全体を配置してクリッピングする形
    const yOffset = -(page * pageContentHeight) + margin;

    // クリッピング領域を設定
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

  const pdfDataUri = pdf.output("datauristring");
  return pdfDataUri;
}

// background.js からのメッセージを処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "combine-images") {
    combineImages(message)
      .then((dataUrl) => {
        sendResponse({ dataUrl });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true; // async response
  }
});

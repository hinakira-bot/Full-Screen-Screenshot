/**
 * Offscreen Document - PDF生成
 *
 * content.js から受け取った画像データをPDFに変換する。
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
 * 画像データをPDFに変換
 */
async function convertToPdf(data) {
  const { imageDataUrl, width, height, devicePixelRatio } = data;

  // Canvasに画像を描画
  const canvas = document.getElementById("canvas");
  const img = await loadImage(imageDataUrl);
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const { jspdf } = window.jspdf;

  // 実際の表示サイズ
  const dpr = devicePixelRatio || window.devicePixelRatio || 1;
  const displayWidth = img.width / dpr;
  const displayHeight = img.height / dpr;

  // A4サイズ
  const a4Width = 210; // mm
  const a4Height = 297; // mm
  const margin = 10; // mm
  const contentWidth = a4Width - margin * 2;

  // px → mm 変換（96dpi 基準: 1px ≈ 0.264583mm）
  const pxToMm = 0.264583;
  const scaledHeight = (displayHeight / displayWidth) * contentWidth;

  // ページあたりの有効高さ
  const pageContentHeight = a4Height - margin * 2;

  // 必要なページ数
  const totalPages = Math.ceil(scaledHeight / pageContentHeight);

  const pdf = new jspdf({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  const pngDataUrl = canvas.toDataURL("image/png");

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) {
      pdf.addPage();
    }

    const yOffset = -(page * pageContentHeight) + margin;

    pdf.saveGraphicsState();
    pdf.rect(margin, margin, contentWidth, pageContentHeight, "clip");
    pdf.addImage(pngDataUrl, "PNG", margin, yOffset, contentWidth, scaledHeight);
    pdf.restoreGraphicsState();
  }

  return pdf.output("datauristring");
}

// background.js からのメッセージを処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "convert-to-pdf") {
    convertToPdf(message)
      .then((dataUrl) => {
        sendResponse({ dataUrl });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }
});

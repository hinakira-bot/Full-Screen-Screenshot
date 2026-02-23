document.addEventListener("DOMContentLoaded", () => {
  let selectedFormat = "png";

  // Format selection
  const formatBtns = document.querySelectorAll(".format-btn");
  formatBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      formatBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedFormat = btn.dataset.format;
    });
  });

  const captureBtn = document.getElementById("captureBtn");
  const statusEl = document.getElementById("status");
  const progressBar = document.getElementById("progressBar");
  const progressBarFill = document.getElementById("progressBarFill");

  function setStatus(text, type = "") {
    statusEl.textContent = text;
    statusEl.className = "status" + (type ? " " + type : "");
  }

  function setProgress(percent) {
    if (percent < 0) {
      progressBar.classList.remove("active");
      return;
    }
    progressBar.classList.add("active");
    progressBarFill.style.width = percent + "%";
  }

  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "capture-progress") {
      setStatus(message.text, "progress");
      setProgress(message.percent);
    }
  });

  captureBtn.addEventListener("click", async () => {
    captureBtn.disabled = true;
    setStatus("記事を検出中...", "progress");
    setProgress(10);

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab) {
        setStatus("アクティブなタブが見つかりません", "error");
        captureBtn.disabled = false;
        setProgress(-1);
        return;
      }

      // Inject content script
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/article-detector.js", "content.js"],
      });

      // Send capture command to background
      const response = await chrome.runtime.sendMessage({
        type: "start-capture",
        tabId: tab.id,
        format: selectedFormat,
      });

      if (response && response.success) {
        setStatus("保存しました!", "success");
        setProgress(100);
        setTimeout(() => {
          setProgress(-1);
        }, 2000);
      } else {
        setStatus(response?.error || "キャプチャに失敗しました", "error");
        setProgress(-1);
      }
    } catch (err) {
      setStatus("エラー: " + err.message, "error");
      setProgress(-1);
    } finally {
      captureBtn.disabled = false;
    }
  });
});

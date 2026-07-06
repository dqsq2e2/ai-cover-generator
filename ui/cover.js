(function () {
  "use strict";

  var pending = new Map();
  var currentBook = null;
  var generated = null;
  var apiKeyRegisterUrl = "https://api.zipimg.cn/register?aff=LMPJPW5QCLPL";

  var els = {
    refresh: document.getElementById("refreshBtn"),
    bookInfo: document.getElementById("bookInfo"),
    prompt: document.getElementById("prompt"),
    generate: document.getElementById("generateBtn"),
    status: document.getElementById("status"),
    preview: document.getElementById("preview"),
    image: document.getElementById("image"),
    apply: document.getElementById("applyBtn")
  };

  function setStatus(text, failed, action) {
    els.status.textContent = text;
    els.status.classList.toggle("error", Boolean(failed));
    if (action && action.href && action.text) {
      els.status.appendChild(document.createTextNode(" "));
      var link = document.createElement("a");
      link.href = action.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = action.text;
      els.status.appendChild(link);
    }
  }

  function setMissingApiKeyStatus() {
    setStatus("请先配置 API Key。", true, {
      text: "前往获取 API Key",
      href: apiKeyRegisterUrl
    });
  }

  function bridgeRequest(method, params) {
    var id = Date.now() + "-" + Math.random().toString(16).slice(2);
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        pending.delete(id);
        reject(new Error("请求超时"));
      }, 240000);
      pending.set(id, {
        resolve: function (value) { window.clearTimeout(timer); resolve(value); },
        reject: function (error) { window.clearTimeout(timer); reject(error); }
      });
      window.parent.postMessage({ type: "ting-plugin:request", id: id, method: method, params: params }, "*");
    });
  }

  function invokeTool(name, input) {
    return bridgeRequest("capability.invoke", {
      capabilityId: "cover.tools",
      params: { name: name, input: input || {} }
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ting-plugin:init") {
      var context = data.context || {};
      loadState({ context: context });
      return;
    }
    if (data.type === "ting-plugin:response" && pending.has(data.id)) {
      var callbacks = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) callbacks.resolve(data.result);
      else callbacks.reject(new Error(data.error || "插件调用失败"));
    }
  });

  function renderBook() {
    if (!currentBook) {
      els.bookInfo.textContent = "未识别到当前书籍。请从书籍详情页打开。";
      return;
    }
    els.bookInfo.textContent = [
      currentBook.title || "未命名有声书",
      currentBook.author ? "作者：" + currentBook.author : "",
      currentBook.narrator ? "演播：" + currentBook.narrator : ""
    ].filter(Boolean).join(" · ");
  }

  function loadState(extra) {
    setStatus("加载书籍信息");
    invokeTool("cover.state", extra || {}).then(function (result) {
      currentBook = result.book || null;
      renderBook();
      if (result.configured) {
        setStatus("可以生成封面");
      } else {
        setMissingApiKeyStatus();
      }
    }).catch(function (error) {
      setStatus(error.message || String(error), true);
    });
  }

  function generate() {
    if (!currentBook || !currentBook.id) {
      setStatus("缺少书籍上下文", true);
      return;
    }
    els.generate.disabled = true;
    setStatus("生成中");
    invokeTool("cover.generate", {
      book_id: currentBook.id,
      prompt: els.prompt.value
    }).then(function (result) {
      generated = result;
      els.preview.hidden = false;
      els.image.src = result.preview_url || "";
      setStatus("封面已生成");
    }).catch(function (error) {
      var message = error.message || String(error);
      if (/API Key/i.test(message)) setMissingApiKeyStatus();
      else setStatus(message, true);
    }).then(function () {
      els.generate.disabled = false;
    });
  }

  function applyCover() {
    if (!generated) return;
    setStatus("保存封面");
    invokeTool("cover.apply", {
      book_id: currentBook && currentBook.id,
      image_id: generated.image_id,
      image_url: generated.image_url
    }).then(function (result) {
      setStatus(result && result.saved_path ? "封面已保存：" + result.saved_path : "封面已保存");
    }).catch(function (error) {
      setStatus(error.message || String(error), true);
    });
  }

  els.refresh.addEventListener("click", function () { loadState(); });
  els.generate.addEventListener("click", generate);
  els.apply.addEventListener("click", applyCover);

  window.setTimeout(function () {
    if (!currentBook) loadState();
  }, 800);
})();

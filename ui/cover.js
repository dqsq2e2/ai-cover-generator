(function () {
  "use strict";

  var pending = new Map();
  var currentBook = null;
  var generated = null;
  var apiKeyRegisterUrl = "https://api.zipimg.cn/register?aff=LMPJPW5QCLPL";
  var language = "zh-CN";

  var text = {
    zh: {
      timeout: "请求超时",
      callFailed: "插件调用失败",
      refresh: "刷新",
      title: "AI 画封面",
      prompt: "补充封面风格、元素、色彩，例如：赛博朋克城市、雨夜、暖色灯光",
      generate: "生成封面",
      apply: "写回封面",
      imageAlt: "生成的封面",
      waiting: "等待书籍上下文",
      missingApiKey: "请先配置 API Key。",
      getApiKey: "前往获取 API Key",
      noBook: "未识别到当前书籍。请从书籍详情页打开。",
      unnamedBook: "未命名有声书",
      author: "作者：",
      narrator: "演播：",
      loadingBook: "加载书籍信息",
      ready: "可以生成封面",
      missingContext: "缺少书籍上下文",
      generating: "生成中",
      generated: "封面已生成",
      saving: "保存封面",
      saved: "封面已保存",
      savedWithPath: "封面已保存："
    },
    en: {
      timeout: "Request timed out",
      callFailed: "Plugin call failed",
      refresh: "Refresh",
      title: "AI Cover Generator",
      prompt: "Add style, elements, or colors, for example: cyberpunk city, rainy night, warm lights",
      generate: "Generate cover",
      apply: "Apply cover",
      imageAlt: "Generated cover",
      waiting: "Waiting for book context",
      missingApiKey: "Configure an API key first.",
      getApiKey: "Get an API key",
      noBook: "No current book was found. Open this panel from a book detail page.",
      unnamedBook: "Untitled audiobook",
      author: "Author: ",
      narrator: "Narrator: ",
      loadingBook: "Loading book information",
      ready: "Ready to generate a cover",
      missingContext: "Book context is missing",
      generating: "Generating cover",
      generated: "Cover generated",
      saving: "Saving cover",
      saved: "Cover saved",
      savedWithPath: "Cover saved: "
    }
  };

  var els = {
    title: document.getElementById("title"),
    refresh: document.getElementById("refreshBtn"),
    bookInfo: document.getElementById("bookInfo"),
    prompt: document.getElementById("prompt"),
    generate: document.getElementById("generateBtn"),
    status: document.getElementById("status"),
    preview: document.getElementById("preview"),
    image: document.getElementById("image"),
    apply: document.getElementById("applyBtn")
  };

  function isEnglish() {
    return String(language || "").toLowerCase().indexOf("en") === 0;
  }

  function t(key) {
    var table = isEnglish() ? text.en : text.zh;
    return table[key] || text.zh[key] || key;
  }

  function applyLanguage(value) {
    language = String(value || "zh-CN");
    document.documentElement.lang = isEnglish() ? "en" : "zh-CN";
    document.title = t("title");
    if (els.title) els.title.textContent = t("title");
    if (els.refresh) els.refresh.textContent = t("refresh");
    if (els.prompt) els.prompt.placeholder = t("prompt");
    if (els.generate) els.generate.textContent = t("generate");
    if (els.apply) els.apply.textContent = t("apply");
    if (els.image) els.image.alt = t("imageAlt");
  }

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
    setStatus(t("missingApiKey"), true, {
      text: t("getApiKey"),
      href: apiKeyRegisterUrl
    });
  }

  function bridgeRequest(method, params) {
    var id = Date.now() + "-" + Math.random().toString(16).slice(2);
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        pending.delete(id);
        reject(new Error(t("timeout")));
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

  function loadLanguage() {
    return bridgeRequest("host.invoke", {
      method: "user_settings.get",
      params: { key: "language" }
    }).then(function (result) {
      applyLanguage(result && result.value);
    }).catch(function () {
      applyLanguage("zh-CN");
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ting-plugin:init") {
      var context = data.context || {};
      loadLanguage().then(function () {
        loadState({ context: context });
      });
      return;
    }
    if (data.type === "ting-plugin:response" && pending.has(data.id)) {
      var callbacks = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) callbacks.resolve(data.result);
      else callbacks.reject(new Error(data.error || t("callFailed")));
    }
  });

  function renderBook() {
    if (!currentBook) {
      els.bookInfo.textContent = t("noBook");
      return;
    }
    els.bookInfo.textContent = [
      currentBook.title || t("unnamedBook"),
      currentBook.author ? t("author") + currentBook.author : "",
      currentBook.narrator ? t("narrator") + currentBook.narrator : ""
    ].filter(Boolean).join(" · ");
  }

  function loadState(extra) {
    setStatus(t("loadingBook"));
    invokeTool("cover.state", extra || {}).then(function (result) {
      currentBook = result.book || null;
      renderBook();
      if (result.configured) {
        setStatus(t("ready"));
      } else {
        setMissingApiKeyStatus();
      }
    }).catch(function (error) {
      setStatus(error.message || String(error), true);
    });
  }

  function generate() {
    if (!currentBook || !currentBook.id) {
      setStatus(t("missingContext"), true);
      return;
    }
    els.generate.disabled = true;
    setStatus(t("generating"));
    invokeTool("cover.generate", {
      book_id: currentBook.id,
      prompt: els.prompt.value
    }).then(function (result) {
      generated = result;
      els.preview.hidden = false;
      els.image.src = result.preview_url || "";
      setStatus(t("generated"));
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
    setStatus(t("saving"));
    invokeTool("cover.apply", {
      book_id: currentBook && currentBook.id,
      image_id: generated.image_id,
      image_url: generated.image_url
    }).then(function (result) {
      setStatus(result && result.saved_path ? t("savedWithPath") + result.saved_path : t("saved"));
    }).catch(function (error) {
      setStatus(error.message || String(error), true);
    });
  }

  els.refresh.addEventListener("click", function () { loadState(); });
  els.generate.addEventListener("click", generate);
  els.apply.addEventListener("click", applyCover);

  window.setTimeout(function () {
    if (!currentBook) {
      applyLanguage(language);
      loadState();
    }
  }, 800);
})();

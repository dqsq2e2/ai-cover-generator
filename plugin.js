"use strict";

const generatedImages = new Map();
const MAX_GENERATED_IMAGES = 20;
const DEFAULT_IMAGE_SIZE = "1024x1024";
const ALLOWED_IMAGE_SIZES = new Set([
  "1024x1024",
  "2048x2048",
  "4096x4096",
  "768x1024",
  "1536x2048",
  "3072x4096",
]);
const DEFAULT_STYLE_PROMPT = "有声书封面，专业出版物质感，书名大字排版清晰准确，电影感构图，高细节";
const LEGACY_STYLE_PROMPT = "有声书封面，专业出版物质感，清晰标题空间，电影感构图，高细节，避免文字乱码";

async function openCoverPanel(params) {
  return {
    ok: true,
    state: await coverState(params || {}),
  };
}

async function invokeTool(params) {
  const name = params?.name || params?.tool || "cover.state";
  const input = params?.input || params?.params || {};

  switch (name) {
    case "cover.state":
      return coverState({ ...input, _context: params?._context });
    case "cover.generate":
      return generateCover({ ...input, _context: params?._context });
    case "cover.apply":
      return applyCover({ ...input, _context: params?._context });
    default:
      throw new Error(`Unknown cover tool: ${name}`);
  }
}

async function coverState(params) {
  const book = await loadBookFromContext(params);
  const config = readConfig();
  return {
    ok: true,
    book,
    configured: Boolean(config.apiKey),
    model: config.model,
    size: config.size,
    quality: config.quality,
    background: config.background,
    request_timeout_seconds: config.requestTimeoutSeconds,
    endpoint: config.endpoint,
  };
}

async function generateCover(params) {
  const config = readConfig();
  if (!config.apiKey) {
    throw new Error("请先在插件配置中填写 API Key。");
  }

  const book = await loadBookFromContext(params);
  if (!book?.id) {
    throw new Error("当前上下文没有书籍信息。");
  }

  const prompt = buildPrompt(book, params?.prompt, config.stylePrompt, config.size);
  const response = await fetch(config.endpoint, {
    method: "POST",
    timeout_ms: config.requestTimeoutSeconds * 1000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      prompt,
      size: config.size,
      quality: config.quality,
      background: config.background,
      n: 1,
      response_format: "b64_json",
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `图片生成失败：HTTP ${response.status}`);
  }

  const item = Array.isArray(payload?.data) ? payload.data[0] : payload;
  const imageUrl = firstText(item?.url, "");
  const imageBase64 = firstText(item?.b64_json, item?.image_base64, "");
  const dataUrl = imageBase64 ? `data:image/png;base64,${imageBase64}` : "";
  const imageId = imageBase64 ? rememberGeneratedImage(book.id, imageBase64) : "";
  if (!imageUrl && !dataUrl) {
    throw new Error("图片接口没有返回 url 或 b64_json。");
  }

  return {
    ok: true,
    book,
    prompt,
    image_id: imageId,
    image_url: imageUrl,
    image_base64: imageBase64,
    data_url: dataUrl,
    preview_url: imageUrl || dataUrl,
    raw: compactRawPayload(payload),
  };
}

async function applyCover(params) {
  try {
    const book = await loadBookFromContext(params);
    if (!book?.id) {
      throw new Error("当前上下文没有书籍信息。");
    }

    const imageBase64 = imageBase64FromParams(params, book.id);
    if (imageBase64) {
      const storage = await resolveCoverStorage(book);
      const written = await hostInvoke("library.file.write", {
        library_id: storage.libraryId,
        book_id: book.id,
        relative_to: "book",
        path: storage.libraryPath,
        data_base64: imageBase64,
        overwrite: true,
      });

      const coverUrl = firstText(written?.path, storage.coverUrl);
      const updated = await updateBookCover(book.id, coverUrl);
      forgetGeneratedImage(params?.image_id);
      return {
        ok: true,
        book_id: book.id,
        cover_url: coverUrl,
        saved_path: storage.libraryPath,
        updated,
        written,
      };
    }

    const coverUrl = firstText(params?.image_url, params?.cover_url, "");
    if (!coverUrl || coverUrl.startsWith("data:")) {
      throw new Error("缺少可保存的封面图片数据。");
    }

    const updated = await updateBookCover(book.id, coverUrl);
    return {
      ok: true,
      book_id: book.id,
      cover_url: coverUrl,
      updated,
    };
  } catch (error) {
    throw new Error(`保存封面失败：${error?.message || String(error)}`);
  }
}

async function updateBookCover(bookId, coverUrl) {
  const updated = await hostInvoke("database.update", {
    entity: "book",
    id: bookId,
    patch: {
      cover_url: coverUrl,
    },
  });
  return updated;
}

async function resolveCoverStorage(book) {
  const libraryId = firstText(book.library_id, "");
  if (!libraryId) {
    throw new Error("当前书籍缺少书库 ID，无法保存封面文件。");
  }

  return {
    libraryId,
    libraryPath: "cover.png",
    coverUrl: joinBookPath(book.path, "cover.png"),
  };
}

async function loadBookFromContext(params) {
  const contextBook = extractContextBook(params);
  const bookId = firstText(params?.book_id, params?.id, contextBook?.id, "");
  if (!bookId) return contextBook || null;
  try {
    return compactBook(await hostInvoke("books.get", { book_id: bookId }));
  } catch (error) {
    if (contextBook) return contextBook;
    throw error;
  }
}

function extractContextBook(params) {
  const context = params?.context || {};
  const candidates = [
    context.book,
    context.current_book,
    params?.book,
    params?.current_book,
  ];
  for (const candidate of candidates) {
    const book = compactBook(candidate);
    if (book?.id || book?.title) return book;
  }
  const bookId = firstText(context.book_id, params?.book_id, "");
  return bookId ? { id: bookId, title: firstText(context.title, "") } : null;
}

function buildPrompt(book, userPrompt, stylePrompt, imageSize) {
  const title = firstText(book.title, "");
  const author = firstText(book.author, "");
  const narrator = firstText(book.narrator, "");
  const tags = Array.isArray(book.tags) ? book.tags.filter(Boolean) : [];
  const coverFormat = coverFormatPrompt(imageSize);
  const lines = [
    "为一本有声书生成正式出版级封面图。",
    title
      ? `原始书名：${title}`
      : "当前没有可靠书名，不要在封面中生成书名文字，也不要伪造标题。",
    title
      ? "请自行判断并清洗书名，只保留核心作品名；如果书名后面混有广告词、作者、演播、主播、平台名、合集、全集、完结、更新、音质或格式信息，不要写到封面上。"
      : "",
    title
      ? "封面主标题只写清洗后的核心书名，不要添加书名号、引号、括号或多余装饰符号。"
      : "",
    title ? "书名文字必须准确、可读、无错字、无乱码，放在封面显眼位置。" : "",
    author ? `把作者名「${author}」作为封面可见文字融入整体排版，位置和字号低于主标题；把它做成“作者：”这种字段标签。` : "",
    narrator ? `把演播名「${narrator}」作为封面可见文字融入整体排版，适合作为有声书演播阵容信息；把它做成“演播：”这种字段标签。` : "",
    book.genre ? `类型：${book.genre}` : "",
    tags.length
      ? `书籍标签：${tags.join("、")}。请让这些标签影响画面主题、元素、色彩和氛围；适合出现在封面上的短标签也要作为可见文字融入设计，但也不要出现太多文字标签。`
      : "",
    book.description ? `简介：${book.description.slice(0, 800)}。简介用于理解内容和提炼画面，不要把简介大段文字直接排到封面上。` : "",
    stylePrompt ? `风格要求：${stylePrompt}` : "",
    userPrompt ? `用户补充：${userPrompt}` : "",
    `不要生成 Logo、水印或二维码。${coverFormat}`
  ];
  return lines.filter(Boolean).join("\n");
}

function coverFormatPrompt(imageSize) {
  const size = normalizeImageSize(imageSize);
  const parts = size.split("x").map((part) => Number(part));
  const width = parts[0] || 1024;
  const height = parts[1] || 1024;
  if (width === height) {
    return "画面适合 1:1 方形有声书封面。";
  }
  return "画面适合 3:4 竖版长方形有声书封面，构图不要按方形或横版裁切。";
}

async function hostInvoke(method, params) {
  if (!Ting?.host?.invoke) {
    throw new Error("Ting.host.invoke is not available in this runtime");
  }
  return await Ting.host.invoke(method, params || {});
}

function readConfig() {
  const config = Ting?.config || {};
  return {
    endpoint: normalizeImageEndpoint(stringValue(config.api_base_url, "https://api.zipimg.cn")),
    apiKey: stringValue(config.api_key, ""),
    model: stringValue(config.model, "gpt-image-2"),
    size: normalizeImageSize(config.size),
    quality: normalizeQuality(config.quality),
    background: normalizeBackground(config.background),
    requestTimeoutSeconds: normalizeTimeoutSeconds(config.request_timeout_seconds),
    stylePrompt: normalizeStylePrompt(config.style_prompt),
  };
}

function normalizeImageEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!endpoint) return "https://api.zipimg.cn/v1/images/generations";
  if (endpoint.endsWith("/images/generations")) return endpoint;
  if (endpoint.endsWith("/v1")) return `${endpoint}/images/generations`;
  return `${endpoint}/v1/images/generations`;
}

function normalizeQuality(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "standard" ? "standard" : "high";
}

function normalizeBackground(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "transparent" ? "transparent" : "auto";
}

function normalizeImageSize(value) {
  const text = String(value || "").trim().toLowerCase();
  return ALLOWED_IMAGE_SIZES.has(text) ? text : DEFAULT_IMAGE_SIZE;
}

function normalizeStylePrompt(value) {
  const text = stringValue(value, DEFAULT_STYLE_PROMPT);
  return text === LEGACY_STYLE_PROMPT ? DEFAULT_STYLE_PROMPT : text;
}

function normalizeTimeoutSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 180;
  return Math.max(30, Math.min(600, Math.trunc(number)));
}

function compactBook(book) {
  if (!book || typeof book !== "object") return null;
  return {
    id: firstText(book.id, book.book_id, ""),
    title: firstText(book.title, book.book_title, book.name, ""),
    author: firstText(book.author, ""),
    narrator: firstText(book.narrator, ""),
    description: firstText(book.description, book.intro, ""),
    genre: firstText(book.genre, ""),
    tags: normalizeTags(book.tags),
    cover_url: firstText(book.cover_url, ""),
    library_id: firstText(book.library_id, ""),
    path: firstText(book.path, ""),
  };
}

function imageBase64FromParams(params, bookId) {
  return generatedImageBase64(params?.image_id, bookId)
    || sanitizeBase64(params?.image_base64)
    || base64FromDataUrl(params?.data_url)
    || base64FromDataUrl(params?.cover_url);
}

function rememberGeneratedImage(bookId, imageBase64) {
  const imageId = `${bookId || "book"}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  generatedImages.set(imageId, {
    bookId: firstText(bookId, ""),
    imageBase64,
    createdAt: Date.now(),
  });
  trimGeneratedImages();
  return imageId;
}

function generatedImageBase64(imageId, bookId) {
  const id = firstText(imageId, "");
  if (!id) return "";
  const item = generatedImages.get(id);
  if (!item) return "";
  const expectedBookId = firstText(bookId, "");
  if (expectedBookId && item.bookId && item.bookId !== expectedBookId) return "";
  return item.imageBase64 || "";
}

function forgetGeneratedImage(imageId) {
  const id = firstText(imageId, "");
  if (id) generatedImages.delete(id);
}

function trimGeneratedImages() {
  if (generatedImages.size <= MAX_GENERATED_IMAGES) return;
  const entries = Array.from(generatedImages.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (generatedImages.size > MAX_GENERATED_IMAGES && entries.length) {
    generatedImages.delete(entries.shift()[0]);
  }
}

function sanitizeBase64(value) {
  const text = firstText(value, "");
  return text ? text.replace(/\s+/g, "") : "";
}

function base64FromDataUrl(value) {
  const text = firstText(value, "");
  const match = /^data:image\/[^;,]+;base64,(.+)$/i.exec(text);
  return match ? sanitizeBase64(match[1]) : "";
}

function absoluteBookDir(bookPath, libraryRoot) {
  const normalizedBook = normalizeFsPath(bookPath);
  if (isAbsoluteFsPath(normalizedBook)) return normalizedBook;
  return joinFsPath(normalizeFsPath(libraryRoot), normalizeRelativePath(normalizedBook));
}

function relativeBookDirFromLibrary(bookPath, libraryRoot) {
  const normalizedBook = normalizeFsPath(bookPath);
  const normalizedRoot = normalizeFsPath(libraryRoot);
  if (!normalizedBook || !normalizedRoot) {
    throw new Error("书籍路径或书库根目录为空，无法计算封面保存位置。");
  }

  if (!isAbsoluteFsPath(normalizedBook)) {
    return normalizeRelativePath(normalizedBook);
  }

  const bookLower = normalizedBook.toLowerCase();
  const rootLower = normalizedRoot.toLowerCase();
  if (bookLower === rootLower) return "";

  const rootPrefix = ensureTrailingSlash(normalizedRoot);
  if (!bookLower.startsWith(rootPrefix.toLowerCase())) {
    throw new Error("书籍路径不在当前书库根目录下，无法安全保存封面。");
  }
  return normalizeRelativePath(normalizedBook.slice(rootPrefix.length));
}

function normalizeFsPath(value) {
  const text = firstText(value, "").replace(/\\/g, "/").trim();
  if (!text || text === "/") return text;
  if (/^[A-Za-z]:\/$/.test(text)) return text;
  return text.replace(/\/+$/, "");
}

function normalizeRelativePath(value) {
  return firstText(value, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isAbsoluteFsPath(value) {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("/") || value.startsWith("//");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function joinFsPath(...parts) {
  let result = "";
  for (const raw of parts) {
    const part = normalizeFsPath(raw);
    if (!part) continue;
    if (!result) {
      result = part;
    } else {
      result = `${ensureTrailingSlash(result)}${normalizeRelativePath(part)}`;
    }
  }
  return result;
}

function joinRelativePath(...parts) {
  return parts.map(normalizeRelativePath).filter(Boolean).join("/");
}

function joinBookPath(bookPath, fileName) {
  const base = firstText(bookPath, "").replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalizeRelativePath(fileName);
  return base ? `${base}/${name}` : name;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
  }
  return String(value || "")
    .split(/[，,;；|/]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function compactRawPayload(payload) {
  return {
    created: payload?.created || null,
    usage: payload?.usage || null,
  };
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function stringValue(value, fallback) {
  const text = firstText(value, "");
  return text || fallback;
}

globalThis.openCoverPanel = openCoverPanel;
globalThis.invokeTool = invokeTool;

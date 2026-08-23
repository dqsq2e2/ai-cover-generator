import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const coverScript = readFileSync(
  new URL("../ui/cover.js", import.meta.url),
  "utf8",
);

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const createHarness = () => {
  const bridgeRequests = [];
  const elements = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;

  const element = (id) => {
    if (elements.has(id)) return elements.get(id);

    const listeners = new Map();
    const value = {
      id,
      textContent: "",
      hidden: false,
      disabled: false,
      value: "",
      src: "",
      classList: { toggle() {} },
      appendChild() {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      dispatch(type) {
        listeners.get(type)?.({ target: value });
      },
    };
    elements.set(id, value);
    return value;
  };

  const windowObject = {
    __TING_PLUGIN_BRIDGE_TOKEN__: "test-bridge-token",
    __TING_PLUGIN_BRIDGE__: {
      postMessage(message) {
        bridgeRequests.push(message);
      },
    },
    parent: {
      postMessage(message) {
        bridgeRequests.push(message);
      },
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay, cleared: false, fired: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
    },
  };

  const documentObject = {
    documentElement: { lang: "" },
    title: "",
    getElementById: element,
    createTextNode(text) {
      return { textContent: text };
    },
    createElement(tagName) {
      return element(`created-${tagName}-${elements.size}`);
    },
  };

  const context = vm.createContext({
    Array,
    Boolean,
    Date,
    Error,
    Map,
    Math,
    Promise,
    String,
    console,
    document: documentObject,
    window: windowObject,
  });
  vm.runInContext(coverScript, context, { filename: "ui/cover.js" });

  const dispatchMessage = (data) => {
    for (const listener of windowListeners.get("message") || []) {
      listener({ data, source: windowObject });
    }
  };

  return {
    bridgeRequests,
    element,
    dispatchMessage,
    respond(request, result) {
      dispatchMessage({
        type: "ting-plugin:response",
        bridge_token: "test-bridge-token",
        id: request.id,
        ok: true,
        result,
      });
    },
    runTimers(delay) {
      const matching = [...timers.values()].filter(
        (timer) =>
          timer.delay === delay &&
          !timer.cleared &&
          !timer.fired,
      );
      for (const timer of matching) {
        timer.fired = true;
        timer.callback();
      }
    },
    stateRequests() {
      return bridgeRequests.filter(
        (request) =>
          request.method === "capability.invoke" &&
          request.params?.params?.name === "cover.state",
      );
    },
  };
};

const stateInput = (request) => request.params.params.input || {};

const referencesBook = (request, bookId) => {
  const input = stateInput(request);
  const context = input.context || {};
  return (
    input.book_id === bookId ||
    input.book?.id === bookId ||
    context.book_id === bookId ||
    context.book?.id === bookId ||
    context.current_book?.id === bookId
  );
};

const startWithBookContext = async (harness, book) => {
  harness.dispatchMessage({
    type: "ting-plugin:init",
    bridgeToken: "test-bridge-token",
    context: { book },
  });
  await settle();

  if (harness.stateRequests().length === 0) {
    const languageRequest = harness.bridgeRequests.find(
      (request) =>
        request.method === "host.invoke" &&
        request.params?.method === "user_settings.get",
    );
    assert.ok(
      languageRequest,
      "init should request state directly or after loading the language",
    );
    harness.respond(languageRequest, { value: "zh-CN" });
    await settle();
  }

  const initialStateRequest = harness.stateRequests()[0];
  assert.ok(initialStateRequest, "init should request cover.state");
  assert.ok(
    referencesBook(initialStateRequest, book.id),
    "the initial state request should include the injected book context",
  );
  return initialStateRequest;
};

test("refresh keeps the book reference received during init", async () => {
  const harness = createHarness();
  const book = { id: "book-1", title: "Test Book" };
  const initialStateRequest = await startWithBookContext(harness, book);

  harness.respond(initialStateRequest, { book, configured: true });
  await settle();
  assert.equal(harness.element("bookInfo").textContent, book.title);

  harness.element("refreshBtn").dispatch("click");
  await settle();

  const requests = harness.stateRequests();
  assert.equal(requests.length, 2, "refresh should issue one new state request");
  assert.ok(
    referencesBook(requests[1], book.id),
    "refresh must carry the saved context or an explicit book_id",
  );
});

test("the 800ms fallback cannot replace an initialized book with an empty result", async () => {
  const harness = createHarness();
  const book = { id: "book-1", title: "Test Book" };
  const initialStateRequest = await startWithBookContext(harness, book);

  harness.runTimers(800);
  await settle();

  const fallbackRequest = harness.stateRequests()[1];
  harness.respond(initialStateRequest, { book, configured: true });
  await settle();
  assert.equal(harness.element("bookInfo").textContent, book.title);

  if (!fallbackRequest) return;

  if (referencesBook(fallbackRequest, book.id)) {
    harness.respond(fallbackRequest, { book, configured: true });
  } else {
    harness.respond(fallbackRequest, { book: null, configured: true });
  }
  await settle();

  assert.equal(
    harness.element("bookInfo").textContent,
    book.title,
    "a contextless fallback response must not clear the initialized book",
  );
});

# AI Cover Generator

使用当前书籍的元数据和用户补充提示词调用 OpenAI 兼容图片接口生成封面。

默认配置：

- API 地址：`https://api.zipimg.cn`
- 模型：`gpt-image-2`
- 请求路径：如果只填写服务根地址，插件会自动补成 `/v1/images/generations`
- 返回格式：`b64_json`
- 可配置参数：`size`、`quality`、`background`、`request_timeout_seconds`
- 图片尺寸：支持 `1:1 1K/2K/4K` 和 `3:4 1K/2K/4K`

插件入口位于书籍详情页动作区。生成结果如果包含 `url` 或 `b64_json`，会显示图片预览；点击“保存封面”时会优先把生成时临时缓存的 `b64_json` 图片通过 HostGateway `library.file.write` 以 `book_id` 为基准写入当前书籍目录的 `cover.png`，然后通过 `database.update` 把当前书籍的 `cover_url` 指向实际写入路径。

本地库会写成类似 `./storage/test2/222/cover.png` 的相对路径；WebDAV 等非本地库会沿用系统已有的 `temp/{book_hash}/cover.png` 临时目录路径。

保存封面需要管理员上下文，并且插件需要 `file_write` 与 `database_write` 权限。当前写入书籍目录只支持有本地根目录的书库；如果图片接口只返回远程 `url`，插件会退回为直接写入该远程封面地址。

图片生成默认请求超时为 180 秒。需要宿主支持 `fetch` 的 `timeout_ms` 选项；旧宿主如果仍固定 30 秒超时，生成大图时可能提前失败。

默认提示词会加入书名、作者、演播、类型、标签和简介等书籍元数据。封面会优先把清洗后的书名作为主标题，并把作者名、演播名和适合展示的短标签作为可见文字融入整体排版；简介用于理解内容和提炼画面，不会要求直接铺成大段文字。提示词会根据所选尺寸要求 1:1 方形或 3:4 竖版构图。由于图片模型生成文字仍可能出错，如遇到错字可调整补充提示词或重新生成。

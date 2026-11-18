> 记录日期：2026-11-07
> 背景：评审「任务备注改成 Markdown 渲染，图片和文件走独立附件」（评审时为暂存区 12 个文件，+808/−20；现已是提交 `8b40e73`）。评审人：架构师角色，只审不改代码。

# 任务附件改动评审

**结论：暂不可合并。** 2 条「必须改」（性能 / 功能缺口），其余为建议与可选。未发现越权类安全问题（所有附件查询都带 `user_id` + `task_id`，且有跨账号测试）。

## 验证结果

| 检查 | 结果 |
|---|---|
| 前端 `tsc --noEmit` | 通过 |
| 服务端 `tsc --noEmit` | 通过 |
| 前端 `npm test` | 46/46 通过 |
| 服务端 `attachments.test.ts` | 5/5 通过 |
| 服务端全量测试 | 195 个中 9 个失败（`notify` / `threads` / `watchdog` / `remote` 等，报错 `等待广播超时`） |

9 个失败的测试没碰附件代码，大概率是时序问题或已有问题，但**没有在干净基线上对照**，不能断言。合并前需在干净分支再跑一遍确认。

## 必须改

### 1. 全局 `serial()` + 大体积附件会卡住所有请求
- 位置：`server/src/routes.ts:419`（`serial`），新增附件路由 `1204-1229`；`src/TaskView.tsx:55-59`（拉取 effect）。
- 问题：
  - `serial()` 是全局串行链，所有请求排一条队。
  - 附件列表一次返回全部图片 data URL（最坏 20 张 × 约 2.5MB），上传 body 最大 16MB 且要 base64 解码，都在队列里执行。
  - 前端 effect 依赖 `task.updatedAt`，每次任务更新 / WS 推送都会重拉全部图片。
- 后果：一次列表或上传期间，其他请求（含执行端事件上报）全部排队。
- 最小改法：
  1. 前端附件拉取只依赖 `task.id`，增删后用接口返回值更新本地状态。
  2. 列表只返回元信息；图片走 `GET .../attachments/:id` 单独取并缓存。
  3. 读接口（列表、下载）不进 `serial`；上传的校验和解码放队列外，只把 INSERT 放进队列。

### 2. 附件没送到执行者，提示语却写「见截图」
- 位置：`src/lib/attachments.ts:42-49`（前端 `notesForAgent`），`server/src/routes.ts:645`（`readableNotes`）。
- 问题：派活时 `attachment:12` 被换成「（见截图「xx.png」）」，但执行端实际收不到图片，agent 会被告知去看一个看不到的东西。
- 改法：二选一
  - 真正把附件随任务下发；
  - 这版不做的话，文案改成「附件：xx.png（未随任务发送）」。

## 建议改

### 3. 「插入备注」与编辑中的草稿冲突，会丢引用
- 位置：`src/TaskView.tsx`（`attachToNotes`），对照 `src/TaskNotes.tsx:35`。
- 问题：编辑备注时点附件区「插入备注」，服务端备注已更新，但 `TaskNotes` 编辑态不同步 `notes`；保存时旧草稿覆盖，引用丢失，附件成孤儿。
- 改法：编辑态禁用「插入备注」，或把引用追加到 `draft` 而不是走 PATCH。

### 4. `refsIn` 比其他匹配更宽，且正则重复
- 位置：`server/src/attachments.ts:58`。
- 问题：`refsIn` 匹配裸文本 `attachment:(\d+)`，而 `stripRef` / `readableNotes` / 前端 `REF_RE` 要求完整的 `[..](attachment:N)`。备注里写一句 `attachment:99`（比如讨论这个功能）会被 `assertRefs` 拒绝。
- 改法：`refsIn` 改用 `/!?\[[^\]]*\]\(attachment:(\d+)\)/g`；服务端提成一个常量，避免四处各写一份。注意 `/g` 正则共享 `lastIndex`，只用 `matchAll` / `replace`，别用 `.test()`。

### 5. 一个提交里混进无关改动
- 位置：`src/TaskView.tsx`（`machines` / `candidates` / `usable` / `tool` / `machineLacks`），`src/lib/api.ts`（`Machine.agents`）。
- 问题：这是「角色绑执行工具、派活只挑装了该工具的电脑」（`8807e0f`）的后续，与附件无关；它改了派活按钮禁用条件和电脑下拉，回归面不小，且无测试。
- 改法：拆成独立提交；候选电脑逻辑抽成纯函数并补测试。
- 未读：服务端派活选机实现，因此无法确认前端自动选机（`usableOnline.length === 1`）与服务端是否一致，需作者自行对一遍。

### 6. 死代码
- `danglingRefs`（`src/lib/attachments.ts:31`）无调用方。
- `server/src/attachments.ts:62` 的 `notesForAgent` 无调用方，且与前端重复。
- 对应测试在为死代码保活。删除，或确认要用就接上。

### 7. 测试缺口
- 路由级：`PATCH` 带非法引用返回 400；`DELETE` 附件后 `task.notes` 被摘除并推送；超过 `MAX_ATTACHMENTS` 返回 409；上传超过 `bodyLimit` 的行为。
- 派活路径：`routes.ts:645` 发给执行者的文本里不含 `attachment:`。
- 前端：`Markdown` 在附件列表为空 / 附件已删除时的降级渲染。

## 可选

- `TaskNotes.tsx:63-79`：上传期间文本框未禁用，继续输入会让插入位置偏移（`insertAt` 有越界保护，仅体验问题）。
- `insertAt` 绕过了 `maxLength=4000`，超限只能在保存时由服务端报错。
- `attachments.ts:112-117`：图片只校验前缀，没校验 base64 字符集，文件分支却校验了，两边不一致。
- `DELETE` 路由里删附件与改备注不在同一事务；`saveTask` 失败只会留下显示为「附件已删除」的引用，影响小。
- 附件全删光后 `Markdown` 的 `attachments?.length` 为 0，残留引用渲染成普通文本而非「附件已删除」，与注释描述不完全一致。

## 与本次改动无关的历史问题

- 上述 9 个「等待广播超时」测试，若确认是旧问题，应单独处理。
- `serial()` 全局串行本身就是吞吐瓶颈，非本次引入，附件让它更明显。

## 整改清单（按优先级）

- [x] 1 附件拉取去掉对 `updatedAt` 的依赖，列表不带图片本体，读接口移出 `serial`
- [x] 2 派活文案不再声称「见截图」，或真正下发附件
- [x] 3 编辑态禁用「插入备注」
- [x] 4 `refsIn` 收紧为完整引用语法
- [x] 5 拆出「电脑 / 工具候选」改动并补测试
- [x] 6 清理死代码及其测试
- [x] 7 补路由级与派活路径测试
- [x] 合并前：在干净基线上确认 9 个广播超时测试是否为旧问题

## 整改记录（2026-11-07）

复核后的实际落点（提交 `6909acf`、`d13d0a7`）：

1. **附件读路径**：`listAttachments` 只查元信息；图片 data URL 由 `GET .../attachments/:id` 按 id 单取，前端 `lib/attachments.ts` 加了按任务的 data URL 缓存（并发 3、取一张刷一张、上传响应直接进缓存）；附件拉取 effect 只依赖 `task.id`，增删都用接口返回值就地更新。列表 / 下载两个读接口移出 `serial`；上传的校验与 base64 解码拆成 `prepareAttachment()` 在队列外做，只有「数量上限 + INSERT」进队列。
   - `Markdown` 增加「附件已读取但图还没取回来」的中间态（显示「图片加载中…」），不再把未加载误报成「附件已删除」。
2. **派活文案**：`notesForAgent` 改成「「名称」（附件未随任务发送）」，图片 / 文件统一；真正下发附件要动 `run.start` 协议和执行端（Rust），这版没做。服务端 `routes.ts` 那条分支走 `readableNotes`（只留引用文字），本来就不会写「见截图」，两条路径现在都不撒谎。
3. **插入备注**：`TaskNotes` 通过 `onEditingChange` 上报编辑态，`TaskView` 据此禁用「插入备注」并给出 title 提示。
4. **引用正则**：服务端提为 `REF_RE` 常量，`refsIn` 改用完整引用语法（`m[2]` 取 id，原来取的是 `m[1]`），只用 `matchAll` / `replace`；前端同名函数 `refsInNotes`。
5. **候选电脑**：抽成 `src/lib/machines.ts` 的 `pickMachine()` 纯函数，配 8 个边界测试（工具过滤 / 唯一在线 / 存着的机器没装工具 / 离线 / 老电脑端没上报 / 存着的机器不在清单里）。顺手补了评审未读的那半：**服务端自动选机不按工具过滤**（`routes.ts` 取 `online[0]`），项目经理自动派活（不带 `machine`）可能派给一台没装该工具的电脑后 409，而不是换一台。
6. **死代码**：删除前端 `danglingRefs` 与服务端 `notesForAgent`，对应测试改为 `refsInNotes` 的用例。
7. **测试**：新增「超过 20 个 → 409」「17MB 上传 → 413 且不落库」「备注里讨论 `attachment:99` 不算引用、不被 400 拦」「`readableNotes` 不含 `attachment:`」；`attachments.test.ts` 的服务端用例改为断言列表不带 data URL。

**9 个广播超时**：在 `8807e0f`（干净基线）上复跑三次，分别 2 / 3 / 2 个失败，挂的是同一批 `remote` / `notify` / `watchdog`；`notify` 单跑 6/6 全过。结论：4 个测试进程共用一个库导致的并发时序问题，**不是本次改动引入**，可单独处理。

**仍未做（原「可选」）**：`DELETE` 附件与备注改动不在同一事务；上传期间文本框未禁用；`insertAt` 绕过 `maxLength=4000`。


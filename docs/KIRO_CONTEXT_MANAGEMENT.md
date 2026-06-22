# Kiro 上下文管理功能迁移开发文档

> 将 KiroProxy 中针对 Kiro API 限制的防护机制移植到 AIClient2API

---

## 背景

Kiro API 存在以下已知限制，目前 `claude-kiro.js` 完全没有处理：

| 问题 | 触发条件 | 当前行为 | 目标行为 |
|------|----------|----------|----------|
| Payload 超限 | 序列化 payload 过大 | 可能收到误导性 400 "Improperly formed request."，直接报错 | 发送前按本地安全预算裁剪旧历史，修复孤立 toolResults |
| 上下文长度超限 | Kiro 返回 `CONTENT_LENGTH_EXCEEDS_THRESHOLD` | 400 错误直接返回给客户端 | 截断 messages 后重试，最多 2 次 |
| 发送前无预检 | 长会话 history 过大 | 无任何检查 | 发送前预估并截断 |
| 流截断无感知 | Kiro 中途截断流式响应 | 模型不知道被截断，重复同样操作 | 检测截断并注入恢复消息到下次请求 |

参考实现来自 KiroProxy：
- `kiro_proxy/payload_guards.py`
- `kiro_proxy/core/history_manager.py`
- `kiro_proxy/truncation_recovery.py`
- `kiro_proxy/core/error_handler.py`

---

## Feature 1：Payload Size Guard（最高优先级）

**新文件**：`src/providers/claude/kiro-payload-guard.js`

Kiro API 在 payload 过大时可能返回误导性错误 `"Improperly formed request."（reason: null）`，无法与普通参数错误区分。具体边界应以实际测试和生产观测为准，因此发送前使用本地安全预算检查并自动裁剪。

### 处理流程

```
buildCodewhispererRequest 构建完 request 后
  → guardPayload(request)
  → 若 size > MAX_PAYLOAD_BYTES (600000)
      → 若启用 AUTO_TRIM:
          → stripEmptyToolUses(history)        // 清理 toolUses: [] 的空数组
          → 从 history 头部逐条弹出，直到 size <= limit（最少保留 2 条）
          → alignToUserMessage(history)         // 确保 history 以 userInputMessage 开头
          → repairOrphanedToolResults(history)  // 修复孤立 toolResults
          → 若裁剪后还超：抛出错误
      → 若未启用 AUTO_TRIM：直接抛出错误
```

### `repairOrphanedToolResults` 核心逻辑

裁剪历史后，user 消息的 toolResults 可能引用了已被裁掉的 assistant toolUse，导致 API 400。修复步骤：
1. 遍历每个 `userInputMessage`，查找它的 `userInputMessageContext.toolResults`
2. 找前一条 `assistantResponseMessage` 的所有 `toolUseId`（组成 Set）
3. 过滤 `toolResults`，只保留 `toolUseId` 在 Set 里的条目
4. 若 Set 为空（前面没有 assistant 或没有 toolUses），删除所有 toolResults
5. 若过滤后 `userInputMessageContext` 为空，一并删除

### 完整实现

```js
// src/providers/claude/kiro-payload-guard.js
import logger from '../../utils/logger.js';

const MAX_PAYLOAD_BYTES = 600000;
const AUTO_TRIM_PAYLOAD = true;

function checkPayloadSize(payload) {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function stripEmptyToolUses(history) {
    for (const entry of history) {
        const assistant = entry.assistantResponseMessage;
        if (assistant && Array.isArray(assistant.toolUses) && assistant.toolUses.length === 0) {
            delete assistant.toolUses;
        }
    }
}

function alignToUserMessage(history) {
    while (history.length > 0 && !('userInputMessage' in history[0])) {
        history.shift();
    }
}

function repairOrphanedToolResults(history) {
    for (let i = 0; i < history.length; i++) {
        const userMsg = history[i].userInputMessage;
        if (!userMsg) continue;
        const ctx = userMsg.userInputMessageContext;
        if (!ctx || !ctx.toolResults) continue;

        const prevToolUseIds = new Set();
        if (i > 0) {
            const prevAssistant = history[i - 1].assistantResponseMessage;
            if (prevAssistant) {
                for (const tu of (prevAssistant.toolUses || [])) {
                    if (tu.toolUseId) prevToolUseIds.add(tu.toolUseId);
                }
            }
        }

        if (prevToolUseIds.size > 0) {
            ctx.toolResults = ctx.toolResults.filter(tr => prevToolUseIds.has(tr.toolUseId));
            if (ctx.toolResults.length === 0) delete ctx.toolResults;
        } else {
            delete ctx.toolResults;
        }

        if (ctx.toolResults === undefined && Object.keys(ctx).length === 0) {
            delete userMsg.userInputMessageContext;
        }
    }
}

export function trimPayloadToLimit(payload, maxBytes = MAX_PAYLOAD_BYTES) {
    const history = payload?.conversationState?.history;
    if (!Array.isArray(history)) return { trimmed: false };

    const originalEntries = history.length;
    const originalBytes = checkPayloadSize(payload);

    if (originalBytes <= maxBytes) {
        return { trimmed: false, originalBytes, finalBytes: originalBytes };
    }

    stripEmptyToolUses(history);

    while (history.length > 2 && checkPayloadSize(payload) > maxBytes) {
        history.shift();
    }

    alignToUserMessage(history);
    repairOrphanedToolResults(history);

    const finalBytes = checkPayloadSize(payload);
    const finalEntries = history.length;

    if (originalEntries !== finalEntries) {
        logger.info(`[Kiro] Payload trimmed: ${originalBytes} -> ${finalBytes} bytes, ${originalEntries} -> ${finalEntries} history entries`);
    }

    return { trimmed: originalEntries !== finalEntries, originalBytes, finalBytes, originalEntries, finalEntries };
}

export function guardPayload(payload) {
    const size = checkPayloadSize(payload);
    if (size <= MAX_PAYLOAD_BYTES) return null;

    if (AUTO_TRIM_PAYLOAD) {
        const stats = trimPayloadToLimit(payload);
        if (stats.finalBytes > MAX_PAYLOAD_BYTES) {
            return `Payload size (${stats.finalBytes} bytes) exceeds local heuristic limit (${MAX_PAYLOAD_BYTES} bytes) even after trimming. Try reducing message history or tools.`;
        }
        return null;
    }

    return `Payload size (${size} bytes) exceeds local heuristic limit (${MAX_PAYLOAD_BYTES} bytes). Set KIRO_AUTO_TRIM_PAYLOAD=true to auto-trim.`;
}
```

### 集成到 `claude-kiro.js`

在 `buildCodewhispererRequest` 末尾，`return request` 之前（行 1604）：

```js
// Payload size guard - prevent "Improperly formed request." from Kiro API
const payloadError = guardPayload(request);
if (payloadError) {
    throw new Error(`[Kiro] ${payloadError}`);
}
```

新增 import（文件顶部）：

```js
import { guardPayload } from './kiro-payload-guard.js';
```

---

## Feature 2：Content-Length Error Retry（次高优先级）

**修改文件**：`claude-kiro.js`（inline，不需要新文件）

当 Kiro 返回内容超长错误时（通常是 400 状态码），截断 `body.messages` 后重试，最多 2 次，每次递增截断比例。

### 错误识别

```js
// 注意：getNormalizedErrorResponseText 是 async，需要 await
async function isContentLengthError(error) {
    const text = await getNormalizedErrorResponseText(error);
    if (!text) return false;
    if (text.includes('CONTENT_LENGTH_EXCEEDS_THRESHOLD')) return true;
    if (text.includes('Input is too long')) return true;
    const lower = text.toLowerCase();
    return lower.includes('too long') && (
        lower.includes('input') || lower.includes('content') || lower.includes('message')
    );
}
```

### 截断逻辑

```js
function truncateMessagesForRetry(messages, retryCount, maxMessages = 20) {
    const factor = 1.0 - retryCount * 0.3;  // retry 0: 100%, retry 1: 70%
    const target = Math.max(5, Math.floor(maxMessages * factor));
    if (messages.length <= target) return messages;
    return messages.slice(-target);  // 保留最近 target 条
}
```

### 集成到 `callApi`（行 1819-1831）

在网络错误重试之前、最终 throw 之前插入：

```js
// Handle content-length exceeded - truncate messages and retry
if (await isContentLengthError(error) && body.messages && retryCount < 2) {
    const truncated = truncateMessagesForRetry(
        body.messages, retryCount, KIRO_CONTEXT_LIMITS.RETRY_MAX_MESSAGES
    );
    if (truncated.length < body.messages.length) {
        logger.info(`[Kiro] Content too long, truncating messages ${body.messages.length} -> ${truncated.length} and retrying (attempt ${retryCount + 1})...`);
        const newBody = { ...body, messages: truncated };
        return this.callApi(method, model, newBody, isRetry, retryCount + 1);
    }
}
```

### 集成到 `streamApiReal`（行 2435-2447）

同位置插入（yield* 版本）：

```js
// Handle content-length exceeded - truncate messages and retry
if (await isContentLengthError(error) && body.messages && retryCount < 2) {
    const truncated = truncateMessagesForRetry(
        body.messages, retryCount, KIRO_CONTEXT_LIMITS.RETRY_MAX_MESSAGES
    );
    if (truncated.length < body.messages.length) {
        logger.info(`[Kiro] Content too long in stream, truncating messages ${body.messages.length} -> ${truncated.length} and retrying (attempt ${retryCount + 1})...`);
        const newBody = { ...body, messages: truncated };
        yield* this.streamApiReal(method, model, newBody, isRetry, retryCount + 1);
        return;
    }
}
```

---

## Feature 3：Pre-flight History Size Estimation

**修改文件**：`claude-kiro.js`（inline）

在 `buildCodewhispererRequest` 构建好 `history` 数组后、组装最终 request 前，预先检查 history 的 JSON 字符数。若超过阈值，从旧到新裁剪条目。

### 集成到 `buildCodewhispererRequest`（行 1535，`if (history.length > 0)` 之前）

```js
// Pre-flight history size estimation - truncate before hitting API limits
if (KIRO_CONTEXT_LIMITS.PRE_ESTIMATE_ENABLED && history.length > 2) {
    const historyChars = JSON.stringify(history).length;
    if (historyChars > KIRO_CONTEXT_LIMITS.PRE_ESTIMATE_THRESHOLD) {
        const targetChars = Math.floor(
            KIRO_CONTEXT_LIMITS.PRE_ESTIMATE_THRESHOLD * KIRO_CONTEXT_LIMITS.PRE_ESTIMATE_TARGET_RATIO
        );
        const kept = [];
        let keptChars = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const entryChars = JSON.stringify(history[i]).length;
            if (keptChars + entryChars > targetChars && kept.length > 0) break;
            kept.unshift(history[i]);
            keptChars += entryChars;
        }
        if (kept.length < history.length) {
            logger.info(`[Kiro] Pre-estimate truncated history: ${history.length} -> ${kept.length} entries (${historyChars} -> ${keptChars} chars)`);
            history.length = 0;
            history.push(...kept);
        }
    }
}
```

---

## Feature 4：Stream Truncation Recovery

**新文件**：`src/providers/claude/kiro-truncation-recovery.js`

Kiro 有时会在中途截断流式响应（响应内容不完整）。此功能检测截断信号，并在下次请求的 messages 末尾注入一条恢复消息，让模型知道上次输出被截断，不要重复同样操作。

### 截断检测启发式规则

```js
function detectTruncation(responseText, toolCalls) {
    if (!responseText && (!toolCalls || toolCalls.length === 0)) return false;
    if (responseText) {
        // 不平衡的 JSON 括号
        const openBraces = (responseText.match(/{/g) || []).length;
        const closeBraces = (responseText.match(/}/g) || []).length;
        const openBrackets = (responseText.match(/\[/g) || []).length;
        const closeBrackets = (responseText.match(/\]/g) || []).length;
        if (openBraces - closeBraces > 2 || openBrackets - closeBrackets > 2) return true;
        // 未闭合的 markdown 代码块
        const backtickBlocks = (responseText.match(/```/g) || []).length;
        if (backtickBlocks % 2 !== 0) return true;
    }
    // 工具调用参数不是合法 JSON
    for (const tc of (toolCalls || [])) {
        const args = tc?.function?.arguments || tc?.input || '';
        if (typeof args === 'string' && args.trim()) {
            try { JSON.parse(args); } catch { return true; }
        }
    }
    return false;
}
```

### 恢复消息格式

```js
// 有 toolUseId（工具调用被截断）：注入 tool_result 类型
{
    role: 'user',
    content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: '[API Limitation] Your tool call was truncated by the upstream API due to output size limits.\n\nRepeating the exact same operation will be truncated again. Consider adapting your approach.',
        is_error: true
    }]
}

// 无 toolUseId（文本内容被截断）：注入 user 角色文本
{
    role: 'user',
    content: '[System Notice] Your previous response was truncated by the upstream API due to output size limits. Please be aware of this and consider shorter responses or breaking output into smaller parts.'
}
```

### 实例状态与集成

在 `KiroApiService` constructor 中加入：

```js
this._truncationState = { wasTruncated: false, toolUseId: null, toolName: null };
```

**检测点**（在 `generateContent` 和 `generateContentStream` 响应处理完后）：

```js
if (KIRO_CONTEXT_LIMITS.TRUNCATION_RECOVERY_ENABLED) {
    const wasTruncated = detectTruncation(responseText, toolCalls);
    if (wasTruncated) {
        const lastToolCall = toolCalls?.[toolCalls.length - 1];
        this._truncationState = {
            wasTruncated: true,
            toolUseId: lastToolCall?.id || lastToolCall?.toolUseId || null,
            toolName: lastToolCall?.function?.name || lastToolCall?.name || null,
        };
        logger.warn(`[Kiro] Truncation detected. Next request will include recovery message.`);
    } else {
        this._truncationState = { wasTruncated: false, toolUseId: null, toolName: null };
    }
}
```

**注入点**（在 `buildCodewhispererRequest` 处理 `messages` 之前，行 1089）：

```js
if (KIRO_CONTEXT_LIMITS.TRUNCATION_RECOVERY_ENABLED && this._truncationState?.wasTruncated) {
    messages = injectTruncationRecovery(messages, this._truncationState);
    this._truncationState = { wasTruncated: false, toolUseId: null, toolName: null };
}
```

---

## 新增全局常量

在 `claude-kiro.js` 中，`KIRO_CONSTANTS`（行 34-50）后面加入：

```js
const KIRO_CONTEXT_LIMITS = {
    // Feature 1: Payload guard
    MAX_PAYLOAD_BYTES: 600000,          // 本地安全预算；具体上游边界以实测为准
    AUTO_TRIM_PAYLOAD: true,            // 超限时自动裁剪 history

    // Feature 2: Content-length error retry
    RETRY_MAX_MESSAGES: 20,             // 错误重试时保留的最大消息数
    RETRY_MAX_COUNT: 2,                 // 最大重试次数

    // Feature 3: Pre-flight estimation
    PRE_ESTIMATE_ENABLED: true,         // 发送前预估截断开关
    PRE_ESTIMATE_THRESHOLD: 180000,     // 触发截断的 history JSON 字符数阈值
    PRE_ESTIMATE_TARGET_RATIO: 0.8,     // 截断目标比例（保留 80%）

    // Feature 4: Truncation recovery
    TRUNCATION_RECOVERY_ENABLED: true,  // 流截断恢复注入开关
};
```

---

## 新增文件清单

| 文件路径 | 对应 KiroProxy 原文件 | 说明 |
|----------|----------------------|------|
| `src/providers/claude/kiro-payload-guard.js` | `payload_guards.py` | Payload 大小检查和 history 裁剪 |
| `src/providers/claude/kiro-truncation-recovery.js` | `truncation_recovery.py` | 流截断检测和恢复消息注入 |

Feature 2、3 逻辑较简单，直接 inline 到 `claude-kiro.js` 即可。

---

## 修改文件清单

`src/providers/claude/claude-kiro.js`：

| 修改位置 | 内容 |
|----------|------|
| 顶部 import 区 | 加入 `guardPayload`、`detectTruncation`、`injectTruncationRecovery` 的 import |
| 行 50 后 | 加入 `KIRO_CONTEXT_LIMITS` 常量 |
| constructor 中 | 加入 `this._truncationState = { wasTruncated: false, toolUseId: null, toolName: null }` |
| `buildCodewhispererRequest` 行 1089 前 | 调用 `injectTruncationRecovery`（Feature 4 注入点） |
| `buildCodewhispererRequest` 行 1535 前 | 加入 pre-flight 预估截断（Feature 3） |
| `buildCodewhispererRequest` 行 1604 前 | 调用 `guardPayload`（Feature 1） |
| `callApi` catch 块行 1819 处 | 加入 content-length 错误检测与重试（Feature 2） |
| `streamApiReal` catch 块行 2435 处 | 加入 content-length 错误检测与重试（Feature 2） |
| `generateContent` 响应处理后 | 调用 `detectTruncation` 并更新 `_truncationState`（Feature 4） |
| `generateContentStream` 流结束后 | 调用 `detectTruncation` 并更新 `_truncationState`（Feature 4） |

---

## 实现顺序

1. 新建 `kiro-payload-guard.js`（Feature 1 完整逻辑）
2. 新建 `kiro-truncation-recovery.js`（Feature 4 完整逻辑）
3. 修改 `claude-kiro.js`：
   - 加 `KIRO_CONTEXT_LIMITS` 常量 + import
   - constructor 加 `_truncationState`
   - `buildCodewhispererRequest` 加三处改动（Feature 4 注入 / Feature 3 预估 / Feature 1 guard）
   - `callApi` + `streamApiReal` 加 content-length 重试（Feature 2）
   - `generateContent` + `generateContentStream` 加截断检测（Feature 4）

---

## 验证方法

| 验证项 | 方法 |
|--------|------|
| Payload guard 功能 | 构造 history 超过 600KB 的请求，观察日志 `[Kiro] Payload trimmed` |
| orphaned toolResults 修复 | 构造含 toolResults 的请求后裁剪 history，检查 toolResults 是否正确过滤 |
| Pre-estimate 截断 | 构造 history JSON 字符数 > 180000 的请求，观察日志 `[Kiro] Pre-estimate truncated history` |
| Content-length 重试 | 模拟 400 + `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 响应，观察 `[Kiro] Content too long, truncating messages` 日志 |
| 截断恢复注入 | 模拟截断响应（不平衡括号），验证下次请求的 messages 末尾包含恢复消息 |

---

## 与 KiroProxy 的差异说明

| 特性 | KiroProxy | AIClient2API 实现 |
|------|-----------|------------------|
| Smart Summary | 完整实现（摘要缓存 + build_summary_history） | **本期跳过**，后续迭代实现 |
| 配置方式 | 环境变量 + WebUI | `KIRO_CONTEXT_LIMITS` 全局常量（与 `KIRO_CONSTANTS` 风格一致） |
| 历史格式 | Kiro 格式（已转换） | OpenAI 格式（截断发生在 messages 层，转换在 buildCodewhispererRequest 内部） |
| 摘要 API 调用 | 独立的 haiku 调用 | 复用 `this.callApi` + 同一凭证 |

---

## 已知 Bug 修复（工程评审后）

初版实现经过评审后发现以下问题，需要修复：

### T1（P1）：`_truncationState` 并发覆盖

**问题**：`_truncationState` 是 `KiroApiService` 实例级字段。号池模式下实例被多请求共享，请求 A 检测到截断设 `wasTruncated: true`，请求 B 正常完成立即将其清为 `false`，截断恢复在并发场景下完全失效。

**修复**：不再使用实例字段，改为通过 `requestBody` 字段传递截断状态。检测点在 `generateContent`/`generateContentStream` 末尾把截断信息写入 `requestBody._truncationState`，注入点在下次 `buildCodewhispererRequest` 调用时读取并消费该字段。

```js
// 检测点（generateContent/generateContentStream 末尾）
if (detectTruncation(responseText, toolCalls)) {
    // 不再写 this._truncationState
    // 下次请求时传入 requestBody._prevTruncation，由上层负责传递
}

// 注入点（buildCodewhispererRequest 入口）
if (KIRO_CONTEXT_LIMITS.TRUNCATION_RECOVERY_ENABLED && requestBody._prevTruncation?.wasTruncated) {
    messages = [...messages];
    injectTruncationRecovery(messages, requestBody._prevTruncation);
}
```

### T2（P1）：`retryCount` 被两种重试逻辑共享

**问题**：`callApi` 和 `streamApiReal` 用同一个 `retryCount` 控制网络错误退避（上限 `REQUEST_MAX_RETRIES=3`）和 content-length 截断重试（上限 `RETRY_MAX_COUNT=2`）。网络错误先消耗到 `retryCount=2` 后，content-length 检查 `2 < 2` 为 false，截断重试永远不触发。

**修复**：新增独立参数 `contentLengthRetryCount = 0`，与 `retryCount` 完全解耦。

```js
async callApi(method, model, body, isRetry = false, retryCount = 0, contentLengthRetryCount = 0) {
    // ...
    // content-length retry 使用 contentLengthRetryCount
    if (body.messages && contentLengthRetryCount < KIRO_CONTEXT_LIMITS.RETRY_MAX_COUNT) {
        // ...
        return this.callApi(method, model, newBody, isRetry, retryCount, contentLengthRetryCount + 1);
    }
}
```

### T3（P1）：`truncateMessagesForRetry` 首次重试无效

**问题**：`retryCount=0` 时 `factor=1.0`，`target=maxMessages=20`。若原始 messages ≤ 20 条，`truncated.length < body.messages.length` 为 false，整个重试分支直接跳过，报错给客户端。覆盖了"消息数少但单条超大（大型 tools/system prompt）"的常见场景。

**修复**：首次重试（`contentLengthRetryCount=0`）固定截断到 `max(5, floor(maxMessages * 0.7))`，从第二次起才用 factor 公式。

```js
function truncateMessagesForRetry(messages, contentLengthRetryCount, maxMessages = 20) {
    const factor = contentLengthRetryCount === 0 ? 0.7 : (1.0 - contentLengthRetryCount * 0.3);
    const target = Math.max(5, Math.floor(maxMessages * factor));
    if (messages.length <= target) return messages;
    return messages.slice(-target);
}
```

### T4（P2）：恢复消息被合并进相邻 user 消息

**问题**：`injectTruncationRecovery` 注入 `role: 'user'` 字符串消息，`buildCodewhispererRequest` 的相邻同 role 合并逻辑会把它混入前一条 user 消息的 content 数组，失去独立轮次语义。

**修复**：注入消息加 `_noMerge: true` 标记，合并循环跳过有此标记的消息。

```js
// injectTruncationRecovery 注入时
messages.push({ role: 'user', content: notice, _noMerge: true });

// buildCodewhispererRequest 合并循环中
if (currentMsg.role === lastMsg.role && !currentMsg._noMerge && !lastMsg._noMerge) {
    // 合并逻辑
}
```

### T5（P2）：`alignToUserMessage` 可能静默清空 history

**问题**：`trimPayloadToLimit` 从头部 trim 到 `history.length > 2` 为止，然后调用 `alignToUserMessage`。若最后剩余2条都是 `assistantResponseMessage`，`alignToUserMessage` 会把两条都 shift 掉，history 变为空数组。`guardPayload` 看到 `finalBytes < 600KB` 返回 null，无任何报错，会话上下文静默丢失。

**修复**：`alignToUserMessage` 检测清空情况，打 warn 日志。

```js
function alignToUserMessage(history) {
    const originalLen = history.length;
    while (history.length > 0 && !('userInputMessage' in history[0])) {
        history.shift();
    }
    if (history.length === 0 && originalLen > 0) {
        logger.warn('[Kiro] alignToUserMessage: all entries were assistant messages, history is now empty');
    }
}
```

### T6（P2）：`generateContent` 截断检测在处理后文本上运行

**问题**：`_processApiResponse` 调用 `repairJson` 修复了部分不平衡括号，`detectTruncation` 运行在这之后已经看不到原始截断信号。`generateContentStream` 没有此问题（`totalContent` 是原始流内容累积）。

**修复**：在 `_processApiResponse` 调用前保存 `rawResponseText`，截断检测对原始文本运行。

```js
const rawResponseText = Buffer.isBuffer(response.data)
    ? response.data.toString('utf8') : String(response.data);
const { responseText, toolCalls } = this._processApiResponse(response);
// ...
if (KIRO_CONTEXT_LIMITS.TRUNCATION_RECOVERY_ENABLED) {
    if (detectTruncation(rawResponseText, toolCalls)) { // 用 rawResponseText
        // ...
    }
}
```

---

## 单元测试清单

两个新模块是纯函数，应新建以下测试文件（项目使用 Jest）：

**`tests/kiro-payload-guard.test.js`**：
- `checkPayloadSize` 返回正确字节数
- `stripEmptyToolUses` 移除 `toolUses: []`，保留非空的
- `alignToUserMessage` — happy path：去掉头部 assistant 条目
- `alignToUserMessage` — edge case：全为 assistant 时清空并触发 warn
- `repairOrphanedToolResults` — 匹配 toolUseId：保留
- `repairOrphanedToolResults` — 不匹配 toolUseId：删除
- `repairOrphanedToolResults` — 前面无 assistant：删除所有 toolResults
- `trimPayloadToLimit` — 不超限时不修改
- `trimPayloadToLimit` — 超限时裁剪并修复 orphaned toolResults
- `guardPayload` — AUTO_TRIM=true 时自动裁剪并返回 null
- `guardPayload` — 裁剪后仍超限时返回错误字符串

**`tests/kiro-truncation-recovery.test.js`**：
- `detectTruncation` — 平衡括号：不截断
- `detectTruncation` — diff=2 不触发（阈值 > 2）
- `detectTruncation` — diff=3 触发
- `detectTruncation` — 奇数 backtick 触发
- `detectTruncation` — 工具调用无效 JSON 触发
- `detectTruncation` — 工具调用合法 JSON 不触发
- `injectTruncationRecovery` — wasTruncated=false 时不注入
- `injectTruncationRecovery` — 有 toolUseId 时注入 tool_result
- `injectTruncationRecovery` — 无 toolUseId 时注入文本通知
- `injectTruncationRecovery` — 注入后清除 truncationState
- `injectTruncationRecovery` — 注入消息带 `_noMerge: true`

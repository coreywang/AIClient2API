# Kiro Context 参数观测口径

当前版本的关键参数：

- `compressHistory` 触发阈值：`580000` bytes
- `guardPayload` 本地安全预算：`600000` bytes
- Tier-3 summary 注入上限：`6000` chars
- Tier-3 summary 请求 prompt 上限：约 `28000` chars，本地先提取 coding memory / pinned facts / tool digest
- 上游 payload 边界不写死为固定合同，以线上错误和实测为准

## 快速分析

文件日志：

```bash
npm run analyze:kiro-context -- logs/app-YYYY-MM-DD.log
```

Docker 日志：

```bash
docker logs aiclient2api | npm run analyze:kiro-context -- -
```

线上 Web UI 下载接口：

```bash
curl -fsS -H "Authorization: Bearer $AICLIENT_TOKEN" \
  "$AICLIENT_BASE_URL/api/system/download-log" \
  | npm run analyze:kiro-context -- -
```

脚本直接拉取线上日志：

```bash
AICLIENT_BASE_URL="https://your-host" \
AICLIENT_TOKEN="your-admin-token" \
npm run analyze:kiro-context -- --remote
```

对比参数调整前后两个日志窗口：

```bash
npm run analyze:kiro-context -- --compare before.log after.log
```

通过 SSH 读取远端容器日志：

```bash
npm run analyze:kiro-context -- \
  --ssh user@host \
  --container aiclient2api \
  --since 24h \
  --tail 5000
```

JSON 输出：

```bash
docker logs aiclient2api | npm run analyze:kiro-context -- - --json
```

输出中的 `assessment` 会按四个维度给出 `ok` / `warn` / `unknown`：

- `parameterInteraction`：580KB 压缩触发和 600KB guard 是否互相打架
- `upstreamLimitFit`：是否仍有 Kiro 上游限制相关错误
- `latencyImpact`：Tier-3 summary 对延迟的影响
- `contextFidelity`：上下文裁剪和摘要上限对保真度的影响

## 判断标准

### 参数是否互相打架

正常情况下：

- `History compression triggered` 先出现，阈值应为 `580000`。
- 若 Tier-2 或 Tier-3 后 payload 已低于 `600000`，不应频繁出现 `Payload trimmed`。
- `Payload trimmed` 可以存在，但应主要作为兜底，不应成为长上下文的主处理路径。

需要关注：

- `payloadTrimmed` 接近或高于 `compressionTriggered`：说明 580KB 压缩没有有效接住，可能 Tier-2/Tier-3 后仍过大，或压缩没有覆盖某类请求。
- `payloadStillAboveLimit > 0`：说明当前消息、tools 或系统提示自身太大，历史裁剪无法解决。
- `contentLengthRetries > 0` 且持续出现：说明 bytes 阈值不足以代理 Kiro 的真实上下文限制，需要结合上游错误重新评估。

### 是否符合 Kiro 上游限制

不能把 `600000` 当作 Kiro 的确定硬限制。更可靠的线上信号是：

- `improperRequestErrors`
- `upstreamErrors["400"]`
- `contentLengthRetries`
- `payloadFinalBytes`
- `compressionOriginalBytes`

如果 `payloadFinalBytes` 的 p95 已低于 `600000`，但仍有大量 `Improperly formed request` 或 `CONTENT_LENGTH_EXCEEDS_THRESHOLD`，说明限制可能不是单纯 JSON bytes，可能还受 token、tools schema、system prompt 或消息结构影响。

如果接近或超过 `600000` 的请求稳定成功，说明本地预算可能偏保守，但是否放宽应同时看失败率和延迟。

### 延迟影响

重点看：

- `tier3DurationMs`
- `tier3PromptChars`
- `tier3Attempts`
- `tier3Fallbacks`
- `tier3InvalidAttempts`

可接受状态：

- Tier-3 触发率低，p95 延迟可接受。
- `attempts=2` 或 fallback 很少出现。

需要回滚或优化：

- `tier3DurationMs` p95 明显抬高整体请求延迟。
- `invalid_summary` 或 `call_failed` fallback 占比高，说明摘要调用质量或稳定性仍有问题。

### 上下文保真度影响

重点看：

- `tier2DroppedPairs`
- `tier3SummarisedEntries`
- `tier3SummaryChars`
- `payloadEntryLossRatio`
- `payloadByteReductionRatio`

判断口径：

- Tier-2 删除的是纯 tool pairs，保真度损失通常低于直接删除文本对话。
- Tier-3 是保真度和 payload 的折中，`summaryChars` 长期贴近 `6001` 表示摘要经常打满上限，可能还会丢细节。
- `tier3PromptChars` 长期贴近 `28000` 表示旧历史本地压缩后仍经常打满 prompt 上限，需要继续减少工具输出或做增量 summary。
- `payloadEntryLossRatio` 高说明 guard 兜底裁剪过重，应优先让压缩在 580KB 阶段完成，而不是依赖 guard。

## 线上观测建议

至少采集一个完整高峰窗口和一个低峰窗口。每次调整参数后，对比：

- Kiro 400 / `Improperly formed request` 数量是否下降
- `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 是否下降
- `tier3DurationMs` p95 是否可接受
- `payloadTrimmed` 是否只是兜底而不是主路径
- `summaryChars` 是否经常贴近 6001
- `tier3PromptChars` 是否从大段旧 history 降到 28000 以内，且不长期打满
- 用户侧是否反馈旧上下文丢失

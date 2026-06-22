#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

function usage() {
    console.error('Usage: npm run analyze:kiro-context -- <log-file-or-dir-or-> [...] [--json]');
    console.error('Usage: AICLIENT_BASE_URL=https://host AICLIENT_TOKEN=... npm run analyze:kiro-context -- --remote');
    console.error('Usage: AICLIENT_TOKEN=... npm run analyze:kiro-context -- --url https://host/api/system/download-log');
    console.error('Usage: npm run analyze:kiro-context -- --ssh user@host --container aiclient2api [--since 24h] [--tail 5000]');
    console.error('Usage: npm run analyze:kiro-context -- --compare <before-log-or-dir> <after-log-or-dir>');
    console.error('Example: npm run analyze:kiro-context -- logs/app-2026-06-22.log');
    console.error('Example: docker logs aiclient2api | npm run analyze:kiro-context -- -');
}

function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function avg(values) {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(before, after) {
    if (!before) return null;
    return (before - after) / before;
}

export function collectFiles(inputPaths) {
    const files = [];
    for (const inputPath of inputPaths) {
        const stat = fs.statSync(inputPath);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(inputPath)
                .filter(name => name.endsWith('.log'))
                .map(name => path.join(inputPath, name));
            files.push(...entries);
        } else {
            files.push(inputPath);
        }
    }
    return files;
}

export function buildRemoteLogRequest({ baseUrl, token, url } = {}) {
    const rawUrl = url || (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/api/system/download-log` : '');
    if (!rawUrl) {
        throw new Error('Missing remote log URL. Set AICLIENT_BASE_URL or pass --url.');
    }
    if (!token) {
        throw new Error('Missing admin token. Set AICLIENT_TOKEN.');
    }
    return {
        url: rawUrl,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildSshDockerLogsCommand({ sshTarget, container, since, tail } = {}) {
    if (!sshTarget) {
        throw new Error('Missing SSH target. Pass --ssh user@host.');
    }
    if (!container) {
        throw new Error('Missing container name. Pass --container <name>.');
    }

    const remoteArgs = ['docker', 'logs', '--timestamps'];
    if (since) remoteArgs.push('--since', since);
    if (tail) remoteArgs.push('--tail', tail);
    remoteArgs.push(container);

    return {
        executable: 'ssh',
        args: [
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=15',
            sshTarget,
            `${remoteArgs.map(shellQuote).join(' ')} 2>&1`,
        ],
    };
}

function fetchSshDockerLog(options) {
    const command = buildSshDockerLogsCommand(options);
    return execFileSync(command.executable, command.args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}

async function fetchRemoteLog(request) {
    const response = await fetch(request.url, { headers: request.headers });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Failed to download remote log: HTTP ${response.status} ${detail.slice(0, 200)}`.trim());
    }
    return response.text();
}

function createStats() {
    return {
        files: [],
        totalLines: 0,
        kiroLines: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        compressionTriggered: 0,
        compressionOriginalBytes: [],
        compressionThresholdBytes: [],
        compressionHistoryEntries: [],
        tier2Result: 0,
        tier2DroppedPairs: [],
        tier2BeforeBytes: [],
        tier2AfterBytes: [],
        tier2BeforeEntries: [],
        tier2AfterEntries: [],
        tier2Sufficient: 0,
        tier3Started: 0,
        tier3SummarisedEntries: [],
        tier3PromptChars: [],
        tier3PromptPinnedFacts: [],
        tier3PromptRecentFailures: [],
        tier3PromptToolEvents: [],
        tier3PromptTranscriptExcerpts: [],
        tier3Generated: 0,
        tier3SummaryChars: [],
        tier3Attempts: [],
        tier3DurationMs: [],
        tier3Fallbacks: {},
        tier3InvalidAttempts: 0,
        tier3CallFailures: 0,
        tier3AfterBytes: [],
        tier3BeforeBytes: [],
        payloadTrimmed: 0,
        payloadOriginalBytes: [],
        payloadFinalBytes: [],
        payloadOriginalEntries: [],
        payloadFinalEntries: [],
        payloadStillAboveLimit: 0,
        contentLengthRetries: 0,
        contentLengthRetryMessagesBefore: [],
        contentLengthRetryMessagesAfter: [],
        upstreamErrors: {},
        improperRequestErrors: 0,
        contextUsageEvents: 0,
        contextUsagePercentages: [],
    };
}

function bump(map, key) {
    map[key] = (map[key] || 0) + 1;
}

function parseLogTimestampMs(timestamp) {
    if (!timestamp) return null;
    const parsed = Date.parse(timestamp.replace(' ', 'T'));
    return Number.isNaN(parsed) ? null : parsed;
}

function parseLogText(text, stats) {
    const tier3StartedAtByReq = new Map();

    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        stats.totalLines++;
        if (!line.includes('[Kiro]')) continue;
        stats.kiroLines++;

        if (line.includes('Improperly formed request')) {
            stats.improperRequestErrors++;
        }

        const timestamp = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/)?.[1];
        const timestampMs = parseLogTimestampMs(timestamp);
        const requestId = line.match(/\[Req:([^\]]+)\]/)?.[1] || null;
        if (timestamp) {
            stats.firstTimestamp ||= timestamp;
            stats.lastTimestamp = timestamp;
        }

        let match = line.match(/History compression triggered: (\d+) bytes > (\d+) bytes(?: \(history entries: (\d+)\))?/);
        if (match) {
            stats.compressionTriggered++;
            stats.compressionOriginalBytes.push(Number(match[1]));
            stats.compressionThresholdBytes.push(Number(match[2]));
            if (match[3]) stats.compressionHistoryEntries.push(Number(match[3]));
            continue;
        }

        match = line.match(/Tier-2 trim result: (\d+) -> (\d+) bytes, (\d+) -> (\d+) history entries, dropped (\d+) pure tool pairs/);
        if (match) {
            stats.tier2Result++;
            stats.tier2BeforeBytes.push(Number(match[1]));
            stats.tier2AfterBytes.push(Number(match[2]));
            stats.tier2BeforeEntries.push(Number(match[3]));
            stats.tier2AfterEntries.push(Number(match[4]));
            stats.tier2DroppedPairs.push(Number(match[5]));
            continue;
        }

        match = line.match(/Tier-2 trim: dropped (\d+) pure tool pairs/);
        if (match) {
            stats.tier2DroppedPairs.push(Number(match[1]));
            continue;
        }

        if (line.includes('Tier-2 trim sufficient')) {
            stats.tier2Sufficient++;
            continue;
        }

        match = line.match(/Tier-3 summary: compressing (\d+) old history entries via Kiro/);
        if (match) {
            stats.tier3Started++;
            stats.tier3SummarisedEntries.push(Number(match[1]));
            if (requestId && timestampMs !== null) {
                tier3StartedAtByReq.set(requestId, timestampMs);
            }
            continue;
        }

        match = line.match(/Tier-3 summary prompt compacted: (\d+) history entries -> (\d+) chars \(pinnedFacts=(\d+), (?:(?:recentFailures=(\d+), )?toolEvents=(\d+), transcriptExcerpts=(\d+))\)/);
        if (match) {
            stats.tier3PromptChars.push(Number(match[2]));
            stats.tier3PromptPinnedFacts.push(Number(match[3]));
            if (match[4] !== undefined) stats.tier3PromptRecentFailures.push(Number(match[4]));
            stats.tier3PromptToolEvents.push(Number(match[5]));
            stats.tier3PromptTranscriptExcerpts.push(Number(match[6]));
            continue;
        }

        match = line.match(/Tier-3 summary invalid on attempt \d+ \((\d+) chars\)/);
        if (match) {
            stats.tier3InvalidAttempts++;
            continue;
        }

        if (line.includes('Tier-3 summary call failed')) {
            stats.tier3CallFailures++;
            continue;
        }

        match = line.match(/Tier-3 summary generated: (\d+) chars(?: \(attempts=(\d+), durationMs=(\d+), fallback=([^)]+)\))?/);
        if (match) {
            stats.tier3Generated++;
            stats.tier3SummaryChars.push(Number(match[1]));
            if (match[2]) stats.tier3Attempts.push(Number(match[2]));
            if (match[3]) {
                stats.tier3DurationMs.push(Number(match[3]));
            } else if (requestId && timestampMs !== null && tier3StartedAtByReq.has(requestId)) {
                const inferredDurationMs = timestampMs - tier3StartedAtByReq.get(requestId);
                if (inferredDurationMs >= 0) {
                    stats.tier3DurationMs.push(inferredDurationMs);
                }
            }
            bump(stats.tier3Fallbacks, match[4] || 'unknown_old_log_format');
            continue;
        }

        match = line.match(/After Tier-3 compression: (?:(\d+) -> )?(\d+) bytes(?: \((\d+) history entries\))?/);
        if (match) {
            if (match[1]) stats.tier3BeforeBytes.push(Number(match[1]));
            stats.tier3AfterBytes.push(Number(match[2]));
            continue;
        }

        match = line.match(/Payload trimmed: (\d+) -> (\d+) bytes, (\d+) -> (\d+) history entries/);
        if (match) {
            stats.payloadTrimmed++;
            stats.payloadOriginalBytes.push(Number(match[1]));
            stats.payloadFinalBytes.push(Number(match[2]));
            stats.payloadOriginalEntries.push(Number(match[3]));
            stats.payloadFinalEntries.push(Number(match[4]));
            continue;
        }

        if (line.includes('remains above local heuristic limit')) {
            stats.payloadStillAboveLimit++;
            continue;
        }

        match = line.match(/Content too long(?: in stream)?, truncating messages (\d+) -> (\d+) and retrying/);
        if (match) {
            stats.contentLengthRetries++;
            stats.contentLengthRetryMessagesBefore.push(Number(match[1]));
            stats.contentLengthRetryMessagesAfter.push(Number(match[2]));
            continue;
        }

        match = line.match(/(?:Stream )?API call failed \(Status: ([^,)]*)/);
        if (match) {
            bump(stats.upstreamErrors, match[1] || 'unknown');
            continue;
        }

        match = line.match(/contextUsagePercentage["']?:\s*([0-9.]+)/);
        if (match) {
            stats.contextUsageEvents++;
            stats.contextUsagePercentages.push(Number(match[1]));
        }
    }
}

function summarizeArray(values) {
    return {
        count: values.length,
        min: values.length ? Math.min(...values) : null,
        p50: percentile(values, 50),
        p90: percentile(values, 90),
        p95: percentile(values, 95),
        max: values.length ? Math.max(...values) : null,
        avg: avg(values),
    };
}

function makeAssessmentItem(status, summary, evidence = []) {
    return { status, summary, evidence };
}

function buildAssessment(report) {
    const triggerCount = report.triggers.compressionTriggered;
    const payloadTrimmed = report.triggers.payloadTrimmed;
    const payloadStillAboveLimit = report.triggers.payloadStillAboveLimit;
    const contentLengthRetries = report.triggers.contentLengthRetries;
    const improperRequestErrors = report.triggers.improperRequestErrors;
    const upstream400 = report.triggers.upstreamErrors['400'] || 0;
    const tier3Started = report.triggers.tier3Started;
    const tier3P95Ms = report.latency.tier3DurationMs.p95;
    const summaryP95Chars = report.contextFidelity.tier3SummaryChars.p95;
    const entryLossP95 = report.contextFidelity.payloadEntryLossRatio.p95;
    const finalPayloadP95 = report.upstreamLimitSignals.payloadFinalBytes.p95;

    let parameterInteraction;
    if (triggerCount === 0 && payloadTrimmed === 0) {
        parameterInteraction = makeAssessmentItem(
            'unknown',
            'No long-context compression or payload guard events were observed.',
            ['Need logs that include long Kiro conversations to verify interaction.']
        );
    } else if (payloadStillAboveLimit > 0) {
        parameterInteraction = makeAssessmentItem(
            'warn',
            'Some requests remained above the local guard budget after trimming.',
            [`payloadStillAboveLimit=${payloadStillAboveLimit}`]
        );
    } else if (triggerCount > 0 && payloadTrimmed > triggerCount * 0.5) {
        parameterInteraction = makeAssessmentItem(
            'warn',
            'Payload guard is firing often relative to history compression; compression may not be catching enough requests before guard trimming.',
            [`compressionTriggered=${triggerCount}`, `payloadTrimmed=${payloadTrimmed}`]
        );
    } else {
        parameterInteraction = makeAssessmentItem(
            'ok',
            'Compression and guard appear staged correctly: compression handles long context first, guard remains a fallback.',
            [`compressionTriggered=${triggerCount}`, `payloadTrimmed=${payloadTrimmed}`]
        );
    }

    let upstreamLimitFit;
    if (improperRequestErrors > 0 || contentLengthRetries > 0) {
        upstreamLimitFit = makeAssessmentItem(
            'warn',
            'Upstream limit signals are still present; the byte budget alone may not fully match Kiro limits.',
            [
                `improperRequestErrors=${improperRequestErrors}`,
                `contentLengthRetries=${contentLengthRetries}`,
                `upstream400=${upstream400}`,
                `payloadFinalBytesP95=${formatNumber(finalPayloadP95)}`,
            ]
        );
    } else if (triggerCount === 0 && payloadTrimmed === 0) {
        upstreamLimitFit = makeAssessmentItem(
            'unknown',
            'No limit-pressure requests were observed, so upstream fit cannot be verified.',
            ['Need logs around requests near or above the 580KB/600KB budgets.']
        );
    } else {
        upstreamLimitFit = makeAssessmentItem(
            'ok',
            'No content-length retries or misleading Kiro payload errors were observed in the analyzed window.',
            [`payloadFinalBytesP95=${formatNumber(finalPayloadP95)}`]
        );
    }

    let latencyImpact;
    if (tier3Started === 0) {
        latencyImpact = makeAssessmentItem(
            'unknown',
            'Tier-3 summary did not run in this window, so summary latency impact cannot be measured.',
            []
        );
    } else if (tier3P95Ms !== null && tier3P95Ms > 5000) {
        latencyImpact = makeAssessmentItem(
            'warn',
            'Tier-3 summary p95 latency is high enough to affect user-visible request latency.',
            [`tier3DurationMsP95=${formatNumber(tier3P95Ms)}`]
        );
    } else {
        latencyImpact = makeAssessmentItem(
            'ok',
            'Tier-3 summary latency is within the conservative observation budget.',
            [`tier3DurationMsP95=${formatNumber(tier3P95Ms)}`]
        );
    }

    let contextFidelity;
    if (triggerCount === 0 && payloadTrimmed === 0) {
        contextFidelity = makeAssessmentItem(
            'unknown',
            'No compression or guard trimming happened, so context fidelity impact cannot be measured.',
            []
        );
    } else if (entryLossP95 !== null && entryLossP95 > 0.5) {
        contextFidelity = makeAssessmentItem(
            'warn',
            'Guard trimming is dropping a large share of history entries; context fidelity risk is high.',
            [`payloadEntryLossRatioP95=${formatNumber(entryLossP95)}`]
        );
    } else if (summaryP95Chars !== null && summaryP95Chars >= 6000) {
        contextFidelity = makeAssessmentItem(
            'warn',
            'Tier-3 summaries are hitting the 6000 char cap; older context may still be losing details.',
            [`tier3SummaryCharsP95=${formatNumber(summaryP95Chars)}`]
        );
    } else {
        contextFidelity = makeAssessmentItem(
            'ok',
            'Observed compression appears bounded; no high entry-loss or summary-cap signal was detected.',
            [
                `payloadEntryLossRatioP95=${formatNumber(entryLossP95)}`,
                `tier3SummaryCharsP95=${formatNumber(summaryP95Chars)}`,
            ]
        );
    }

    return {
        parameterInteraction,
        upstreamLimitFit,
        latencyImpact,
        contextFidelity,
    };
}

function buildReport(stats) {
    const tier2Reductions = stats.tier2BeforeBytes
        .map((before, index) => ratio(before, stats.tier2AfterBytes[index]))
        .filter(value => value !== null);
    const tier3Reductions = stats.tier3BeforeBytes
        .map((before, index) => ratio(before, stats.tier3AfterBytes[index]))
        .filter(value => value !== null);
    const payloadReductions = stats.payloadOriginalBytes
        .map((before, index) => ratio(before, stats.payloadFinalBytes[index]))
        .filter(value => value !== null);
    const payloadEntryLoss = stats.payloadOriginalEntries
        .map((before, index) => ratio(before, stats.payloadFinalEntries[index]))
        .filter(value => value !== null);

    const report = {
        files: stats.files,
        window: {
            firstTimestamp: stats.firstTimestamp,
            lastTimestamp: stats.lastTimestamp,
            totalLines: stats.totalLines,
            kiroLines: stats.kiroLines,
        },
        triggers: {
            compressionTriggered: stats.compressionTriggered,
            tier2Sufficient: stats.tier2Sufficient,
            tier3Started: stats.tier3Started,
            payloadTrimmed: stats.payloadTrimmed,
            payloadStillAboveLimit: stats.payloadStillAboveLimit,
            contentLengthRetries: stats.contentLengthRetries,
            improperRequestErrors: stats.improperRequestErrors,
            upstreamErrors: stats.upstreamErrors,
        },
        latency: {
            tier3DurationMs: summarizeArray(stats.tier3DurationMs),
        },
        contextFidelity: {
            tier2DroppedPairs: summarizeArray(stats.tier2DroppedPairs),
            tier2ByteReductionRatio: summarizeArray(tier2Reductions),
            tier3SummarisedEntries: summarizeArray(stats.tier3SummarisedEntries),
            tier3PromptChars: summarizeArray(stats.tier3PromptChars),
            tier3PromptPinnedFacts: summarizeArray(stats.tier3PromptPinnedFacts),
            tier3PromptRecentFailures: summarizeArray(stats.tier3PromptRecentFailures),
            tier3PromptToolEvents: summarizeArray(stats.tier3PromptToolEvents),
            tier3PromptTranscriptExcerpts: summarizeArray(stats.tier3PromptTranscriptExcerpts),
            tier3SummaryChars: summarizeArray(stats.tier3SummaryChars),
            tier3Attempts: summarizeArray(stats.tier3Attempts),
            tier3Fallbacks: stats.tier3Fallbacks,
            tier3InvalidAttempts: stats.tier3InvalidAttempts,
            tier3CallFailures: stats.tier3CallFailures,
            tier3ByteReductionRatio: summarizeArray(tier3Reductions),
            payloadByteReductionRatio: summarizeArray(payloadReductions),
            payloadEntryLossRatio: summarizeArray(payloadEntryLoss),
        },
        upstreamLimitSignals: {
            compressionOriginalBytes: summarizeArray(stats.compressionOriginalBytes),
            compressionThresholdBytes: summarizeArray(stats.compressionThresholdBytes),
            payloadOriginalBytes: summarizeArray(stats.payloadOriginalBytes),
            payloadFinalBytes: summarizeArray(stats.payloadFinalBytes),
            contextUsagePercentage: summarizeArray(stats.contextUsagePercentages),
        },
    };
    report.assessment = buildAssessment(report);
    return report;
}

function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4);
    return String(value);
}

function formatSummary(summary) {
    return `count=${summary.count}, p50=${formatNumber(summary.p50)}, p90=${formatNumber(summary.p90)}, p95=${formatNumber(summary.p95)}, max=${formatNumber(summary.max)}, avg=${formatNumber(summary.avg)}`;
}

function compareMetric(name, before, after, lowerIsBetter = true) {
    const known = before !== null && before !== undefined && after !== null && after !== undefined;
    if (!known) {
        return { name, before, after, delta: null, ratio: null, status: 'unknown' };
    }

    const delta = after - before;
    const ratioValue = before === 0 ? null : delta / before;
    let status = 'unchanged';
    if (delta !== 0) {
        const better = lowerIsBetter ? delta < 0 : delta > 0;
        status = better ? 'improved' : 'regressed';
    }

    return { name, before, after, delta, ratio: ratioValue, status };
}

function totalLimitErrors(report) {
    return report.triggers.improperRequestErrors +
        report.triggers.contentLengthRetries +
        (report.triggers.upstreamErrors['400'] || 0);
}

function summarizeComparison(deltas) {
    const highSignal = [
        deltas.limitErrors,
        deltas.payloadStillAboveLimit,
        deltas.tier3DurationP95Ms,
        deltas.payloadEntryLossP95,
        deltas.tier3SummaryCharsP95,
        deltas.tier3PromptCharsP95,
    ];

    if (highSignal.some(item => item.status === 'regressed')) {
        return {
            status: 'warn',
            summary: 'The current window regressed on at least one high-signal Kiro context metric.',
        };
    }
    if (highSignal.some(item => item.status === 'improved')) {
        return {
            status: 'improved',
            summary: 'The current window improved on at least one high-signal Kiro context metric without a high-signal regression.',
        };
    }
    if (highSignal.every(item => item.status === 'unknown')) {
        return {
            status: 'unknown',
            summary: 'The compared windows do not contain enough Kiro context events to judge impact.',
        };
    }
    return {
        status: 'neutral',
        summary: 'No material before/after movement was detected in high-signal Kiro context metrics.',
    };
}

export function compareReports(before, after) {
    const deltas = {
        compressionTriggered: compareMetric(
            'compressionTriggered',
            before.triggers.compressionTriggered,
            after.triggers.compressionTriggered,
            false,
        ),
        payloadTrimmed: compareMetric(
            'payloadTrimmed',
            before.triggers.payloadTrimmed,
            after.triggers.payloadTrimmed,
        ),
        payloadStillAboveLimit: compareMetric(
            'payloadStillAboveLimit',
            before.triggers.payloadStillAboveLimit,
            after.triggers.payloadStillAboveLimit,
        ),
        limitErrors: compareMetric(
            'limitErrors',
            totalLimitErrors(before),
            totalLimitErrors(after),
        ),
        tier3DurationP95Ms: compareMetric(
            'tier3DurationP95Ms',
            before.latency.tier3DurationMs.p95,
            after.latency.tier3DurationMs.p95,
        ),
        payloadEntryLossP95: compareMetric(
            'payloadEntryLossP95',
            before.contextFidelity.payloadEntryLossRatio.p95,
            after.contextFidelity.payloadEntryLossRatio.p95,
        ),
        tier3SummaryCharsP95: compareMetric(
            'tier3SummaryCharsP95',
            before.contextFidelity.tier3SummaryChars.p95,
            after.contextFidelity.tier3SummaryChars.p95,
        ),
        tier3PromptCharsP95: compareMetric(
            'tier3PromptCharsP95',
            before.contextFidelity.tier3PromptChars.p95,
            after.contextFidelity.tier3PromptChars.p95,
        ),
    };

    return {
        baseline: {
            files: before.files,
            window: before.window,
            assessment: before.assessment,
        },
        current: {
            files: after.files,
            window: after.window,
            assessment: after.assessment,
        },
        deltas,
        assessment: summarizeComparison(deltas),
    };
}

function printHuman(report) {
    console.log('Kiro context log analysis');
    console.log(`Files: ${report.files.join(', ')}`);
    console.log(`Window: ${report.window.firstTimestamp || 'n/a'} -> ${report.window.lastTimestamp || 'n/a'}`);
    console.log(`Lines: total=${report.window.totalLines}, kiro=${report.window.kiroLines}`);
    console.log('');
    console.log('Triggers');
    for (const [key, value] of Object.entries(report.triggers)) {
        console.log(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    console.log('');
    console.log('Latency');
    console.log(`- tier3DurationMs: ${formatSummary(report.latency.tier3DurationMs)}`);
    console.log('');
    console.log('Context fidelity');
    console.log(`- tier2DroppedPairs: ${formatSummary(report.contextFidelity.tier2DroppedPairs)}`);
    console.log(`- tier2ByteReductionRatio: ${formatSummary(report.contextFidelity.tier2ByteReductionRatio)}`);
    console.log(`- tier3SummarisedEntries: ${formatSummary(report.contextFidelity.tier3SummarisedEntries)}`);
    console.log(`- tier3PromptChars: ${formatSummary(report.contextFidelity.tier3PromptChars)}`);
    console.log(`- tier3PromptPinnedFacts: ${formatSummary(report.contextFidelity.tier3PromptPinnedFacts)}`);
    console.log(`- tier3PromptRecentFailures: ${formatSummary(report.contextFidelity.tier3PromptRecentFailures)}`);
    console.log(`- tier3PromptToolEvents: ${formatSummary(report.contextFidelity.tier3PromptToolEvents)}`);
    console.log(`- tier3PromptTranscriptExcerpts: ${formatSummary(report.contextFidelity.tier3PromptTranscriptExcerpts)}`);
    console.log(`- tier3SummaryChars: ${formatSummary(report.contextFidelity.tier3SummaryChars)}`);
    console.log(`- tier3Attempts: ${formatSummary(report.contextFidelity.tier3Attempts)}`);
    console.log(`- tier3Fallbacks: ${JSON.stringify(report.contextFidelity.tier3Fallbacks)}`);
    console.log(`- tier3InvalidAttempts: ${report.contextFidelity.tier3InvalidAttempts}`);
    console.log(`- tier3CallFailures: ${report.contextFidelity.tier3CallFailures}`);
    console.log(`- tier3ByteReductionRatio: ${formatSummary(report.contextFidelity.tier3ByteReductionRatio)}`);
    console.log(`- payloadByteReductionRatio: ${formatSummary(report.contextFidelity.payloadByteReductionRatio)}`);
    console.log(`- payloadEntryLossRatio: ${formatSummary(report.contextFidelity.payloadEntryLossRatio)}`);
    console.log('');
    console.log('Upstream limit signals');
    console.log(`- compressionOriginalBytes: ${formatSummary(report.upstreamLimitSignals.compressionOriginalBytes)}`);
    console.log(`- payloadOriginalBytes: ${formatSummary(report.upstreamLimitSignals.payloadOriginalBytes)}`);
    console.log(`- payloadFinalBytes: ${formatSummary(report.upstreamLimitSignals.payloadFinalBytes)}`);
    console.log(`- contextUsagePercentage: ${formatSummary(report.upstreamLimitSignals.contextUsagePercentage)}`);
    console.log('');
    console.log('Assessment');
    for (const [key, value] of Object.entries(report.assessment)) {
        console.log(`- ${key}: ${value.status} - ${value.summary}`);
        if (value.evidence.length > 0) {
            console.log(`  evidence: ${value.evidence.join(', ')}`);
        }
    }
}

function printComparisonHuman(comparison) {
    console.log('Kiro context before/after comparison');
    console.log(`Baseline: ${comparison.baseline.files.join(', ')}`);
    console.log(`Current: ${comparison.current.files.join(', ')}`);
    console.log('');
    console.log(`Overall: ${comparison.assessment.status} - ${comparison.assessment.summary}`);
    console.log('');
    console.log('Deltas');
    for (const item of Object.values(comparison.deltas)) {
        console.log(
            `- ${item.name}: ${item.status} ` +
            `(before=${formatNumber(item.before)}, after=${formatNumber(item.after)}, delta=${formatNumber(item.delta)})`
        );
    }
    console.log('');
    console.log('Current assessment');
    for (const [key, value] of Object.entries(comparison.current.assessment)) {
        console.log(`- ${key}: ${value.status} - ${value.summary}`);
    }
}

export function analyzeLogText(text, source = '<inline>') {
    const stats = createStats();
    stats.files = [source];
    parseLogText(text, stats);
    return buildReport(stats);
}

export function analyzeLogPaths(inputPaths) {
    const stats = createStats();
    const files = collectFiles(inputPaths);
    stats.files = [...files];

    for (const file of files) {
        parseLogText(fs.readFileSync(file, 'utf8'), stats);
    }

    return buildReport(stats);
}

function parseCliArgs(args) {
    const json = args.includes('--json');
    const remote = args.includes('--remote');
    let compare = null;
    let url = null;
    let sshTarget = null;
    let container = null;
    let since = null;
    let tail = null;
    const inputPaths = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json' || arg === '--remote') continue;
        if (arg === '--compare') {
            compare = [args[i + 1], args[i + 2]];
            i += 2;
            continue;
        }
        if (arg === '--url') {
            url = args[i + 1];
            i++;
            continue;
        }
        if (arg === '--ssh') {
            sshTarget = args[i + 1];
            i++;
            continue;
        }
        if (arg === '--container') {
            container = args[i + 1];
            i++;
            continue;
        }
        if (arg === '--since') {
            since = args[i + 1];
            i++;
            continue;
        }
        if (arg === '--tail') {
            tail = args[i + 1];
            i++;
            continue;
        }
        inputPaths.push(arg);
    }

    return { json, remote, compare, url, sshTarget, container, since, tail, inputPaths };
}

async function runCli(args) {
    const { json, remote, compare, url, sshTarget, container, since, tail, inputPaths } = parseCliArgs(args);

    if (compare) {
        if (!compare[0] || !compare[1]) {
            throw new Error('Missing compare inputs. Use --compare <before-log-or-dir> <after-log-or-dir>.');
        }
        const comparison = compareReports(
            analyzeLogPaths([compare[0]]),
            analyzeLogPaths([compare[1]]),
        );
        if (json) {
            console.log(JSON.stringify(comparison, null, 2));
        } else {
            printComparisonHuman(comparison);
        }
        return;
    }

    if (inputPaths.length === 0 && !remote && !url && !sshTarget) {
        usage();
        process.exit(1);
    }

    const stdinRequested = inputPaths.includes('-');
    const pathInputs = inputPaths.filter(inputPath => inputPath !== '-');
    const stats = createStats();
    const files = collectFiles(pathInputs);
    stats.files = [...files];

    if (stdinRequested) {
        const stdinText = fs.readFileSync(0, 'utf8');
        parseLogText(stdinText, stats);
        stats.files.unshift('<stdin>');
    }

    if (remote || url) {
        const request = buildRemoteLogRequest({
            baseUrl: process.env.AICLIENT_BASE_URL,
            token: process.env.AICLIENT_TOKEN,
            url,
        });
        const remoteText = await fetchRemoteLog(request);
        parseLogText(remoteText, stats);
        stats.files.unshift(request.url);
    }

    if (sshTarget) {
        const sshText = fetchSshDockerLog({ sshTarget, container, since, tail });
        parseLogText(sshText, stats);
        stats.files.unshift(`ssh://${sshTarget}/${container}`);
    }

    for (const file of files) {
        parseLogText(fs.readFileSync(file, 'utf8'), stats);
    }

    const report = buildReport(stats);
    if (json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printHuman(report);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli(process.argv.slice(2)).catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
